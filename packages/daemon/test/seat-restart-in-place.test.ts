// OPR.0.7.0.5 — in-place restart of one Codex seat: every gate and every outcome, driven through the
// public SeatLifecycleService surface against a fake tmux, process table, Codex launcher and OS reads.
import { defaultTmuxFileOps, isStagedSendScriptPath } from "../src/adapters/tmux.js";
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
import { accountLineNames, parseEffectiveSettings, shellWords } from "../src/domain/seat-restart-in-place.js";

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
  /** Shell-backed only: the command line of a process between the pane shell and Codex (OpenRig's
   *  staged launch script, or something else). */
  between?: string;
  /** The OS's name for that process (ps ucomm); defaults to argv[0]'s basename. */
  betweenName?: string;
  activity?: ArbitratedSeatState | null;
  launch?: HarnessLaunchResult;
  codexIgnoresSignals?: boolean;
  /** The pane's own remain-on-exit value; "unreadable" makes the read fail. */
  remainOnExit?: string | null | "unreadable";
  threadId?: string;
  facts?: Partial<Record<number, ProcessFacts | null>>;
  identityFails?: boolean;
  rollout?: string | null;
  /** Printed in the pane after the restart (the operator's /status). */
  screen?: string;
  /** Already in the pane before the restart. */
  screenBefore?: string;
  throwAt?: "signalPid" | "sendResumeCommand" | "readProcessAfter" | "signalPaneProcess" | "respawnPane" | "verifyResumeInPane" | "restorePaneOption";
  daemonStartedAt?: Date;
  /** The pane hold fails: the remain-on-exit write errors, or it doesn't read back as on. */
  holdFails?: "write" | "readback";
  /** The pane disappears when its process is signalled, and tmux doesn't report it dead (review-r2's case). */
  paneVanishes?: boolean;
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
    ? options.between
      ? [shellRow(100, 150), { pid: 150, ppid: 100, pgid: 150, tpgid: 150, executableName: options.betweenName ?? options.between.split(" ")[0]!.split("/").pop()!, command: options.between, startedAt: LSTART },
        codexRow(200, 150, runningArgs, LSTART, 150)]
      : [shellRow(100, 200), codexRow(200, 100, runningArgs)]
    : [codexRow(100, 1, runningArgs, LSTART, 100)];
  let paneCommand = "codex";
  let dead = false;
  let paneGone = false;
  let remainOnExit: string | null = options.remainOnExit === "unreadable" ? null : options.remainOnExit ?? null;
  const calls: string[] = [];
  const paneLines: string[] = (options.screenBefore ?? "").split("\n").filter(Boolean);
  let relaunched = false;
  let thrown = false;
  const maybeThrow = (at: WorldOptions["throwAt"]) => {
    if (options.throwAt === at && !thrown) { thrown = true; throw new Error(`injected failure at ${at}`); }
  };

  const relaunch = (startedAt = LATER) => {
    const replacement = shape === "shell_backed"
      ? codexRow(300, 100, runningArgs, startedAt)
      : codexRow(300, 1, runningArgs, startedAt, 300);
    rows = shape === "shell_backed" ? [shellRow(100, 300), replacement] : [replacement];
    relaunched = true;
    paneCommand = "codex";
    dead = false;
  };

  const tmux = {
    probeSession: async () => ({ state: "present" as const }),
    listPanes: async () => (paneGone ? [] : [{ id: "%1", index: 0, cwd: "/work", width: 80, height: 24, active: true }]),
    getPanePid: async () => (shape === "shell_backed" ? 100 : rows[0]?.pid ?? null),
    getPaneCommand: async () => paneCommand,
    getSessionEnv: async (_s: string, key: string) => (key === "CODEX_HOME" ? HOME : undefined),
    signalPid: async (pid: number, signal: string): Promise<TmuxResult> => {
      calls.push(`signalPid ${pid} ${signal}`);
      maybeThrow("signalPid");
      // The launch script ends with Codex, so its sh exits too.
      if (!options.codexIgnoresSignals) { rows = rows.filter((row) => row.executableName !== "codex" && row.pid !== 150); paneCommand = "bash"; }
      return { ok: true };
    },
    signalPaneProcess: async (_pane: string, signal: string): Promise<TmuxResult> => {
      calls.push(`signalPaneProcess ${signal}`);
      maybeThrow("signalPaneProcess");
      if (!options.codexIgnoresSignals) {
        // Other processes keep running: an empty table would mean the process list couldn't be read.
        rows = options.paneVanishes ? [{ ...shellRow(900, 900), command: "sshd" }] : [];
        if (options.paneVanishes) paneGone = true; else dead = true;
      }
      return { ok: true };
    },
    isPaneDead: async () => dead,
    setRemainOnExit: async (_pane: string, on: boolean): Promise<TmuxResult> => {
      calls.push(`remain-on-exit ${on ? "on" : "off"}`);
      if (options.holdFails === "write") return { ok: false, code: "unknown", message: "injected write failure" } as TmuxResult;
      if (options.holdFails !== "readback") remainOnExit = on ? "on" : "off";
      return { ok: true };
    },
    getPaneLocalOption: async () => (options.remainOnExit === "unreadable" ? undefined : remainOnExit),
    restorePaneOption: async (_pane: string, _option: string, value: string | null): Promise<TmuxResult> => {
      calls.push(`restore remain-on-exit ${value}`); maybeThrow("restorePaneOption"); remainOnExit = value; return { ok: true };
    },
    respawnPane: async (_pane: string, command?: string): Promise<TmuxResult> => { calls.push(`respawn ${command}`); maybeThrow("respawnPane"); relaunch(); return { ok: true }; },
    capturePaneHistory: async () => paneLines.join("\n"),
  } as unknown as TmuxAdapter;

  const launches: Array<{ command: string; resumeToken: string }> = [];
  const builds: Array<{ running?: unknown }> = [];
  const codex = {
    runtime: "codex",
    async buildResumeCommand(binding: NodeBinding, opts: { resumeToken: string; running?: { networkOverride: boolean; daemonOptOut: boolean; addDirs: string[] } }) {
      builds.push({ running: opts.running });
      const running = opts.running;
      const core = `codex${running?.daemonOptOut ? " --no-daemon" : ""}${binding.model ? ` -m '${binding.model}'` : ""} -s workspace-write`
        + `${running?.networkOverride ? " -c 'sandbox_workspace_write.network_access=true'" : ""} resume`
        + `${(running?.addDirs ?? []).map((dir) => ` --add-dir '${dir}'`).join("")} '${opts.resumeToken}'`;
      return { ok: true as const, core, command: `env CODEX_HOME='${HOME}' ${core}` };
    },
    async sendResumeCommand(_session: string, command: string, resumeToken: string): Promise<HarnessLaunchResult> {
      launches.push({ command, resumeToken });
      maybeThrow("sendResumeCommand");
      const result = options.launch ?? { ok: true, resumeToken, resumeType: "codex_id" };
      if (result.ok && !options.identityFails) relaunch();
      return result;
    },
    async verifyResumeInPane(): Promise<HarnessLaunchResult> {
      calls.push("verifyResumeInPane");
      maybeThrow("verifyResumeInPane");
      return options.launch ?? { ok: true };
    },
  };

  const io: Partial<InPlaceRestartIo> = {
    readProcess: async (pid) => {
      if (relaunched) maybeThrow("readProcessAfter");
      return options.facts && pid in options.facts ? options.facts[pid] ?? null : facts();
    },
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
    inPlaceRestartDaemonStartedAt: options.daemonStartedAt ?? new Date("2000-01-01T00:00:00Z"),
  });
  const events = () => (db.prepare("SELECT type, payload FROM events WHERE type LIKE 'seat.restart_in_place%' ORDER BY seq").all() as Array<{ type: string; payload: string }>)
    .map((row) => ({ type: row.type, ...JSON.parse(row.payload) }));
  return { db, service, node, session, calls, launches, builds, events, sessionRegistry,
    setRows: (next: NativeProcessRow[]) => { rows = next; },
    print: (text: string) => { paneLines.push(...text.split("\n").filter(Boolean)); } };
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

  it("accepts a Codex launched through OpenRig's staged launch script, and only that script, between shell and Codex", async () => {
    const staged = "/bin/sh /tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt";
    const w = world({ between: staged });
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: true, paneShape: "shell_backed" });
    // macOS (measured on Build): /bin/sh is a shim that runs bash, so ps names the process bash.
    const mac = world({ between: "/bin/sh /var/folders/7x/abc123/T/openrig-tmux-send-4242-5b249a92-40d6-40c4-b424-57b3b6980529.txt", betweenName: "bash" });
    expect(await mac.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: true, paneShape: "shell_backed" });
    // The real generator's names are what the matcher accepts.
    const generated = defaultTmuxFileOps().tmpName();
    expect(isStagedSendScriptPath(generated), generated).toBe(true);
    const done = await w.service.restartInPlace({ seatRef: SEAT, reason: "new account" });
    expect(done).toMatchObject({ ok: true, outcome: "restarted_account_unverified", paneShape: "shell_backed" });
    expect(w.calls).toContain("signalPid 200 TERM");
    for (const other of [
      "/bin/sh /home/u/run-codex.sh",
      "/bin/sh /tmp/openrig-tmux-send-1.txt",
      "/bin/sh -c /tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt",
      "/usr/bin/script -q /tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt",
      "/bin/sh tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt",
      "/bin/sh /tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt extra",
      "/bin/bash /tmp/openrig-tmux-send-1128548-5b249a92-40d6-40c4-b424-57b3b6980529.txt",
    ]) {
      const refused = world({ between: other });
      expect(await refused.service.restartInPlace({ seatRef: SEAT, plan: true }), other).toMatchObject({ ok: false, code: "pane_shape_unknown" });
      expect(refused.calls, other).toEqual([]);
    }
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
    expect(w.launches[0]).toEqual({ resumeToken: TOKEN, command: `env CODEX_HOME='${HOME}' codex -m 'gpt-5.5' -s workspace-write resume '${TOKEN}'` });
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
    expect(w.calls).toEqual(["remain-on-exit on", "remain-on-exit on", "signalPaneProcess TERM", `respawn env CODEX_HOME='${HOME}' codex -m 'gpt-5.5' -s workspace-write resume '${TOKEN}'`,
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
    const w = world({ ...options, screen: undefined });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    if (options.screen) w.print(options.screen);
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

describe("#1196 round 1: every exit after started records a result; stale starts don't lock the seat", () => {
  it.each([
    ["shell_backed", "signalPid", "stop", false],
    ["shell_backed", "sendResumeCommand", "resume", false],
    ["shell_backed", "readProcessAfter", "identity check", false],
    ["direct_native", "signalPaneProcess", "stop", true],
    ["direct_native", "respawnPane", "respawn", true],
    ["direct_native", "verifyResumeInPane", "resume", true],
    ["direct_native", "readProcessAfter", "identity check", true],
    ["direct_native", "restorePaneOption", "restoring remain-on-exit", true],
  ] as const)("%s: a throw at %s finishes as native_unknown (stage %s), and the seat can be previewed again", async (shape, throwAt, stage, held) => {
    const w = world({ shape, throwAt, remainOnExit: null });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "native_unknown", couldNotSee: [expect.stringContaining(`during ${stage}: injected failure at ${throwAt}`)] });
    expect((result as { paneHeld?: unknown }).paneHeld !== undefined).toBe(held);
    expect(w.events().map((event) => [event.type, event.outcome, event.paneHeld])).toEqual([
      ["seat.restart_in_place_started", undefined, undefined], ["seat.restart_in_place_finished", "native_unknown", held]]);
    const plan = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(plan).not.toMatchObject({ code: "restart_in_progress" });
  });

  function startedAt(w: ReturnType<typeof world>, createdAt: string) {
    w.db.prepare("INSERT INTO events (rig_id, node_id, type, payload, created_at) VALUES (?, ?, 'seat.restart_in_place_started', ?, ?)")
      .run("r", w.node.id, JSON.stringify({ oldPid: 77, pane: "%1" }), createdAt);
  }

  it("a started restart from before this daemon started is reported as stale, in --plan and execute, not refused", async () => {
    const w = world({ daemonStartedAt: new Date("2026-10-12T21:00:00Z") });
    startedAt(w, "2026-10-12 20:59:59");
    const plan = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(plan).toMatchObject({ ok: true, staleRestart: { startedAt: "2026-10-12T20:59:59.000Z", oldPid: 77, pane: "%1" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "restarted_account_unverified", staleRestart: { oldPid: 77 } });
  });

  it("a started restart under this daemon is still in flight: --plan and execute refuse", async () => {
    const w = world({ daemonStartedAt: new Date("2026-10-12T21:00:00Z") });
    startedAt(w, "2026-10-12 21:00:05");
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "restart_in_progress" });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ ok: false, code: "restart_in_progress" });
    expect(w.calls).toEqual([]);
  });

  it("--plan shows the last recorded result", async () => {
    const w = world();
    await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: true, lastRestart: { outcome: "restarted_account_unverified" } });
  });
});

