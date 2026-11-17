// OPR.0.4.6.PI1 — hermetic unit tests for the pi-runner core: submitted paste
// boundaries (including delayed multi-line sends), stdin→RPC routing
// (every block a prompt the runtime queues as a steer while busy / prefix conventions), the event→mirror and
// event→activity mapping, the get_state identity capture + sidecar, the
// durable catch-up cursor, and honest pi-exit reporting. No live pi.

import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { describe, it, expect, vi } from "vitest";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import {
  createRunnerInput, inOrder, MAX_PI_INPUT_BYTES, RunnerCore, mapPiEvent, parseRunnerArgs,
  prepareRunnerSidecar, startHeartbeatTimer,
  type RunnerIo,
} from "../src/adapters/pi-runner.js";
import { PI_RUNNER_READY_MARKER, PI_RUNNER_EXIT_MARKER, buildPiRunnerCommand, buildPiChildArgs, type PiRunnerState } from "../src/adapters/pi-runner-protocol.js";

const SESSION = "devpi-a@some-rig";
const SESSION_FILE = "/state/pi/devpi-a@some-rig/sessions/2026_0197.jsonl";

function fakeIo() {
  const rpc: Record<string, unknown>[] = [];
  const lines: string[] = [];
  const appends: string[] = [];
  const activity: Record<string, unknown>[] = [];
  const sidecars: PiRunnerState[] = [];
  const io: RunnerIo = {
    sendRpc: (cmd) => rpc.push(cmd),
    mirrorLine: (line) => lines.push(line),
    mirrorAppend: (text) => appends.push(text),
    postActivity: (payload) => activity.push(payload),
    writeSidecar: (state) => sidecars.push(state),
    now: () => "2026-07-06T10:00:00Z",
  };
  return { io, rpc, lines, appends, activity, sidecars };
}

function readyCore(f = fakeIo()) {
  const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" });
  core.start();
  core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state",
    data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
  }));
  return { core, ...f };
}

// ── Activity posts arrive in the runner's own order ─────────────────────────

describe("inOrder", () => {
  it("starts a post only after the one before it settles, even when the first is slow", async () => {
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const send = inOrder((name: string) => new Promise<string>((resolve) => {
      started.push(name);
      releases.push(() => resolve(name));
    }));
    const first = send("beat");
    const second = send("agent_start");
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["beat"]);
    releases[0]();
    await first;
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["beat", "agent_start"]);
    releases[1]();
    await expect(second).resolves.toBe("agent_start");
  });

  it("goes on to the next post when one fails", async () => {
    const send = inOrder(async (n: number) => { if (n === 1) throw new Error("down"); return n; });
    const failed = send(1);
    await expect(send(2)).resolves.toBe(2);
    await expect(failed).rejects.toThrow("down");
  });
});

describe("Pi extension UI requests", () => {
  it.each(["confirm", "select", "input", "editor"])("shows a %s request, cancels it and retains attention until the next turn", method => {
    const f = readyCore();
    f.core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "probe", method, title: "Probe", message: "Proceed?" }));
    expect(f.rpc.at(-1)).toEqual({ type: "extension_ui_response", id: "probe", cancelled: true });
    expect(f.lines.at(-1)).toContain("Probe — Proceed?");
    expect(f.lines.at(-1)).toMatch(/cancelled.*Operator action required/);
    expect(f.activity.at(-1)).toMatchObject({ runtime: "pi", hookEvent: "Notification", subtype: "permission_prompt" });
    f.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    f.core.heartbeat();
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Notification", subtype: "permission_prompt" });
    f.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    f.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(f.activity.at(-1)).toMatchObject({ runtime: "pi", hookEvent: "Stop" });
  });

  it("shows notify text without replying or raising attention", () => {
    const f = readyCore();
    const before = f.rpc.length;
    f.core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "notice", method: "notify", message: "\u001b[31mprobe notify\u001b[0m\nnext line" }));
    expect(f.lines.at(-1)).toBe("[pi-runner] probe notify next line");
    expect(f.rpc).toHaveLength(before);
    expect(f.activity).not.toContainEqual(expect.objectContaining({ hookEvent: "Notification" }));
    f.core.heartbeat();
    expect(f.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "idle_heartbeat" });
  });
});

// ── Idle heartbeat ──────────────────────────────────────────────────────────

describe("idle heartbeat", () => {
  function clocked(runtime?: "pi" | "omp") {
    const f = fakeIo();
    let t = Date.parse("2026-07-06T10:00:00Z");
    f.io.now = () => new Date(t).toISOString();
    const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" }, runtime ? { runtime } : undefined);
    core.start();
    const beats = () => f.activity.filter(a => a.subtype === "idle_heartbeat");
    return { core, f, beats, advance: (ms: number) => { t += ms; } };
  }
  const ready = (core: RunnerCore) => core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" } }));

  it("says nothing before the runner is ready", () => {
    const c = clocked();
    c.core.heartbeat();
    expect(c.beats()).toEqual([]);
  });

  it("posts idle once ready, then at most once per interval", () => {
    const c = clocked();
    ready(c.core);
    c.core.heartbeat();
    expect(c.beats()).toEqual([expect.objectContaining({ sessionName: SESSION, hookEvent: "Stop", subtype: "idle_heartbeat", runtime: "pi" })]);
    c.advance(60_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1);
    c.advance(120_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(2);
  });

  it("stays quiet mid-turn and resumes after agent_end", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.advance(10 * 60_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(180_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1);
  });

  // agent_start is not the only way a turn runs, but turn_start DOES open the streaming flag:
  // a turn opened by turn_start alone gets beats. Compaction and auto-retry report the agent
  // working without opening a turn, and a beat in those stretches would read idle mid-turn.
  it.each([
    ["a compaction", { type: "compaction_start" }],
    ["an automatic retry", { type: "auto_retry_start" }],
  ])("stays quiet during %s, and resumes after agent_end", (_name, event) => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify(event));
    c.advance(10 * 60_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(180_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1);
  });

  it("counts a Stop the turn posted as a report: the next beat is a full interval after agent_end", () => {
    const c = clocked();
    ready(c.core);
    c.core.heartbeat();
    c.advance(170_000);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(60_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1);
    c.advance(120_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(2);
  });

  it("stays quiet after the pi child exits", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiExit(1);
    c.advance(10 * 60_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
  });

  it("every Stop a Pi runner posts says how often it will beat, except its exit report", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(180_000); c.core.heartbeat();
    const stops = c.f.activity.filter(a => a.hookEvent === "Stop");
    expect(stops).toHaveLength(2);
    for (const stop of stops) expect(stop.livenessSeconds).toBe(180);
    c.core.handlePiExit(1);
    const exit = c.f.activity.find(a => a.subtype === "pi_exited");
    expect(exit).toBeDefined();
    expect(exit).not.toHaveProperty("livenessSeconds");
    expect(c.f.activity.filter(a => a.hookEvent !== "Stop")).toSatisfy((rest: Record<string, unknown>[]) => rest.every(a => !("livenessSeconds" in a)));
  });

  it("is not an OMP behaviour", () => {
    const c = clocked("omp");
    ready(c.core);
    c.core.heartbeat();
    expect(c.beats()).toEqual([]);
  });
});

// ── Streaming heartbeat: the runner contract's working beat (section 4), `active` / `liveness` ──

