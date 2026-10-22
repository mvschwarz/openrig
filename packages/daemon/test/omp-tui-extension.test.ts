import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { MAX_BRIDGE_FRAME_BYTES, OMP_BRIDGE_COMMAND_TYPES, OMP_BRIDGE_PROTOCOL_VERSION, createBridgeFrameDecoder, parseBridgeCommand } from "../src/adapters/omp-bridge-protocol.js";
import { OmpBridgeServer } from "../src/adapters/omp-bridge-server.js";
import activate, { OmpTuiBridge, type BridgeApi, type BridgeContext } from "../src/adapters/omp-tui-extension.js";

/** A short socket path inside a fresh temp dir (Unix sockets cap at 108 chars). */
function tempSocketPath(name: string): string {
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "openrig-omp-tui-"));
  return nodePath.join(dir, `${name}.sock`);
}

/** Collects frames and lets a test wait for the next one it cares about. */
class FrameCollector {
  readonly frames: Record<string, unknown>[] = [];
  private readonly waiters: Array<{
    match: (frame: Record<string, unknown>) => boolean;
    resolve: (frame: Record<string, unknown>) => void;
  }> = [];

  add(frame: Record<string, unknown>): void {
    this.frames.push(frame);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(frame)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }

  waitFor(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
    const existing = this.frames.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => { this.waiters.push({ match, resolve }); });
  }
}

/** The OMP-side fake: an extension API that records what OMP was asked to do. */
function fakeExtensionApi() {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: BridgeContext) => void>();
  const messages: Array<{ content: string; deliverAs?: string }> = [];
  let notify: (() => void) | null = null;
  const api: BridgeApi = {
    on: (event, handler) => { handlers.set(event, handler); },
    sendUserMessage: (content, options) => {
      messages.push({ content, deliverAs: options?.deliverAs });
      notify?.();
    },
  };
  /** Resolves once OMP was asked to deliver at least `count` messages. */
  const waitForMessages = (count: number): Promise<void> => new Promise((resolve) => {
    const check = (): void => {
      if (messages.length >= count) {
        resolve();
        return;
      }
      notify = () => { check(); };
    };
    check();
  });
  return { api, handlers, messages, waitForMessages };
}

