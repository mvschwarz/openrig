// OMP-side bridge extension for OpenRig's native-TUI seat shape.
//
// OpenRig launches OMP's OWN interactive TUI inside the seat's tmux pane
// (interactive OMP under a pty). The TUI owns the pane, so the pane cannot be
// scraped for events and cannot be typed into. This extension is the other half
// of that contract: it runs INSIDE the OMP process, reports OMP's session
// events to the OpenRig runner over a Unix socket, and applies the commands the
// runner relays (a Rig message, a steer, an abort, a state read).
//
// It is loaded by OMP through `--trusted-extension <abs path>` and stays
// dependency-free: no OMP imports, no daemon imports beyond the wire contract
// next to this file, no UI access. The TUI stays the only renderer and the only
// approval authority; this extension only reports and applies.

import net from "node:net";
import {
  OMP_BRIDGE_PROTOCOL_VERSION,
  bridgeCommandDeliversAs,
  bridgeEventDedupeKey,
  createBridgeFrameDecoder,
  encodeBridgeFrame,
  parseBridgeCommand,
  type OmpBridgeEntriesReply,
} from "./omp-bridge-protocol.js";

const MAX_ENUMERATED_ENTRIES = 1000;
const MAX_CURSOR_WALK_STEPS = 1000;
const RECONNECT_INITIAL_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;

/** OMP session events the runner projects onto the seat's activity feed. */
const FORWARDED_EVENTS = [
  "session_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_compaction_start",
  "auto_compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "goal_updated",
  "tool_approval_requested",
  "tool_approval_resolved",
] as const;


/** The slice of OMP's session manager this extension reads. */
export interface BridgeSessionManager {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId?: () => string | null;
  getEntry?: (id: string) => { id?: string; parentId?: string | null } | undefined;
}

/** The slice of OMP's extension context this extension uses. */
export interface BridgeContext {
  sessionManager?: BridgeSessionManager;
  abort?(): void;
}

/** The slice of OMP's extension API this extension uses. */
export interface BridgeApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx: BridgeContext) => void): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void | Promise<void>;
  getSessionName?(): string | undefined;
}

/** Where the runner's control socket lives (set by the runner's child env). */
export function bridgeSocketPath(): string | null {
  const value = process.env.OPENRIG_OMP_BRIDGE_SOCKET;
  return value && value.trim() ? value.trim() : null;
}


/**
 * The bridge's whole job: connect to the runner, report events, apply
 * commands. Exported so the runner-side tests can drive it with a fake socket
 * and a fake OMP API.
 */
export class OmpTuiBridge {
  private socket: net.Socket | null = null;
  private connected = false;
  private closed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
  private readonly seenEvents = new Set<string>();
  private ctx: BridgeContext | null = null;
  private sessionId: string | undefined;
  private sessionFile: string | undefined;

  constructor(
    private readonly api: BridgeApi,
    private readonly socketPath: string,
  ) {}

  /** Connect, handshake, and start reporting. */
  async start(): Promise<void> {
    this.registerEventHandlers();
    try {
      await this.connect();
    } catch (error) {
      this.scheduleReconnect();
      throw error;
    }
  }

  /** Whether the runner connection is up. */
  get isConnected(): boolean {
    return this.connected;
  }

  /** The OMP session id reported to the runner (once known). */
  get reportedSessionId(): string | undefined {
    return this.sessionId;
  }

  /** The OMP session file reported to the runner (once known). */
  get reportedSessionFile(): string | undefined {
    return this.sessionFile;
  }

  /** Close the runner connection and prevent further reconnects. */
  close(): void {
    this.closed = true;
    this.connected = false;
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
    this.socket?.end();
    this.socket = null;
  }

