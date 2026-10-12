// OPR.0.7.0.5 — in-place restart of one Codex seat: every gate and every outcome, driven through the
// public SeatLifecycleService surface against a fake tmux, process table, Codex launcher and OS reads.
import { describe, it, expect, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";
import type { HarnessLaunchResult, NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ArbitratedSeatState } from "../src/domain/activity-taxonomy.js";
import type { InPlaceRestartIo, ProcessFacts } from "../src/domain/seat-restart-in-place.js";
import { parseEffectiveSettings, shellWords } from "../src/domain/seat-restart-in-place.js";

const LSTART = "Mon Oct 12 21:00:00 2026";
const LATER = "Mon Oct 12 21:05:00 2026";
const TOKEN = "019a0000-0000-7000-8000-000000000001";
const SEAT = "dev-codex@r";
const HOME = "/home/u/.codex";

type Shape = "shell_backed" | "direct_native";

interface WorldOptions {
  shape?: Shape;
  runningArgs?: string;
  savedModel?: string | null;
  activity?: ArbitratedSeatState | null;
  launch?: HarnessLaunchResult;
  codexIgnoresSignals?: boolean;
  /** The pane's own remain-on-exit value; "unreadable" makes the read fail. */
  remainOnExit?: string | null | "unreadable";
  threadId?: string;
  facts?: Partial<Record<number, ProcessFacts | null>>;
  identityFails?: boolean;
  rollout?: string | null;
  screen?: string;
}

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function shellRow(pid: number, tpgid: number): NativeProcessRow {
  return { pid, ppid: 1, pgid: pid, tpgid, executableName: "bash", command: "-bash", startedAt: LSTART };
}
function codexRow(pid: number, ppid: number, args: string, startedAt = LSTART, pgid = pid): NativeProcessRow {
  return { pid, ppid, pgid, tpgid: pgid, executableName: "codex", command: `/usr/local/bin/codex ${args}`, startedAt };
}
function facts(over: Partial<ProcessFacts> = {}): ProcessFacts {
  return { cwd: "/work", exe: "/usr/local/bin/codex", env: { CODEX_HOME: HOME }, apiKeyEnvNames: [], ...over };
}

function world(options: WorldOptions = {}) {
  const shape = options.shape ?? "shell_backed";
  const db = createFullTestDb();
  dbs.push(db);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const rig = rigRepo.createRig("r");
  const node = rigRepo.addNode(rig.id, "dev.codex", { runtime: "codex", cwd: "/work", ...(options.savedModel !== null ? { model: options.savedModel ?? "gpt-5.5" } : {}) });
  const session = sessionRegistry.registerSession(node.id, SEAT);
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
  sessionRegistry.updateResumeToken(session.id, "codex_id", TOKEN, "scrape");

  const runningArgs = options.runningArgs ?? `-m gpt-5.5 -s workspace-write resume ${TOKEN}`;
  let rows: NativeProcessRow[] = shape === "shell_backed"
    ? [shellRow(100, 200), codexRow(200, 100, runningArgs)]
    : [codexRow(100, 1, runningArgs, LSTART, 100)];
  let paneCommand = "codex";
  let dead = false;
  let remainOnExit: string | null = options.remainOnExit === "unreadable" ? null : options.remainOnExit ?? null;
  const calls: string[] = [];

  const relaunch = (startedAt = LATER) => {
    const replacement = shape === "shell_backed"
      ? codexRow(300, 100, runningArgs, startedAt)
      : codexRow(300, 1, runningArgs, startedAt, 300);
    rows = shape === "shell_backed" ? [shellRow(100, 300), replacement] : [replacement];
    paneCommand = "codex";
    dead = false;
  };

  const tmux = {
    probeSession: async () => ({ state: "present" as const }),
    listPanes: async () => [{ id: "%1", index: 0, cwd: "/work", width: 80, height: 24, active: true }],
    getPanePid: async () => (shape === "shell_backed" ? 100 : rows[0]?.pid ?? null),
    getPaneCommand: async () => paneCommand,
    getSessionEnv: async (_s: string, key: string) => (key === "CODEX_HOME" ? HOME : undefined),
    signalPid: async (pid: number, signal: string): Promise<TmuxResult> => {
      calls.push(`signalPid ${pid} ${signal}`);
      if (!options.codexIgnoresSignals) { rows = rows.filter((row) => row.executableName !== "codex"); paneCommand = "bash"; }
      return { ok: true };
    },
    signalPaneProcess: async (_pane: string, signal: string): Promise<TmuxResult> => {
      calls.push(`signalPaneProcess ${signal}`);
      if (!options.codexIgnoresSignals) { rows = []; dead = true; }
      return { ok: true };
    },
    isPaneDead: async () => dead,
    setRemainOnExit: async (_pane: string, on: boolean): Promise<TmuxResult> => { calls.push(`remain-on-exit ${on ? "on" : "off"}`); remainOnExit = on ? "on" : "off"; return { ok: true }; },
    getPaneLocalOption: async () => (options.remainOnExit === "unreadable" ? undefined : remainOnExit),
    restorePaneOption: async (_pane: string, _option: string, value: string | null): Promise<TmuxResult> => { calls.push(`restore remain-on-exit ${value}`); remainOnExit = value; return { ok: true }; },
    respawnPane: async (_pane: string, command?: string): Promise<TmuxResult> => { calls.push(`respawn ${command}`); relaunch(); return { ok: true }; },
    capturePaneContent: async () => options.screen ?? "",
  } as unknown as TmuxAdapter;

  const launches: Array<{ binding: NodeBinding; resumeToken?: string }> = [];
  const codex = {
    runtime: "codex",
    async buildResumeCommand(binding: NodeBinding, opts: { resumeToken: string }) {
      const core = `codex${binding.model ? ` -m '${binding.model}'` : ""} -s workspace-write resume '${opts.resumeToken}'`;
      return { ok: true as const, core, command: core };
    },
    async launchHarness(binding: NodeBinding, opts: { resumeToken?: string }): Promise<HarnessLaunchResult> {
      launches.push({ binding, ...(opts.resumeToken ? { resumeToken: opts.resumeToken } : {}) });
      const result = options.launch ?? { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id" };
      if (result.ok && !options.identityFails) relaunch();
      return result;
    },
    async verifyResumeInPane(): Promise<HarnessLaunchResult> {
      calls.push("verifyResumeInPane");
      return options.launch ?? { ok: true };
    },
  };

  const io: Partial<InPlaceRestartIo> = {
    readProcess: async (pid) => (options.facts && pid in options.facts ? options.facts[pid] ?? null : facts()),
    readThreadId: async (pid) => (pid === 200 ? options.threadId : undefined),
    readCredentialStore: () => "file",
    statAuthFile: () => null,
    findRollout: () => (options.rollout === undefined ? null : "/rollout.jsonl"),
    readRolloutTail: () => options.rollout ?? null,
  };

  const service = new SeatLifecycleService({
    db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
    runtimeAdapters: { codex: codex as never },
    listProcesses: () => (options.identityFails && rows.some((row) => row.pid === 300) ? [] : rows),
    activityOracle: { declareOccupantSwap: () => {}, getSeatState: () => options.activity ?? null },
    inPlaceRestartIo: io,
    inPlaceRestartTiming: { pollMs: 1, timeoutMs: 2, sleep: async () => {} },
  });
  const events = () => (db.prepare("SELECT type, payload FROM events WHERE type LIKE 'seat.restart_in_place%' ORDER BY seq").all() as Array<{ type: string; payload: string }>)
    .map((row) => ({ type: row.type, ...JSON.parse(row.payload) }));
  return { db, service, node, session, calls, launches, events, sessionRegistry, setRows: (next: NativeProcessRow[]) => { rows = next; } };
}

function state(activity: string, needs = 0): ArbitratedSeatState {
  return { seatNodeId: "n", activity: activity as never, needsInput: { count: needs, reason: needs ? "approval prompt" : null },
    needsInputEvidence: null, decidedBy: "hook" as never, seq: 1, changedAt: LSTART, rungs: [], lastSwap: null };
}

describe("rig seat restart --keep-conversation: gates before any signal", () => {
  it("plan reports activity, child processes, billing and settings, and changes nothing", async () => {
    const w = world({ activity: state("working"), facts: { 200: facts({ apiKeyEnvNames: ["OPENAI_API_KEY"] }), 100: facts() } });
    w.setRows([shellRow(100, 200), codexRow(200, 100, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`),
      { pid: 210, ppid: 200, pgid: 210, tpgid: 200, executableName: "node", command: "node mcp-server.js --token=x", startedAt: LSTART }]);
    const plan = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(plan).toMatchObject({
      ok: true, planOnly: true, paneShape: "shell_backed", conversationId: TOKEN, conversationProof: "argv",
      activity: { state: "working" }, childProcesses: [{ pid: 210, name: "node" }],
      billingRoute: { state: "unknown", apiKeyEnvNames: ["OPENAI_API_KEY"] },
      settings: { effective: { model: "gpt-5.5", sandbox: "workspace-write" }, saved: { model: "gpt-5.5" } },
      codexHome: HOME,
    });
    expect(JSON.stringify(plan)).not.toContain("--token=x"); // argv of children is never reported
    expect(w.calls).toEqual([]);
    expect(w.events()).toEqual([]);
  });

  it("mid-turn and needs-input are reported, never refused", async () => {
    const working = await world({ activity: state("working") }).service.restartInPlace({ seatRef: SEAT, reason: "new account" });
    expect(working).toMatchObject({ ok: true, outcome: "restarted_account_unverified", activity: { state: "working" } });
    const waiting = await world({ activity: state("idle-at-prompt", 1) }).service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(waiting).toMatchObject({ ok: true, activity: { state: "needs_input", needsInput: 1 } });
    const unknown = await world({ activity: null }).service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(unknown).toMatchObject({ ok: true, activity: { state: "unknown" } });
  });

  it("refuses a pending set-model riding along: effective settings must equal the relaunch", async () => {
    const w = world({ savedModel: "gpt-5.6" });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "new account" });
    expect(result).toMatchObject({ ok: false, code: "settings_drift", detail: { differs: ["model"] } });
    expect(w.calls).toEqual([]);
  });

  it("refuses drift in effort, home and cwd, naming each", async () => {
    const effort = world({ runningArgs: `-m gpt-5.5 -c model_reasoning_effort="high" -s workspace-write resume ${TOKEN}` });
    expect(await effort.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ code: "settings_drift", detail: { differs: ["effort"] } });
    const home = world({ facts: { 200: facts({ env: { CODEX_HOME: "/other/.codex" } }), 100: facts() } });
    expect(await home.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ code: "settings_drift", detail: { differs: ["codex home"] } });
    const cwd = world({ facts: { 200: facts(), 100: facts({ cwd: "/elsewhere" }) } });
    expect(await cwd.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ code: "settings_drift", detail: { differs: ["cwd"] } });
  });

  it("refuses when the running Codex is on another conversation, or none can be proven", async () => {
    const other = world({ runningArgs: "-m gpt-5.5 -s workspace-write resume 019a-other" });
    expect(await other.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "resume_binding_unverified" });
    const fresh = world({ runningArgs: "-m gpt-5.5 -s workspace-write -C /work" });
    expect(await fresh.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "resume_binding_unverified" });
  });

  it("proves a fresh-launched Codex by its own native logs", async () => {
    const w = world({ runningArgs: "-m gpt-5.5 -s workspace-write -C /work", threadId: TOKEN });
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: true, conversationProof: "native_logs" });
  });

  it("refuses a pane that is neither a shell running Codex nor Codex itself", async () => {
    const w = world();
    w.setRows([{ ...shellRow(100, 200), executableName: "python3", command: "python3 wrapper.py" }, codexRow(200, 100, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`)]);
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "pane_shape_unknown" });
  });

  it("refuses while an earlier restart has no recorded result, and a request that waited behind another", async () => {
    const w = world();
    w.db.prepare("INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, 'seat.restart_in_place_started', '{}')").run("r", w.node.id);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "again" })).toMatchObject({ ok: false, code: "restart_in_progress" });
  });

  it("refuses a direct-native pane whose remain-on-exit cannot be read (it could not be put back)", async () => {
    const w = world({ shape: "direct_native", remainOnExit: "unreadable" });
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "tmux_probe_failed" });
  });

  it("names the shared seat refusals: reason, runtime, adopted session", async () => {
    const w = world();
    expect(await w.service.restartInPlace({ seatRef: SEAT })).toMatchObject({ ok: false, code: "missing_reason" });
    w.db.prepare("UPDATE nodes SET runtime = 'claude-code' WHERE id = ?").run(w.node.id);
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "not_codex" });
    w.db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(w.node.id);
    w.db.prepare("UPDATE sessions SET origin = 'claimed' WHERE id = ?").run(w.session.id);
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "claimed_session" });
  });
});