describe("streaming heartbeat", () => {
  function clocked(runtime?: string) {
    const f = fakeIo();
    let t = Date.parse("2026-07-06T10:00:00Z");
    f.io.now = () => new Date(t).toISOString();
    const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" }, runtime ? { runtime } : undefined);
    core.start();
    const beats = () => f.activity.filter(a => a.subtype === "liveness");
    return { core, f, beats, advance: (ms: number) => { t += ms; } };
  }
  const ready = (core: RunnerCore) => core.handlePiLine(JSON.stringify({
    type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" } }));

  // A silent inference leaves no events for the daemon; without a beat, a `running` hook older than
  // the freshness window decays to `unknown` minutes into the turn it saw start.
  it("re-asserts working behind a turn that runs silently, at most once per interval", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toEqual([expect.objectContaining({ sessionName: SESSION, hookEvent: "active", subtype: "liveness", runtime: "pi",
      turnId: "1", livenessSeconds: 30 })]);
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(2);
  });

  // A protocol: pi-rpc fork speaks Pi's protocol, so a silent turn keeps reading working, as an accepted turn.
  it("gives a pi-rpc fork the same accepted turn and working beat as Pi", () => {
    const c = clocked("omo");
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(c.f.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ hookEvent: "UserPromptSubmit", subtype: "accepted", turnId: "1", runtime: "omo" })]));
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toEqual([expect.objectContaining({ hookEvent: "active", subtype: "liveness", runtime: "omo",
      turnId: "1", livenessSeconds: 30 })]);
  });

  // CodeRabbit 2336 — some turn paths omit agent_start; turn_start alone opens the turn.
  it("keeps beating on a turn opened by turn_start alone", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "turn_start" }));
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toEqual([expect.objectContaining({ subtype: "liveness", turnId: "1" })]);
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1); // closed: idle branch resumes
  });

  it("stays quiet while real events keep arriving, then spaces the beat behind the newest one", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    for (let i = 0; i < 10; i++) { c.advance(1_000); c.core.handlePiLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash" })); }
    c.core.heartbeat();
    expect(c.beats()).toEqual([]); // the newest post (a tool call) is 1s old — well inside the interval
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats()).toHaveLength(1);
  });

  it("stops when agent_end closes the turn, and after the pi child exits", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.advance(20_000);
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.advance(20_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.core.handlePiExit(1);
    c.advance(20_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
  });

  it("says nothing before the runner is ready", () => {
    const c = clocked();
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.advance(20_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
  });

  it("is not an OMP behaviour", () => {
    const c = clocked("omp");
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.advance(20_000); c.core.heartbeat();
    expect(c.beats()).toEqual([]);
    expect(c.f.activity.filter(a => a.hookEvent === "UserPromptSubmit")).toEqual([]);
  });

  // A beat counts only for the latest accepted turn (contract section 4). Pi's runs start from the runner's prompts, so
  // each run that opens posts its accepted turn first; a prompt Pi handles without a run opens none.
  it("posts one accepted turn per run, before the run's first post, and its beats name that turn", () => {
    const c = clocked();
    ready(c.core);
    const turns = () => c.f.activity.filter(a => a.hookEvent === "UserPromptSubmit");
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.core.handlePiLine(JSON.stringify({ type: "turn_start" })); // the same run's next model call opens no turn
    expect(turns()).toEqual([expect.objectContaining({ subtype: "accepted", turnId: "1", runtime: "pi" })]);
    const opened = c.f.activity.findIndex(a => a.hookEvent === "UserPromptSubmit");
    expect(c.f.activity[opened + 1]).toMatchObject({ hookEvent: "active", subtype: "agent_start" });
    c.advance(10_000); c.core.heartbeat();
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    c.core.handlePiLine(JSON.stringify({ type: "turn_start" })); // a run opened by turn_start alone
    c.advance(10_000); c.core.heartbeat();
    expect(turns().map(a => a.turnId)).toEqual(["1", "2"]);
    expect(c.beats().map(a => a.turnId)).toEqual(["1", "2"]);
    const sequences = c.f.activity.map(a => Number(a.sequence)).filter(Number.isFinite);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  // Section 4: each prompt the runner submits is accepted with its own number. One submitted while a run is open (a
  // steer, or a follow-up) is posted as it's sent, and the open run's agent_end ends it.
  it("posts an accepted turn for each prompt or follow-up submitted while a run is open, and its beats name it", () => {
    const c = clocked();
    ready(c.core);
    const turns = () => c.f.activity.filter(a => a.hookEvent === "UserPromptSubmit").map(a => a.turnId);
    c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    c.core.handleUserBlock("look at b.txt too");
    expect(turns()).toEqual(["1", "2"]);
    c.advance(10_000); c.core.heartbeat();
    c.core.handleUserBlock("/followup then c.txt");
    c.core.handleUserBlock("/abort");
    expect(turns()).toEqual(["1", "2", "3"]);
    c.advance(10_000); c.core.heartbeat();
    expect(c.beats().map(a => a.turnId)).toEqual(["2", "3"]);
    const sequences = c.f.activity.map(a => Number(a.sequence)).filter(Number.isFinite);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it.each([false, true])("accepts custom hosted person input exactly once with a bound channel=%s", bound => {
    const f = fakeIo(), posts: Record<string, unknown>[] = [];
    f.io.postActivity = payload => { f.activity.push(payload); };
    if (bound) f.io.postRunner = async body => { posts.push(body); return true; };
    const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", runId: "custom-run" }, { runtime: "omo" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE } }));
    const turns = () => f.activity.filter(a => a.hookEvent === "UserPromptSubmit").map(a => a.turnId);
    core.handleUserBlock("idle words");
    expect(turns()).toEqual([]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    expect(turns()).toEqual(["1"]);
    core.handleUserBlock("busy words");
    core.handleUserBlock("/followup later words");
    expect(turns()).toEqual(["1", "2", "3"]);
    expect(f.rpc.filter(r => r.type === "prompt" || r.type === "follow_up").map(r => r.message))
      .toEqual(["idle words", "busy words", "later words"]);
    expect(posts.some(p => p.type === "turn" || p.nativeTurnId !== undefined || p.acceptedTurnId !== undefined)).toBe(false);
  });

  it("opens no turn for a prompt Pi handles without a run, so the idle beat goes on", () => {
    const c = clocked();
    ready(c.core);
    c.core.handlePiLine(JSON.stringify({ type: "agent_end" })); // idle, with a Stop posted
    c.core.handleUserBlock("/model some-model");
    c.advance(180_000); c.core.heartbeat();
    expect(c.f.activity.filter(a => a.hookEvent === "UserPromptSubmit")).toEqual([]);
    expect(c.f.activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "idle_heartbeat" });
  });
});

// ── The real heartbeat scheduler (CodeRabbit 2336: the first cut's tests called
// heartbeat() by hand and never drove the interval, hiding that a 15s tick landed the
// streaming beat at the edge of HOOK_AUTHORITY_WINDOW_MS). Fake timers run the actual
// startHeartbeatTimer wiring, and io.now follows the faked clock so age checks are real.

describe("heartbeat scheduler cadence", () => {
  function scheduledCore() {
    vi.useFakeTimers({ now: Date.parse("2026-07-06T10:00:00Z") });
    const f = fakeIo();
    f.io.now = () => new Date().toISOString();
    const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    const timer = startHeartbeatTimer(core, "pi");
    const beats = () => f.activity.filter(a => a.subtype === "liveness");
    return { f, core, timer, beats, advance: (ms: number) => vi.advanceTimersByTime(ms) };
  }
  const after = (c: ReturnType<typeof scheduledCore>) => { c.timer.stop(); vi.useRealTimers(); };

  it("lands the first streaming beat 5–10s after the turn opens, then every ~5s — inside the 15s authority window", () => {
    const c = scheduledCore();
    try {
      c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
      c.advance(4_000);
      expect(c.beats()).toEqual([]); // too young
      c.advance(1_000); // t+5s: the tick fires, the age gate passes
      expect(c.beats()).toHaveLength(1);
      c.advance(5_000); // t+10s
      expect(c.beats()).toHaveLength(2);
      c.advance(5_000); // t+15s: still inside the authority window per beat
      expect(c.beats()).toHaveLength(3);
    } finally { after(c); }
  });

  it("spaces the beat behind the newest real event, not just behind the turn", () => {
    const c = scheduledCore();
    try {
      c.core.handlePiLine(JSON.stringify({ type: "agent_start" }));
      c.advance(5_000);
      expect(c.beats()).toHaveLength(1); // 5s after agent_start
      c.core.handlePiLine(JSON.stringify({ type: "tool_execution_start", toolName: "bash" }));
      c.advance(4_000);
      expect(c.beats()).toHaveLength(1); // tool event only 4s old — age gate holds the beat
      c.advance(1_000); // 5s after the tool event
      expect(c.beats()).toHaveLength(2);
    } finally { after(c); }
  });

  it("the idle beat still keeps its 3-minute interval under the 5s tick", () => {
    const c = scheduledCore();
    try {
      const idles = () => c.f.activity.filter(a => a.subtype === "idle_heartbeat");
      c.advance(3 * 60_000);
      const first = idles().length; // 1: the very first tick posts (nothing older than the gate yet)
      expect(first).toBe(1);
      c.advance(4_000); // total 184s since open: 179s since the first beat — the age gate holds
      expect(idles()).toHaveLength(first);
      c.advance(1_000); // total 185s = 180s after the first beat
      expect(idles()).toHaveLength(first + 1);
    } finally { after(c); }
  });

  it("a non-pi runtime starts no timer", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" }, { runtime: "omp" });
    core.start();
    const timer = startHeartbeatTimer(core, "omp");
    timer.stop(); // noop, and nothing threw
    expect(true).toBe(true);
  });
});

// ── Actual Node line editor + framed input ──────────────────────────────────

describe("runner input", () => {
  const start = "\u001b[200~";
  const end = "\u001b[201~";
  function terminal(onSubmit?: (s: string) => void) {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false,
      setRawMode: vi.fn(function (this: { isRaw: boolean }, value: boolean) { this.isRaw = value; }) });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    const blocks: string[] = [];
    let screen = "";
    output.on("data", chunk => { screen += chunk.toString(); });
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, s => { blocks.push(s); onSubmit?.(s); });
    return { input, output, editor, blocks, screen: () => screen };
  }

  it.each([1011, 1012, 1023, 2048, 16384])("accepts %i bytes then abort and next", size => {
    const t = terminal();
    try {
      t.input.write(start + "x".repeat(size) + end + "\r");
      t.input.write("/abort\rnext\r");
      expect(t.blocks).toEqual(["x".repeat(size), "/abort", "next"]);
      expect(t.input.setRawMode).toHaveBeenCalledWith(true);
    } finally { t.editor.close(); }
    expect(t.input.isRaw).toBe(false);
  });

  it("holds delayed paste and preserves whitespace, Unicode and CRLF bytes", () => {
    vi.useFakeTimers();
    const t = terminal();
    try {
      t.input.write(start + " \n café\r\n\n日本語 ");
      vi.advanceTimersByTime(60_000);
      expect(t.blocks).toEqual([]);
      t.input.write(end);
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual([" \n café\r\n\n日本語 "]);
    } finally { t.editor.close(); vi.useRealTimers(); }
  });

  it("reassembles UTF-8 and markers across single-byte chunks", () => {
    const t = terminal();
    try {
      for (const byte of Buffer.from(start + "café\n日本語" + end)) t.input.write(Buffer.from([byte]));
      expect(t.blocks).toEqual([]);
      t.input.write("\r");
      expect(t.blocks).toEqual(["café\n日本語"]);
    } finally { t.editor.close(); }
  });

  it("retains mixed typing/paste, cursor insertion, backspace and line clear", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "paste\n café " + end + " suffix\r");
      t.input.write("ac\u001b[Db\r"); // Node's left-arrow editing.
      t.input.write("removeX\u007f\r");
      t.input.write("clear this\u0015kept\r");
      expect(t.blocks).toEqual(["prefix paste\n café  suffix", "abc", "remove", "kept"]);
    } finally { t.editor.close(); }
  });

  it.each([
    ["ac\u001b[Dbé🦊\r", "abé🦊c"],
    ["world\u001b[Hhello \r", "hello world"],
    ["do delete" + "\u001b[D".repeat(6) + "not \r", "do not delete"],
    ["abcd\u001b[D\u007fXY\r", "abXYd"],
    ["hello world\u001bbX\r", "hello Xworld"],
  ])("keeps coalesced edit keys and text ordered: %j", (input, expected) => {
    const t = terminal();
    try {
      t.input.write(input);
      expect(t.blocks).toEqual([expected]);
    } finally { t.editor.close(); }
  });

  it("keeps split escape sequences and UTF-8 ordered across every byte boundary", () => {
    const bytes = Buffer.from("ac\u001b[Dbé🦊\r");
    for (let i = 1; i < bytes.length; i++) {
      const t = terminal();
      try {
        t.input.write(bytes.subarray(0, i));
        t.input.write(bytes.subarray(i));
        expect(t.blocks).toEqual(["abé🦊c"]);
      } finally { t.editor.close(); }
    }
  });

  it("leaves unknown escape sequences to readline without holding the next input", () => {
    const t = terminal();
    try {
      t.input.write("ac\u001b[999~b\rnext\r");
      expect(t.blocks).toEqual(["acb", "next"]);
    } finally { t.editor.close(); }
  });

  it("preserves undo grouping on Node releases with correct native cursor insertion", ({ skip }) => {
    const input = new PassThrough(), output = new PassThrough(), control: string[] = [];
    output.resume();
    const native = readline.createInterface({ input, output, terminal: true });
    if (Object.prototype.hasOwnProperty.call(native, "_ttyWrite")) delete (native as any)._ttyWrite;
    native.on("line", line => control.push(line));
    input.write("ac\u001b[Db\r");
    native.close();
    if (control[0] !== "abc") { skip(); return; } // Affected Node uses grouped text in the workaround.
    const t = terminal();
    try {
      t.input.write("abc\u001f\r");
      expect(t.blocks).toEqual(["ab"]);
    } finally { t.editor.close(); }
  });

  it("keeps rapid submissions distinct, with current core routing", () => {
    const { core, rpc } = readyCore();
    const t = terminal(s => core.handleUserBlock(s));
    try {
      t.input.write(start + "first" + end + "\r");
      core.handlePiLine(JSON.stringify({ type: "agent_start" }));
      t.input.write(start + "second" + end + "\r/followup later\r/abort\r");
      expect(rpc.filter(x => ["prompt", "steer", "follow_up", "abort"].includes(String(x.type)))).toEqual([
        { type: "prompt", message: "first", streamingBehavior: "steer" }, { type: "prompt", message: "second", streamingBehavior: "steer" },
        { type: "follow_up", message: "later" }, { type: "abort" },
      ]);
    } finally { t.editor.close(); }
  });

  it("Ctrl-C cancels an unfinished paste and leaves the next input reachable", () => {
    const t = terminal();
    try {
      t.input.write(start + "unfinished\n/abort\r");
      expect(t.blocks).toEqual([]); // Text in a paste is content, not a command.
      t.input.write("\u0003");
      expect(t.blocks).toEqual(["/abort"]);
      t.input.write(start + "next" + end + "\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      expect(t.screen()).toContain("input cleared");
    } finally { t.editor.close(); }
  });

  it("rejects an oversized paste without submitting a prefix; controls recover", () => {
    const t = terminal();
    try {
      t.input.write("prefix " + start + "x".repeat(MAX_PI_INPUT_BYTES + 1));
      expect(t.screen()).toContain("input rejected");
      expect(t.blocks).toEqual([]);
      t.input.write(end + "\r/abort\rnext\r");
      expect(t.blocks).toEqual(["/abort", "next"]);
      t.input.write(start + "x".repeat(MAX_PI_INPUT_BYTES + 1) + "\u0003next again\r");
      expect(t.blocks.slice(-2)).toEqual(["/abort", "next again"]);
    } finally { t.editor.close(); }
  });

  it("does not echo framing markers or submit empty input; EOF restores raw mode", () => {
    const t = terminal();
    t.input.write("\r" + start + end + "\r");
    expect(t.blocks).toEqual([]);
    expect(t.screen()).not.toContain(start);
    expect(t.screen()).not.toContain(end);
    t.input.write("\u0004");
    expect(t.input.isRaw).toBe(false);
  });

  it("uses newline-delimited messages for nonterminal input", () => {
    const input = new PassThrough(), output = new PassThrough(), blocks: string[] = [];
    const editor = createRunnerInput(input as unknown as NodeJS.ReadStream,
      output as unknown as NodeJS.WriteStream, block => blocks.push(block));
    input.write(" \nraw one\nraw two\n");
    expect(blocks).toEqual(["raw one", "raw two"]);
    input.end(); editor.close();
  });

  it("preserves terminal line editing under TERM=dumb, while normal terminal and piped input still behave", () => {
    try {
      // 1. Under TERM=dumb with TTY streams: editing (type, backspace, retype) must be retained
      vi.stubEnv("TERM", "dumb");
      const dumbTerm = terminal();
      dumbTerm.input.write("hello worlx\u007fd\r");
      expect(dumbTerm.blocks).toEqual(["hello world"]);
      dumbTerm.editor.close();

      // 2. Under normal terminal: editing behaves as before
      vi.stubEnv("TERM", "xterm-256color");
      const normalTerm = terminal();
      normalTerm.input.write("normal worlx\u007fd\r");
      expect(normalTerm.blocks).toEqual(["normal world"]);
      normalTerm.editor.close();

      // 3. Piped nonterminal input under TERM=dumb: newline-delimited messages behave as before
      vi.stubEnv("TERM", "dumb");
      const pipedIn = new PassThrough(), pipedOut = new PassThrough(), pipedBlocks: string[] = [];
      const pipedEditor = createRunnerInput(pipedIn as unknown as NodeJS.ReadStream,
        pipedOut as unknown as NodeJS.WriteStream, block => pipedBlocks.push(block));
      pipedIn.write("piped one\npiped two\n");
      expect(pipedBlocks).toEqual(["piped one", "piped two"]);
      pipedIn.end();
      pipedEditor.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// ── stdin → RPC routing ──────────────────────────────────────────────────────

describe("RunnerCore.handleUserBlock", () => {
  // Every ordinary block is a prompt with streamingBehavior "steer": Pi and OMP queue it as a steer while they are busy
  // and run it as a prompt when they are idle, so the runtime decides, not the runner's view of the turn.
  const prompt = (message: string) => ({ type: "prompt", message, streamingBehavior: "steer" });

  it("idle → RPC prompt that the runtime queues as a steer if it turns out to be busy", () => {
    const { core, rpc, lines } = readyCore();
    core.handleUserBlock("hello pi");
    expect(rpc.at(-1)).toEqual(prompt("hello pi"));
    expect(lines.at(-1)).toBe("you ▸ hello pi");
  });

  it("streaming → the same prompt, which Pi queues as a steer (its documented mid-stream delivery)", () => {
    const { core, rpc, lines } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handleUserBlock("change course");
    expect(rpc.at(-1)).toEqual(prompt("change course"));
    expect(lines.at(-1)).toBe("you (steer) ▸ change course");
  });

  it("back to an ordinary prompt line after agent_end", () => {
    const { core, rpc, lines } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handleUserBlock("next task");
    expect(rpc.at(-1)).toEqual(prompt("next task"));
    expect(lines.at(-1)).toBe("you ▸ next task");
  });

  it("a block that arrives after a prompt but before agent_start goes as a prompt the busy runtime queues as a steer (#1932)", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("first startup block");
    core.handlePiLine(JSON.stringify({ type: "response", command: "prompt", success: true }));
    core.handleUserBlock("second startup block");
    expect(rpc.filter(x => ["prompt", "steer"].includes(String(x.type)))).toEqual([
      prompt("first startup block"), prompt("second startup block"),
    ]);
  });

  it("after a local-only command succeeds with no turn, real work still goes as a prompt and runs", () => {
    // An extension command or an input handler can consume a prompt: Pi answers success and starts no turn.
    // A steer then would only queue, with no turn to drain it.
    const { core, rpc } = readyCore();
    core.handleUserBlock("/local-command");
    core.handlePiLine(JSON.stringify({ type: "response", command: "prompt", success: true }));
    core.handleUserBlock("real work");
    core.handleUserBlock("more work");
    expect(rpc.filter(x => x.type === "steer")).toEqual([]);
    expect(rpc.at(-2)).toMatchObject({ type: "prompt", message: "real work" });
    expect(rpc.at(-1)).toMatchObject({ type: "prompt", message: "more work" });
  });

  it("/abort → RPC abort; /followup → RPC follow_up", () => {
    const { core, rpc } = readyCore();
    core.handleUserBlock("/abort");
    expect(rpc.at(-1)).toEqual({ type: "abort" });
    core.handleUserBlock("/followup after this turn");
    expect(rpc.at(-1)).toEqual({ type: "follow_up", message: "after this turn" });
  });
});

// ── identity capture + sidecar + catch-up cursor ─────────────────────────────

describe("RunnerCore identity + sidecar", () => {
  it("get_state response → READY marker + sidecar + session_identity POST with sessionFile", () => {
    const { lines, activity, sidecars } = readyCore();
    expect(lines.some((l) => l.startsWith(PI_RUNNER_READY_MARKER))).toBe(true);
    const sidecar = sidecars.at(-1)!;
    expect(sidecar).toMatchObject({ ready: true, launchId: "launch-77", sessionFile: SESSION_FILE, sessionId: "0197a2f0" });
    const identity = activity.find((a) => a.eventFamily === "session_identity")!;
    expect(identity).toMatchObject({
      runtime: "pi", sessionName: SESSION, sessionId: "0197a2f0", sessionFile: SESSION_FILE,
    });
  });

  it("start() with a catch-up cursor issues get_entries since (durable catch-up, FR-5)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION }, { catchUpSince: "entry-42" });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("events carrying entry ids advance the sidecar cursor", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start", entryId: "entry-7" }));
    expect(sidecars.at(-1)!.lastEntryId).toBe("entry-7");
  });

  it("pi exit → EXIT marker + sidecar exited + idle activity (honest, never frozen)", () => {
    const { core, lines, sidecars, activity } = readyCore();
    core.handlePiExit(1);
    expect(lines.some((l) => l.startsWith(PI_RUNNER_EXIT_MARKER))).toBe(true);
    expect(sidecars.at(-1)!.exited).toEqual({ code: 1, at: "2026-07-06T10:00:00Z" });
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "pi_exited" });
  });

  it("non-JSON pi stdout noise is mirrored verbatim, never swallowed", () => {
    const { core, lines } = readyCore();
    core.handlePiLine("some stray warning");
    expect(lines).toContain("some stray warning");
  });
});