describe("#1196 round 1: launch choices come from the running Codex (LOW-1); verify reads only post-restart output (LOW-2)", () => {
  it("passes the running argv's network override, --no-daemon and add-dirs to the relaunch", async () => {
    const w = world({ runningArgs: `--no-daemon -m gpt-5.5 -s workspace-write -c sandbox_workspace_write.network_access=true resume --add-dir /shared/state ${TOKEN}` });
    await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(w.builds).toEqual([{ running: { networkOverride: true, daemonOptOut: true, addDirs: ["/shared/state"] } }]);
  });

  it("the production adapter builds from the running choices without starting any probe", async () => {
    const { CodexRuntimeAdapter } = await import("../src/adapters/codex-runtime-adapter.js");
    const probes: string[] = [];
    const adapter = new CodexRuntimeAdapter({
      tmux: { getPaneCommand: async () => "codex" } as never,
      fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {} },
      detectDaemonSupport: async () => { probes.push("daemon-support"); return { kind: "supported" } as never; },
      readNetworkDefault: async () => { probes.push("network"); return { apply: true, elapsedMs: 1 } as never; },
      verifyProfilePreflight: async () => { probes.push("profile"); return { ok: true } as never; },
      prepareTeamWorkspace: () => { probes.push("team-workspace"); return []; },
    });
    const binding = { id: "", nodeId: "n", attachmentType: "tmux", tmuxSession: SEAT, tmuxWindow: null, tmuxPane: "%1",
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "/work", codexConfigProfile: "prof", teamPermissionDefault: true } as NodeBinding;
    const built = await adapter.buildResumeCommand(binding, { name: SEAT, resumeToken: TOKEN, running: { networkOverride: false, daemonOptOut: true, addDirs: ["/a b"] } });
    expect(probes).toEqual([]);
    expect(built).toMatchObject({ ok: true, core: expect.stringContaining("--no-daemon") });
    if (built.ok) {
      expect(built.core).toContain("--add-dir '/a b'");
      expect(built.core).not.toContain("network_access");
    }
  });

  it("an Account line from before the restart is not evidence", async () => {
    const w = world({ screenBefore: "  Account:  me@example.com (Pro)", rollout: JSON.stringify({ timestamp: "2099-01-01T00:00:00Z", type: "response_item", payload: { type: "function_call_output" } }) });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
    w.print("  Account:  Pro plan");
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_matched" } });
    w.print("  Account:  me@example.com (Pro)");
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" })).toMatchObject({ outcome: "moved" });
  });
});