describe("the OMP bridge reports events and applies commands", () => {
  it("hands the runner OMP's events, the session identity, and one reply per request", async () => {
    const socketPath = tempSocketPath("events");
    const bridgeFrames = new FrameCollector();
    const controlFrames = new FrameCollector();
    let aborted = false;
    const ctx: BridgeContext = {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => "/state/omp/seat/sessions/2026_1.jsonl",
        getLeafId: () => "entry-2",
        getEntry: (id) => id === "entry-2" ? { id, parentId: "entry-1" } : { id, parentId: null },
      },
      abort: () => { aborted = true; },
    };

    let readyBridge: (handshake: Record<string, unknown>) => void = () => { /* replaced below */ };
    const bridgeReady = new Promise<Record<string, unknown>>((resolve) => { readyBridge = resolve; });
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: (frame) => { controlFrames.add(frame); },
      onBridgeReady: (handshake) => { readyBridge(handshake as Record<string, unknown>); },
    });
    await server.start();

    const { api, handlers, messages, waitForMessages } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();

    // The handshake identifies the bridge and carries the protocol version.
    expect(await bridgeReady).toMatchObject({
      role: "bridge",
      protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION,
    });

    // An OMP event reaches the runner as a frame of the same type.
    handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    expect(await bridgeFrames.waitFor((frame) => frame.type === "agent_start")).toMatchObject({ type: "agent_start" });

    // The identity the runner needs for its sidecar and resume token.
    expect(await bridgeFrames.waitFor((frame) => frame.type === "session_identity")).toMatchObject({
      type: "session_identity",
      sessionId: "session-1",
      sessionFile: "/state/omp/seat/sessions/2026_1.jsonl",
    });

    // A Rig message becomes OMP's own user message; steer and follow-up keep
    // their delivery modes, and abort cancels the running turn.
    server.sendToBridge({ type: "prompt", id: "prompt-1", message: "hello" });
    server.sendToBridge({ type: "steer", id: "steer-1", message: "turn left" });
    server.sendToBridge({ type: "follow_up", id: "follow-1", message: "then this" });
    server.sendToBridge({ type: "abort", id: "abort-1" });
    // The bridge applies a command asynchronously, so the applied messages are
    // proven by the wait, not by the order of the writes above.
    await waitForMessages(3);
    expect(messages).toEqual([
      { content: "hello", deliverAs: undefined },
      { content: "turn left", deliverAs: "steer" },
      { content: "then this", deliverAs: "followUp" },
    ]);
    expect(aborted).toBe(true);
    for (const id of ["prompt-1", "steer-1", "follow-1", "abort-1"]) {
      expect(await bridgeFrames.waitFor((frame) => frame.type === "command_ack" && frame.id === id))
        .toMatchObject({ type: "command_ack", id, success: true });
    }
    server.sendToBridge({ type: "prompt", id: "empty-prompt" });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "command_ack" && frame.id === "empty-prompt"))
      .toMatchObject({ success: false, error: "command message is empty" });

    // A state request is answered in the RPC response shape.
    server.sendToBridge({ type: "get_state", id: "state-1" });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "state-1")).toMatchObject({
      type: "response",
      id: "state-1",
      success: true,
      data: { sessionId: "session-1", sessionFile: "/state/omp/seat/sessions/2026_1.jsonl" },
    });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "command_ack" && frame.id === "state-1"))
      .toMatchObject({ success: true });

    // The newest entry id lets the runner advance its durable cursor.
    server.sendToBridge({ type: "get_entries", id: "entries-1" });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "entries-1")).toMatchObject({
      data: { entries: [{ id: "entry-1" }, { id: "entry-2" }], truncated: false, available: true, newestId: "entry-2" },
    });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "command_ack" && frame.id === "entries-1"))
      .toMatchObject({ success: true });

    expect(controlFrames.frames).toHaveLength(0);
    bridge.close();
    server.close();
  });

  it("reports one frame for an event the same source repeats", async () => {
    const socketPath = tempSocketPath("dedupe");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: () => { /* no control client in this case */ },
    });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    const ctx: BridgeContext = {
      sessionManager: { getSessionId: () => "s", getSessionFile: () => "/f.jsonl" },
    };

    const event = { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" };
    handlers.get("tool_execution_start")?.(event, ctx);
    handlers.get("tool_execution_start")?.(event, ctx);
    await bridgeFrames.waitFor((frame) => frame.type === "tool_execution_start");
    expect(bridgeFrames.frames.filter((frame) => frame.type === "tool_execution_start")).toHaveLength(1);

    bridge.close();
    server.close();
  });

  it("closes a socket that sends an oversized unterminated frame", async () => {
    const socketPath = tempSocketPath("oversized");
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: () => {},
      onControlFrame: () => {},
    });
    await server.start();
    const socket = net.connect({ path: socketPath });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write(`${"x".repeat(MAX_BRIDGE_FRAME_BYTES + 1)}`);
    await closed;
    expect(socket.destroyed).toBe(true);
    server.close();
  });

  it("closes a socket after a malformed frame", async () => {
    const socketPath = tempSocketPath("malformed");
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: () => {},
      onControlFrame: () => {},
    });
    await server.start();
    const socket = net.connect({ path: socketPath });
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write("{not-json}\n");
    await closed;
    expect(socket.destroyed).toBe(true);
    server.close();
  });
});

  it("routes extension acknowledgement to originating control socket", async () => {
    const socketPath = tempSocketPath("control-ack");
    const bridgeFrames = new FrameCollector();
    let server: OmpBridgeServer;
    server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: (frame) => server.sendToBridge(frame),
    });
    await server.start();
    const { api, messages } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    const control = net.connect({ path: socketPath });
    const controlFrames = new FrameCollector();
    const decoder = createBridgeFrameDecoder((frame) => controlFrames.add(frame));
    control.on("data", (chunk: Buffer) => decoder.push(chunk.toString("utf8")));
    await new Promise<void>((resolve) => control.once("connect", resolve));
    control.write(`${JSON.stringify({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })}\n`);
    control.write(`${JSON.stringify({ type: "prompt", id: "control-prompt", message: "ack me" })}\n`);
    expect(await controlFrames.waitFor((frame) => frame.type === "command_ack"))
      .toMatchObject({ type: "command_ack", id: "control-prompt", success: true });
    expect(messages).toEqual([{ content: "ack me", deliverAs: undefined }]);
    control.destroy();
    bridge.close();
    server.close();
  });