describe("rig seat restart --keep-conversation: outcomes", () => {
  it("shell-backed: TERMs Codex (not the shell), resumes the same conversation once, records started and finished", async () => {
    const w = world();
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "take the home's account", operator: "op@r" });
    expect(result).toMatchObject({ ok: true, outcome: "restarted_account_unverified", paneShape: "shell_backed",
      oldProcess: { pid: 200 }, newProcess: { pid: 300, startedAt: LATER, sameExecutable: true } });
    expect(w.calls).toEqual(["signalPid 200 TERM"]);
    expect(w.launches).toHaveLength(1);
    expect(w.launches[0]).toMatchObject({ resumeToken: TOKEN, binding: { cwd: "/work", model: "gpt-5.5", launchPosture: "floor" } });
    expect(w.events().map((event) => [event.type, event.outcome])).toEqual([
      ["seat.restart_in_place_started", undefined], ["seat.restart_in_place_finished", "restarted_account_unverified"]]);
  });

  it("not_started when Codex survives TERM and KILL: no resume is attempted", async () => {
    const w = world({ codexIgnoresSignals: true });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "not_started" });
    expect(w.calls).toEqual(["signalPid 200 TERM", "signalPid 200 KILL"]);
    expect(w.launches).toHaveLength(0);
  });

  it("incomplete with the sign-in step when Codex shows an auth gate; no fresh launch, no retry", async () => {
    const w = world({ launch: { ok: false, error: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.", recovery: "attention_required" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "incomplete", remainingStep: expect.stringContaining(`signs in to Codex in ${HOME}`),
      recoveryCommand: `codex -m 'gpt-5.5' -s workspace-write resume '${TOKEN}'`, account: { startupGate: expect.stringContaining("sign in") } });
    expect(w.launches).toHaveLength(1);
  });

  it("incomplete, never fresh, when Codex has no saved session for the conversation", async () => {
    const w = world({ launch: { ok: false, error: "Codex resume failed: no saved session found", recovery: "retry_fresh" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ outcome: "incomplete", remainingStep: expect.stringContaining("no fresh session was started") });
    expect(w.launches).toHaveLength(1);
  });

  it("native_unknown when the resumed process cannot be proven to be the conversation", async () => {
    const w = world({ identityFails: true });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "native_unknown", couldNotSee: [expect.stringContaining("identity")] });
  });

  it("direct-native: respawns without -k, restores remain-on-exit only after a verified live replacement", async () => {
    const w = world({ shape: "direct_native", remainOnExit: null });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "restarted_account_unverified", paneShape: "direct_native" });
    expect(result).not.toHaveProperty("paneHeld");
    expect(w.calls).toEqual(["remain-on-exit on", "signalPaneProcess TERM", `respawn codex -m 'gpt-5.5' -s workspace-write resume '${TOKEN}'`,
      "verifyResumeInPane", "restore remain-on-exit null"]);
  });

  it("direct-native failure keeps the dead pane held and says so", async () => {
    const w = world({ shape: "direct_native", remainOnExit: "off", launch: { ok: false, error: "readiness timeout", recovery: "attention_required" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ outcome: "incomplete", paneHeld: { option: "remain-on-exit", value: "on", previous: "off" } });
    expect(w.calls.some((call) => call.startsWith("restore"))).toBe(false);
  });

  it("peers sharing the Codex home are reported, not restarted", async () => {
    const w = world();
    const rigRepo = new RigRepository(w.db);
    rigRepo.addNode(rigRepo.findRigsByName("r")[0]!.id, "dev.peer", { runtime: "codex", cwd: "/work" });
    const result = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(result).toMatchObject({ peers: [{ logicalId: "dev.peer", home: "unknown", effect: expect.stringContaining("Not restarted; account unverified") }] });
  });
});