describe("--expect-account matches the account as a whole value (CodeRabbit on #1196)", () => {
  it("names the account exactly, not as part of a longer one", () => {
    expect(accountLineNames("Account: bob@corp.com (Plus)", "bob@corp.com")).toBe(true);
    expect(accountLineNames("Account: BOB@corp.com", "bob@corp.com")).toBe(true);
    expect(accountLineNames("Account: jimbob@corp.com", "bob@corp.com")).toBe(false);
    expect(accountLineNames("Account: bob@corp.com.au", "bob@corp.com")).toBe(false);
    expect(accountLineNames("Account: bob@corpXcom", "bob@corp.com")).toBe(false);
    expect(accountLineNames("Account: bob@corp.com", "  ")).toBe(false);
  });
});

describe("#1196 round 2: the shell branch keeps the running settings (F1)", () => {
  it("types the exact command built from the old argv: --no-daemon, the network override and every --add-dir survive", async () => {
    const w = world({ runningArgs: `--no-daemon -m gpt-5.5 -s workspace-write -c sandbox_workspace_write.network_access=true resume --add-dir /shared/one --add-dir /shared/two ${TOKEN}` });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "restarted_account_unverified", paneShape: "shell_backed" });
    // Built once, before anything stopped; nothing is prepared again after Codex exits.
    expect(w.builds).toEqual([{ running: { networkOverride: true, daemonOptOut: true, addDirs: ["/shared/one", "/shared/two"] } }]);
    expect(w.launches).toHaveLength(1);
    const typed = shellWords(w.launches[0]!.command);
    expect(typed).toContain("--no-daemon");
    expect(typed).toContain("sandbox_workspace_write.network_access=true");
    expect(typed.filter((_, index) => typed[index - 1] === "--add-dir")).toEqual(["/shared/one", "/shared/two"]);
  });

  it("the production adapter types the given command as is and verifies the resume", async () => {
    const { CodexRuntimeAdapter } = await import("../src/adapters/codex-runtime-adapter.js");
    const sent: string[] = [];
    const adapter = new CodexRuntimeAdapter({
      tmux: { sendShellCommand: async (_s: string, text: string) => { sent.push(text); return { ok: true }; } } as never,
      fsOps: { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {} },
    });
    const verified: string[] = [];
    (adapter as unknown as { verifyResumeInPane: (s: string, t: string) => Promise<HarnessLaunchResult> }).verifyResumeInPane =
      async (_s, token) => { verified.push(token); return { ok: true, resumeToken: token, resumeType: "codex_id" }; };
    const command = `env CODEX_HOME='${HOME}' codex --no-daemon resume --add-dir '/a b' '${TOKEN}'`;
    expect(await adapter.sendResumeCommand(SEAT, command, TOKEN)).toMatchObject({ ok: true });
    expect(sent).toEqual([command]);
    expect(verified).toEqual([TOKEN]);
  });
});