describe("the bridge socket routes both roles", () => {
  it("relays a control client's command to the bridge and queues commands sent too early", async () => {
    const socketPath = tempSocketPath("roles");
    const controlFrames = new FrameCollector();
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: (frame) => { controlFrames.add(frame); },
    });
    await server.start();

    // A command sent before the bridge connects waits for it.
    server.sendToBridge({ type: "prompt", message: "queued" });
    expect(server.pendingCount).toBe(1);

    // The bridge connects, identifies itself, and receives the queued command.
    const bridgeSocket = net.connect({ path: socketPath });
    const queued = await new Promise<Record<string, unknown>>((resolve) => {
      let buffer = "";
      bridgeSocket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        for (const line of buffer.split("\n")) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line) as Record<string, unknown>;
          if (frame.type === "prompt") resolve(frame);
        }
      });
      bridgeSocket.write(`${JSON.stringify({ role: "bridge", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })}\n`);
    });
    expect(queued).toEqual({ type: "prompt", message: "queued" });
    expect(server.pendingCount).toBe(0);

    // A control client identifies itself, then sends a command.
    const controlSocket = net.connect({ path: socketPath });
    controlSocket.write(`${JSON.stringify({ role: "control", protocolVersion: OMP_BRIDGE_PROTOCOL_VERSION })}\n`);
    controlSocket.write(`${JSON.stringify({ type: "prompt", message: "from the daemon" })}\n`);
    expect(await controlFrames.waitFor((frame) => frame.type === "prompt")).toEqual({ type: "prompt", message: "from the daemon" });

    // The bridge's own frames stay on the bridge channel.
    bridgeSocket.write(`${JSON.stringify({ type: "agent_start" })}\n`);
    await bridgeFrames.waitFor((frame) => frame.type === "agent_start");
    expect(controlFrames.frames.filter((frame) => frame.type === "agent_start")).toHaveLength(0);

    bridgeSocket.destroy();
    controlSocket.destroy();
    server.close();
  });
});