// ── event → mirror / activity mapping ────────────────────────────────────────

// Shapes from a real `pi --mode rpc` 0.87.1 run (OpenRig's child argv) that
// streamed a reply from a local OpenAI-compatible mock. Since Pi 0.84.0,
// message_update carries only `usage` and the `assistantMessageEvent` delta.
const PI_USAGE = {
  input: 12, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 17,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const PI_REPLY = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "User wants a greeting.", thinkingSignature: "reasoning_content" },
    { type: "text", text: "Hello from the mock server." },
  ],
  api: "openai-completions", provider: "mock", model: "mock-model", usage: PI_USAGE,
  stopReason: "stop", timestamp: 1790281248272, responseId: "chatcmpl-mock",
};
const piUpdate = (assistantMessageEvent: Record<string, unknown>) =>
  ({ type: "message_update", usage: PI_USAGE, assistantMessageEvent });
const PI_REPLY_EVENTS = [
  { type: "message_start", message: { ...PI_REPLY, content: [], stopReason: "pending" } },
  piUpdate({ type: "thinking_start", contentIndex: 0 }),
  piUpdate({ type: "thinking_delta", contentIndex: 0, delta: "User wants a greeting." }),
  piUpdate({ type: "text_start", contentIndex: 1 }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: "Hello" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " from the" }),
  piUpdate({ type: "text_delta", contentIndex: 1, delta: " mock server." }),
  piUpdate({ type: "thinking_end", contentIndex: 0, content: "User wants a greeting." }),
  piUpdate({ type: "text_end", contentIndex: 1, content: "Hello from the mock server." }),
  { type: "message_end", message: PI_REPLY },
];

describe("mapPiEvent", () => {
  it("agent_start/agent_end drive streaming + running/idle activity", () => {
    expect(mapPiEvent({ type: "agent_start" })).toMatchObject({
      streaming: true, activity: { hookEvent: "active", subtype: "agent_start" },
    });
    expect(mapPiEvent({ type: "agent_end" })).toMatchObject({
      streaming: false, activity: { hookEvent: "Stop", subtype: "agent_end" },
    });
  });

  // Some turn paths omit agent_start; turn_start alone opens the turn, so it must open the
  // streaming flag too — the beat's only in-flight signal — or that path still goes blind.
  it("turn_start opens streaming for pi", () => {
    expect(mapPiEvent({ type: "turn_start" })).toMatchObject({
      streaming: true, activity: { hookEvent: "active", subtype: "turn_start" },
    });
  });

  it("pre-0.84 message_update appends only the delta, never the cumulative message", () => {
    const partial = { ...PI_REPLY, content: [{ type: "text", text: "Hello from the" }], stopReason: "pending" };
    const legacy = mapPiEvent({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: " from the", partial },
    });
    expect(legacy.mirrorAppend).toBe(" from the");
  });

  it("tool executions render compact one-line summaries + PreToolUse activity", () => {
    const start = mapPiEvent({ type: "tool_execution_start", toolName: "bash" });
    expect(start.mirrorLines[0]).toContain("bash");
    expect(start.activity).toEqual({ hookEvent: "PreToolUse", subtype: "bash" });
    const failed = mapPiEvent({ type: "tool_execution_end", toolName: "bash", isError: true });
    expect(failed.mirrorLines[0]).toContain("FAILED");
  });

  it("compaction and retry map to their honest states", () => {
    expect(mapPiEvent({ type: "compaction_start" }).activity).toEqual({ hookEvent: "active", subtype: "compaction" });
    expect(mapPiEvent({ type: "auto_retry_start" }).activity).toEqual({ hookEvent: "active", subtype: "auto_retry" });
  });

  // Pi's compaction_end (its docs/rpc.md): `aborted` when it was cancelled, otherwise `errorMessage` when it failed and no
  // summary was written (#2521). The JSON line carries no `result` then.
  it("reports a compaction's end the way Pi does: cancelled, failed with Pi's reason, or done", () => {
    const done = { type: "compaction_end", reason: "threshold", result: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 150000 }, aborted: false, willRetry: false };
    const failed = { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
      errorMessage: "Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete" };
    const cancelled = { type: "compaction_end", reason: "manual", aborted: true, willRetry: false };
    expect(mapPiEvent(done).mirrorLines).toEqual(["[pi] compaction done"]);
    expect(mapPiEvent(failed).mirrorLines).toEqual(["[pi] compaction failed: Auto-compaction failed: Summarization failed: generation hit the token cap and the summary is incomplete"]);
    expect(mapPiEvent(cancelled).mirrorLines).toEqual(["[pi] compaction cancelled"]);
    expect(mapPiEvent({ ...failed, errorMessage: "Compaction failed: \u001b[31mquota\u001b[0m\nexceeded" }).mirrorLines)
      .toEqual(["[pi] compaction failed: Compaction failed: quota exceeded"]);
    // An end that names neither a cancel nor a failure keeps reading done, as before.
    expect(mapPiEvent({ type: "compaction_end" }, "omp").mirrorLines).toEqual(["[omp] compaction done"]);
  });

  it("leaves auto_compaction_* unmapped for Pi so an idle seat never reads as running", () => {
    for (const type of ["auto_compaction_start", "auto_compaction_end"]) {
      expect(mapPiEvent({ type })).toEqual({ mirrorLines: [] });
      expect(mapPiEvent({ type }, "pi")).toEqual({ mirrorLines: [] });
    }
    expect(mapPiEvent({ type: "auto_compaction_start" }, "omp").activity).toEqual({ hookEvent: "active", subtype: "compaction" });
  });
});

describe("RunnerCore assistant reply mirror", () => {
  it("streams a Pi 0.84+ reply from text deltas and ends the line on message_end", () => {
    const f = fakeIo();
    const { core } = readyCore(f);
    let pane = "";
    f.io.mirrorLine = (line) => { pane += `${line}\n`; };
    f.io.mirrorAppend = (text) => { pane += text; };
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    expect(pane).toBe("Hello from the mock server.\n");
  });
});

describe.each(["pi", "omp"] as const)("%s terminal diagnostic fallbacks", runtime => {
  const notice = (detail: string) => `[${runtime}-runner] ERROR ${detail}`;
  const unusable = ["", " \n\t ", "\u001b[2J\u001b]0;title\u0007\u202e", null, undefined, {}, 7];
  const failure = (errorMessage: unknown, error: unknown, eventError: unknown) => ({
    type: "message_end", error: eventError,
    message: { role: "assistant", stopReason: "error", errorMessage, error },
  });

  it.each(unusable)(
    "skips unusable diagnostic %j before later message and event details", detail => {
      expect(mapPiEvent(failure(detail, "message detail", "event detail"), runtime).errorNotice)
        .toBe(notice("message detail"));
      expect(mapPiEvent(failure(detail, detail, "event detail"), runtime).errorNotice)
        .toBe(notice("event detail"));
      expect(mapPiEvent(failure(detail, detail, detail), runtime).errorNotice)
        .toBe(notice("request failed"));
    },
  );

  it.each(unusable)("skips unusable finalError %j before a later retry detail", detail => {
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: detail, error: "retry detail" }, runtime).errorNotice)
      .toBe(notice("retry detail"));
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: detail, error: detail }, runtime).errorNotice)
      .toBe(notice("request failed"));
  });

  it("keeps the first usable detail and ignores errors on successful events", () => {
    expect(mapPiEvent(failure("first detail", "message detail", "event detail"), runtime).errorNotice)
      .toBe(notice("first detail"));
    expect(mapPiEvent(failure("request failed", "message detail", "event detail"), runtime).errorNotice)
      .toBe(notice("request failed"));
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: "final detail", error: "retry detail" }, runtime).errorNotice)
      .toBe(notice("final detail"));
    expect(mapPiEvent({ type: "auto_retry_end", success: true, finalError: "", error: "retry detail" }, runtime).errorNotice)
      .toBeUndefined();
    const event = failure("", "message detail", "event detail");
    expect(mapPiEvent({ ...event, message: { ...event.message, stopReason: "stop" } }, runtime).errorNotice)
      .toBeUndefined();
    expect(mapPiEvent({ ...event, type: "turn_end" }, runtime).errorNotice)
      .toBe(runtime === "omp" ? notice("message detail") : undefined);
  });

  it("cleans and bounds the selected fallback just like the primary detail", () => {
    const detail = "\u001b[2J\u001b]0;title\u0007bad\r\nrequest\u0000\u202e" + "x".repeat(1000);
    const expected = notice(("bad request " + "x".repeat(1000)).slice(0, 400));
    expect(mapPiEvent(failure("", detail, "event detail"), runtime).errorNotice).toBe(expected);
    expect(mapPiEvent({ type: "auto_retry_end", success: false, finalError: "", error: detail }, runtime).errorNotice)
      .toBe(expected);
  });

  it("coalesces fallback failures and resets for a later turn", () => {
    const { io, lines } = fakeIo();
    const core = new RunnerCore(io, { sessionName: SESSION, nodeId: "node-1", launchId: "launch-77" }, { runtime });
    const event = failure("", "message detail", "event detail");
    const retry = { type: "auto_retry_end", success: false, finalError: "", error: "retry detail" };
    for (const next of [event, { ...event, type: "turn_end" }, retry, retry]) core.handlePiLine(JSON.stringify(next));
    expect(lines.filter(line => line.startsWith(notice("")))).toEqual([notice("message detail")]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(retry));
    expect(lines.filter(line => line.startsWith(notice("")))).toEqual([notice("message detail"), notice("retry detail")]);
  });
});