describe("#1196 round 2: the pane hold comes first and the report says what is observed (F2)", () => {
  it.each(["write", "readback"] as const)("a hold that fails (%s) signals nothing and ends not_started, with no pane held", async (holdFails) => {
    const w = world({ shape: "direct_native", remainOnExit: "off", holdFails });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "not_started", message: expect.stringContaining("could not be held") });
    expect(result).not.toHaveProperty("paneHeld");
    expect(w.calls.some((call) => call.startsWith("signal"))).toBe(false);
    expect(w.calls.some((call) => call.startsWith("respawn"))).toBe(false);
    expect(w.events().at(-1)).toMatchObject({ type: "seat.restart_in_place_finished", outcome: "not_started", paneHeld: false });
  });

  it("a pane that disappears is reported as gone, with the original exited, never as still running or held", async () => {
    const w = world({ shape: "direct_native", remainOnExit: null, paneVanishes: true });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "incomplete", observedAfterStop: { pane: "gone", process: "exited" },
      message: expect.stringContaining("pane is gone"), remainingStep: expect.stringContaining("new pane") });
    expect(result).not.toHaveProperty("paneHeld");
    expect(JSON.stringify(result)).not.toContain("still running");
    expect(w.events().at(-1)).toMatchObject({ outcome: "incomplete", paneHeld: false });
  });

  it("a Codex that survives TERM and KILL in a direct pane is observed running, and the pane stays held", async () => {
    const w = world({ shape: "direct_native", remainOnExit: null, codexIgnoresSignals: true });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ outcome: "not_started", observedAfterStop: { pane: "present", process: "running" }, paneHeld: { value: "on" } });
  });
});

