import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hookEventState } from "../src/domain/agent-activity-store.js";
import { createHash } from "node:crypto";
// The seat extension is plain ESM that runs inside OMP (under Bun). It uses only Node built-ins, so it loads here too.
// @ts-expect-error — a JavaScript asset without declarations
import openrigSeat, { IDLE_LIVENESS_SECONDS, createSeatReporter, readSeatConfig, resolveActivityEndpoint } from "../assets/omp/openrig-seat.js";

type Body = Record<string, unknown>;

const seat = { sessionName: "dev-omp@rig", statePath: "/seat/runner-state.json", launchId: "attempt-1", nodeId: "node-1", generation: "gen-1", contextSidecarPath: "/ctx/dev-omp@rig.json" };
const sessionFile = "/seat/sessions/s1.jsonl";

/** An OMP session as the extension sees it: its session manager, model registry and context accounting. */
function ompContext(opts: { file?: string; id?: string; authenticated?: boolean; percent?: number } = {}) {
  const model = { provider: "anthropic", id: "claude-example" };
  return {
    sessionManager: { getSessionFile: () => opts.file ?? sessionFile, getSessionId: () => opts.id ?? "s1" },
    model,
    models: { list: () => (opts.authenticated === false ? [] : [model]) },
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: opts.percent ?? 25 }),
  };
}

function harness(opts: { persisted?: () => boolean; onDisk?: () => boolean } = {}) {
  const posts: Body[] = [];
  const files: Record<string, Body> = {};
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
  let clock = 0;
  const reporter = createSeatReporter({
    seat,
    pid: 4242,
    now: () => new Date(Date.UTC(2026, 10, 11, 0, 0, clock++)).toISOString(),
    post: async (body: Body) => { posts.push(body); return { ok: true, tokenPersisted: opts.persisted?.() ?? true }; },
    writeFile: (file: string, content: string) => { files[file] = JSON.parse(content); },
    fileExists: () => opts.onDisk?.() ?? true,
    schedule: (fn: () => void, ms: number) => { const timer = { fn, ms, live: true }; timers.push(timer); return timer; },
    cancel: (timer: { live: boolean }) => { timer.live = false; },
  });
  const activity = () => posts.filter((post) => post.hookEvent).map((post) => `${post.hookEvent}/${post.subtype}`);
  const tick = (ms: number) => { for (const timer of timers.filter((t) => t.live && t.ms === ms)) timer.fn(); };
  return { reporter, posts, files, activity, tick, state: () => files[seat.statePath]! };
}