describe("RunnerCore terminal assistant failures", () => {
  const failure = (errorMessage?: unknown, content: unknown[] = []) => ({
    type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage, content },
  });
  const errors = (lines: string[]) => lines.filter(line => line.startsWith("[pi-runner] ERROR"));

  it.each([
    ["openrouter", "OPENROUTER_API_KEY"], ["zai", "ZAI_API_KEY"], ["kimi-coding", "KIMI_API_KEY"],
  ])("explains the existing %s credential route at RPC and model failure", (provider, key) => {
    const { core, lines } = readyCore();
    const detail = `No API key found for ${provider}.`;
    core.handlePiLine(JSON.stringify({ type: "response", command: "prompt", success: false, error: detail }));
    core.handlePiLine(JSON.stringify(failure(detail)));
    const notices = errors(lines);
    expect(notices).toHaveLength(2);
    for (const notice of notices) {
      expect(notice).toContain(detail);
      expect(notice).toContain(`set ${key} in the daemon environment`);
      expect(notice).toContain(`add ${key} to recovery.provider_auth_env_allowlist`);
      expect(notice).toContain(`model ${provider}/<id>`);
      expect(notice).toContain("restart the daemon and relaunch the seat");
      expect(notice).toContain("Default Pi logins are not automatically shared");
    }
  });

  it("keeps missing-credentials get_state unready while giving the same route", () => {
    const { core, lines, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: false, error: "No API key found for openrouter." }));
    expect(errors(lines)[0]).toContain("recovery.provider_auth_env_allowlist");
    expect(core.isReady()).toBe(false);
    expect(sidecars.at(-1)?.ready).toBe(false);
  });

  it("does not suggest an unsupported provider environment key", () => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure("No API key found for custom-provider.")));
    expect(errors(lines)[0]).toContain("PI_CODING_AGENT_DIR (auth.json or models.json)");
    expect(errors(lines)[0]).not.toContain("provider_auth_env_allowlist");
    expect(errors(lines)[0]).not.toContain("CUSTOM_PROVIDER_API_KEY");
  });

  it("keeps unrelated errors, OMP diagnostics and successful Pi replies unchanged", () => {
    for (const detail of ["401 Unauthorized", "No model found", "Network unavailable", "API key rejected"]) {
      expect(mapPiEvent(failure(detail)).errorNotice).toBe(`[pi-runner] ERROR ${detail}`);
    }
    const detail = "No API key found for openrouter.";
    expect(mapPiEvent(failure(detail), "omp").errorNotice).toBe(`[omp-runner] ERROR ${detail}`);
    expect(mapPiEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: detail }] } }).errorNotice).toBeUndefined();
  });

  it("shows an empty native error and ends partial text without replaying its content", () => {
    const { core, lines, appends } = readyCore();
    core.handlePiLine(JSON.stringify(failure('400 "field_not_allowed"')));
    expect(errors(lines)).toEqual(['[pi-runner] ERROR 400 "field_not_allowed"']);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "text_delta", delta: "Partial answer" })));
    core.handlePiLine(JSON.stringify(failure("connection ended", [{ type: "text", text: "Partial answer" }])));
    expect(appends).toEqual(["Partial answer"]);
    expect(lines.slice(-2)).toEqual(["", "[pi-runner] ERROR connection ended"]);
  });

  it.each([undefined, null, {}, 7, "", " \n\t "])("uses a useful fallback for invalid error detail %j", (detail) => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure(detail)));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR request failed"]);
  });

  it("extracts fallback error detail from message.error or event.error when errorMessage is missing", () => {
    const { core, lines } = readyCore();
    // Fallback to message.error
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", error: "backend stream broke" },
    }));
    // Fallback to event.error
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "message_end",
      error: "upstream service unavailable",
      message: { role: "assistant", stopReason: "error" },
    }));
    // auto_retry_end fallback to event.error
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({
      type: "auto_retry_end",
      success: false,
      error: "retry limit reached",
    }));
    expect(errors(lines)).toEqual([
      "[pi-runner] ERROR backend stream broke",
      "[pi-runner] ERROR upstream service unavailable",
      "[pi-runner] ERROR retry limit reached",
    ]);
  });

  it("ignores malformed message envelopes and does not dump thinking or tool arguments", () => {
    const { core, lines, appends } = readyCore();
    for (const message of [undefined, null, 7, [], { role: "user", stopReason: "error" }]) {
      core.handlePiLine(JSON.stringify({ type: "message_end", message }));
    }
    core.handlePiLine(JSON.stringify(piUpdate({ type: "thinking_delta", delta: "private-thought" })));
    core.handlePiLine(JSON.stringify(piUpdate({ type: "toolcall_delta", delta: "private-arguments" })));
    core.handlePiLine(JSON.stringify(failure(undefined, [
      { type: "thinking", thinking: "private-thought" }, { type: "toolCall", arguments: "private-arguments" },
    ])));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR request failed"]);
    expect(appends).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/private-thought|private-arguments/);
  });

  it("strips terminal controls, flattens newlines and bounds error notices", () => {
    const { core, lines } = readyCore();
    core.handlePiLine(JSON.stringify(failure("\u001b[2J\u001b]0;title\u0007bad\r\nrequest\u0000\u202e" + "x".repeat(1000))));
    const notice = errors(lines)[0]!;
    expect(notice).toContain("bad request");
    expect(notice).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(notice).not.toContain("title");
    expect(notice.length).toBeLessThanOrEqual(420);
  });

  it("shows standalone exhausted retry once and suppresses its duplicate terminal notice", () => {
    const { core, lines } = readyCore();
    const retryEnd = { type: "auto_retry_end", success: false, finalError: "busy" };
    core.handlePiLine(JSON.stringify(retryEnd));
    core.handlePiLine(JSON.stringify(retryEnd));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy"]);
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify(failure("busy")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false }));
    expect(errors(lines)).toEqual(["[pi-runner] ERROR busy", "[pi-runner] ERROR busy"]);
  });

  it("resets for a subsequent successful turn and a later independent failure", () => {
    const { core, lines, appends, activity, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify(failure("first failure")));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    for (const event of PI_REPLY_EVENTS) core.handlePiLine(JSON.stringify(event));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: true }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(appends.join("")).toBe("Hello from the mock server.");
    expect(errors(lines)).toEqual(["[pi-runner] ERROR first failure"]);
    expect(activity.at(-1)).toMatchObject({ hookEvent: "Stop", subtype: "agent_end" });
    expect(sidecars.at(-1)).toMatchObject({ ready: true, sessionFile: SESSION_FILE, launchId: "launch-77" });
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "auto_retry_end", success: false, finalError: "first failure" }));
    expect(errors(lines)).toHaveLength(2);
  });
});

// ── argv contract ────────────────────────────────────────────────────────────

describe("parseRunnerArgs", () => {
  const base = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--launch-id", "launch-77"];

  it("requires --launch-id (launch-attempt scoping, guard fold)", () => {
    const noLaunch = ["--session-name", SESSION, "--state-root", "/sr", "--cwd", "/work", "--approve"];
    expect(() => parseRunnerArgs(noLaunch)).toThrow(/--launch-id is required/);
  });

  it("requires an EXPLICIT trust flag (BR-5)", () => {
    expect(() => parseRunnerArgs(base)).toThrow(/explicit trust flag/);
    expect(parseRunnerArgs([...base, "--no-approve"]).trust).toBe("no-approve");
    expect(parseRunnerArgs([...base, "--approve"]).trust).toBe("approve");
  });

  it("refuses --session + --fork together", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--session", "/a.jsonl", "--fork", "/b.jsonl"]))
      .toThrow(/mutually exclusive/);
  });

  it("rejects unknown flags loudly", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--resume"])).toThrow(/unknown flag/);
  });

  it("accepts --thinking verbatim (Pi warns on a level it does not know)", () => {
    expect(parseRunnerArgs([...base, "--approve", "--thinking", "high"]).thinking).toBe("high");
    expect(parseRunnerArgs([...base, "--approve", "--thinking", "bogus"]).thinking).toBe("bogus");
    expect(parseRunnerArgs([...base, "--approve"]).thinking).toBeUndefined();
  });

  it("a --thinking VALUE that looks like a control flag is a value, not a flag", () => {
    const parsed = parseRunnerArgs([...base, "--approve", "--thinking", "--approval-mode"]);
    expect(parsed.thinking).toBe("--approval-mode");
    expect(parsed.trust).toBe("approve");
    const cmdBase = { runnerEntryPath: "/r.js", sessionName: SESSION, stateRoot: "/sr", cwd: "/work", trust: "approve" as const, launchId: "L1", runtime: "pi" as const };
    const cmd = buildPiRunnerCommand({ ...cmdBase, thinking: "none" });
    expect(parseRunnerArgs(cmd.split(" ").slice(2).map((w) => w.replace(/^'|'$/g, ""))).thinking).toBe("none");
  });

  it("still refuses genuinely incompatible trust control flags", () => {
    expect(() => parseRunnerArgs([...base, "--approve", "--approval-mode", "yolo"])).toThrow(/explicit trust flag is required/);
    expect(() => parseRunnerArgs([...base, "--runtime", "omp", "--approval-mode", "yolo", "--approve"])).toThrow(/OMP requires --approval-mode/);
    expect(() => parseRunnerArgs([...base, "--runtime", "omp", "--approve"])).toThrow(/OMP requires --approval-mode/);
  });

  it("a flag-looking value elsewhere does not count as a Pi trust flag", () => {
    const parsed = parseRunnerArgs([...base, "--runtime", "omp", "--approval-mode", "yolo", "--model", "--approve"]);
    expect(parsed.model).toBe("--approve");
    expect(parsed.trust).toBe("approve");
  });

  it("parses repeated --launch-wrapper-arg tokens with literal spaces, quotes, leading --, and empty strings", () => {
    const wrapper = ["/abs/bin/wrapper", "space arg", "quote's", "$UNEXPANDED", "--", "--approve", "--runtime", ""];
    const argv = [...base, "--no-approve", ...wrapper.flatMap((arg) => ["--launch-wrapper-arg", arg])];
    const parsed = parseRunnerArgs(argv);
    expect(parsed.launchWrapper).toEqual(wrapper);
    expect(parsed.trust).toBe("no-approve");
  });

  it.each([
    ["dangling flag without value", [...base, "--no-approve", "--launch-wrapper-arg"], /--launch-wrapper-arg requires a value/],
    ["OMP runtime with wrapper", [...base, "--runtime", "omp", "--approval-mode", "yolo", "--launch-wrapper-arg", "/bin/sh"], /only supported for the Pi runtime/],
    ["relative bare wrapper[0]", [...base, "--no-approve", "--launch-wrapper-arg", "bare-wrapper"], /absolute/],
    ["relative dot wrapper[0]", [...base, "--no-approve", "--launch-wrapper-arg", "./wrapper"], /absolute/],
    ["empty wrapper[0]", [...base, "--no-approve", "--launch-wrapper-arg", ""], /non-empty/],
    ["whitespace wrapper[0]", [...base, "--no-approve", "--launch-wrapper-arg", "   "], /non-empty/],
    ["NUL in wrapper arg", [...base, "--no-approve", "--launch-wrapper-arg", "/bin/sh", "--launch-wrapper-arg", "bad\0arg"], /NUL, CR, or LF/],
    ["LF in wrapper arg", [...base, "--no-approve", "--launch-wrapper-arg", "/bin/sh", "--launch-wrapper-arg", "bad\narg"], /NUL, CR, or LF/],
  ])("rejects malformed --launch-wrapper-arg (%s)", (_label, argv, pattern) => {
    expect(() => parseRunnerArgs(argv)).toThrow(pattern);
  });
});