  private async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ path: this.socketPath });
      const onError = (error: Error): void => {
        socket.destroy();
        reject(error);
      };
      socket.once("error", onError);
      socket.once("connect", () => {
        socket.off("error", onError);
        this.socket = socket;
        this.connected = true;
        this.reconnectDelayMs = RECONNECT_INITIAL_DELAY_MS;
        const decoder = createBridgeFrameDecoder((frame) => {
          void this.applyCommand(frame);
        }, () => socket.destroy());
        socket.on("data", (chunk: Buffer) => {
          decoder.push(chunk.toString("utf8"));
        });
        socket.on("error", () => {
          this.connected = false;
        });
        socket.on("close", () => {
          this.connected = false;
          if (this.socket === socket) this.socket = null;
          this.scheduleReconnect();
        });
        resolve();
      });
    });
    this.captureSessionIdentity();
    this.write({
      role: "bridge",
      protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      sessionFile: this.sessionFile,
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
    timer.unref();
    this.reconnectTimer = timer;
  }

  private captureSessionIdentity(): void {
    const manager = this.ctx?.sessionManager;
    if (!manager) return;
    const sessionId = manager.getSessionId();
    const sessionFile = manager.getSessionFile();
    const changed = (sessionId !== undefined && sessionId !== this.sessionId)
      || (sessionFile !== undefined && sessionFile !== this.sessionFile);
    this.sessionId = sessionId ?? this.sessionId;
    this.sessionFile = sessionFile ?? this.sessionFile;
    if (changed) {
      // The runner builds its readiness sidecar and resume token from this.
      this.write({ type: "session_identity", sessionId: this.sessionId, sessionFile: this.sessionFile });
    }
  }

  private registerEventHandlers(): void {
    for (const eventName of FORWARDED_EVENTS) {
      this.api.on(eventName, (event, ctx) => {
        this.ctx = ctx;
        this.captureSessionIdentity();
        this.reportEvent(eventName, event);
      });
    }
  }

  /** Report one OMP event to the runner, dropping a duplicate of the same event. */
  reportEvent(eventName: string, event: Record<string, unknown>): void {
    const key = bridgeEventDedupeKey({ type: eventName, ...event });
    if (key) {
      if (this.seenEvents.has(key)) return;
      this.seenEvents.add(key);
    }
    const payload: Record<string, unknown> = { type: eventName };
    for (const [field, value] of Object.entries(event)) {
      if (field === "type") continue;
      payload[field] = value;
    }
    this.write(payload);
  }

  private reply(id: string | undefined, data: Record<string, unknown>): void {
    this.write({ type: "response", id: id ?? "", success: true, data });
  }

  private acknowledge(id: string | undefined, success: boolean, error?: string): void {
    if (!id) return;
    this.write({ type: "command_ack", id, success, ...(error ? { error } : {}) });
  }

  /** Apply one command frame from the runner, then acknowledge its outcome. */
  async applyCommand(frame: Record<string, unknown>): Promise<void> {
    const command = parseBridgeCommand(frame);
    if (!command) return;
    try {
      switch (command.type) {
        case "abort":
          if (!this.ctx?.abort) throw new Error("OMP abort is unavailable");
          this.ctx.abort();
          break;
        case "get_state":
          this.reply(command.id, { sessionId: this.sessionId, sessionFile: this.sessionFile });
          break;
        case "get_entries": {
          this.reply(command.id, this.entries(command.since));
          break;
        }
        case "prompt":
        case "steer":
        case "follow_up": {
          const message = command.message ?? "";
          if (!message) throw new Error("command message is empty");
          const deliverAs = bridgeCommandDeliversAs(command.type);
          await this.api.sendUserMessage(message, deliverAs ? { deliverAs } : undefined);
          break;
        }
      }
      this.acknowledge(command.id, true);
    } catch (error) {
      this.acknowledge(command.id, false, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * The reply enumerates the entries after the caller's cursor by walking the
   * leaf's parent chain: the chain is the session's current branch, so the
   * ids below the cursor are exactly the ones the cursor has not seen.
   *
   * A cursor off that chain or beyond the walk budget cannot identify a safe
   * suffix and returns an empty truncated reply with the cursor unchanged. A
   * range longer than the reply budget keeps omitted entries recoverable: the
   * caller advances through enumerated entries and asks again. Cursor walks
   * are bounded to 1000 parent lookups; a cursor more than 1000 entries behind
   * the leaf remains unserved until the cursor or session identity is reset.
   */
  private entries(since?: string): OmpBridgeEntriesReply {
    const manager = this.ctx?.sessionManager;
    if (!manager || typeof manager.getLeafId !== "function") {
      return { entries: [], truncated: false, available: false };
    }
    const newestId = manager.getLeafId();
    if (newestId === null || newestId === "") {
      return { entries: [], truncated: false, available: true };
    }
    if (since === newestId) {
      return { entries: [], truncated: false, available: true, newestId };
    }
    if (typeof manager.getEntry !== "function") {
      return { entries: [], truncated: true, available: true, newestId };
    }

    const parentOf = (id: string): string | null | undefined => {
      const entry = manager.getEntry?.(id);
      if (!entry) return undefined;
      return typeof entry.parentId === "string" && entry.parentId.length > 0 ? entry.parentId : null;
    };

    // The session is mutable, so a missing entry is a hole in the chain, not its end.

    if (since === undefined) {
      // No cursor yet: the caller wants the session's position, so the newest
      // ids are the answer. The ids left out are older than the cursor this
      // reply establishes, not a gap behind it.
      const newest: string[] = [];
      let currentId: string | null | undefined = newestId;
      while (currentId !== null && currentId !== undefined && newest.length < MAX_ENUMERATED_ENTRIES) {
        newest.push(currentId);
        currentId = parentOf(currentId);
      }
      newest.reverse();
      return {
        entries: newest.map((id) => ({ id })),
        truncated: currentId !== null,
        available: true,
        newestId,
      };
    }

    // A cursor: the answer is the range after it. The walk runs from the leaf
    // (newest first) down to the cursor, so the range's oldest ids are the
    // last ones seen. Keeping those — rather than the newest — lets the
    // cursor advance one reply at a time while the omitted entries stay
    // recoverable on the next catch-up.
    const window: Array<string | undefined> = new Array<string | undefined>(MAX_ENUMERATED_ENTRIES);
    let kept = 0;
    let next = 0;
    let rangeLength = 0;
    let currentId: string | null | undefined = newestId;
    let anchored = false;
    let steps = 0;
    while (currentId !== null && currentId !== undefined && steps < MAX_CURSOR_WALK_STEPS) {
      if (currentId === since) {
        anchored = true;
        break;
      }
      window[next] = currentId;
      next = (next + 1) % MAX_ENUMERATED_ENTRIES;
      kept = Math.min(kept + 1, MAX_ENUMERATED_ENTRIES);
      rangeLength += 1;
      steps += 1;
      currentId = parentOf(currentId);
    }
    // The last permitted lookup can land directly on the cursor; recognize it
    // without spending an extra parent lookup.
    if (!anchored && currentId === since) anchored = true;
    if (!anchored) {
      // The cursor is not safely reachable within the bounded walk; keep it so
      // omitted entries remain recoverable.
      return { entries: [], truncated: true, available: true, newestId };
    }
    const ids: string[] = [];
    for (let offset = 1; offset <= kept; offset += 1) {
      const id = window[(next - offset + MAX_ENUMERATED_ENTRIES) % MAX_ENUMERATED_ENTRIES];
      if (id !== undefined) ids.push(id);
    }
    // The window holds the oldest kept ids first, which is the append order
    // the caller expects.
    return {
      entries: ids.map((id) => ({ id })),
      truncated: rangeLength > kept,
      available: true,
      newestId,
    };
  }

  /** Write one frame to the runner. */
  write(frame: Record<string, unknown>): void {
    if (!this.socket || !this.connected) return;
    try {
      this.socket.write(encodeBridgeFrame(frame));
    } catch {
      this.connected = false;
    }
  }
}

/**
 * Extension entry point. OMP calls this with its extension API; the bridge
 * connects to the runner's socket and stays connected for the session. A
 * failure to connect must never break OMP's startup: the TUI is still the
 * seat's UI, it simply has no OpenRig channel.
 */
export default async function activate(pi: BridgeApi): Promise<void> {
  const path = bridgeSocketPath();
  if (!path) return;
  const bridge = new OmpTuiBridge(pi, path);
  process.on("exit", () => {
    bridge.close();
  });
  try {
    await bridge.start();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[openrig omp bridge] failed to connect to ${path}: ${detail}\n`);
  }
}
