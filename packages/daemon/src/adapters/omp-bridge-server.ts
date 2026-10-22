// The runner-side half of the OpenRig ↔ OMP native-TUI bridge.
//
// The seat runner owns one Unix socket. Two kinds of client connect to it:
//
//   role "bridge"  — the OMP-side extension running inside OMP. It reports
//                    OMP's session events and applies the commands relayed
//                    to it (a Rig message, a steer, an abort, a state read).
//   role "control" — the daemon's message writer. It sends one command frame
//                    per Rig message.
//
// The runner routes frames between them and never interprets OMP's event
// vocabulary itself: bridge frames go into the same event path the RPC child
// used, so activity, session identity and the readiness sidecar keep working
// unchanged.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import {
  OMP_BRIDGE_PROTOCOL_VERSION,
  createBridgeFrameDecoder,
  encodeBridgeFrame,
  isBridgeHandshake,
  type OmpBridgeHandshake,
} from "./omp-bridge-protocol.js";

export interface OmpBridgeServerOptions {
  /** Absolute path of the socket file to serve. */
  socketPath: string;
  /** A frame from the OMP-side bridge (an OMP event or a command reply). */
  onBridgeFrame: (frame: Record<string, unknown>) => void;
  /** A command frame from a control client (the daemon's message writer). */
  onControlFrame: (frame: Record<string, unknown>) => void;
  /** The bridge connected and identified itself. */
  onBridgeReady?: (handshake: OmpBridgeHandshake) => void;
  /** The bridge connection closed; the seat is no longer reachable through it. */
  onBridgeClosed?: () => void;
  /** Process signal probe seam for deterministic lock-owner checks. */
  processKill?: (pid: number, signal: 0) => boolean;
  /** Deterministic seam for exercising lock replacement after atomic rename. */
  onLockMovedAside?: (asidePath: string) => void;
  /** Diagnostics for the seat log. */
  onLog?: (line: string) => void;
  /** Deterministic seam for exercising stale-lock replacement races. */
  onLockOwnerJudged?: (owner: string) => void;
}

/** Commands queued for the bridge while it has not connected yet. */
const MAX_PENDING_COMMANDS = 64;