describe("the bridge bounds what it answers and refuses what it does not declare", () => {
  it("enumerates the append-order suffix after the caller cursor", async () => {
    const socketPath = tempSocketPath("entries-leaf");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: () => { /* no control client in this case */ },
    });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    const tree = new Map([
      ["entry-1197", null],
      ["entry-1198", "entry-1197"],
      ["entry-1199", "entry-1198"],
      ["entry-1200", "entry-1199"],
    ]);
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getLeafId: () => "entry-1200",
        getEntry: (id) => tree.has(id) ? { id, parentId: tree.get(id) } : undefined,
        getEntries: () => { throw new Error("entry list must not be copied"); },
      },
    });

    server.sendToBridge({ type: "get_entries", id: "catch-up-1", since: "entry-1198" });
    const catchUpReply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "catch-up-1");
    expect(catchUpReply.data).toEqual({
      entries: [{ id: "entry-1199" }, { id: "entry-1200" }],
      truncated: false, available: true, newestId: "entry-1200",
    });
    server.sendToBridge({ type: "get_entries", id: "current-1", since: "entry-1200" });
    const currentReply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "current-1");
    expect(currentReply.data).toEqual({ entries: [], truncated: false, available: true, newestId: "entry-1200" });
    server.sendToBridge({ type: "get_entries", id: "unknown-1", since: "unknown" });
    const unknownReply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "unknown-1");
    expect(unknownReply.data).toEqual({ entries: [], truncated: true, available: true, newestId: "entry-1200" });
    bridge.close();
    server.close();
  });

  it("caps ancestry enumeration and reports truncation", async () => {
    const socketPath = tempSocketPath("entries-cap");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({ socketPath, onBridgeFrame: (frame) => { bridgeFrames.add(frame); }, onControlFrame: () => {} });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1", getSessionFile: () => undefined,
        getLeafId: () => "id-1200", getEntry: (id) => {
          const index = Number(id.slice(3));
          return index > 0 ? { id, parentId: `id-${index - 1}` } : { id, parentId: null };
        },
      },
    });
    server.sendToBridge({ type: "get_entries", id: "cap-1" });
    const reply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "cap-1");
    expect(reply.data).toMatchObject({ truncated: true, available: true, newestId: "id-1200" });
    expect((reply.data as { entries: Array<{ id: string }> }).entries).toHaveLength(1000);
    expect((reply.data as { entries: Array<{ id: string }> }).entries.at(-1)).toEqual({ id: "id-1200" });
    bridge.close();
    server.close();
  });

  it("keeps an over-budget cursor unchanged when ancestry exceeds the walk cap", async () => {
    const socketPath = tempSocketPath("entries-long-range");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: () => {},
    });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1", getSessionFile: () => undefined,
        getLeafId: () => "id-1199", getEntry: (id) => {
          const index = Number(id.slice(3));
          return index > 0 ? { id, parentId: `id-${index - 1}` } : { id, parentId: null };
        },
      },
    });
    server.sendToBridge({ type: "get_entries", id: "long-range-1", since: "id-0" });
    const reply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "long-range-1");
    expect(reply.data).toEqual({ entries: [], truncated: true, available: true, newestId: "id-1199" });
    bridge.close();
    server.close();
  });

  it("reports unavailable entries when the session manager or leaf accessor is missing", async () => {
    const contexts: BridgeContext[] = [
      {},
      {
        sessionManager: {
          getSessionId: () => "session-1",
          getSessionFile: () => undefined,
        },
      },
    ];
    for (const [index, ctx] of contexts.entries()) {
      const socketPath = tempSocketPath(`entries-unavailable-${index}`);
      const bridgeFrames = new FrameCollector();
      const server = new OmpBridgeServer({
        socketPath,
        onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
        onControlFrame: () => { /* no control client in this case */ },
      });
      await server.start();
      const { api, handlers } = fakeExtensionApi();
      const bridge = new OmpTuiBridge(api, socketPath);
      await bridge.start();
      handlers.get("agent_start")?.({ type: "agent_start" }, ctx);

      const id = `unavailable-${index}`;
      server.sendToBridge({ type: "get_entries", id });
      const reply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === id);
      expect(reply.data).toEqual({ entries: [], truncated: false, available: false });

      bridge.close();
      server.close();
    }
  });

  it("answers a session without a leaf id as available and empty", async () => {
    const socketPath = tempSocketPath("entries-empty");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: () => { /* no control client in this case */ },
    });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1",
        getSessionFile: () => undefined,
        getLeafId: () => null,
      },
    });

    server.sendToBridge({ type: "get_entries", id: "empty-1" });
    const reply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "empty-1");
    expect(reply.data).toEqual({ entries: [], truncated: false, available: true });

    bridge.close();
    server.close();
  });

  it("applies only the command types the protocol declares", async () => {
    // Every declared type is a command; anything else is not.
    for (const type of OMP_BRIDGE_COMMAND_TYPES) {
      expect(parseBridgeCommand({ type })).toMatchObject({ type });
    }
    expect(parseBridgeCommand({ type: "delete_everything" })).toBeNull();

    const socketPath = tempSocketPath("undeclared");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({
      socketPath,
      onBridgeFrame: (frame) => { bridgeFrames.add(frame); },
      onControlFrame: () => { /* no control client in this case */ },
    });
    await server.start();
    const { api, messages } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();

    // An undeclared type is not a command: it is never applied and never
    // acknowledged, while the next declared command still is.
    server.sendToBridge({ type: "delete_everything", id: "undeclared-1", message: "must not be delivered" });
    server.sendToBridge({ type: "prompt", id: "declared-1", message: "delivered" });
    expect(await bridgeFrames.waitFor((frame) => frame.type === "command_ack" && frame.id === "declared-1"))
      .toMatchObject({ success: true });
    expect(bridgeFrames.frames.filter((frame) => frame.type === "command_ack" && frame.id === "undeclared-1"))
      .toHaveLength(0);
    expect(messages).toEqual([{ content: "delivered", deliverAs: undefined }]);

    bridge.close();
    server.close();
  });

  it("treats a missing ancestor as an unknown end for initial and cursor walks", async () => {
    const socketPath = tempSocketPath("entries-hole");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({ socketPath, onBridgeFrame: (frame) => bridgeFrames.add(frame), onControlFrame: () => {} });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1", getSessionFile: () => undefined,
        getLeafId: () => "entry-3",
        getEntry: (id) => id === "entry-3" ? { id, parentId: "entry-2" } : id === "entry-1" ? { id, parentId: null } : undefined,
      },
    });
    const writes = vi.spyOn(bridge, "write");
    await bridge.applyCommand({ type: "get_entries", id: "hole-initial" });
    expect(writes.mock.calls[0]?.[0]).toMatchObject({
      type: "response", id: "hole-initial", data: { truncated: true, available: true },
    });
    await bridge.applyCommand({ type: "get_entries", id: "hole-cursor", since: "entry-1" });
    expect(writes.mock.calls[2]?.[0]).toEqual({
      type: "response", id: "hole-cursor",
      success: true,
      data: { entries: [], truncated: true, available: true, newestId: "entry-3" },
    });
    bridge.close();
    server.close();
  });

  it("bounds cursor ancestry work at the hard walk cap", async () => {
    const socketPath = tempSocketPath("entries-walk-cap");
    const bridgeFrames = new FrameCollector();
    const server = new OmpBridgeServer({ socketPath, onBridgeFrame: (frame) => bridgeFrames.add(frame), onControlFrame: () => {} });
    await server.start();
    const { api, handlers } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    const entries = new Map<string, string | null>();
    for (let index = 0; index <= 1001; index += 1) {
      entries.set(`entry-${index}`, index === 0 ? null : `entry-${index - 1}`);
    }
    let lookups = 0;
    handlers.get("agent_start")?.({ type: "agent_start" }, {
      sessionManager: {
        getSessionId: () => "session-1", getSessionFile: () => undefined,
        getLeafId: () => "entry-1001",
        getEntry: (id) => {
          lookups += 1;
          return entries.has(id) ? { id, parentId: entries.get(id) } : undefined;
        },
      },
    });
    server.sendToBridge({ type: "get_entries", id: "walk-cap", since: "entry-0" });
    const reply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "walk-cap");
    expect(reply.data).toEqual({ entries: [], truncated: true, available: true, newestId: "entry-1001" });
    expect(lookups).toBeLessThanOrEqual(1000);
    expect(lookups).toBe(1000);
    lookups = 0;
    server.sendToBridge({ type: "get_entries", id: "walk-exact-cap", since: "entry-1" });
    const exactCapReply = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "walk-exact-cap");
    expect(exactCapReply.data).toMatchObject({
      truncated: false, available: true, newestId: "entry-1001",
    });
    const exactCapEntries = (exactCapReply.data as { entries: Array<{ id: string }> }).entries;
    expect(exactCapEntries).toHaveLength(1000);
    expect(exactCapEntries[0]).toEqual({ id: "entry-2" });
    expect(exactCapEntries.at(-1)).toEqual({ id: "entry-1001" });
    expect(lookups).toBe(1000);
    bridge.close();
    server.close();
  });

  it("reports unexpected activation failures but stays silent without a socket path", async () => {
    const previousPath = process.env.OPENRIG_OMP_BRIDGE_SOCKET;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      delete process.env.OPENRIG_OMP_BRIDGE_SOCKET;
      await activate(fakeExtensionApi().api);
      expect(stderr).not.toHaveBeenCalled();
      process.env.OPENRIG_OMP_BRIDGE_SOCKET = tempSocketPath("activation-failure");
      await activate(fakeExtensionApi().api);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("failed to connect to"));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("activation-failure.sock"));
    } finally {
      if (previousPath === undefined) delete process.env.OPENRIG_OMP_BRIDGE_SOCKET;
      else process.env.OPENRIG_OMP_BRIDGE_SOCKET = previousPath;
      stderr.mockRestore();
    }
  });

  it("reconnects after socket close and sends a fresh handshake", async () => {
    const socketPath = tempSocketPath("reconnect");
    const bridgeFrames = new FrameCollector();
    const makeServer = (): OmpBridgeServer => new OmpBridgeServer({
      socketPath, onBridgeFrame: (frame) => bridgeFrames.add(frame), onControlFrame: () => {},
    });
    let server = makeServer();
    await server.start();
    const { api } = fakeExtensionApi();
    const bridge = new OmpTuiBridge(api, socketPath);
    await bridge.start();
    const bridgeSocket = (bridge as unknown as { socket: net.Socket | null }).socket;
    if (!bridgeSocket) throw new Error("bridge socket did not connect");
    try {
      server.sendToBridge({ type: "get_state", id: "before-close" });
      await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "before-close");
      vi.useFakeTimers();
      server.close();
      await new Promise<void>((resolve) => bridgeSocket.once("close", resolve));
      server = makeServer();
      await server.start();
      server.sendToBridge({ type: "get_state", id: "after-reconnect" });
      await vi.advanceTimersByTimeAsync(250);
      const response = await bridgeFrames.waitFor((frame) => frame.type === "response" && frame.id === "after-reconnect");
      expect(response.type).toBe("response");
    } finally {
      bridge.close();
      server.close();
      vi.useRealTimers();
    }
  });
});