describe("#1196 round 2: account evidence only from lines produced after the restart (F3)", () => {
  const rollout = JSON.stringify({ timestamp: "2099-01-01T00:00:00Z", type: "response_item", payload: { type: "function_call_output" } });

  it("review-r2's case: an old Account line that stays in the frame across the restart never gives moved", async () => {
    // Rows above and below the cursor, unchanged across the restart: nothing about the cursor matters now.
    const w = world({ screenBefore: "header\n\n\n\n\n\n\n\n\n  Account:  me@example.com (Pro)\nfooter", rollout });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("an old matching line plus a new plan-only line is not_matched, not moved", async () => {
    const w = world({ screenBefore: "Account: me@example.com", rollout });
    await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    w.print("Account: Pro plan");
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_matched" } });
  });

  it("no record of the pane's text at the restart means not_observed", async () => {
    const w = world({ rollout });
    await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    w.db.prepare("UPDATE events SET payload = json_set(payload, '$.accountLinesAtRestart', NULL) WHERE type = 'seat.restart_in_place_finished'").run();
    w.print("Account: me@example.com");
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("the event log keeps digests, not account names", async () => {
    const w = world({ screenBefore: "Account: me@example.com" });
    await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    const finished = w.events().at(-1)!;
    expect(Object.values(finished.accountLinesAtRestart)).toEqual([1]);
    expect(JSON.stringify(finished)).not.toContain("example.com");
  });
});