describe("rig seat restart --keep-conversation --verify", () => {
  const turn = (type: string, payload: string, at = "2099-01-01T00:00:00Z") => JSON.stringify({ timestamp: at, type, payload: { type: payload } });

  async function restarted(options: WorldOptions) {
    const w = world(options);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    return w;
  }

  it("moved needs a completed tool turn AND the expected account on Codex's status", async () => {
    const w = await restarted({ rollout: turn("response_item", "function_call_output"), screen: "  Account:  me@example.com (Pro)\n" });
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ ok: true, outcome: "moved" });
  });

  it("stays unverified with a tool turn but no account-specific evidence (plan-only status, or none asked)", async () => {
    const w = await restarted({ rollout: turn("response_item", "function_call_output"), screen: "  Account:  Pro plan\n" });
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_matched" } });
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT })).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_requested" } });
  });

  it("stays unverified with the account but no tool turn, or with an error event", async () => {
    const screen = "Account: me@example.com\n";
    const none = await restarted({ rollout: turn("response_item", "message"), screen });
    expect(await none.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ outcome: "restarted_account_unverified", toolTurn: { state: "not_observed" } });
    const errored = await restarted({ rollout: [turn("response_item", "function_call_output"), turn("event_msg", "error")].join("\n"), screen });
    expect(await errored.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ outcome: "restarted_account_unverified", toolTurn: { errors: 1 } });
    const old = await restarted({ rollout: turn("response_item", "function_call_output", "2000-01-01T00:00:00Z"), screen });
    expect(await old.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ toolTurn: { completed: 0 } });
  });

  it("refuses when nothing was restarted, or the seat changed since", async () => {
    const w = world();
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT })).toMatchObject({ ok: false, code: "no_restart_recorded" });
    const done = await restarted({});
    done.setRows([shellRow(100, 400), codexRow(400, 100, `-s workspace-write resume ${TOKEN}`, "Mon Oct 12 22:00:00 2026")]);
    expect(await done.service.verifyRestartInPlace({ seatRef: SEAT })).toMatchObject({ ok: false, code: "seat_restarted_since" });
  });
});

describe("effective settings parsing", () => {
  it("splits shellQuote output and reads codex flags, ignoring cwd, add-dirs and the resume target", () => {
    expect(shellWords(`codex --no-daemon -m 'gpt 5' -c 'model_reasoning_effort="high"' resume --add-dir '/a b' 'tok'`))
      .toEqual(["codex", "--no-daemon", "-m", "gpt 5", "-c", 'model_reasoning_effort="high"', "resume", "--add-dir", "/a b", "tok"]);
    expect(parseEffectiveSettings(["codex", "--model=x", "-p", "prof", "-a", "never", "--sandbox", "read-only", "-C", "/w", "--add-dir", "/d", "-c", "b=2", "-c", "a=1", "resume", "t"]))
      .toEqual({ model: "x", profile: "prof", sandbox: "read-only", approval: "never", bypass: false, config: ["a=1", "b=2"] });
    expect(parseEffectiveSettings(["codex", "--dangerously-bypass-approvals-and-sandbox", "constructor", "toString"]).bypass).toBe(true);
  });
});