describe("buildPiRunnerCommand launchWrapper", () => {
  const cmdBase = { runnerEntryPath: "/r.js", sessionName: SESSION, stateRoot: "/sr", cwd: "/work", trust: "no-approve" as const, launchId: "L1" };

  it("keeps unconfigured and empty launchWrapper byte-identical and serializes repeated --launch-wrapper-arg tokens for Pi only", () => {
    const baseline = buildPiRunnerCommand(cmdBase);
    expect(buildPiRunnerCommand({ ...cmdBase, launchWrapper: [] })).toBe(baseline);
    expect(baseline).not.toContain("--launch-wrapper-arg");

    const wrapper = ["/abs/wrapper", "space arg", "quote's", "--", "--flag", ""];
    const wrappedCmd = buildPiRunnerCommand({ ...cmdBase, launchWrapper: wrapper });
    expect(wrappedCmd).toBe(
      `${baseline} --launch-wrapper-arg '/abs/wrapper' --launch-wrapper-arg 'space arg' --launch-wrapper-arg 'quote'"'"'s' --launch-wrapper-arg '--' --launch-wrapper-arg '--flag' --launch-wrapper-arg ''`,
    );

    const ompBaseline = buildPiRunnerCommand({ ...cmdBase, runtime: "omp" });
    expect(buildPiRunnerCommand({ ...cmdBase, runtime: "omp", launchWrapper: wrapper })).toBe(ompBaseline);
  });
});

describe("--thinking in the runner command and the pi child argv", () => {
  const cmdBase = { runnerEntryPath: "/r.js", sessionName: SESSION, stateRoot: "/sr", cwd: "/work", trust: "approve" as const, launchId: "L1" };
  const childBase = { sessionsDir: "/sd", sessionName: SESSION, trust: "approve" as const };

  it("runner command carries --thinking after --model, only when non-blank, never for omp", () => {
    const cmd = buildPiRunnerCommand({ ...cmdBase, runtime: "pi", model: "zai/glm", thinking: " high " });
    expect(cmd).toContain("--model 'zai/glm' --thinking 'high'");
    expect(cmd.indexOf("--thinking")).toBeGreaterThan(cmd.indexOf("--launch-id"));
    for (const thinking of [undefined, "", "  "]) {
      expect(buildPiRunnerCommand({ ...cmdBase, runtime: "pi", thinking })).toBe(buildPiRunnerCommand({ ...cmdBase, runtime: "pi" }));
    }
    expect(buildPiRunnerCommand({ ...cmdBase, runtime: "omp", thinking: "high" })).toBe(buildPiRunnerCommand({ ...cmdBase, runtime: "omp" }));
    expect(buildPiRunnerCommand({ ...cmdBase, runtime: "omp", thinking: "high" })).not.toContain("--thinking");
  });

  it("only a value of set-effort's shape is sent: Pi's levels and unknown words go through, flag-shaped and spaced values are left out", () => {
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max", "none"]) {
      expect(buildPiRunnerCommand({ ...cmdBase, runtime: "pi", thinking })).toContain(`--thinking '${thinking}'`);
      expect(buildPiChildArgs({ ...childBase, thinking })).toEqual(expect.arrayContaining(["--thinking", thinking]));
    }
    for (const thinking of ["--cwd", "very high", "x".repeat(33)]) {
      expect(buildPiRunnerCommand({ ...cmdBase, runtime: "pi", thinking })).toBe(buildPiRunnerCommand({ ...cmdBase, runtime: "pi" }));
      expect(buildPiChildArgs({ ...childBase, thinking })).not.toContain("--thinking");
    }
  });

  it("a suffixed model passes through unchanged next to --thinking", () => {
    const cmd = buildPiRunnerCommand({ ...cmdBase, runtime: "pi", model: "openrouter/x:high", thinking: "low" });
    expect(cmd).toContain("--model 'openrouter/x:high' --thinking 'low'");
    const args = buildPiChildArgs({ ...childBase, runtime: "pi", model: "openrouter/x:high", thinking: "low" });
    expect(args).toContain("openrouter/x:high");
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 4)).toEqual(["--model", "openrouter/x:high", "--thinking", "low"]);
  });

  it("child argv: --thinking present with a value, absent when blank, never for omp", () => {
    expect(buildPiChildArgs({ ...childBase, thinking: "xhigh" })).toEqual(expect.arrayContaining(["--thinking", "xhigh"]));
    for (const thinking of [undefined, "", " "]) {
      expect(buildPiChildArgs({ ...childBase, thinking })).not.toContain("--thinking");
    }
    expect(buildPiChildArgs({ ...childBase, runtime: "omp", thinking: "high" })).toEqual(buildPiChildArgs({ ...childBase, runtime: "omp" }));
  });

  it("parseRunnerArgs round-trips the command's --thinking into the child argv", () => {
    const cmd = buildPiRunnerCommand({ ...cmdBase, runtime: "pi", thinking: "medium" });
    const parsed = parseRunnerArgs(cmd.split(" ").slice(2).map((w) => w.replace(/^'|'$/g, "")));
    expect(buildPiChildArgs({ ...childBase, thinking: parsed.thinking })).toEqual(expect.arrayContaining(["--thinking", "medium"]));
  });

  it("parseRunnerArgs round-trips the command's --command and custom runtime", () => {
    const cmd = buildPiRunnerCommand({ ...cmdBase, runtime: "omo", command: "omo", thinking: "high" });
    const argv = cmd.match(/(?:'[^']*'|[^\s]+)/g)!.slice(2).map((arg) => arg.replace(/^'|'$/g, ""));
    const parsed = parseRunnerArgs(argv);
    expect(parsed.command).toBe("omo");
    expect(parsed.runtime).toBe("omo");
    expect(parsed.thinking).toBe("high");
    expect(parsed.trust).toBe("approve");
  });

  it("custom protocol: pi-rpc harness reporting no sessionFile raises attention (runtime_error)", () => {
    const f = fakeIo();
    const core = new RunnerCore(
      f.io,
      { sessionName: "omo-worker@rig", nodeId: "omo-node", launchId: "launch-1" },
      { runtime: "omo" },
    );
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response",
      id: "pi-runner-get-state",
      data: { sessionId: "omo-session-1", sessionFile: null },
    }));

    expect(f.lines.join("\n")).toMatch(/\[omo-runner\] ERROR rpc get_state returned no session file/);
    expect(f.lines.join("\n")).not.toContain("READY");
    expect(f.sidecars).toEqual([]);
    expect(f.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hookEvent: "Notification",
        subtype: "runtime_error",
        runtime: "omo",
      }),
    ]));
  });
});

// ── FR-5: prepareRunnerSidecar + cursor seed (guard re-verdict fold) ─────────

describe("prepareRunnerSidecar — the cursor survives the runner's own reset", () => {
  function memFsOps(files: Record<string, string>) {
    return {
      files,
      readFile: (p: string) => { if (!(p in files)) throw new Error("ENOENT"); return files[p]!; },
      writeFile: (p: string, c: string) => { files[p] = c; },
      exists: (p: string) => p in files,
    };
  }
  const PATH = "/seat/runner-state.json";
  const prior = JSON.stringify({ ready: true, launchId: "old", lastEntryId: "entry-42", updatedAt: "t" });

  it("reads the prior cursor BEFORE overwriting, carries it in the pending record, returns it when resuming", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBe("entry-42");
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", lastEntryId: "entry-42", updatedAt: "t2" });
  });

  it("fresh/fork (not resuming) returns no catch-up but still preserves the record's cursor", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", false, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!).lastEntryId).toBe("entry-42");
  });

  it("absent/unreadable prior sidecar -> pending without cursor, no catch-up", () => {
    const fs = memFsOps({});
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    expect(catchUpSince).toBeUndefined();
    expect(JSON.parse(fs.files[PATH]!)).toEqual({ ready: false, launchId: "launch-9", updatedAt: "t2" });
  });

  it("COMPOSED (the guard's red-green case): prior cursor -> prepare -> RunnerCore.start sends get_entries since", () => {
    const fs = memFsOps({ [PATH]: prior });
    const { catchUpSince } = prepareRunnerSidecar(fs, PATH, "launch-9", true, () => "t2");
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince });
    core.start();
    expect(f.rpc).toContainEqual({ type: "get_entries", since: "entry-42", id: "pi-runner-catch-up" });
  });

  it("the seeded cursor survives the core's own post-get_state sidecar write", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "entry-42" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, launchId: "launch-9", lastEntryId: "entry-42" });
  });
});

// ── QA RED fold: the cursor refreshes from get_entries, not live-event guesses ─

describe("cursor refresh via get_entries (QA RED, qitem-20260707020922)", () => {
  it("agent_end triggers a cursor-refresh get_entries request", () => {
    const { core, rpc } = readyCore();
    core.handlePiLine(JSON.stringify({ type: "agent_start" }));
    core.handlePiLine(JSON.stringify({ type: "agent_end" }));
    expect(rpc).toContainEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
  });

  it("the refresh response advances lastEntryId from the LAST entry and persists it", () => {
    const { core, sidecars } = readyCore();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-cursor-refresh",
      data: { entries: [{ id: "e1" }, { id: "e2" }, { id: "e9" }] },
    }));
    expect(sidecars.at(-1)).toMatchObject({ lastEntryId: "e9", launchId: "launch-77" });
  });

  it("the catch-up response also advances the cursor (restart path)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e1" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-catch-up",
      entries: [{ id: "e2" }, { id: "e3" }],
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e3");
  });

  it("#2117: a catch-up Pi refuses for a saved cursor it doesn't hold is history sync, and the cursor is re-read from history", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "ui-old" });
    core.start();
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-catch-up", command: "get_entries", success: false, error: "Entry not found: ui-old",
    }));
    // No runner ERROR line, which the pane-marker readiness fallback would read as a runner error.
    expect(f.lines.some((line) => line.includes("[pi-runner] ERROR"))).toBe(false);
    expect(f.lines).toContainEqual(expect.stringContaining("History catch-up didn't run (Entry not found: ui-old)"));
    expect(f.rpc.at(-1)).toEqual({ type: "get_entries", id: "pi-runner-cursor-refresh" });
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, lastEntryId: "ui-old" });
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-cursor-refresh", success: true, data: { entries: [{ id: "h1" }, { id: "h7" }] },
    }));
    expect(f.sidecars.at(-1)).toMatchObject({ ready: true, lastEntryId: "h7" });
  });

  it("#2117: on Pi, an event's own id never becomes the cursor; an explicit entryId still does", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e5" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "bash_execution_update", id: "rpc-bash-1", delta: "x" }));
    core.handlePiLine(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "setStatus", statusKey: "k", statusText: "t" }));
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "0197a2f0" },
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e5");
    core.handlePiLine(JSON.stringify({ type: "agent_start", entryId: "entry-8" }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("entry-8");
  });

  it("an empty/id-less entries response leaves the cursor untouched (never regresses)", () => {
    const f = fakeIo();
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "launch-9" }, { catchUpSince: "e5" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-cursor-refresh", data: { entries: [] } }));
    core.handlePiLine(JSON.stringify({
      type: "response", id: "pi-runner-get-state",
      data: { sessionFile: SESSION_FILE, sessionId: "x" },
    }));
    expect(f.sidecars.at(-1)!.lastEntryId).toBe("e5");
  });
});

describe("managed run identity retries", () => {
  it("retries a pending run identity until Core confirms persistence, then stops", async () => {
    const f = fakeIo();
    let persisted = false;
    f.io.postActivity = vi.fn(async (payload) => { f.activity.push(payload); return persisted ? { tokenPersisted: true } : null; });
    const core = new RunnerCore(f.io, { sessionName: SESSION, launchId: "actual-run", runId: "actual-run" });
    core.start();
    core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", data: { sessionFile: SESSION_FILE, sessionId: "native" } }));
    await new Promise(resolve => setImmediate(resolve));
    const count = () => f.activity.filter(p => p.eventFamily === "session_identity").length;
    const initial = count();
    persisted = true;
    core.retrySessionIdentity();
    await new Promise(resolve => setImmediate(resolve));
    expect(count()).toBe(initial + 1);
    expect(f.activity.filter(p => p.eventFamily === "session_identity").at(-1)).toMatchObject({ runId: "actual-run" });
    core.retrySessionIdentity();
    expect(count()).toBe(initial + 1);
  });
});