/** Probe an existing Unix socket without letting an unresponsive peer stall startup. */
function isSocketServing(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (serving: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(serving);
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Whether a process is still running. Only ESRCH proves that it is dead. */
function isProcessAlive(pid: number, processKill: (pid: number, signal: 0) => boolean): boolean {
  try {
    processKill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The exact content recorded in a lock file, or null when it cannot be read. */
function readLockOwner(lockPath: string): string | null {
  try {
    return fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * The bridge socket server. One instance per seat, owned by the runner.
 */
export class OmpBridgeServer {
  private server: net.Server | null = null;
  private bridgeSocket: net.Socket | null = null;
  private readonly pending: Array<{ payload: string; control?: net.Socket; id?: string }> = [];
  private readonly awaiting = new Map<string, net.Socket>();
  private activeControlSocket: net.Socket | null = null;
  private ownsLock = false;
  private readonly lockOwner = `${process.pid}:${randomBytes(12).toString("hex")}`;

  constructor(private readonly opts: OmpBridgeServerOptions) {}

  /** Whether the OMP-side bridge has connected. */
  get bridgeConnected(): boolean {
    return this.bridgeSocket !== null;
  }

  /** Commands waiting for the bridge to connect. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Start serving. A stale socket file left by a previous launch is replaced;
   * a socket that another live runner still serves is refused, not taken over.
   */
  async start(): Promise<void> {
    const lockPath = `${this.opts.socketPath}.lock`;
    this.claimLock(lockPath);
    try {
      if (await isSocketServing(this.opts.socketPath)) {
        throw new Error(`Another runner already serves socket ${this.opts.socketPath}`);
      }
      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      try {
        fs.rmSync(this.opts.socketPath, { force: true });
      } catch { /* a stale socket that cannot be removed fails the listen below */ }
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.removeListener("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.opts.socketPath);
      });
      // The socket carries seat traffic: keep it owner-only.
      try {
        fs.chmodSync(this.opts.socketPath, 0o600);
      } catch { /* best effort — the seat directory already restricts access */ }
    } catch (error) {
      this.server?.close();
      this.server = null;
      this.releaseLock(lockPath);
      throw error;
    }
  }

  private claimLock(lockPath: string): void {
    const refuse: () => never = () => {
      throw new Error(`Another runner already serves socket ${this.opts.socketPath}`);
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          if (attempt > 0) refuse();
          throw error;
        }
        const owner = readLockOwner(lockPath);
        if (owner === null) refuse();
        this.opts.onLockOwnerJudged?.(owner);
        const pidText = owner.split(":", 1)[0];
        const pid = Number(pidText);
        // A pid outside the operating system's range cannot be running.
        const owned = Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff
          && isProcessAlive(pid, this.opts.processKill ?? process.kill);
        if (owned) refuse();
        const asidePath = `${lockPath}.${randomBytes(12).toString("hex")}.aside`;
        try {
          fs.renameSync(lockPath, asidePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          refuse();
        }
        this.opts.onLockMovedAside?.(asidePath);
        const asideOwner = readLockOwner(asidePath);
        if (asideOwner === owner) {
          fs.unlinkSync(asidePath);
          continue;
        }
        try {
          fs.linkSync(asidePath, lockPath);
          try { fs.unlinkSync(asidePath); } catch { /* aside cleanup is best effort */ }
        } catch {
          // The moved lock stays on disk: it is a live claim that cannot be put
          // back, and deleting it would destroy the other owner's claim.
          refuse();
        }
        refuse();
      }
      try {
        fs.writeFileSync(descriptor, this.lockOwner);
      } catch (error) {
        fs.closeSync(descriptor);
        try { fs.unlinkSync(lockPath); } catch { /* lock cleanup is best effort */ }
        throw error;
      }
      fs.closeSync(descriptor);
      this.ownsLock = true;
      return;
    }
    refuse();
  }

  private releaseLock(lockPath: string): void {
    if (!this.ownsLock) return;
    this.ownsLock = false;
    const asidePath = `${lockPath}.${randomBytes(12).toString("hex")}.aside`;
    try {
      fs.renameSync(lockPath, asidePath);
    } catch { return; }
    this.opts.onLockMovedAside?.(asidePath);
    if (readLockOwner(asidePath) === this.lockOwner) {
      try { fs.unlinkSync(asidePath); } catch { /* already gone */ }
      return;
    }
    try {
      fs.linkSync(asidePath, lockPath);
      try { fs.unlinkSync(asidePath); } catch { /* aside cleanup is best effort */ }
    } catch {
      // Preserve the moved lock rather than delete a claim now at lockPath.
    }
  }

  /** Stop serving and remove the socket file. */
  close(): void {
    const lockPath = `${this.opts.socketPath}.lock`;
    const ownsSocket = this.ownsLock && readLockOwner(lockPath) === this.lockOwner;
    this.failAwaiting("bridge server closed");
    this.bridgeSocket?.end();
    this.bridgeSocket = null;
    this.server?.close();
    this.server = null;
    if (ownsSocket) {
      try {
        fs.rmSync(this.opts.socketPath, { force: true });
      } catch { /* already gone */ }
    }
    this.releaseLock(lockPath);
  }

  /**
   * Send one frame to the OMP-side bridge. While the bridge is still
   * starting, the frame is queued and flushed on connect.
   */
  sendToBridge(frame: Record<string, unknown>, control?: net.Socket): void {
    const payload = encodeBridgeFrame(frame);
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const origin = control ?? this.activeControlSocket ?? undefined;
    if (origin && id) this.awaiting.set(id, origin);
    if (!this.bridgeSocket) {
      if (this.pending.length < MAX_PENDING_COMMANDS) {
        this.pending.push({ payload, control: origin, id });
      } else if (origin && id) {
        this.awaiting.delete(id);
        this.sendAck(origin, id, false, "bridge command queue is full");
      }
      return;
    }
    this.writeToBridge(payload, origin, id);
  }

  private sendAck(socket: net.Socket, id: string, success: boolean, error?: string): void {
    if (!socket.destroyed) socket.write(encodeBridgeFrame({ type: "command_ack", id, success, ...(error ? { error } : {}) }));
  }

  private failAwaiting(reason: string): void {
    for (const [id, socket] of this.awaiting) this.sendAck(socket, id, false, reason);
    this.awaiting.clear();
  }

  private writeToBridge(payload: string, control?: net.Socket, id?: string): void {
    const socket = this.bridgeSocket;
    if (!socket) {
      if (control && id) {
        this.awaiting.delete(id);
        this.sendAck(control, id, false, "bridge disconnected before command delivery");
      }
      return;
    }
    try {
      socket.write(payload, (error) => {
        if (error && control && id) {
          this.awaiting.delete(id);
          this.sendAck(control, id, false, error.message);
        }
      });
    } catch (error) {
      this.opts.onLog?.(`[omp-bridge] write to bridge failed: ${(error as Error).message}`);
      if (control && id) {
        this.awaiting.delete(id);
        this.sendAck(control, id, false, (error as Error).message);
      }
    }
  }

  private accept(socket: net.Socket): void {
    let role: "bridge" | "control" | null = null;
    const decoder = createBridgeFrameDecoder((frame) => {
      if (role === null) {
        if (!isBridgeHandshake(frame)) {
          this.opts.onLog?.("[omp-bridge] ignored a connection that did not handshake");
          socket.end();
          return;
        }
        role = frame.role;
        if (role === "bridge") {
          this.bridgeSocket = socket;
          socket.on("close", () => {
            if (this.bridgeSocket === socket) {
              this.bridgeSocket = null;
              this.failAwaiting("bridge disconnected before acknowledgement");
              this.opts.onBridgeClosed?.();
            }
          });
          this.opts.onBridgeReady?.(frame);
          this.flushPending();
        }
        return;
      }
      if (role === "bridge") {
        if (frame.type === "command_ack" && typeof frame.id === "string") {
          const control = this.awaiting.get(frame.id);
          if (control) {
            this.awaiting.delete(frame.id);
            if (!control.destroyed) control.write(encodeBridgeFrame(frame));
            return;
          }
        }
        this.opts.onBridgeFrame(frame);
        return;
      }
      this.activeControlSocket = socket;
      try {
        this.opts.onControlFrame(frame);
      } finally {
        this.activeControlSocket = null;
      }
      return;
    }, (error) => {
      this.opts.onLog?.(`[omp-bridge] rejected connection: ${error.message}`);
      socket.destroy();
    });
    socket.on("close", () => {
      for (const [id, control] of this.awaiting) if (control === socket) this.awaiting.delete(id);
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk.toString("utf8")));
    socket.on("error", (error: Error) => {
      this.opts.onLog?.(`[omp-bridge] connection error: ${error.message}`);
    });
  }

  private flushPending(): void {
    while (this.pending.length > 0) {
      const pending = this.pending.shift();
      if (pending) this.writeToBridge(pending.payload, pending.control, pending.id);
    }
  }
}


/** The handshake frame a control client sends before its first command. */
export function controlHandshakeFrame(): Record<string, unknown> {
  return { role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION };
}