describe("OMP seat extension: what the daemon reads from a seat", () => {
  it("does not let an old identity acknowledgement suppress a switched conversation", async () => {
    const posted: string[] = [];
    let resolveFirst!: (value: unknown) => void;
    const reporter = createSeatReporter({ seat, writeFile: () => {}, fileExists: () => true,
      schedule: () => null, cancel: () => {}, post: async (body: Body) => {
        if (body.eventFamily !== "session_identity") return {};
        posted.push(body.sessionFile);
        if (posted.length === 1) return new Promise(resolve => { resolveFirst = resolve; });
        return { tokenPersisted: true };
      } });
    reporter.sessionStart(ompContext({ id: "a", file: "/a" }));
    await new Promise(resolve => setImmediate(resolve));
    reporter.sessionChanged(ompContext({ id: "b", file: "/b" }));
    resolveFirst({ tokenPersisted: true });
    await reporter.settled();
    expect(posted).toEqual(["/a", "/b"]);
    reporter.agentEnd({}, ompContext({ id: "b", file: "/b" }));
    await reporter.settled();
    expect(posted).toEqual(["/a", "/b"]);
  });

  it("refreshes login state without requiring a manual model turn", () => {
    const { reporter, state, tick } = harness();
    const options = { authenticated: false };
    reporter.sessionStart(ompContext(options));
    expect(state().auth).toBe("missing");
    options.authenticated = true;
    tick(30_000);
    expect(state().auth).toBe("ok");
  });

  it("clears the old conversation's error when a new conversation opens", async () => {
    const { reporter, activity, tick } = harness();
    reporter.sessionStart(ompContext());
    reporter.agentStart(ompContext());
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "error" }] }, ompContext());
    reporter.sessionChanged(ompContext({ id: "new", file: "/new" }));
    tick(IDLE_LIVENESS_SECONDS * 1000);
    await reporter.settled();
    expect(activity().slice(-2)).toEqual(["Stop/idle_heartbeat", "Stop/idle_heartbeat"]);
  });
  it("reports a ready seat: the launch-scoped sidecar, an idle report that states its interval, and context usage", async () => {
    const { reporter, posts, files, state } = harness();
    reporter.sessionStart(ompContext());
    await reporter.settled();
    expect(state()).toMatchObject({ ready: true, launchId: "attempt-1", nodeId: seat.nodeId, generation: seat.generation, sessionFile, sessionId: "s1", auth: "ok", model: "anthropic/claude-example", pid: 4242 });
    expect(posts.find((post) => post.hookEvent)).toMatchObject({
      hookEvent: "Stop", subtype: "idle_heartbeat", livenessSeconds: IDLE_LIVENESS_SECONDS,
      sessionName: "dev-omp@rig", nodeId: "node-1", generation: "gen-1", runtime: "omp-tui", sequence: 1,
    });
    expect(files[seat.contextSidecarPath!]).toMatchObject({
      source: "omp_extension", session_name: "dev-omp@rig", occupant_generation: "gen-1", transcript_path: sessionFile,
      context_window: { context_window_size: 200_000, used_percentage: 25, remaining_percentage: 75, total_input_tokens: 50_000 },
    });
  });

  it("says a seat without credentials for its model is missing a login", () => {
    const { reporter, state } = harness();
    reporter.sessionStart(ompContext({ authenticated: false }));
    expect(state()).toMatchObject({ ready: true, auth: "missing" });
  });

  it("posts each turn boundary once, in order, numbered by one rising sequence", async () => {
    const { reporter, posts, activity } = harness();
    reporter.sessionStart(ompContext());
    reporter.agentStart(ompContext());
    reporter.turnStart();
    reporter.toolStart({ toolName: "bash" });
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ompContext());
    await reporter.settled();
    expect(activity()).toEqual(["Stop/idle_heartbeat", "UserPromptSubmit/accepted", "active/turn_start", "PreToolUse/bash", "Stop/end_turn"]);
    const turn = posts.filter((post) => post.hookEvent);
    expect(turn.map((post) => post.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(turn.slice(1).every((post) => post.turnId === "1")).toBe(true);
    expect(turn.at(-1)).toMatchObject({ livenessSeconds: IDLE_LIVENESS_SECONDS });
  });

  it("an approval prompt holds needs-input until the person answers it in the pane", async () => {
    const { reporter, activity, tick } = harness();
    reporter.sessionStart(ompContext());
    reporter.agentStart(ompContext());
    reporter.approvalRequested("call-one");
    // While a person is asked, nothing may read as work or as idle: no beats, no turn or tool posts.
    tick(10_000);
    tick(IDLE_LIVENESS_SECONDS * 1000);
    reporter.turnStart();
    reporter.approvalResolved("call-one");
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ompContext());
    await reporter.settled();
    expect(activity()).toEqual(["Stop/idle_heartbeat", "UserPromptSubmit/accepted", "Notification/permission_prompt", "active/permission_resolved", "Stop/end_turn"]);
  });

  it("a failed turn is not reported idle: it holds attention until the next turn starts", async () => {
    const { reporter, activity, tick } = harness();
    reporter.sessionStart(ompContext());
    reporter.agentStart(ompContext());
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "error" }] }, ompContext());
    tick(IDLE_LIVENESS_SECONDS * 1000);
    await reporter.settled();
    expect(activity()).toEqual(["Stop/idle_heartbeat", "UserPromptSubmit/accepted", "Notification/runtime_error"]);
    reporter.agentStart(ompContext());
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ompContext());
    await reporter.settled();
    expect(activity().slice(3)).toEqual(["UserPromptSubmit/accepted", "Stop/cancelled"]);
  });

  it("a turn OMP will continue on its own is not reported idle", async () => {
    const { reporter, activity } = harness();
    reporter.sessionStart(ompContext());
    reporter.agentStart(ompContext());
    reporter.agentEnd({ willContinue: true, messages: [{ role: "assistant", stopReason: "stop" }] }, ompContext());
    await reporter.settled();
    expect(activity()).toEqual(["Stop/idle_heartbeat", "UserPromptSubmit/accepted", "active/continuing"]);
  });

  it("beats working only while a turn is outstanding, and idle only while at the prompt", async () => {
    const { reporter, posts, tick } = harness();
    reporter.sessionStart(ompContext());
    tick(10_000); // no turn: a working beat would invent one
    reporter.agentStart(ompContext());
    tick(10_000);
    tick(IDLE_LIVENESS_SECONDS * 1000); // mid-turn: an idle beat would end it
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ompContext());
    tick(10_000);
    tick(IDLE_LIVENESS_SECONDS * 1000);
    await reporter.settled();
    const beats = posts.filter((post) => post.subtype === "liveness" || post.subtype === "idle_heartbeat").map((post) => `${post.subtype}@${post.sequence}`);
    expect(beats).toEqual(["idle_heartbeat@1", "liveness@3", "idle_heartbeat@5"]);
    expect(posts.find((post) => post.subtype === "liveness")).toMatchObject({ hookEvent: "active", turnId: "1", livenessSeconds: 30 });
  });

  it("claims a session's identity only once its file exists, and repeats it until the daemon confirms it stored it", async () => {
    let onDisk = false;
    let persisted = false;
    const { reporter, posts } = harness({ onDisk: () => onDisk, persisted: () => persisted });
    const identities = () => posts.filter((post) => post.eventFamily === "session_identity");
    reporter.sessionStart(ompContext());
    await reporter.settled();
    expect(identities()).toEqual([]); // OMP names a new session's file before it writes the first turn
    onDisk = true;
    reporter.agentStart(ompContext());
    reporter.agentEnd({ messages: [{ role: "assistant", stopReason: "stop" }] }, ompContext());
    await reporter.settled();
    expect(identities()).toEqual([expect.objectContaining({ sessionId: "s1", sessionFile, runtime: "omp-tui", generation: "gen-1", nodeId: "node-1" })]);
    persisted = true;
    reporter.agentEnd({ messages: [] }, ompContext());
    await reporter.settled();
    expect(identities()).toHaveLength(2);
    reporter.agentEnd({ messages: [] }, ompContext());
    await reporter.settled();
    expect(identities()).toHaveLength(2); // confirmed: not posted again
    // The person switched conversations inside OMP: the seat now names another file.
    reporter.sessionChanged(ompContext({ file: "/seat/sessions/s2.jsonl", id: "s2" }));
    await reporter.settled();
    expect(identities().at(-1)).toMatchObject({ sessionId: "s2", sessionFile: "/seat/sessions/s2.jsonl" });
  });

  it("reports its own exit as an exit, never as idle, and marks the sidecar", async () => {
    const { reporter, posts, state, tick } = harness();
    reporter.sessionStart(ompContext());
    await reporter.shutdown();
    tick(IDLE_LIVENESS_SECONDS * 1000);
    const stopped = posts.at(-1)!;
    expect(stopped).toMatchObject({ hookEvent: "Stop", subtype: "omp-tui_exited" });
    expect(hookEventState(String(stopped.hookEvent), String(stopped.subtype), "omp-tui")).toBe("unknown");
    expect(posts.at(-1)).not.toHaveProperty("livenessSeconds");
    expect(state()).toMatchObject({ ready: false, launchId: "attempt-1", exited: { code: 0 } });
  });
});