describe("managed Pi input and attributed wake", () => {
  function managed(retain?: (body: Record<string, unknown>) => void | boolean | Promise<void | boolean>, withdrawNativeTurn?: RunnerIo["withdrawNativeTurn"], preflightState?: (reply: () => void) => void, postEndState = true, settleOnEnd = true) {
    const f = fakeIo(), posts: Record<string, unknown>[] = [];
    let nativeBusy = false, nativePendingCount = 0, aborted = false;
    const core = new RunnerCore({ ...f.io, withdrawNativeTurn, sendRpc: command => {
      f.rpc.push(command);
      if (command.type === "get_state" && (String(command.id).startsWith("openrig-native-idle-") || postEndState && String(command.id).startsWith("openrig-cancel-state-")))
        queueMicrotask(() => core.handlePiLine(JSON.stringify({ type: "response", id: command.id, success: true, data: { isStreaming: nativeBusy, pendingMessageCount: nativePendingCount } })));
      if (command.type === "get_state" && String(command.id).startsWith("openrig-cancel-preflight-")) {
        const reply = () => core.handlePiLine(JSON.stringify({ type: "response", id: command.id, success: true, data: { isStreaming: nativeBusy, pendingMessageCount: nativePendingCount } }));
        if (preflightState) preflightState(reply); else queueMicrotask(reply);
      }
      if (command.type === "clear_queue") queueMicrotask(() => {
        nativePendingCount = 0; core.handlePiLine(JSON.stringify({ type: "queue_update", steering: [], followUp: [] }));
        core.handlePiLine(JSON.stringify({ type: "response", id: command.id, success: true }));
      });
    }, postActivity: async body => { f.activity.push(body); return { tokenPersisted: true }; }, postRunner: async (body: Record<string, unknown>) => { posts.push(body); return await retain?.(body) !== false; } },
      { sessionName: SESSION, runId: "run" });
    core.start(); core.handlePiLine(JSON.stringify({ type: "response", id: "pi-runner-get-state", success: true, data: { sessionId: "native", isStreaming: false, pendingMessageCount: 0 } }));
    const frame = (id: string, sequence: number, kind: "input" | "wake") => ({ version: 1, requestId: id, runId: "run", sequence, kind,
      payload: kind === "wake" ? { question: id } : { text: id } });
    const event = (type: string, extra: Record<string, unknown> = {}) => {
      if (type === "queue_update") nativePendingCount = (extra.steering as string[]).length + (extra.followUp as string[]).length;
      if (type === "agent_start") nativeBusy = true; else if (type === "agent_end") nativeBusy = false;
      if (type === "message_end") aborted = (extra.message as { stopReason?: string })?.stopReason === "aborted";
      core.handlePiLine(JSON.stringify({ type, ...extra }));
      if (type === "agent_end" && settleOnEnd) core.handlePiLine(JSON.stringify({ type: "agent_settled", aborted }));
    };
    const response = (id: string, success = true) => event("response", { id: `openrig-native-${id}`, command: "prompt", success, data: { disposition: "started" } });
    return { ...f, posts, core, frame, event, response };
  }
  it.each(["plain", "followup"].flatMap(mode => ["before-end", "after-end"].map(phase => [mode, phase])))("submitted cancellation holds a %s person prompt (%s) until native settlement and starts F once", async (mode, phase) => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, true, false); f.core.handleUserBlock("E");
    const e = f.rpc.find(command => command.message === "E")!; f.event("response", { id: e.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "settle-E", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    f.event("agent_settled", { aborted: true }); // An earlier scope's event cannot settle still-running E.
    if (phase === "before-end") f.core.handleUserBlock(mode === "plain" ? "person F" : "/followup person F");
    f.event("message_end", { message: { role: "assistant", stopReason: "aborted" } }); f.event("agent_end");
    if (phase === "after-end") f.core.handleUserBlock(mode === "plain" ? "person F" : "/followup person F");
    expect(f.rpc.filter(command => command.message === "person F")).toEqual([]);
    expect(f.posts.filter(post => post.type === "result" && post.requestId === "settle-E")).toEqual([]);
    f.event("agent_settled", { aborted: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "settle-E", result: expect.objectContaining({ outcome: "cancelled", confirmed: true }) }));
    f.event("agent_settled", { aborted: true }); expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
  });
  it("retained native input reports only known request IDs and waiting F at settlement, never copied words", async () => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, true, false); f.core.handleUserBlock("E");
    f.event("response", { id: f.rpc.find(command => command.message === "E")!.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    await f.core.acceptRunnerRequest(f.frame("retained words", 1, "input")); f.event("response", { id: "openrig-native-retained words", success: true, data: { disposition: "queued" } });
    f.event("queue_update", { steering: ["retained words"], followUp: [] });
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "retained-E", sequence: 2, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); await f.core.acceptRunnerRequest(f.frame("waiting F", 3, "wake"));
    f.event("message_end", { message: { role: "assistant", stopReason: "aborted" } }); f.event("agent_end"); f.event("agent_settled", { aborted: true });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "retained-E", result: expect.objectContaining({ outcome: "requested", confirmed: false,
      continuation: { inputRequestIds: ["retained words"], pendingRequestIds: ["waiting F"], unmatchedCount: 0 } }) }));
  });
  it.each(["intervening start", "start before end", "exit"])("settlement wait preserves later work when %s supersedes the captured cancelled run", async mode => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, true, false); f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "superseded-settle", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); if (mode !== "start before end") f.event("agent_end"); f.core.handleUserBlock("person held");
    if (mode === "exit") f.core.handlePiExit(7); else { f.event("agent_start"); f.event("agent_settled", { aborted: true }); }
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "superseded-settle", result: expect.objectContaining({ outcome: "requested", confirmed: false }) }));
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
  });
  it.each(["rejected", "handled-wake"])("held person followup dispatches after %s without another native event", async mode => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("first", 1, mode === "rejected" ? "input" : "wake"));
    await new Promise(resolve => setImmediate(resolve)); f.core.handleUserBlock("/followup person F");
    f.event("response", { id: "openrig-native-first", success: mode !== "rejected", data: { disposition: "handled" } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
  });
  it.each(["missing", "negative", "positive", "delayed", "normal"])("native settlement releases without a post-end probe or %s abort ACK", async ack => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, false);
    f.core.handleUserBlock("E");
    f.event("response", { id: f.rpc.find(command => command.message === "E")!.id, success: true, data: { disposition: "started" } });
    f.event("agent_start");
    const cancel = { version: 1, runId: "run", requestId: "cancel-E", sequence: 1, kind: "cancel" as const, payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(cancel); await new Promise(resolve => setImmediate(resolve));
    await f.core.acceptRunnerRequest(f.frame("managed F", 2, "input"));
    if (["negative", "positive", "normal"].includes(ack)) f.event("response", { id: "openrig-cancel-cancel-E", success: ack !== "negative" });
    expect(f.rpc.filter(command => command.message === "managed F")).toHaveLength(0);
    f.event("message_end", { message: { role: "assistant", stopReason: ack === "normal" ? "stop" : "aborted" } }); f.event("agent_end");
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "managed F")).toHaveLength(1);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "cancel-E", result: expect.objectContaining({ outcome: ack !== "normal" ? "cancelled" : "requested", confirmed: ack !== "normal" }) }));
    if (ack === "delayed") { f.event("response", { id: "openrig-cancel-cancel-E", success: true }); await new Promise(resolve => setImmediate(resolve)); }
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "clear_queue")).toEqual([]);
  });
  it.each([false, true])("bare settlement releases submitted cancellation without inventing aborted evidence (prior proof=%s)", async priorProof => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, true, false);
    f.core.handleUserBlock("E"); f.event("response", { id: f.rpc.find(command => command.message === "E")!.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "bare-E", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    f.event("message_end", { message: { role: "assistant", stopReason: priorProof ? "aborted" : "stop" } }); f.event("agent_end"); f.core.handleUserBlock("person F");
    expect(f.rpc.filter(command => command.message === "person F")).toEqual([]);
    f.event("agent_settled"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "bare-E", result: expect.objectContaining({ outcome: priorProof ? "cancelled" : "requested", confirmed: priorProof }) }));
    f.event("agent_settled"); expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1); expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
  });
  it.each((["withdrawal", "preflight", "ACK"] as const).flatMap(phase => ["before", "after"].flatMap(timing => [true, false].map(success => [phase, timing, success] as const))))
    ("prewrite %s callback %s bare settlement (success=%s) never releases person input early or aborts F", async (phase, timing, success) => {
    let release!: () => void, failPreflight!: () => void; let withdrawals = 0;
    const f = managed(phase === "ACK" ? body => body.type === "ack" && body.requestId === "waiting-E" ? new Promise<boolean>(resolve => { release = () => resolve(success); }) : true : undefined,
      phase === "withdrawal" ? () => { withdrawals++; return new Promise(resolve => { release = () => resolve(success ? { confirmed: true } : null); }); }
        : async () => { withdrawals++; return { confirmed: true }; },
      phase === "preflight" ? resume => { release = success ? resume : () => failPreflight(); } : undefined, true, false);
    failPreflight = () => f.event("response", { id: "openrig-cancel-preflight-waiting-E", success: false });
    f.core.handleUserBlock("E"); f.event("response", { id: f.rpc.find(command => command.message === "E")!.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    const target = { runId: "run", nativeTurnId: "pi-invocation-1" };
    const pending = f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "waiting-E", sequence: 1, kind: "cancel", payload: { target } });
    await new Promise(resolve => setImmediate(resolve)); await f.core.acceptRunnerRequest(f.frame("managed F", 2, "input"));
    f.event("agent_end"); f.core.handleUserBlock("person F");
    expect(f.rpc.filter(command => command.message === "person F" || command.message === "managed F")).toEqual([]);
    expect(f.core.recheckNativeCancellation(target)).toBe(true);
    if (timing === "before") { release(); await pending; await new Promise(resolve => setImmediate(resolve)); }
    expect(f.rpc.filter(command => command.message === "person F")).toEqual([]);
    expect(f.posts.filter(post => post.type === "result" && post.requestId === "waiting-E")).toEqual([]);
    f.event("agent_settled"); if (timing === "after") release(); await pending; await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
    const results = f.posts.filter(post => post.type === "result" && post.requestId === "waiting-E");
    if (phase === "ACK" && !success) expect(results).toEqual([]);
    else { expect(results).toHaveLength(1); expect(results[0]).toMatchObject({ result: { outcome: "not-this-turn", confirmed: false } }); }
    expect(withdrawals).toBe(phase === "ACK" ? 0 : 1);
    f.event("response", { id: f.rpc.find(command => command.message === "person F")!.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    await new Promise(resolve => setImmediate(resolve)); expect(f.rpc.filter(command => command.message === "managed F")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
  });
  it.each(["rejected withdrawal", "retry loop", "new opening"])("ended preparation keeps its settlement boundary across %s", async mode => {
    let reject!: (error: Error) => void, resolve!: (value: { confirmed: boolean }) => void; let calls = 0;
    const f = managed(undefined, () => { calls++; return mode === "retry loop" ? Promise.resolve({ confirmed: false }) : new Promise((done, fail) => { resolve = done; reject = fail; }); }, undefined, true, false);
    f.core.handleUserBlock("E"); f.event("response", { id: f.rpc.find(command => command.message === "E")!.id, success: true, data: { disposition: "started" } }); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "late-prepare", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(done => setImmediate(done)); f.event("agent_end"); f.core.handleUserBlock("person F");
    if (mode === "rejected withdrawal") reject(new Error("late transport failure"));
    if (mode === "retry loop") await new Promise(done => setTimeout(done, 300));
    await new Promise(done => setImmediate(done)); expect(f.rpc.filter(command => command.message === "person F")).toEqual([]); expect(calls).toBe(1);
    if (mode === "new opening") { f.event("agent_start"); resolve({ confirmed: true }); }
    else f.event("agent_settled");
    await new Promise(done => setImmediate(done));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "late-prepare", result: expect.objectContaining({ outcome: "not-this-turn", confirmed: false }) }));
    if (mode !== "new opening") expect(f.rpc.filter(command => command.message === "person F")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
  });
  it("failed local preparation is rejected as not applied without disabling managed capability", async () => {
    const f = managed(undefined, async () => null); f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "failed", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", requestId: "failed", result: { kind: "cancel", reason: "preparation_failed", applied: false } }));
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]); expect(f.core.nativeChannelCapabilities().input).toBe(true);
  });
  it.each([false, true])("a rejected preparation promise retires only its captured operation (stale=%s)", async stale => {
    let rejectFirst!: (error: Error) => void; let releaseSecond!: (value: { confirmed: boolean }) => void; let calls = 0;
    const f = managed(undefined, () => ++calls === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : new Promise(resolve => { releaseSecond = resolve; }));
    f.core.handleUserBlock("E"); f.event("agent_start");
    const frame = { version: 1, runId: "run", requestId: "rejected-first", sequence: 1, kind: "cancel" as const, payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(frame); await new Promise(resolve => setImmediate(resolve));
    if (stale) f.core.handleUserBlock("person supersedes first");
    else rejectFirst(new Error("failed transport"));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", requestId: "rejected-first", result: expect.objectContaining({ applied: false }) }));
    await f.core.acceptRunnerRequest({ ...frame, requestId: "second", sequence: 2 }); await new Promise(resolve => setImmediate(resolve));
    if (stale) { rejectFirst(new Error("late failure")); await new Promise(resolve => setImmediate(resolve)); }
    releaseSecond({ confirmed: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
  });
  it.each([false, true])("malformed native queue evidence preserves uncertainty (known pending first=%s)", async knownPending => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, false);
    f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "queue-evidence", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    if (knownPending) f.event("queue_update", { steering: ["known words"], followUp: [] });
    f.event("queue_update", { steering: "malformed", followUp: [] });
    f.event("response", { id: "openrig-cancel-queue-evidence", success: true });
    f.event("message_end", { message: { role: "assistant", stopReason: "aborted" } }); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "queue-evidence", result: expect.objectContaining({ outcome: "requested", confirmed: false }) }));
    expect(f.rpc.filter(command => command.type === "clear_queue")).toEqual([]);
  });
  it("person input supersedes only local prewrite preparation, invalidates stale state and retains its accepted association", async () => {
    let reply!: () => void;
    const f = managed(undefined, async () => ({ confirmed: true }), resume => { reply = resume; });
    f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "superseded", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); f.core.handleUserBlock("person steer"); reply(); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "person steer")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", requestId: "superseded", result: expect.objectContaining({ applied: false }) }));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "turn", acceptedTurnIds: ["1", "2"] }));
  });
  it("known person's queued steer is never deleted and does not quarantine the run", async () => {
    const f = managed(undefined, async () => ({ confirmed: true })); f.core.handleUserBlock("E"); f.event("agent_start");
    f.core.handleUserBlock("person steer"); f.event("queue_update", { steering: ["person steer"], followUp: [] });
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "person-queue", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => ["abort", "clear_queue"].includes(String(command.type)))).toEqual([]);
    expect(f.core.nativeChannelCapabilities().input).toBe(true);
  });
  it("a second local cancellation is rejected busy without disturbing the first preparation", async () => {
    let release!: (value: { confirmed: boolean }) => void;
    const f = managed(undefined, () => new Promise(resolve => { release = resolve; })); f.core.handleUserBlock("E"); f.event("agent_start");
    const cancel = { version: 1, runId: "run", requestId: "R1", sequence: 1, kind: "cancel" as const, payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(cancel); await new Promise(resolve => setImmediate(resolve));
    await f.core.acceptRunnerRequest({ ...cancel, requestId: "R2", sequence: 2 }); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", requestId: "R2", result: { kind: "cancel", reason: "cancellation_in_progress", applied: false } }));
    release({ confirmed: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
  });
  it("a request-local ACK refusal releases a later accepted request", async () => {
    let release!: (accepted: boolean) => void;
    const f = managed(body => body.type === "ack" && body.requestId === "first"
      ? new Promise<boolean>(resolve => { release = resolve; }) : Promise.resolve(true));
    const first = f.core.acceptRunnerRequest(f.frame("first", 1, "input"));
    await f.core.acceptRunnerRequest(f.frame("later", 2, "input"));
    expect(f.rpc.filter(command => command.type === "prompt")).toHaveLength(0);
    release(false); await first;
    expect(f.rpc.filter(command => command.type === "prompt")).toEqual([expect.objectContaining({ message: "later" })]);
  });
  it("a permanently unavailable run holds later managed work while person input remains usable", async () => {
    let release!: (accepted: boolean) => void;
    const f = managed(body => body.type === "ack" && body.requestId === "first"
      ? new Promise<boolean>(resolve => { release = resolve; }) : Promise.resolve(true));
    const first = f.core.acceptRunnerRequest(f.frame("first", 1, "input"));
    await f.core.acceptRunnerRequest(f.frame("later", 2, "input"));
    f.core.quarantineManagedChannel(); release(false); await first;
    f.core.handleUserBlock("person still usable");
    expect(f.rpc.filter(command => command.type === "prompt")).toEqual([expect.objectContaining({ message: "person still usable" })]);
    expect(f.core.nativeChannelCapabilities()).toEqual({ input: false, wake: false, cancel: false });
  });
  it("reporting-authority loss preserves in-flight native custody and its terminal receipt", async () => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.response("question"); f.event("agent_start"); f.core.quarantineManagedChannel();
    f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "existing work" }], stopReason: "stop" } });
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ answer: "existing work", completion: "completed" }) }));
    expect(f.rpc.filter(command => command.message === "question")).toHaveLength(1);
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(0);
  });
  it("a rejected person preflight reports the existing diagnostic once and releases queued work", async () => {
    const f = managed(); f.core.handleUserBlock("person startup");
    await f.core.acceptRunnerRequest(f.frame("later", 1, "input"));
    const person = f.rpc.find(command => command.message === "person startup")!;
    f.event("response", { id: person.id, success: false, error: "person prompt failed" });
    expect(f.lines.filter(line => line.includes("ERROR rpc: person prompt failed"))).toHaveLength(1);
    expect(f.rpc.filter(command => command.message === "later")).toHaveLength(1);
  });
  it.each(["handled", "queued", "started", "unknown"])("input disposition %s releases pending start only when explicitly handled", async disposition => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("first", 1, "input"));
    await f.core.acceptRunnerRequest(f.frame("later", 2, "input"));
    f.event("response", { id: "openrig-native-first", success: true, data: { disposition } });
    expect(f.rpc.filter(command => command.message === "later")).toHaveLength(disposition === "handled" ? 1 : 0);
  });
  it("permanent reporting refusal releases only an unsubmitted cancellation preparation and keeps person controls usable", async () => {
    let release!: (withdrawal: { confirmed: boolean }) => void;
    const f = managed(undefined, () => new Promise(resolve => { release = resolve; }));
    f.core.handleUserBlock("E"); f.event("agent_start");
    const cancel = { version: 1, runId: "run", requestId: "revoked-preparation", sequence: 1, kind: "cancel" as const,
      payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(cancel); await new Promise(resolve => setImmediate(resolve));
    f.core.quarantineManagedChannel(); f.core.handleUserBlock("person after refusal");
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person after refusal" }));
    release({ confirmed: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
    await f.core.acceptRunnerRequest(cancel);
    expect(f.posts.filter(post => post.type === "ack" && post.requestId === cancel.requestId)).toHaveLength(1);
    expect(f.posts.some(post => (post.result as { outcome?: string })?.outcome === "cancelled")).toBe(false);
  });
  it.each([false, true])("named cancel releases successors on matching native settlement without waiting for abort acknowledgement (reporting unavailable=%s)", async unavailable => {
    const f = managed(undefined, async () => ({ confirmed: true }), undefined, true, false);
    f.core.handleUserBlock("start"); f.event("agent_start");
    const cancel = { version: 1 as const, runId: "run", requestId: "cancel-E", sequence: 1, kind: "cancel" as const,
      payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(cancel); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual({ type: "abort", id: "openrig-cancel-cancel-E" });
    if (unavailable) f.core.quarantineManagedChannel();
    f.core.handleUserBlock("/followup successor");
    f.event("message_end", { message: { role: "assistant", stopReason: "aborted" } }); f.event("agent_end");
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.some(command => command.message === "successor")).toBe(false);
    expect(f.posts.filter(post => post.type === "result" && post.requestId === "cancel-E")).toEqual([]);
    f.event("agent_settled", { aborted: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.some(command => command.message === "successor")).toBe(true);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "cancel-E", result: expect.objectContaining({ outcome: "cancelled", confirmed: true }) }));
    f.event("response", { id: "openrig-cancel-cancel-E", success: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "cancel-E", result: expect.objectContaining({ outcome: "cancelled" }) }));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "successor" }));
    await f.core.acceptRunnerRequest(cancel);
    expect(f.rpc.filter(command => command.type === "abort")).toHaveLength(1);
  });
  it.each(["steering", "followUp"] as const)("never writes global abort or clear for an unknown native %s queue and releases manual input", async family => {
    const f = managed(undefined, async () => ({ confirmed: true })); f.core.handleUserBlock("owned E"); f.event("agent_start");
    f.event("queue_update", { steering: family === "steering" ? ["UNKNOWN NATIVE"] : [], followUp: family === "followUp" ? ["UNKNOWN NATIVE"] : [] });
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "unsafe", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => ["abort", "clear_queue"].includes(String(command.type)))).toEqual([]);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", result: expect.objectContaining({ applied: false, reason: "native_queue_ownership_unknown" }) }));
    f.core.handleUserBlock("/followup person F"); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person F" }));
    await f.core.acceptRunnerRequest(f.frame("managed F", 2, "input"));
    expect(f.core.nativeChannelCapabilities().input).toBe(true);
  });
  it("rechecks exact E after correlated pre-abort state await before writing a global abort", async () => {
    let reply!: () => void;
    const f = managed(undefined, async () => ({ confirmed: true }), resume => { reply = resume; });
    f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "preflight", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); expect(reply).toBeTypeOf("function");
    f.event("agent_end"); f.event("agent_start");
    // A cached positive state response must not authorize aborting the now-current F.
    f.event("response", { id: "openrig-cancel-preflight-preflight", success: true, data: { isStreaming: true, pendingMessageCount: 0 } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ outcome: "not-this-turn" }) }));
  });
  it("a correlated pre-abort state response with unknown queues retires preparation without native writes", async () => {
    let reply!: () => void;
    const f = managed(undefined, async () => ({ confirmed: true }), resume => { reply = resume; });
    f.core.handleUserBlock("E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "state-unknown", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); expect(reply).toBeTypeOf("function");
    f.event("queue_update", { steering: [], followUp: ["UNKNOWN FUTURE"] });
    reply(); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => ["abort", "clear_queue"].includes(String(command.type)))).toEqual([]);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "rejected", result: expect.objectContaining({ applied: false }) }));
    f.core.handleUserBlock("/followup person F"); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person F" }));
  });
  it("a late duplicate of refused A cannot clear B's post-write successor fence", async () => {
    const f = managed(body => body.type === "ack" && body.requestId === "A" ? false : undefined, async () => ({ confirmed: true }));
    f.core.handleUserBlock("E"); f.event("agent_start");
    const a = { version: 1 as const, runId: "run", requestId: "A", sequence: 1, kind: "cancel" as const, payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } };
    await f.core.acceptRunnerRequest(a); f.event("agent_end"); f.core.handleUserBlock("F"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ ...a, requestId: "B", sequence: 2, payload: { target: { runId: "run", nativeTurnId: "pi-invocation-2" } } });
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual({ type: "abort", id: "openrig-cancel-B" });
    await f.core.acceptRunnerRequest(a); f.core.handleUserBlock("/followup person G"); f.event("agent_end");
    await new Promise(resolve => setImmediate(resolve)); expect(f.rpc.some(command => command.message === "person G")).toBe(true);
    f.event("response", { id: "openrig-cancel-B", success: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person G" }));
  });
  it("permanent cancel acknowledgement refusal releases only pre-effect preparation and leaves person input usable", async () => {
    let withdrawals = 0;
    const f = managed(body => body.type === "ack" ? false : undefined, async () => { withdrawals++; return { confirmed: true }; });
    f.core.handleUserBlock("owned E"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "refused", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    f.core.handleUserBlock("/followup person F"); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person F" }));
    expect(f.rpc.filter(command => ["abort", "clear_queue"].includes(String(command.type)))).toEqual([]);
    expect(withdrawals).toBe(0);
  });
  it.each([true, false])("preserves queued words and releases successors without clearing native queues (personOwned=%s)", async owned => {
    const f = managed(undefined, async () => ({ confirmed: true })); f.core.handleUserBlock("start"); f.event("agent_start");
    if (owned) f.core.handleUserBlock("owned steer");
    if (owned) f.event("queue_update", { steering: ["owned steer"], followUp: [] });
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "residual", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    if (!owned) f.event("queue_update", { steering: ["unknown extension"], followUp: [] });
    f.core.handleUserBlock("/followup future");
    f.event("message_end", { message: { role: "assistant", stopReason: "aborted" } }); f.event("agent_end");
    f.event("response", { id: "openrig-cancel-residual", success: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.some(command => command.type === "clear_queue")).toBe(false);
    expect(f.rpc.some(command => command.message === "future")).toBe(true);
    expect(f.posts.some(post => post.type === "result" && (post.result as { outcome?: string })?.outcome === "cancelled")).toBe(false);
  });
  it("normal native completion after abort submission stays requested and never becomes cancelled", async () => {
    const f = managed(undefined, async () => ({ confirmed: true })); f.core.handleUserBlock("start"); f.event("agent_start");
    await f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "normal", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve));
    f.event("message_end", { message: { role: "assistant", stopReason: "stop" } }); f.event("agent_end");
    f.event("response", { id: "openrig-cancel-normal", success: true }); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ outcome: "requested", confirmed: false, detail: "native_end_without_cancellation_proof" }) }));
    expect(f.posts.some(post => (post.result as { outcome?: string })?.outcome === "cancelled")).toBe(false);
  });
  it("a target ending during permission withdrawal never sends native abort", async () => {
    let release!: () => void;
    const f = managed(undefined, () => new Promise(resolve => { release = () => resolve({ confirmed: true }); }));
    f.core.handleUserBlock("start"); f.event("agent_start");
    const accepting = f.core.acceptRunnerRequest({ version: 1, runId: "run", requestId: "late", sequence: 1, kind: "cancel", payload: { target: { runId: "run", nativeTurnId: "pi-invocation-1" } } });
    await new Promise(resolve => setImmediate(resolve)); f.event("agent_end"); release(); await accepting; await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.type === "abort")).toEqual([]);
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ outcome: "not-this-turn" }) }));
  });
  function retainedInput() {
    const db = createDb(); migrate(db, [outboxEntriesSchema]); db.exec("ALTER TABLE outbox_entries ADD COLUMN guard_delivery TEXT");
    const outbox = new OutboxHandler(db);
    const f = managed(body => {
      if (!body.requestId) return;
      outbox.updateRunner("node", "run", String(body.requestId), Number(body.sequence),
        body.type === "ack" ? "accepted" : body.type === "result" ? "completed" : body.type as "submitted" | "rejected",
        { ...(body.nativeTurnId ? { nativeTurnId: String(body.nativeTurnId) } : {}),
          ...(body.acceptedTurnId ? { acceptedTurnId: String(body.acceptedTurnId) } : {}),
          ...(body.result ? { result: body.result as Record<string, unknown> } : {}) });
    });
    const frame = (id: string) => {
      const receipt = outbox.admitRunner({ outboxId: id, nodeId: "node", runId: "run", kind: "input", inputRoute: "native",
        payload: { text: id }, senderSession: "person", destinationSession: SESSION, body: id });
      outbox.updateRunner("node", "run", id, receipt.sequence, "offered");
      return f.frame(id, receipt.sequence, "input");
    };
    return { ...f, db, outbox, frame };
  }
  it("retains the actual invocation mapping when prompt acceptance precedes agent_start", async () => {
    const f = retainedInput();
    try {
      const first = f.frame("first");
      await f.core.acceptRunnerRequest({ ...first, runId: "other-run" });
      expect(f.rpc.filter(command => command.message === "first")).toEqual([]);
      expect(f.outbox.runnerReceipt("first")).toMatchObject({ stage: "offered" });
      await f.core.acceptRunnerRequest(first); f.response("first");
      await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("first")).toMatchObject({ stage: "submitted" });
      expect(f.posts.filter(post => post.type === "result")).toEqual([]);
      f.event("agent_start"); await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("first")).toMatchObject({ stage: "completed", nativeTurnId: "pi-invocation-1", acceptedTurnId: "1", result: { kind: "input", accepted: true } });
      // Both busy steers keep their own accepted ordinal while sharing that execution epoch.
      for (const id of ["second", "third"]) { await f.core.acceptRunnerRequest(f.frame(id)); f.response(id); }
      await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("second")).toMatchObject({ nativeTurnId: "pi-invocation-1", acceptedTurnId: "2" });
      expect(f.outbox.runnerReceipt("third")).toMatchObject({ nativeTurnId: "pi-invocation-1", acceptedTurnId: "3" });
    } finally { f.db.close(); }
  });
  it.each(["handled", "agentInvokedFalse"])("local-only %s completes without inheriting a later unrelated invocation", async mode => {
    const f = retainedInput();
    try {
      await f.core.acceptRunnerRequest(f.frame("local"));
      f.event("response", { id: "openrig-native-local", success: true, data: mode === "handled" ? { disposition: "handled" } : { agentInvoked: false } });
      await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("local")).toMatchObject({ stage: "completed", result: { accepted: true } });
      expect(f.outbox.runnerReceipt("local")?.nativeTurnId).toBeUndefined();
      await f.core.acceptRunnerRequest(f.frame("next"));
      expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "next" }));
      f.response("next"); f.event("agent_start"); await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("next")).toMatchObject({ nativeTurnId: "pi-invocation-1" });
      expect(f.posts.filter(post => post.requestId === "local").some(post => post.nativeTurnId !== undefined)).toBe(false);
    } finally { f.db.close(); }
  });
  it("maps normally when agent_start precedes the prompt response and never completes a start that never arrives", async () => {
    const f = retainedInput();
    try {
      await f.core.acceptRunnerRequest(f.frame("first")); f.event("agent_start"); f.response("first");
      await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("first")).toMatchObject({ stage: "completed", nativeTurnId: "pi-invocation-1", acceptedTurnId: "1" });
      f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
      await f.core.acceptRunnerRequest(f.frame("never opens")); f.response("never opens");
      await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("never opens")).toMatchObject({ stage: "submitted" });
      f.core.handlePiExit(1); await new Promise(resolve => setImmediate(resolve));
      expect(f.outbox.runnerReceipt("never opens")).toMatchObject({ stage: "submitted" });
      expect(f.outbox.runnerReceipt("never opens")?.nativeTurnId).toBeUndefined();
      expect(f.rpc.filter(p => p.message === "never opens")).toHaveLength(1);
    } finally { f.db.close(); }
  });
  it("reports one native invocation for two steers and inner model turns", async () => {
    const f = managed(); f.core.handleUserBlock("start"); f.event("agent_start");
    f.core.handleUserBlock("steer one"); f.event("turn_start"); f.core.handleUserBlock("steer two");
    await new Promise(resolve => setImmediate(resolve));
    const opened = f.posts.filter(p => p.type === "turn" && p.state === "opened");
    expect(opened.at(-1)).toMatchObject({ runId: "run", nativeTurnId: "pi-invocation-1", acceptedTurnIds: ["1", "2", "3"] });
    expect(new Set(opened.map(p => p.nativeTurnId)).size).toBe(1);
    f.event("agent_end"); f.core.handleUserBlock("next"); f.event("agent_start");
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "turn", state: "closed", nativeTurnId: "pi-invocation-1" }));
    expect(f.posts.at(-1)).toMatchObject({ type: "turn", state: "opened", nativeTurnId: "pi-invocation-2" });
  });
  it("keeps person input usable across preparation while managed successors wait for exact target recheck", async () => {
    const f = managed(); f.core.handleUserBlock("start"); f.event("agent_start");
    expect(f.core.prepareNativeCancellation({ runId: "run", nativeTurnId: "pi-invocation-1" })).toBe(true);
    f.core.handleUserBlock("/followup future"); f.core.handleUserBlock("person future");
    await f.core.acceptRunnerRequest(f.frame("managed future", 1, "input"));
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ message: "person future" }));
    expect(f.rpc.filter(p => p.message === "managed future")).toEqual([]);
    expect(f.core.recheckNativeCancellation({ runId: "run", nativeTurnId: "pi-invocation-1" })).toBe(false);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "future" }));
    expect(f.rpc.filter(p => p.type === "abort")).toEqual([]);
    expect(f.core.nativeChannelCapabilities().cancel).toBe(false);
  });
  it("holds native followups in the runner and refuses accepted-ordinal or stale cancellation targets", () => {
    const f = managed(); f.core.handleUserBlock("start"); f.event("agent_start");
    f.core.handleUserBlock("/followup next");
    expect(f.rpc.filter(p => p.type === "follow_up")).toEqual([]);
    expect(f.core.prepareNativeCancellation({ runId: "run", nativeTurnId: "1" })).toBe(false);
    expect(f.core.prepareNativeCancellation({ runId: "other", nativeTurnId: "pi-invocation-1" })).toBe(false);
  });
  it("a person/startup preflight cannot race a dedicated wake before agent_start", async () => {
    const f = managed(); f.core.handleUserBlock("person startup");
    await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    expect(f.rpc.filter(command => command.message === "question")).toHaveLength(0);
    const person = f.rpc.find(command => command.message === "person startup")!;
    f.event("response", { id: person.id, success: true, data: { disposition: "started" } });
    f.event("agent_start"); f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "question")).toHaveLength(1);
  });
  it("person steering stays usable but mixed output is not returned as the dedicated answer", async () => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.response("question"); f.event("agent_start"); f.core.handleUserBlock("person steer");
    f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "mixed output" }], stopReason: "stop" } });
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person steer" }));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ answer: null, completion: "unknown" }) }));
  });
  it.each(["queued", "handled", "started"])("authoritative %s disposition cannot adopt earlier native/extension events", async disposition => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    await f.core.acceptRunnerRequest(f.frame("later", 2, "wake"));
    f.event("agent_start");
    if (disposition === "queued") f.event("response", { id: "openrig-native-question", success: true, data: { disposition } });
    f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "unrelated execution" }], stopReason: "stop" } });
    f.event("agent_end");
    // Native terminal alone cannot commit an answer or release a preflight awaiting disposition.
    await new Promise(resolve => setImmediate(resolve));
    if (disposition !== "queued") {
      expect(f.posts.filter(post => post.type === "result")).toHaveLength(0);
      f.event("response", { id: "openrig-native-question", success: true, data: { disposition } });
    }
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ answer: null, completion: "unknown", ownershipUnknown: true }) }));
    await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.event("agent_start"); f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "queued followup" }], stopReason: "stop" } }); f.event("agent_end");
    f.core.handleUserBlock("person still works");
    await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(command => command.message === "question")).toHaveLength(1);
    expect(f.rpc.filter(command => command.message === "later")).toHaveLength(0);
    expect(f.rpc).toContainEqual(expect.objectContaining({ type: "prompt", message: "person still works" }));
    expect(f.core.nativeChannelCapabilities()).toEqual({ input: false, wake: false, cancel: false });
    expect(f.posts.filter(post => post.type === "result" && post.requestId === "question")).toHaveLength(1);
  });
  it("a queued disposition holds managed dispatch through native terminal without guessing ownership", async () => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.event("agent_start");
    f.event("response", { id: "openrig-native-question", success: true, data: { disposition: "queued" } });
    await f.core.acceptRunnerRequest(f.frame("later", 2, "input"));
    await new Promise(resolve => setImmediate(resolve));
    expect(f.posts.filter(post => post.type === "result")).toHaveLength(0);
    expect(f.rpc.filter(command => command.message === "later")).toHaveLength(0);
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", result: expect.objectContaining({ completion: "unknown", answer: null }) }));
    expect(f.rpc.filter(command => command.message === "later")).toHaveLength(0);
  });
  it("queues busy wakes, protects the dedicated answer, and deduplicates offers", async () => {
    const f = managed(); f.event("agent_start");
    await f.core.acceptRunnerRequest(f.frame("steer", 1, "input"));
    expect(f.rpc).toContainEqual({ id: "openrig-native-steer", type: "prompt", message: "steer", streamingBehavior: "steer" });
    f.response("steer");
    await f.core.acceptRunnerRequest(f.frame("question", 2, "wake"));
    await f.core.acceptRunnerRequest(f.frame("later", 3, "input"));
    expect(f.rpc.filter(r => r.message === "question")).toHaveLength(0);
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.rpc.filter(r => r.message === "question")).toHaveLength(1);
    f.response("question"); f.event("agent_start");
    f.event("message_end", { message: { role: "toolResult", content: [{ type: "text", text: "unrelated tool" }] } });
    f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "actual answer" }], stopReason: "stop" } });
    expect(f.rpc.filter(r => r.message === "later")).toHaveLength(0);
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    await f.core.acceptRunnerRequest(f.frame("question", 2, "wake"));
    await Promise.resolve(); await Promise.resolve();
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ kind: "wake", answer: "actual answer", completion: "completed" }) }));
    expect(f.rpc.filter(r => r.message === "question")).toHaveLength(1);
    expect(f.rpc.filter(r => r.message === "later")).toHaveLength(1);
  });
  it("a native end without assistant text gives no fabricated wake answer", async () => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.response("question"); f.event("agent_start");
    f.event("message_end", { message: { role: "assistant", content: [], stopReason: "stop" } });
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ answer: null, completion: "unknown" }) }));
  });
  it.each(["aborted", "error"])("a terminal %s releases the barrier with no fabricated answer", async stopReason => {
    const f = managed(); await f.core.acceptRunnerRequest(f.frame("question", 1, "wake"));
    f.response("question"); f.event("agent_start");
    await f.core.acceptRunnerRequest(f.frame("next", 2, "wake"));
    f.event("message_end", { message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason } });
    f.event("agent_end"); await new Promise(resolve => setImmediate(resolve));
    await Promise.resolve(); await Promise.resolve();
    expect(f.posts).toContainEqual(expect.objectContaining({ type: "result", requestId: "question", result: expect.objectContaining({ answer: null, completion: stopReason === "aborted" ? "interrupted" : "failed" }) }));
    expect(f.rpc.filter(r => r.message === "next")).toHaveLength(1);
  });
});
