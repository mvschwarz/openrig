import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { OMP_BRIDGE_PROTOCOL_VERSION, ompBridgeSocketPath } from "../src/adapters/omp-bridge-protocol.js";
import { OmpBridgeServer } from "../src/adapters/omp-bridge-server.js";
import { OmpTuiRuntimeAdapter } from "../src/adapters/omp-tui-runtime-adapter.js";

function tempStateRoot(): string {
  return fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-tui-delivery-"));
}

function adapterFor(stateRoot: string): OmpTuiRuntimeAdapter {
  return new OmpTuiRuntimeAdapter({
    tmux: {} as never,
    fsOps: {} as never,
    stateRoot,
    runnerEntryPath: "/daemon/pi-runner.js",
    sleep: async () => { /* no waiting in tests */ },
  });
}

/** A stand-in for the runner's bridge socket: it records commands and optionally acknowledges them. */
async function startSocketServer(
  stateRoot: string,
  sessionName: string,
  acknowledge?: (frame: Record<string, unknown>, socket: net.Socket) => void,
) {
  const socketPath = ompBridgeSocketPath(nodePath.join(stateRoot, sessionName));
  fs.mkdirSync(nodePath.dirname(socketPath), { recursive: true });
  const frames: Record<string, unknown>[] = [];
  const commandSeen = Promise.withResolvers<void>();
  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) {
          const frame = JSON.parse(line) as Record<string, unknown>;
          frames.push(frame);
          if (typeof frame.id === "string") {
            commandSeen.resolve();
            acknowledge?.(frame, socket);
          }
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolve) => { server.listen(socketPath, resolve); });
  return { socketPath, frames, commandSeen: commandSeen.promise, close: () => { server.close(); } };
}

function successAck(frame: Record<string, unknown>, socket: net.Socket): void {
  socket.write(`${JSON.stringify({ type: "command_ack", id: frame.id, success: true })}\n`);
}

describe("the omp-tui adapter delivers a Rig message over the bridge socket", () => {
  it("identifies itself as a control client and sends the message as a prompt", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName, successAck);
    const adapter = adapterFor(stateRoot);
    const result = await adapter.deliverMessage(sessionName, "  look at the diff  ");
    expect(result.ok).toBe(true);
    expect(socket.frames[0]).toEqual({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION });
    expect(socket.frames[1]).toMatchObject({ type: "prompt", message: "look at the diff", id: expect.any(String) });

    socket.close();
  });

  it("keeps the pane's follow-up convention", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName, successAck);
    const adapter = adapterFor(stateRoot);

    const result = await adapter.deliverMessage(sessionName, "/followup and then summarize");
    expect(result.ok).toBe(true);
    expect(socket.frames[1]).toMatchObject({ type: "follow_up", message: "and then summarize", id: expect.any(String) });

    socket.close();
  });

  it("reports failure when command receives no acknowledgement", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName);
    vi.useFakeTimers();
    try {
      const resultPromise = adapterFor(stateRoot).deliverMessage(sessionName, "hello");
      await socket.commandSeen;
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await resultPromise).toMatchObject({ ok: false, error: expect.stringContaining("did not acknowledge") });
    } finally {
      vi.useRealTimers();
      socket.close();
    }
  });

  it("reports explicit bridge rejection", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socket = await startSocketServer(stateRoot, sessionName, (frame, control) => {
      control.write(`${JSON.stringify({ type: "command_ack", id: frame.id, success: false, error: "queue full" })}\n`);
    });
    const result = await adapterFor(stateRoot).deliverMessage(sessionName, "hello");
    expect(result).toEqual({ ok: false, error: "queue full" });
    socket.close();
  });

  it("reports queue overflow when runner has no connected bridge", async () => {
    const stateRoot = tempStateRoot();
    const sessionName = "seat@rig";
    const socketPath = ompBridgeSocketPath(nodePath.join(stateRoot, sessionName));
    fs.mkdirSync(nodePath.dirname(socketPath), { recursive: true });
    let bridge: OmpBridgeServer;
    bridge = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: () => {},
      onControlFrame: (frame) => bridge.sendToBridge(frame),
    });
    await bridge.start();
    for (let index = 0; index < 64; index++) bridge.sendToBridge({ type: "prompt", message: "queued" });
    const result = await adapterFor(stateRoot).deliverMessage(sessionName, "overflow");
    expect(result).toEqual({ ok: false, error: "bridge command queue is full" });
    bridge.close();
  });

  it("reports a failure when the runner's socket is not there", async () => {
    const stateRoot = tempStateRoot();
    const adapter = adapterFor(stateRoot);
    const result = await adapter.deliverMessage("seat@rig", "hello");
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