describe("OMP seat extension: finding the daemon", () => {
  it("is a managed seat only with a session name and a sidecar path", () => {
    expect(readSeatConfig({ OPENRIG_SESSION_NAME: "dev@rig" })).toBeNull();
    expect(readSeatConfig({ OPENRIG_OMP_SEAT_STATE: "/seat/state.json" })).toBeNull();
    expect(readSeatConfig({ OPENRIG_SESSION_NAME: "dev@rig", OPENRIG_OMP_SEAT_STATE: "/seat/state.json", OPENRIG_NODE_ID: " node-9 " }))
      .toMatchObject({ sessionName: "dev@rig", statePath: "/seat/state.json", nodeId: "node-9", generation: null });
  });

  it("takes the endpoint from the environment, else from the instance's endpoint file, else posts nothing", () => {
    const file = () => JSON.stringify({ baseUrl: "http://127.0.0.1:7433", token: "file-token" });
    expect(resolveActivityEndpoint({ OPENRIG_URL: "http://guest:9000", OPENRIG_ACTIVITY_HOOK_TOKEN: "grant" }, file))
      .toEqual({ baseUrl: "http://guest:9000", token: "grant" });
    // A managed host seat: the token is kept out of OMP's environment, so it comes from the file.
    expect(resolveActivityEndpoint({ OPENRIG_HOME: "/home/.openrig", OPENRIG_HOST: "::1", OPENRIG_PORT: "7433" }, file))
      .toEqual({ baseUrl: "http://[::1]:7433", token: "file-token" });
    expect(resolveActivityEndpoint({ OPENRIG_HOME: "/home/.openrig" }, () => { throw new Error("ENOENT"); })).toBeNull();
  });
});

describe("OMP seat extension: wired into OMP", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; vi.unstubAllGlobals(); });

  function load(env: Record<string, string>) {
    process.env = { ...saved, ...env };
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    openrigSeat({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); } });
    return handlers;
  }

  it("does nothing in an OMP that OpenRig didn't launch as a seat", () => {
    expect(load({ OPENRIG_SESSION_NAME: "", OPENRIG_OMP_SEAT_STATE: "" }).size).toBe(0);
  });

  it("holds permission attention until every pending OMP tool call resolves", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-approvals-"));
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: URL, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}");
    });
    const ctx = ompContext();
    const handlers = load({ OPENRIG_SESSION_NAME: "test", OPENRIG_OMP_SEAT_STATE: path.join(root, "state.json"),
      OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "test" });
    const emit = (name: string, toolCallId: string, sessionId = "s1") => handlers.get(name)!({ toolCallId, sessionId }, ctx);
    try {
      handlers.get("session_start")!({}, ctx);
      handlers.get("agent_start")!({}, ctx);
      emit("tool_approval_requested", "first");
      emit("tool_approval_requested", "second");
      emit("tool_approval_resolved", "unknown");
      emit("tool_approval_resolved", "first");
      handlers.get("tool_execution_start")!({ toolName: "while-pending" }, ctx);
      emit("tool_approval_resolved", "first");
      emit("tool_approval_resolved", "second", "previous-session");
      handlers.get("tool_execution_start")!({ toolName: "before-current-resolution" }, ctx);
      emit("tool_approval_resolved", "second");
      emit("tool_approval_resolved", "second");
      handlers.get("tool_execution_start")!({ toolName: "after-resolution" }, ctx);
    } finally {
      await handlers.get("session_shutdown")!({}, ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(bodies.map(body => body.subtype)).toEqual(["idle_heartbeat", "accepted", "permission_prompt", "permission_prompt",
      "permission_resolved", "after-resolution", "omp-tui_exited"]);
  });

  it("refreshes usage immediately after /clear and invalidates a sample when the cleared context has no usage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-context-clear-"));
    const contextPath = path.join(root, "context.json");
    const handlers = load({ OPENRIG_SESSION_NAME: "test", OPENRIG_OMP_SEAT_STATE: path.join(root, "state.json"),
      OPENRIG_OMP_CONTEXT_SIDECAR: contextPath, OPENRIG_URL: "invalid", OPENRIG_ACTIVITY_HOOK_TOKEN: "test" });
    const sample = () => JSON.parse(fs.readFileSync(contextPath, "utf8"));
    const ctx = ompContext({ percent: 75 });
    try {
      handlers.get("session_start")!({}, ctx);
      expect(sample().context_window.used_percentage).toBe(75);
      handlers.get("session_clear")!({}, ompContext({ percent: 0 }));
      expect(sample()).toMatchObject({ session_id: "s1", context_window: { used_percentage: 0 } });
      handlers.get("session_clear")!({}, { ...ctx, getContextUsage() { throw new Error("usage unavailable"); } });
      expect(sample()).toMatchObject({ session_id: "s1", session_name: "test" });
      expect(sample()).not.toHaveProperty("context_window");
    } finally {
      await handlers.get("session_shutdown")!({}, ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("acknowledges only complete managed input dispatched to the composer, including after cancelled switches", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-input-extension-"));
    const statePath = path.join(root, "state.json");
    let handler: (data: string) => { data?: string; consume?: boolean } | undefined;
    let editor = "";
    const ctx = { ...ompContext(), ui: {
      onTerminalInput: (fn: typeof handler) => { handler = fn; return () => { handler = undefined; }; },
      getEditorText: () => editor,
      setEditorText: (text: string) => { editor = text.replaceAll("\r\n", "\n").replaceAll("\t", "    "); },
    } };
    const handlers = load({ OPENRIG_SESSION_NAME: "test", OPENRIG_OMP_SEAT_STATE: statePath, OPENRIG_OMP_LAUNCH_ID: "launch",
      OPENRIG_HOME: root, OPENRIG_URL: "not a URL", OPENRIG_ACTIVITY_HOOK_TOKEN: "test" });
    const state = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
    const arm = (id: string, text: string) => fs.writeFileSync(`${statePath}.input.json`, JSON.stringify({
      id, launchId: "launch", expiresAt: Date.now() + 15_000, sha256: createHash("sha256").update(text).digest("hex"),
    }));
    const dispatch = (data: string, focus = true) => {
      const result = handler!(data);
      if (focus && !result?.consume) {
        const native = result?.data ?? data;
        if (native.startsWith("\x1b[200~") && native.endsWith("\x1b[201~")) editor += native.slice(6, -6);
      }
      return result;
    };
    try {
      handlers.get("session_start")!({}, ctx);
      const text = "message\n".repeat(400) + "Unicode æ🌍";
      arm("one", text);
      // tmux may have finished writing while OMP has not dispatched the completed paste yet.
      await new Promise(resolve => setTimeout(resolve, 250));
      expect(state().inputReceipt).toBeUndefined();
      dispatch(`\x1b[200~${text}\x1b[201~`);
      expect(editor).toBe("OPENRIG_INPUT_one");
      expect(state().inputReceipt).toBeUndefined();
      await new Promise(resolve => setImmediate(resolve));
      expect(editor).toBe(text);
      expect(state().inputReceipt).toMatchObject({ requestId: "one", sha256: createHash("sha256").update(text).digest("hex") });

      for (const [id, payload] of [["tabs", "a\tb"], ["crlf", "a\r\nb"], ["write-failure", "exact"]]) {
        editor = "";
        arm(id, payload);
        const tempState = statePath + "." + process.pid + ".tmp";
        if (id === "write-failure") fs.mkdirSync(tempState);
        dispatch("\x1b[200~" + payload + "\x1b[201~");
        await new Promise(resolve => setImmediate(resolve));
        if (id === "write-failure") fs.rmdirSync(tempState);
        expect(editor).toBe("");
        expect(state().inputReceipt.requestId).toBe("one");
      }
      handlers.get("session_switch")!({}, ctx);
      expect(state().inputReceipt.requestId).toBe("one");

      for (const changedEditor of [false, true]) {
        editor = "";
        arm("cancelled", "next");
        dispatch("\x1b[200~next\x1b[201~");
        if (changedEditor) editor = "human draft";
        arm("replacement", "different input");
        await new Promise(resolve => setImmediate(resolve));
        expect(editor).toBe(changedEditor ? "human draft" : "");
        expect(state().inputReceipt.requestId).toBe("one");
      }

      // A selector or another extension consuming the marker never acknowledges the detached composer.
      editor = "";
      arm("overlay", "next");
      dispatch("\x1b[200~next\x1b[201~", false);
      await new Promise(resolve => setImmediate(resolve));
      expect(editor).toBe("");
      expect(state().inputReceipt.requestId).toBe("one");
      editor = "human draft";
      expect(dispatch("\x1b[200~next\x1b[201~")).toEqual({ consume: true });
      expect(editor).toBe("human draft");

      // OMP clears terminal listeners even before a cancelled switch.
      for (const event of ["session_before_switch", "session_switch", "session_before_branch", "session_branch"]) {
        handler = undefined;
        handlers.get(event)!({}, ctx);
        editor = "";
        arm(event, "after switch");
        dispatch("\x1b[200~after switch\x1b[201~");
        await new Promise(resolve => setImmediate(resolve));
        expect(state().inputReceipt.requestId).toBe(event);
        expect(editor).toBe("after switch");
      }
    } finally {
      await handlers.get("session_shutdown")!({}, ctx);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores a subagent's session: its turn ending never reads as the seat going idle", async () => {
    const bodies: Body[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ ok: true }) };
    });
    const handlers = load({ OPENRIG_SESSION_NAME: "dev-omp@rig", OPENRIG_OMP_SEAT_STATE: `${process.env.TMPDIR ?? "/tmp"}/omp-seat-ext-${process.pid}.json`,
      OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "token" });
    const main = { ...ompContext(), agent: { kind: "main" } };
    const sub = { ...ompContext(), agent: { kind: "sub" } };
    handlers.get("session_start")!({}, main);
    handlers.get("agent_start")!({}, main);
    handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "stop" }] }, sub);
    await vi.waitFor(() => expect(bodies.some((body) => body.subtype === "accepted")).toBe(true));
    expect(bodies.filter((body) => body.hookEvent === "Stop").map((body) => body.subtype)).toEqual(["idle_heartbeat"]);
    await handlers.get("session_shutdown")!({}, main);
  });
});
