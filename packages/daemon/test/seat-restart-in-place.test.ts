// OPR.0.7.0.5 — in-place restart of one Codex seat: every gate and every outcome, driven through the
// public SeatLifecycleService surface against a fake tmux, process table, Codex launcher and OS reads.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { defaultTmuxFileOps, isStagedSendScriptPath } from "../src/adapters/tmux.js";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
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
import { accountLineNames, accountTextMark, defaultInPlaceRestartIo, linesAfterAnchor, parseEffectiveSettings, procCmdlineArgv, shellWords } from "../src/domain/seat-restart-in-place.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexThreadIdResolver, type CodexThreadEvidence } from "../src/domain/codex-thread-id.js";

// No test here may read a real Codex home: the fake io answers every native-thread read. The real resolver is watched for
// the whole file, and any call fails the test that made it.
let realResolverReads: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  realResolverReads = vi.spyOn(CodexThreadIdResolver.prototype, "resolveWithReadability");
});
afterEach(() => {
  expect(realResolverReads!.mock.calls, "a test read a real Codex home").toEqual([]);
  realResolverReads!.mockRestore();
});

const LSTART = "Mon Oct 12 21:00:00 2026";
const LATER = "Mon Oct 12 21:05:00 2026";
const TOKEN = "019a0000-0000-7000-8000-000000000001";
const SEAT = "dev-codex@r";
const HOME = "/home/u/.codex";

type Shape = "shell_backed" | "direct_native";

interface WorldOptions {
  shape?: Shape;
  runningArgs?: string;
  runningArgv?: string[];
  savedModel?: string | null;
  /** nodes.effort (authored) and nodes.effort_choice (rig seat set-effort). */
  savedEffort?: { authored?: string; choice?: string };
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
  /** What the running Codex's own logs show, and whether the read met no detected incompleteness. */
  evidence?: CodexThreadEvidence;
  facts?: Partial<Record<number, ProcessFacts | null>>;
  identityFails?: boolean;
  rollout?: string | null;
  /** Printed in the pane after the restart (the operator's /status). */
  screen?: string;
  /** Already in the pane before the restart. */
  screenBefore?: string;
  /** How many of the pane's last lines are its visible screen; the rest is history (default 3). */
  screenRows?: number;
  /** History as the restart's history-only capture read it, when the pane moved before the whole-pane capture. */
  historyCapture?: string;
  throwAt?: "signalPid" | "sendResumeCommand" | "readProcessAfter" | "signalPaneProcess" | "respawnPane" | "verifyResumeInPane" | "restorePaneOption";
  daemonStartedAt?: Date;
  /** Only post-relaunch process observations; preflight and stop retain the existing table. */
  replacementRows?: (read: number, rows: NativeProcessRow[]) => NativeProcessRow[];
  replacementTiming?: { pollMs: number; timeoutMs: number };
  afterReplacementYield?: (ms: number) => void | Promise<void>;
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
function codexRow(pid: number, ppid: number, args: string, startedAt = LSTART, pgid = pid, argv?: string[]): NativeProcessRow {
  return { pid, ppid, pgid, tpgid: pgid, executableName: "codex", command: `/usr/local/bin/codex ${args}`,
    argv: argv ?? ["/usr/local/bin/codex", ...args.split(" ")], startedAt };
}
function facts(over: Partial<ProcessFacts> = {}): ProcessFacts {
  return { cwd: "/work", exe: "/usr/local/bin/codex", env: { CODEX_HOME: HOME }, ...over };
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
  if (options.savedEffort?.authored) rigRepo.setNodeEffort(node.id, options.savedEffort.authored);
  if (options.savedEffort?.choice) rigRepo.setNodeEffortChoice(node.id, options.savedEffort.choice);
  const session = sessionRegistry.registerSession(node.id, SEAT);
  sessionRegistry.updateStatus(session.id, "running");
  sessionRegistry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: SEAT, tmuxPane: "%1" });
  sessionRegistry.updateResumeToken(session.id, "codex_id", TOKEN, "scrape");

  const runningArgs = options.runningArgs ?? `-m gpt-5.5 -s workspace-write resume ${TOKEN}`;
  let rows: NativeProcessRow[] = shape === "shell_backed"
    ? options.between
      ? [shellRow(100, 150), { pid: 150, ppid: 100, pgid: 150, tpgid: 150, executableName: options.betweenName ?? options.between.split(" ")[0]!.split("/").pop()!, command: options.between, startedAt: LSTART },
        codexRow(200, 150, runningArgs, LSTART, 150, options.runningArgv)]
      : [shellRow(100, 200), codexRow(200, 100, runningArgs, LSTART, 200, options.runningArgv)]
    : [codexRow(100, 1, runningArgs, LSTART, 100, options.runningArgv)];
  let paneCommand = "codex";
  let dead = false;
  let paneGone = false;
  let remainOnExit: string | null = options.remainOnExit === "unreadable" ? null : options.remainOnExit ?? null;
  const calls: string[] = [];
  const paneLines: string[] = (options.screenBefore ?? "").split("\n").filter(Boolean);
  let relaunched = false;
  let replacementReads = 0;
  const replacementYields: number[] = [];
  let thrown = false;
  const maybeThrow = (at: WorldOptions["throwAt"]) => {
    if (options.throwAt === at && !thrown) { thrown = true; throw new Error(`injected failure at ${at}`); }
  };

  const relaunch = (startedAt = LATER) => {
    const replacement = shape === "shell_backed"
      ? codexRow(300, 100, runningArgs, startedAt, 300, options.runningArgv)
      : codexRow(300, 1, runningArgs, startedAt, 300, options.runningArgv);
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
    capturePaneHistoryParts: async () => {
      const history = paneLines.slice(0, Math.max(0, paneLines.length - (options.screenRows ?? 3)));
      return { history: options.historyCapture ?? history.join("\n"), all: paneLines.join("\n") };
    },
  } as unknown as TmuxAdapter;

  const launches: Array<{ command: string; resumeToken: string }> = [];
  /** The Codex home each resume proof was asked to read. */
  const proofHomes: Array<string | undefined> = [];
  const builds: Array<{ running?: unknown }> = [];
  const codex = {
    runtime: "codex",
    async buildResumeCommand(binding: NodeBinding, opts: { resumeToken: string; running?: { networkOverride: boolean; daemonOptOut: boolean; addDirs: string[] } }) {
      builds.push({ running: opts.running });
      const running = opts.running;
      const core = `codex${running?.daemonOptOut ? " --no-daemon" : ""}${binding.model ? ` -m '${binding.model}'` : ""}`
        + `${binding.effort ? ` -c 'model_reasoning_effort="${binding.effort}"'` : ""} -s workspace-write`
        + `${running?.networkOverride ? " -c 'sandbox_workspace_write.network_access=true'" : ""} resume`
        + `${(running?.addDirs ?? []).map((dir) => ` --add-dir '${dir}'`).join("")} '${opts.resumeToken}'`;
      return { ok: true as const, core, command: `env CODEX_HOME='${HOME}' ${core}` };
    },
    async sendResumeCommand(_session: string, command: string, resumeToken: string, _nodeId?: string, home?: string): Promise<HarnessLaunchResult> {
      launches.push({ command, resumeToken });
      proofHomes.push(home);
      maybeThrow("sendResumeCommand");
      const result = options.launch ?? { ok: true, resumeToken, resumeType: "codex_id" };
      if (result.ok && !options.identityFails) relaunch();
      return result;
    },
    async verifyResumeInPane(_session?: string, _token?: string, _nodeId?: string, home?: string): Promise<HarnessLaunchResult> {
      calls.push("verifyResumeInPane");
      proofHomes.push(home);
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
    // Always answered here, never by the real reader. With no evidence given, the fake readThreadId's answer, as a read
    // that wasn't complete: it can't produce the conflict refusal, only a "not established" note.
    readThreadEvidence: async (pid: number): Promise<CodexThreadEvidence> => {
      if (options.evidence) return pid === 200 ? options.evidence : { reason: "no_log_row", fullyReadable: true };
      const thread = pid === 200 ? options.threadId : undefined;
      return { ...(thread ? { thread } : { reason: "no_log_row" as const }), fullyReadable: false, incomplete: "discovery" };
    },
    readCredentialStore: () => "file",
    statAuthFile: () => null,
    findRollout: () => (options.rollout === undefined ? null : "/rollout.jsonl"),
    readRolloutTail: () => options.rollout ?? null,
  };

  const service = new SeatLifecycleService({
    db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux,
    runtimeAdapters: { codex: codex as never },
    listProcesses: () => {
      if (relaunched) {
        replacementReads++;
        if (options.replacementRows) return options.replacementRows(replacementReads, rows);
      }
      return options.identityFails && rows.some((row) => row.pid === 300) ? [] : rows;
    },
    activityOracle: { declareOccupantSwap: () => {}, getSeatState: () => options.activity ?? null },
    inPlaceRestartIo: io,
    inPlaceRestartTiming: { pollMs: 1, timeoutMs: 2, ...options.replacementTiming, sleep: async ms => {
      if (relaunched) {
        replacementYields.push(ms);
        await options.afterReplacementYield?.(ms);
      }
    } },
    inPlaceRestartDaemonStartedAt: options.daemonStartedAt ?? new Date("2000-01-01T00:00:00Z"),
  });
  const events = () => (db.prepare("SELECT type, payload FROM events WHERE type LIKE 'seat.restart_in_place%' ORDER BY seq").all() as Array<{ type: string; payload: string }>)
    .map((row) => ({ type: row.type, ...JSON.parse(row.payload) }));
  return { db, service, node, session, calls, launches, proofHomes, builds, events, sessionRegistry, tmux,
    replacementYields, get replacementReads() { return replacementReads; }, get relaunched() { return relaunched; },
    setRows: (next: NativeProcessRow[]) => { rows = next; },
    print: (text: string) => { paneLines.push(...text.split("\n").filter(Boolean)); },
    /** tmux dropping the oldest history lines once the history is full. */
    trim: (count: number) => { paneLines.splice(0, count); },
    /** A redraw clearing the screen's last rows. */
    erase: (count: number) => { paneLines.splice(paneLines.length - count, count); } };
}

function state(activity: string, needs = 0): ArbitratedSeatState {
  return { seatNodeId: "n", activity: activity as never, needsInput: { count: needs, reason: needs ? "approval prompt" : null },
    needsInputEvidence: null, decidedBy: "hook" as never, seq: 1, changedAt: LSTART, rungs: [], lastSwap: null };
}

describe("rig seat restart --keep-conversation: gates before any signal", () => {
  it("plan reports activity, child processes and settings, and changes nothing", async () => {
    const w = world({ activity: state("working") });
    w.setRows([shellRow(100, 200), codexRow(200, 100, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`),
      { pid: 210, ppid: 200, pgid: 210, tpgid: 200, executableName: "node", command: "node mcp-server.js --token=x", startedAt: LSTART }]);
    const plan = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(plan).toMatchObject({
      ok: true, planOnly: true, paneShape: "shell_backed", conversationId: TOKEN, conversationProof: "argv",
      activity: { state: "working" }, childProcesses: [{ pid: 210, name: "node" }],
      settings: { effective: { model: "gpt-5.5", sandbox: "workspace-write" }, saved: { model: "gpt-5.5" } },
      codexHome: HOME,
    });
    expect(JSON.stringify(plan)).not.toContain("--token=x"); // argv of children is never reported
    expect(w.calls).toEqual([]);
    expect(w.events()).toEqual([]);
  });

  it.each([null, undefined, [], ["codex", "resume", TOKEN, "bad\0argument"], ["node", "resume", TOKEN]])(
    "refuses plan and execution before provider input or stop when exact Codex argv is unusable: %j", async argv => {
      const w = world({ threadId: TOKEN });
      w.setRows([shellRow(100, 200), { ...codexRow(200, 100, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`, LSTART, 200), argv }]);
      expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "resume_binding_unverified" });
      expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "new account" })).toMatchObject({ ok: false, code: "resume_binding_unverified" });
      expect(w.builds).toEqual([]);
      expect(w.calls).toEqual([]);
      expect(w.events()).toEqual([]);
    });

  it("refuses a readable Codex child below an opaque launcher before changing the seat", async () => {
    const w = world({ threadId: TOKEN });
    w.setRows([shellRow(100, 200), { ...codexRow(150, 100, "-m configured-model", LSTART, 200), argv: null },
      codexRow(200, 150, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`, LSTART, 200)]);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "new account" }))
      .toMatchObject({ ok: false, code: "resume_binding_unverified" });
    expect(w.builds).toEqual([]);
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

  it("applies the seat's saved effort as the one setting it changes (OPR.0.7.0.7)", async () => {
    const chosen = world({ savedEffort: { authored: "medium", choice: "high" }, runningArgs: `-m gpt-5.5 -c model_reasoning_effort="medium" -s workspace-write resume ${TOKEN}` });
    const plan = await chosen.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(plan).toMatchObject({ ok: true, settings: { saved: { effort: "high" }, effort: { running: "medium", relaunch: "high", changes: true } } });
    expect((plan as { settings: { note: string } }).settings.note).toContain("except effort");
    const done = await chosen.service.restartInPlace({ seatRef: SEAT, reason: "new account" });
    expect(done).toMatchObject({ ok: true, outcome: "restarted_account_unverified" });
    expect(chosen.launches[0]!.command).toContain(`-c 'model_reasoning_effort="high"'`);
    expect((plan as { settings: { effort: { source: string } } }).settings.effort.source).toBe("seat_choice");
    const same = world({ savedEffort: { choice: "high" }, runningArgs: `-m gpt-5.5 -c model_reasoning_effort="high" -s workspace-write resume ${TOKEN}` });
    expect(await same.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: true, settings: { effort: { running: "high", relaunch: "high", changes: false } } });
  });

  it("with no saved effort choice (never set, or cleared), an effort difference still refuses as settings_drift", async () => {
    const running = `-m gpt-5.5 -c model_reasoning_effort="high" -s workspace-write resume ${TOKEN}`;
    // Never set, authored medium: relaunching would send medium in place of the running high.
    const authored = world({ savedEffort: { authored: "medium" }, runningArgs: running });
    const a = await authored.service.restartInPlace({ seatRef: SEAT, reason: "new account" });
    expect(a).toMatchObject({ ok: false, code: "settings_drift", detail: { differs: ["effort"] } });
    expect((a as { guidance: string }).guidance).toContain("no saved effort choice (never set, or cleared)");
    expect(authored.calls).toEqual([]);
    // Never set, no authored value: relaunching would send no flag in place of high.
    const none = world({ runningArgs: running });
    expect(await none.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "settings_drift", detail: { differs: ["effort"] } });
    // Cleared after a choice: the same refusal; clearing doesn't apply anything in place.
    const cleared = world({ savedEffort: { authored: "medium", choice: "low" }, runningArgs: running });
    cleared.db.prepare("UPDATE nodes SET effort_choice = NULL WHERE id = ?").run(cleared.node.id);
    expect(await cleared.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "settings_drift", detail: { differs: ["effort"] } });
    expect(cleared.calls).toEqual([]);
    // No difference without a choice: no refusal, and the note says effort is kept.
    const same = world({ savedEffort: { authored: "high" }, runningArgs: running });
    const kept = await same.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(kept).toMatchObject({ ok: true, settings: { effort: { running: "high", relaunch: "high", changes: false, source: "authored" } } });
    expect((kept as { settings: { note: string } }).settings.note).toContain("effort included");
  });

  it("refuses drift in home and cwd, naming each", async () => {
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

  it.each([
    "node --pending-deprecation /absolute/bin/codex.js",
    "node --max-http-header-size 16384 /absolute/bin/codex.js",
    "node relative/bin/codex.js",
    "node /opt/codex/renamed-entry.js",
  ])("preserves the existing node launcher acceptance for %s without exact argv", async between => {
    const w = world({ between, facts: { 150: null } });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "regression" })).toMatchObject({ ok: true });
    expect(w.calls).toContain("signalPid 150 TERM");
  });

  it("refuses a MainThread supervisor mentioning Codex outside its launcher script", async () => {
    const betweenName = "MainThread";
    for (const between of ["node /opt/supervisor.js --project=codex", "node /opt/codex-supervisor.js", "node -e codex", "node /opt/tools.js /usr/local/bin/codex", "node --require /absolute/bin/codex.js /opt/supervisor.js", "node --eval=0 /absolute/bin/codex.js", "node --title /absolute/bin/codex.js /opt/supervisor.js"]) {
      const w = world({ between, betweenName, facts: { 150: facts({ exe: "/usr/bin/node", argv: between.split(" ") }) } });
      expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "regression" }), between).toMatchObject({ ok: false, code: "pane_shape_unknown" });
      expect(w.calls, between).toEqual([]);
    }
  });

  it("recognizes a MainThread Codex launcher after Node options", async () => {
    const betweenName = "MainThread";
    for (const options of ["--no-warnings", "--enable-source-maps --no-warnings", "--require /opt/preload.js", "--import=/opt/preload.mjs", "--inspect=127.0.0.1:9229", "--"]) {
      const w = world({ between: `node ${options} /absolute/bin/codex.js`, betweenName, facts: { 150: facts({ exe: "/usr/bin/node", argv: ["node", ...options.split(" "), "/absolute/bin/codex.js"] }) } });
      expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true }), options).toMatchObject({ ok: true, paneShape: "shell_backed" });
      expect(w.calls).toEqual([]);
    }
  });

  it("uses exact argv to distinguish a MainThread supervisor from a spaced launcher path", async () => {
    const betweenName = "MainThread";
    const cases = [
      { argv: ["node", "--require", "/tmp/preload /absolute/bin/codex.js", "/opt/supervisor.js"], accepted: false },
      { argv: ["node", "--require", "/tmp/preload with spaces.js", "/opt/tools/bin/codex.js"], accepted: true },
      { argv: ["node", "--no-warnings", "/opt/my tools/bin/codex.js"], accepted: true },
    ];
    for (const { argv, accepted } of cases) {
      const w = world({ between: argv.join(" "), betweenName, facts: { 150: facts({ exe: "/usr/bin/node", argv }) } });
      expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "regression" })).toMatchObject(accepted
        ? { ok: true, paneShape: "shell_backed" } : { ok: false, code: "pane_shape_unknown" });
      if (accepted) expect(w.calls).toContain("signalPid 150 TERM");
      else expect(w.calls).toEqual([]);
    }
  });

  it("refuses a MainThread launcher with unreadable exact argv", async () => {
    const betweenName = "MainThread";
    for (const observed of [null, facts({ exe: "/usr/bin/node" }), facts({ exe: "/usr/bin/node", argv: null }), facts({ exe: "/usr/bin/node", argv: [] })]) {
      const w = world({ between: "node /usr/local/bin/codex", betweenName, facts: { 150: observed } });
      expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({ ok: false, code: "pane_shape_unknown" });
      expect(w.calls).toEqual([]);
    }
  });

  it.each(["survives", "launcher PID reused", "exits after KILL", "PID reused"])("checks launcher and native identities before KILL and resume: %s", async nativeState => {
    const w = world({ between: "node /usr/local/bin/codex", betweenName: "MainThread",
      facts: { 150: facts({ exe: "/usr/bin/node", argv: ["node", "/usr/local/bin/codex"] }) } });
    const signalPid = w.tmux.signalPid;
    w.tmux.signalPid = async (pid, signal) => {
      const result = await signalPid(pid, signal);
      if (nativeState !== "exits after KILL" || signal !== "KILL") {
        const launcherRows: NativeProcessRow[] = nativeState === "exits after KILL" || nativeState === "launcher PID reused"
          ? [{ pid: 150, ppid: 100, pgid: 150, tpgid: 150, executableName: "MainThread", command: "node /usr/local/bin/codex",
            startedAt: nativeState === "launcher PID reused" ? LATER : LSTART }] : [];
        w.setRows([shellRow(100, 100), ...launcherRows, codexRow(200, launcherRows.length ? 150 : 1, `-m gpt-5.5 -s workspace-write resume ${TOKEN}`,
          nativeState === "PID reused" ? LATER : LSTART)]);
      }
      return result;
    };
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "regression" });
    const survives = nativeState === "survives" || nativeState === "launcher PID reused";
    expect(result).toMatchObject({ ok: true, outcome: survives ? "not_started" : "restarted_account_unverified" });
    if (survives) expect(w.launches).toEqual([]);
    else expect(w.launches).toHaveLength(1);
    if (nativeState === "exits after KILL") expect(w.calls).toContain("signalPid 150 KILL");
    else expect(w.calls).not.toContain("signalPid 150 KILL");
  });

  it("recognizes a MainThread-named npm launcher only when its OS executable is Node", async () => {
    for (const exe of ["/usr/local/bin/node", "/usr/bin/python3", "", null]) {
      const w = world({ between: "node /usr/local/bin/codex", betweenName: "MainThread",
        facts: { 150: exe === null ? null : facts({ exe, argv: ["node", "/usr/local/bin/codex"] }) } });
      const result = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
      expect(result).toMatchObject(exe?.endsWith("/node")
        ? { ok: true, paneShape: "shell_backed" }
        : { ok: false, code: "pane_shape_unknown" });
      expect(w.calls).toEqual([]);
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

describe("rig seat restart --keep-conversation: conflicting retained native-thread evidence", () => {
  const Y = "019fd98d-16a1-7981-8000-000000000002";

  it("refuses when a fully readable read of the running Codex's own logs names only another conversation: nothing stopped, nothing typed", async () => {
    for (const plan of [true, false]) {
      const w = world({ evidence: { thread: Y, fullyReadable: true } });
      const result = await w.service.restartInPlace({ seatRef: SEAT, ...(plan ? { plan: true } : { reason: "take the home's account" }) });
      expect(result).toMatchObject({ ok: false, code: "resume_binding_unverified",
        detail: { reason: "conflicting retained native-thread evidence", loggedConversation: Y } });
      expect((result as { message: string }).message).toMatch(/^Conflicting retained native-thread evidence: .*Nothing was stopped and nothing was typed\.$/);
      expect(w.calls).toEqual([]);
      expect(w.launches).toEqual([]);
      expect(w.events()).toEqual([]);
    }
  });

  it("keeps today's ok, with a note, whenever the evidence is incomplete, ambiguous, missing or the same conversation", async () => {
    const cases: Array<[CodexThreadEvidence, string]> = [
      [{ thread: TOKEN, fullyReadable: true }, "no other conversation logged"],
      [{ thread: Y, fullyReadable: false, incomplete: "unreadable" }, "not established: a native database was unreadable"],
      [{ thread: Y, fullyReadable: false, incomplete: "discovery" }, "not established: the native databases couldn't all be found"],
      [{ reason: "ambiguous_threads", fullyReadable: true }, "not established: ambiguous_threads"],
      [{ reason: "no_log_row", fullyReadable: true }, "not established: no_log_row"],
      [{ reason: "sqlite_unreadable", fullyReadable: false, incomplete: "unreadable" }, "not established: sqlite_unreadable"],
    ];
    for (const [evidence, note] of cases) {
      const w = world({ evidence });
      expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true }))
        .toMatchObject({ ok: true, conversationProof: "argv", currentConversation: note });
    }
    // Execute still restarts on incomplete evidence, exactly as before.
    const w = world({ evidence: { thread: Y, fullyReadable: false, incomplete: "discovery" } });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "take the home's account" })).toMatchObject({ ok: true, outcome: "restarted_account_unverified" });
    expect(w.calls).toEqual(["signalPid 200 TERM"]);
  });

  it("argv naming no token keeps the native-logs proof unchanged, with no conflict check", async () => {
    const w = world({ runningArgs: "-m gpt-5.5 -s workspace-write -C /work", threadId: TOKEN, evidence: { thread: Y, fullyReadable: true } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(result).toMatchObject({ ok: true, conversationProof: "native_logs" });
    expect(result).not.toHaveProperty("currentConversation");
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

  it("#1524 (b): an unproven resume asks for the live Codex to be checked and adopted first, not for another resume", async () => {
    const error = "Codex resume could not be proven within the resume window: no_log_row. The session was preserved; nothing was restarted.";
    const w = world({ launch: { ok: false, error, recovery: "attention_required", resumeUnproven: true, verifierInput: "none" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ ok: true, outcome: "incomplete", account: { startupGate: error } });
    const remaining = (result as { remainingStep: string }).remainingStep;
    expect(remaining).toContain("may still be running in the pane");
    expect(remaining).toContain(`rig reconcile-session ${SEAT} --no-launch`);
    expect(remaining).toContain("only if the original is gone");
    expect(remaining).not.toMatch(/^Resolve what Codex shows in the pane, then resume/);
    expect(w.launches).toHaveLength(1);
  });

  it.each([
    ["hook_trust_gate", "Codex is waiting for hook trust approval before the session can become interactive.", "Codex is waiting for a hook review decision in the pane"],
    ["trust_gate", "Codex is waiting for the folder trust prompt to be answered.", "Codex is waiting for a folder trust decision in the pane"],
    ["model_selection_gate", "Codex is waiting for model selection before the session can become interactive.", "Codex is waiting for a model choice in the pane"],
    ["update_gate", "Codex is showing an update prompt.", "Codex is waiting for an update decision OpenRig could not skip in the pane"],
  ])("incomplete names the %s startup gate and its native decision; it says what was typed and that nothing was retried", async (gate, error, step) => {
    const w = world({ launch: { ok: false, error, recovery: "attention_required", gate, verifierInput: "none", ...(gate === "update_gate" ? { gateChoice: true } : {}) } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    const recovery = `codex -m 'gpt-5.5' -s workspace-write resume '${TOKEN}'`;
    expect(result).toMatchObject({ ok: true, outcome: "incomplete", recoveryCommand: recovery,
      account: { startupGate: error, startupGateKind: gate } });
    const remaining = (result as { remainingStep: string }).remainingStep;
    expect(remaining).toContain(step);
    expect(remaining).toContain(`(${SEAT}, pane %1)`);
    expect(remaining).toContain(recovery);
    expect(remaining).toContain("That decision is for the person or an authorised operator");
    expect(remaining).toContain(`see it with \`rig capture ${SEAT}\``);
    expect(remaining).toContain("OpenRig typed nothing into this screen; nothing was retried or relaunched.");
    expect(remaining).not.toContain("answered");
    expect(remaining).not.toMatch(/\b(approve|trust all|choose|select|install)\b/i); // names the decision, never makes or prescribes it
    expect(w.launches).toHaveLength(1); // the one resume; no second launch
  });

  it("through the adapter: a skip key sent to an update prompt that stays on screen is reported as sent, never as nothing answered", async () => {
    const prompt = ["✨ Update available! 0.120.0 -> 0.121.0", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "Press enter to continue"].join("\n");
    const keys: string[][] = [];
    const tmux = { getPaneCommand: async () => "codex", capturePaneScreen: async () => prompt, capturePaneContent: async () => prompt,
      getPanePid: async () => 901, sendKeys: async (_: string, k: string[]) => { keys.push(k); return { ok: true }; } } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: {} as never, sleep: async () => {},
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex", argv: ["codex"] }] });
    const launch = await adapter.verifyResumeInPane("impl", "tok");
    expect(keys).toEqual([["3"]]);
    const w = world({ launch });
    const remaining = (await w.service.restartInPlace({ seatRef: SEAT, reason: "x" }) as { remainingStep: string }).remainingStep;
    expect(remaining).toContain("Codex is waiting for an update decision OpenRig could not skip");
    expect(remaining).toContain("OpenRig sent the update prompt's skip key (3) once while checking the resume; nothing was retried or relaunched.");
    expect(remaining).not.toMatch(/typed nothing|answered/);
  });

  // #1524 (b), through the real adapter: what the adapter itself reports decides the step, not a flag the test supplies.
  it("through the adapter: a capture that times out before any proof result asks for the live Codex first, not another resume", async () => {
    const tmux = { getPanePid: async () => 901, capturePaneScreen: async () => "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything",
      capturePaneContent: async () => "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything",
      getPaneCommand: () => new Promise<string>((resolve) => setTimeout(() => resolve("codex"), 120)) } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: {} as never, sleep: async () => {}, resumeProofWindowMs: 40,
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex resume tok", argv: ["codex", "resume", "tok"] }],
      readResumeEvidence: () => ({ threadId: "tok" }) });
    const launch = await adapter.verifyResumeInPane("impl", "tok");
    expect(launch).toMatchObject({ ok: false, recovery: "attention_required", resumeUnproven: true });
    const r = await report(launch);
    expect(r.remainingStep).toContain("may still be running in the pane");
    expect(r.remainingStep).toContain(`rig reconcile-session ${SEAT} --no-launch`);
    expect(r.remainingStep).not.toMatch(/^Resolve what Codex shows in the pane, then resume/);
  });

  it("through the adapter: a resume whose records name another conversation gets its own step, not the unproven one", async () => {
    const ready = "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything";
    const tmux = { getPanePid: async () => 901, getPaneCommand: async () => "codex", capturePaneScreen: async () => ready, capturePaneContent: async () => ready } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: {} as never, sleep: async () => {},
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex resume tok", argv: ["codex", "resume", "tok"] }],
      readResumeEvidence: () => ({ threadId: "another-thread" }) });
    const launch = await adapter.verifyResumeInPane("impl", "tok");
    expect(launch).toMatchObject({ ok: false, recovery: "attention_required", resumeMismatch: { opened: "another-thread" } });
    expect(launch).not.toHaveProperty("resumeUnproven");
    const r = await report(launch);
    expect(r.remainingStep).toContain("The resumed Codex opened another-thread, not the seat's conversation");
    expect(r.remainingStep).toContain("find the seat's conversation before resuming again");
    expect(r.remainingStep).not.toContain("didn't prove the conversation in time");
  });

  // An in-place restart did restart the pane, so its result never repeats the adapter's "nothing was restarted",
  // which stays true for a caller that restarted nothing.
  const ready = "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything";
  const readyTmux = () => ({ getPanePid: async () => 901, getPaneCommand: async () => "codex", capturePaneScreen: async () => ready, capturePaneContent: async () => ready } as unknown as TmuxAdapter);
  it.each([
    ["unproven: no Codex process tied to the conversation", "codex", () => ({ threadId: "tok" })],
    ["disproved: the records name another conversation", "codex resume tok", () => ({ threadId: "another-thread" })],
  ] as const)("through the adapter, %s: the in-place result says the pane restarted and to check it", async (_case, command, evidence) => {
    const adapter = new CodexRuntimeAdapter({ tmux: readyTmux(), fsOps: {} as never, sleep: async () => {}, resumeProofWindowMs: 40,
      listProcesses: () => [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command, argv: command.split(" ") }],
      readResumeEvidence: evidence });
    const launch = await adapter.verifyResumeInPane("impl", "tok");
    // What every other caller shows is unchanged: the adapter's own result still says nothing was restarted.
    expect(launch).toMatchObject({ ok: false, error: expect.stringContaining("The session was preserved; nothing was restarted.") });
    const r = await report(launch);
    expect(r.message).toMatch(/^The pane restarted: the original Codex exited and the resume started in the same pane, but /);
    expect(r.message).toContain(`Check the pane with rig capture ${SEAT}.`);
    expect(JSON.stringify(r)).not.toContain("nothing was restarted");
  });

  // Round 4: the report's message, startupGate and step all describe the newest moment, through the real adapter.
  const UPDATING = ["✨ Update available! 0.120.0 -> 0.121.0", "Updating Codex..."].join("\n");
  const SKIPPABLE = ["✨ Update available! 0.120.0 -> 0.121.0", "› 1. Update now (runs `npm install -g @openai/codex`)", "  2. Skip", "  3. Skip until next version", "Press enter to continue"].join("\n");
  const RESUMED = "OpenAI Codex (v0.120.0)\n› Ask Codex to do anything";
  const BOOTING = "Loading conversation...";
  const CODEX_ROW = [{ pid: 901, ppid: 1, pgid: 901, tpgid: 901, executableName: "codex", startedAt: "Sat Jan  1 12:00:00 2000", command: "codex", argv: ["codex"] }];
  function scriptedAdapter(screen: (n: number, keysSent: number) => string, sendResult: TmuxResult = { ok: true }) {
    let n = 0; let keysSent = 0;
    const tmux = { getPaneCommand: async () => "codex", getPanePid: async () => 901,
      capturePaneScreen: async () => screen(++n, keysSent), capturePaneContent: async () => screen(++n, keysSent),
      sendKeys: async () => { keysSent++; return sendResult; } } as unknown as TmuxAdapter;
    const adapter = new CodexRuntimeAdapter({ tmux, fsOps: {} as never, sleep: async () => {}, listProcesses: () => CODEX_ROW });
    return { adapter, captures: () => n, keys: () => keysSent };
  }
  async function updatingCaptures(): Promise<number> {
    const a = scriptedAdapter(() => UPDATING); await a.adapter.verifyResumeInPane("impl", "tok"); return a.captures();
  }
  async function report(launch: HarnessLaunchResult) {
    const w = world({ launch });
    return await w.service.restartInPlace({ seatRef: SEAT, reason: "x" }) as { message: string; remainingStep: string; account: { startupGate: string | null; startupGateKind: string | null } };
  }

  it.each([["resumed", RESUMED], ["booting", BOOTING]] as const)(
    "a final-poll recheck showing a %s screen leaves no older update text in the message, startupGate or step",
    async (_label, last) => {
      const total = await updatingCaptures() + 1;
      const a = scriptedAdapter((n) => (n === total ? last : n === total - 1 ? SKIPPABLE : UPDATING));
      const launch = await a.adapter.verifyResumeInPane("impl", "tok");
      expect(a.captures()).toBe(total);
      expect(launch).not.toHaveProperty("gate");
      const r = await report(launch);
      for (const text of [r.message, r.account.startupGate ?? "", r.remainingStep]) expect(text).not.toMatch(/update/i);
      expect(r.account.startupGateKind).toBeNull();
    });

  it("a skip key sent with only booting screens after it: the generic step says the key was sent", async () => {
    const a = scriptedAdapter((_n, keys) => (keys > 0 ? BOOTING : SKIPPABLE));
    const launch = await a.adapter.verifyResumeInPane("impl", "tok");
    expect(a.keys()).toBe(1);
    expect(launch).toMatchObject({ ok: false, verifierInput: "update_skip_key_sent" });
    expect(launch).not.toHaveProperty("gate");
    const r = await report(launch);
    expect(r.remainingStep).toContain("OpenRig sent the update prompt's skip key (3) once while checking the resume; nothing was retried or relaunched.");
    expect(r.message).not.toMatch(/update/i);
    expect(r.account.startupGate ?? "").not.toMatch(/update/i);
  });

  it("a failed skip-key send, through the adapter: no 'could not skip'; the effect is unknown in the message, startupGate and step", async () => {
    const total = await updatingCaptures() + 1;
    const a = scriptedAdapter((n) => (n >= total - 2 ? SKIPPABLE : UPDATING), { ok: false, code: "unknown", message: "injected send failure" } as TmuxResult);
    const launch = await a.adapter.verifyResumeInPane("impl", "tok");
    const r = await report(launch);
    expect(r.message).toContain("Could not send the update prompt's skip key (3): injected send failure; its effect is unknown.");
    expect(r.account.startupGate).toContain("Could not send the update prompt's skip key (3)");
    expect(r.remainingStep).toContain("The send failed, so the key's effect is unknown.");
    for (const text of [r.message, r.account.startupGate ?? "", r.remainingStep]) expect(text).not.toMatch(/could not skip/i);
  });

  it("an update screen without the recognised skip option is described neutrally: neither progress nor a waiting decision", async () => {
    const w = world({ launch: { ok: false, error: "Codex is showing an update prompt.", recovery: "attention_required", gate: "update_gate", gateChoice: false, verifierInput: "none" } });
    const remaining = (await w.service.restartInPlace({ seatRef: SEAT, reason: "x" }) as { remainingStep: string }).remainingStep;
    expect(remaining).toContain(`Codex is showing an update screen in the pane (${SEAT}, pane %1); see it with \`rig capture ${SEAT}\`. Check it before you run the recovery command`);
    expect(remaining).not.toMatch(/decision|in progress|waiting/);
  });

  it.each([
    ["sent", "update_skip_key_sent", "The last screen OpenRig saw, before it sent the update prompt's skip key (3), offered an update choice. What Codex showed after the key wasn't observed."],
    ["failed", "update_skip_key_failed", "The last screen OpenRig saw, before it tried to send the update prompt's skip key (3), offered an update choice. The send failed, so the key's effect is unknown."],
  ] as const)("a screen OpenRig acted on afterwards (skip key %s) is reported as the screen before that input", async (_label, verifierInput, opening) => {
    const w = world({ launch: { ok: false, error: "Codex is showing an update prompt.", recovery: "attention_required", gate: "update_gate", gateChoice: true, screenBeforeInput: true, verifierInput } });
    const remaining = (await w.service.restartInPlace({ seatRef: SEAT, reason: "x" }) as { remainingStep: string }).remainingStep;
    expect(remaining.startsWith(opening)).toBe(true);
    expect(remaining).toContain(`See it with \`rig capture ${SEAT}\` (pane %1), then run the recovery command`);
    expect(remaining).toMatch(/nothing was retried or relaunched\.$/i);
    expect(remaining).not.toMatch(/is waiting|could not skip/);
  });

  it("a launch result that doesn't say what was typed claims nothing about input", async () => {
    const w = world({ launch: { ok: false, error: "Codex is waiting for hook trust approval.", recovery: "attention_required", gate: "hook_trust_gate" } });
    const remaining = (await w.service.restartInPlace({ seatRef: SEAT, reason: "x" }) as { remainingStep: string }).remainingStep;
    expect(remaining).toMatch(/Nothing was retried or relaunched\.$/);
    expect(remaining).not.toMatch(/typed nothing|answered/);
  });

  it("the sign-in and generic steps are unchanged; an unnamed gate still says what kind it is", async () => {
    const signIn = world({ launch: { ok: false, error: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.", recovery: "attention_required", gate: "codex_auth_refusal" } });
    expect(await signIn.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({
      remainingStep: `Whoever owns the sign-in signs in to Codex in ${HOME}, then the conversation resumes with the recovery command.`,
      account: { startupGateKind: "codex_auth_refusal" } });
    const generic = world({ launch: { ok: false, error: "Codex is waiting for an MCP server decision.", recovery: "attention_required", gate: "mcp_gate" } });
    expect(await generic.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({
      remainingStep: "Resolve what Codex shows in the pane, then resume with the recovery command. Nothing was retried.",
      account: { startupGateKind: "mcp_gate" } });
    const unknown = world({ launch: { ok: false, error: "Codex resume could not be confirmed.", recovery: "attention_required" } });
    expect(await unknown.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({
      remainingStep: "Resolve what Codex shows in the pane, then resume with the recovery command. Nothing was retried.",
      account: { startupGateKind: null } });
  });

  it("--plan and the report show the --no-daemon launch flag as launch evidence only", async () => {
    const daemon = world();
    const absent = await daemon.service.restartInPlace({ seatRef: SEAT, plan: true }) as { codexNoDaemonFlag: { present: boolean; detail: string } };
    expect(absent.codexNoDaemonFlag).toEqual({ present: false,
      detail: "Launch evidence: the running Codex's command line has no --no-daemon. This doesn't show whether an app-server process, its login or any lock is involved." });
    const optOut = world({ runningArgs: `--no-daemon -m gpt-5.5 -s workspace-write resume ${TOKEN}` });
    expect(await optOut.service.restartInPlace({ seatRef: SEAT, plan: true })).toMatchObject({
      codexNoDaemonFlag: { present: true, detail: "Launch evidence: the running Codex was started with --no-daemon. This doesn't show whether an app-server process, its login or any lock is involved." } });
    const restarted = await optOut.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(restarted).toMatchObject({ outcome: "restarted_account_unverified", codexNoDaemonFlag: { present: true } });
  });

  it("--plan and the report carry no process mode, and only a constant billing route for older CLIs", async () => {
    for (const runningArgs of [undefined, `--no-daemon -m gpt-5.5 -s workspace-write resume ${TOKEN}`]) {
      const w = world(runningArgs ? { runningArgs } : {});
      for (const result of [await w.service.restartInPlace({ seatRef: SEAT, plan: true }), await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })]) {
        expect(result).not.toHaveProperty("processMode");
        expect(result).toMatchObject({ billingRoute: { state: "unknown", detail: "Not reported." } });
        // A CLI before 0.7.0 prints this unguarded: the read must succeed.
        expect(`Billing route: ${(result as unknown as { billingRoute: { detail: string } }).billingRoute.detail}`).toBe("Billing route: Not reported.");
        // The launch flag's line still says it doesn't show app-server involvement.
        expect(result).toMatchObject({ codexNoDaemonFlag: { detail: expect.stringContaining("doesn't show whether an app-server process") } });
      }
    }
  });

  it("incomplete, never fresh, when Codex has no saved session for the conversation", async () => {
    const w = world({ launch: { ok: false, error: "Codex resume failed: no saved session found", recovery: "retry_fresh" } });
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    expect(result).toMatchObject({ outcome: "incomplete", remainingStep: expect.stringContaining("no fresh session was started") });
    expect(w.launches).toHaveLength(1);
  });

  it("proves the resume in the home the running Codex uses, in both pane shapes, though the seat declares none", async () => {
    // The seat has no env: home, so the adapter would fall back to the daemon's; the restart already read the real one.
    for (const shape of ["shell_backed", "direct_native"] as const) {
      const w = world({ shape, ...(shape === "direct_native" ? { remainOnExit: null } : {}) });
      const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
      expect(result).toMatchObject({ ok: true, outcome: "restarted_account_unverified", paneShape: shape });
      expect(w.proofHomes).toEqual([HOME]);
    }
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

  it("an --add-dir holding a space survives whole: the relaunch reads the exact argv, not ps's whitespace split", async () => {
    // ps shows this Codex's argv joined by spaces, so its cwd's .git ("/home/u/my repo/.git") reads as "/home/u/my" + "repo/.git".
    const argv = ["/usr/local/bin/codex", "-m", "gpt-5.5", "-s", "workspace-write", "resume", TOKEN, "--add-dir", "/home/u/my repo/.git"];
    const w = world({ runningArgs: argv.slice(1).join(" "), runningArgv: argv, facts: { 200: facts({ argv }) } });
    await w.service.restartInPlace({ seatRef: SEAT, plan: true });
    expect(w.builds).toEqual([{ running: { networkOverride: false, daemonOptOut: false, addDirs: ["/home/u/my repo/.git"] } }]);
  });

  it("does not plan a restart when the saved token occurs only inside an argv option value", async () => {
    const argv = ["/usr/local/bin/codex", "resume", "--add-dir", `/tmp/${TOKEN}`, "019a0000-0000-7000-8000-000000000002"];
    const w = world({ runningArgs: argv.slice(1).join(" "), runningArgv: argv });
    expect(await w.service.restartInPlace({ seatRef: SEAT, plan: true }))
      .toMatchObject({ ok: false, code: "resume_binding_unverified" });
    expect(w.calls).toEqual([]);
  });

  it("a /proc cmdline read keeps every argv word exactly: spaces and empty words included", () => {
    expect(procCmdlineArgv(Buffer.from("/usr/local/bin/codex\0resume\0tok\0--add-dir\0/home/u/my repo/.git\0"))).toEqual(
      ["/usr/local/bin/codex", "resume", "tok", "--add-dir", "/home/u/my repo/.git"]);
    expect(procCmdlineArgv("codex\0-c\0\0")).toEqual(["codex", "-c", ""]);
    expect(procCmdlineArgv("")).toBeNull();
  });

  it.skipIf(!fs.existsSync("/proc/self/cmdline"))("the default reader takes a process's exact argv from /proc, a word with a space included", async () => {
    const args = ["-e", "setTimeout(() => {}, 30000)", "my repo/.git"];
    const child = spawn(process.execPath, args, { stdio: "ignore" });
    try {
      // Until exec completes, /proc shows the parent's argv; wait for the child's own.
      for (let tries = 0; tries < 200 && !fs.readFileSync(`/proc/${child.pid}/cmdline`, "utf8").includes("my repo"); tries++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect((await defaultInPlaceRestartIo().readProcess(child.pid!))?.argv).toEqual([process.execPath, ...args]);
    } finally {
      child.kill();
    }
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
    w.db.prepare("UPDATE events SET payload = json_set(payload, '$.accountTextAtRestart', NULL) WHERE type = 'seat.restart_in_place_finished'").run();
    w.print("Account: me@example.com");
    expect(await w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" }))
      .toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("the event log keeps digests, not account names", async () => {
    const w = world({ screenBefore: "Account: me@example.com" });
    await w.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    const finished = w.events().at(-1)!;
    expect(Object.values(finished.accountTextAtRestart.counts)).toEqual([1]);
    expect(JSON.stringify(finished)).not.toContain("example.com");
  });
});

// #1264: tmux trims the oldest history once it's full, so the verdict can't depend on how much is kept.
describe("--verify compares only text after the restart, however much history tmux has trimmed since", () => {
  const rollout = JSON.stringify({ timestamp: "2099-01-01T00:00:00Z", type: "response_item", payload: { type: "function_call_output" } });
  const OLD = "  Account:  me@example.com (Pro)";
  const filler = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `output line ${from + i}`).join("\n");
  const verify = (w: ReturnType<typeof world>) => w.service.verifyRestartInPlace({ seatRef: SEAT, expectAccount: "me@example.com" });

  // Two old /status lines, then twelve lines of output; the last three are the visible screen.
  async function restartedAfterOldStatus() {
    const w = world({ screenBefore: [OLD, OLD, filler(1, 12)].join("\n"), rollout });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    return w;
  }

  it("a new /status line counts after the old copies are trimmed (main reported it unverified)", async () => {
    const w = await restartedAfterOldStatus();
    w.print(filler(13, 20));
    w.trim(2);
    w.print(OLD);
    expect(await verify(w)).toMatchObject({ outcome: "moved", accountEvidence: { state: "matched" } });
  });

  it("still counts it when trimming has cut into the anchor, or removed all of it", async () => {
    const partly = await restartedAfterOldStatus();
    partly.trim(5);
    partly.print(OLD);
    expect(await verify(partly)).toMatchObject({ outcome: "moved" });

    const whole = await restartedAfterOldStatus();
    whole.print(filler(13, 20));
    whole.trim(11);
    whole.print(OLD);
    expect(await verify(whole)).toMatchObject({ outcome: "moved" });
  });

  it("a line from before the restart never counts as new, trimmed or not", async () => {
    // In history above the anchor, with nothing new printed.
    const above = await restartedAfterOldStatus();
    above.print(filler(13, 20));
    above.trim(1);
    expect(await verify(above)).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });

    // On the screen at the restart (after the anchor), with the whole anchor trimmed since.
    const onScreen = world({ screenBefore: [filler(1, 12), OLD].join("\n"), rollout });
    await onScreen.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    onScreen.print(filler(13, 20));
    onScreen.trim(12);
    expect(await verify(onScreen)).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });

    // Inside the anchor itself, with the anchor's start trimmed.
    const inAnchor = world({ screenBefore: [filler(1, 4), OLD, filler(5, 12)].join("\n"), rollout });
    await inAnchor.service.restartInPlace({ seatRef: SEAT, reason: "x" });
    inAnchor.trim(4);
    expect(await verify(inAnchor)).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("a copy of the anchor on the screen at the restart doesn't move where counting starts", async () => {
    // History ends with the anchor (a to h) and one more line; the screen shows an old /status, then the anchor again.
    const anchor = "abcdefgh".split("").map((letter) => `step ${letter}`);
    const w = world({ screenBefore: [...anchor, "tail", OLD, ...anchor].join("\n"), screenRows: 9, rollout });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
    w.erase(8);
    expect(await verify(w)).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("captures that don't line up give a whole-pane baseline: a new /status line still counts, the old one never does", async () => {
    // The history-only capture read a, b, tail; by the whole-pane capture the pane read b, tail, then an old /status.
    const restartMisaligned = async () => {
      const w = world({ screenBefore: ["b", "tail", OLD].join("\n"), historyCapture: "a\nb\ntail", rollout });
      expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "x" })).toMatchObject({ outcome: "restarted_account_unverified" });
      expect(w.events().at(-1)!.accountTextAtRestart.anchor).toEqual([]);
      return w;
    };
    const fresh = await restartMisaligned();
    fresh.print(OLD);
    expect(await verify(fresh)).toMatchObject({ outcome: "moved", accountEvidence: { state: "matched" } });

    const unchanged = await restartMisaligned();
    expect(await verify(unchanged)).toMatchObject({ outcome: "restarted_account_unverified", accountEvidence: { state: "not_observed" } });
  });

  it("a restart recorded with the earlier whole-pane counts is still compared as before", async () => {
    const w = await restartedAfterOldStatus();
    w.db.prepare("UPDATE events SET payload = json_remove(json_set(payload, '$.accountLinesAtRestart', json(?)), '$.accountTextAtRestart') WHERE type = 'seat.restart_in_place_finished'")
      .run(JSON.stringify({ [createHash("sha256").update(OLD.trim()).digest("hex").slice(0, 16)]: 2 }));
    w.print(OLD);
    expect(await verify(w)).toMatchObject({ outcome: "moved" });
  });
});

describe("accountTextMark", () => {
  const key = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 16);
  it("counts from where the anchor ends in history, not from a later copy on the screen", () => {
    expect(accountTextMark({ history: "a\nb\ntail", all: "a\nb\ntail\nAccount: x\na\nb" }))
      .toEqual({ anchor: [key("a"), key("b")], counts: { [key("Account: x")]: 1 } });
  });
  it("counts the whole pane, with no anchor, when the two captures don't line up", () => {
    expect(accountTextMark({ history: "a\nb\ntail", all: "b\ntail\nAccount: x" })).toEqual({ anchor: [], counts: { [key("Account: x")]: 1 } });
  });
  it("records nothing when the pane couldn't be read", () => {
    expect(accountTextMark(null)).toBeNull();
  });
});

describe("linesAfterAnchor", () => {
  const key = (line: string) => createHash("sha256").update(line).digest("hex").slice(0, 16);
  it("takes the anchor's last occurrence, so a repeat only shortens what is compared", () => {
    expect(linesAfterAnchor(["a", "b", "x", "a", "b", "y"], [key("a"), key("b")])).toEqual(["y"]);
  });
  it("uses the longest surviving end of a trimmed anchor, and everything when none survives", () => {
    expect(linesAfterAnchor(["b", "c", "y"], [key("a"), key("b"), key("c")])).toEqual(["y"]);
    expect(linesAfterAnchor(["y", "z"], [key("a"), key("b")])).toEqual(["y", "z"]);
    expect(linesAfterAnchor(["y"], [])).toEqual(["y"]);
  });
});


describe("post-relaunch identity observation window", () => {
  // Synthetic process tables model the saved launcher-only observation, not native timing.
  // Reuse the existing row builders and lifecycle fixture; only observation is staged.
  const replacement = (shape: Shape, token = TOKEN): NativeProcessRow[] => {
    const root = shape === "shell_backed" ? 100 : 300;
    return [shellRow(root, 350),
      { pid: 350, ppid: root, pgid: 350, tpgid: 350, executableName: "sh", startedAt: LATER,
        command: "/bin/sh /tmp/openrig-tmux-send-fixture.txt" },
      { pid: 351, ppid: 350, pgid: 350, tpgid: 350, executableName: "node", startedAt: LATER,
        command: `/usr/bin/node /opt/codex/bin/codex.js resume ${token}` },
      codexRow(400, 351, `-m gpt-5.5 -s workspace-write resume ${token}`, LATER, 350)];
  };
  const verdicts = (w: ReturnType<typeof world>) => w.db.prepare("SELECT verdict FROM observed_identity ORDER BY rowid")
    .all() as Array<{ verdict: string }>;
  const auditVerdicts = (w: ReturnType<typeof world>) => w.db.exec(`
    CREATE TEMP TABLE observed_identity (verdict TEXT);
    CREATE TEMP TRIGGER observe_identity_insert AFTER INSERT ON seat_identity_verdicts
      BEGIN INSERT INTO observed_identity VALUES (NEW.verdict); END;
    CREATE TEMP TRIGGER observe_identity_update AFTER UPDATE ON seat_identity_verdicts
      BEGIN INSERT INTO observed_identity VALUES (NEW.verdict); END;
  `);

  it.each(["shell_backed", "direct_native"] as const)("%s: waits for the native child, keeps truthful verdicts and launches once", async (shape) => {
    const rows = replacement(shape);
    const w = world({ shape, replacementRows: read => read <= 4 ? rows.slice(0, -1) : rows,
      afterReplacementYield: async () => {
        expect(verdicts(w).at(-1)?.verdict).toBe("mismatch");
        expect(w.events().map(event => event.type)).toEqual(["seat.restart_in_place_started"]);
        expect(w.sessionRegistry.getBindingForNode(w.node.id)?.tmuxPane).toBe("%1");
        if (shape === "direct_native") expect(await w.tmux.getPaneLocalOption("%1", "remain-on-exit")).toBe("on");
      } });
    auditVerdicts(w);
    const result = await w.service.restartInPlace({ seatRef: SEAT, reason: "observe the replacement" });
    expect(result).toMatchObject({ outcome: "restarted_account_unverified", newProcess: { pid: 400 }, account: { verdict: "unverified" } });
    expect(w.replacementYields).toEqual([1, 1]);
    // Two null attempts each use one strict OS read and one secondary snapshot.
    // The successful attempt uses two fresh strict reads and ONE cached secondary snapshot.
    expect(w.replacementReads).toBe(7);
    expect(verdicts(w).map(row => row.verdict)).toEqual(["mismatch", "mismatch", "verified"]);
    expect(w.events().map(event => [event.type, event.outcome])).toEqual([
      ["seat.restart_in_place_started", undefined], ["seat.restart_in_place_finished", "restarted_account_unverified"]]);
    expect(w.builds).toHaveLength(1);
    expect(w.calls.filter(call => /signal.*TERM/.test(call))).toHaveLength(1);
    if (shape === "shell_backed") expect(w.launches).toHaveLength(1);
    else {
      expect(w.calls.filter(call => call.startsWith("respawn "))).toHaveLength(1);
      expect(w.calls.filter(call => call.startsWith("restore remain-on-exit"))).toEqual(["restore remain-on-exit null"]);
    }
  });

  it("keeps immediate success immediate, with two fresh strict reads and one secondary snapshot", async () => {
    const w = world({ replacementRows: () => replacement("shell_backed") });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "ready now" }))
      .toMatchObject({ outcome: "restarted_account_unverified" });
    expect(w.replacementYields).toEqual([]);
    expect(w.replacementReads).toBe(3);
  });

  it.each(["shell_backed", "direct_native"] as const)("%s: exhausts the default 31 evaluations without another launch", async (shape) => {
    const rows = replacement(shape).slice(0, -1);
    const w = world({ shape, replacementRows: () => rows, replacementTiming: { pollMs: 100, timeoutMs: 3_000 } });
    auditVerdicts(w);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "no native evidence" }))
      .toMatchObject({ outcome: "native_unknown" });
    expect(w.replacementYields).toEqual(Array(30).fill(100));
    // The final failed attempt reads the process table once more to name the failing check; earlier attempts do not.
    expect(w.replacementReads).toBe(63);
    expect(verdicts(w).map(row => row.verdict)).toEqual(Array(31).fill("mismatch"));
    expect(w.events()).toHaveLength(2);
    expect(w.builds).toHaveLength(1);
    if (shape === "shell_backed") expect(w.launches).toHaveLength(1);
    else {
      expect(w.calls.filter(call => call.startsWith("respawn "))).toHaveLength(1);
      expect(w.calls.some(call => call.startsWith("restore remain-on-exit"))).toBe(false);
      expect(await w.tmux.getPaneLocalOption("%1", "remain-on-exit")).toBe("on");
    }
  });

  it.each(["wrong token", "missing token", "conflicting native", "wrong OS executable"])("never promotes stable invalid evidence: %s", async kind => {
    const rows = replacement("shell_backed");
    if (kind === "wrong token") rows[3] = { ...rows[3]!, command: "/usr/local/bin/codex resume other-thread", argv: ["/usr/local/bin/codex", "resume", "other-thread"] };
    if (kind === "missing token") rows[3] = { ...rows[3]!, command: "/usr/local/bin/codex", argv: ["/usr/local/bin/codex"] };
    if (kind === "conflicting native") rows.push(codexRow(401, 351, `resume ${TOKEN}`, LATER, 350));
    if (kind === "wrong OS executable") rows[3] = { ...rows[3]!, executableName: "node" };
    const w = world({ replacementRows: () => rows });
    const report = await w.service.restartInPlace({ seatRef: SEAT, reason: "invalid evidence" });
    expect(report).toMatchObject({ outcome: "native_unknown" });
    expect(w.replacementYields).toEqual([1, 1]);
    // The final failed attempt reads the process table once more to name the failing check; earlier attempts do not.
    // The wrong-token case says the conversation the running Codex resumed does not match the record, without printing it.
    expect(w.replacementReads).toBe(7);
    if (kind === "wrong token") {
      expect(JSON.stringify(report)).toContain("does not match the seat's record");
      expect(JSON.stringify(report)).not.toContain("other-th");
    }
    expect(w.launches).toHaveLength(1);
  });

  it("allows an earlier token mismatch to resolve only into a later fully valid pair", async () => {
    const good = replacement("shell_backed");
    const bad = good.map(row => row.pid === 400 ? { ...row, command: "/usr/local/bin/codex resume other-thread", argv: ["/usr/local/bin/codex", "resume", "other-thread"] } : row);
    const w = world({ replacementRows: read => read <= 2 ? bad : good });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "later valid proof" }))
      .toMatchObject({ outcome: "restarted_account_unverified" });
    expect(w.replacementYields).toEqual([1]);
    expect(w.replacementReads).toBe(5);
  });

  it("does not join a drifting first/second fingerprint across attempts", async () => {
    const good = replacement("shell_backed");
    const drift = good.map(row => row.pid === 400 ? { ...row, startedAt: LSTART } : row);
    const w = world({ replacementRows: read => read === 2 ? drift : good });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "stable second attempt" }))
      .toMatchObject({ outcome: "restarted_account_unverified" });
    expect(w.replacementYields).toEqual([1]);
    expect(w.replacementReads).toBe(6);
  });

  it("keeps a failed secondary snapshot conjunct after each positive strict proof", async () => {
    const w = world({ replacementRows: read => read % 3 === 0 ? [] : replacement("shell_backed") });
    auditVerdicts(w);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "secondary absent" })).toMatchObject({ outcome: "native_unknown" });
    expect(w.replacementYields).toEqual([1, 1]);
    expect(w.replacementReads).toBe(9);
    // These are truthful strict-identity verdicts, not a completed-restart claim.
    expect(verdicts(w).map(row => row.verdict)).toEqual(["verified", "verified", "verified"]);
    expect(w.events().at(-1)).toMatchObject({ outcome: "native_unknown" });
  });

  it.each(["lost", "changed", "ambiguous", "pid changed"])("keeps the pane join mandatory: %s", async kind => {
    const w = world({ replacementRows: () => replacement("shell_backed") });
    const list = w.tmux.listPanes.bind(w.tmux);
    const pid = w.tmux.getPanePid.bind(w.tmux);
    w.tmux.listPanes = async session => {
      const panes = await list(session);
      if (!w.relaunched) return panes;
      if (kind === "lost") return [];
      if (kind === "changed") return panes.map(pane => ({ ...pane, id: "%2" }));
      if (kind === "ambiguous") return [...panes, { ...panes[0]!, id: "%2" }];
      return panes;
    };
    w.tmux.getPanePid = async target => w.relaunched && kind === "pid changed" ? 101
      : w.relaunched && kind === "changed" && target === "%1" ? null : pid(target);
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "pane join fails" })).toMatchObject({ outcome: "native_unknown" });
    expect(w.replacementYields).toEqual([1, 1]);
    expect(w.launches).toHaveLength(1);
  });

  it.each([[5, "restarted_account_unverified", 7], [7, "native_unknown", 7]] as const)(
    "native appears at OS read %i: respects the last allowed attempt", async (appearAt, outcome, reads) => {
      const rows = replacement("shell_backed");
      const w = world({ replacementRows: read => read < appearAt ? rows.slice(0, -1) : rows });
      expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "budget boundary" })).toMatchObject({ outcome });
      expect(w.replacementYields).toEqual([1, 1]);
      // The 7 for read 7 includes the one extra read on the final failed attempt (6 before it).
      expect(w.replacementReads).toBe(reads);
    });

  it("preserves thrown-error finalization instead of resampling an exception", async () => {
    const w = world({ replacementRows: () => replacement("shell_backed").slice(0, -1),
      afterReplacementYield: () => { throw new Error("observation sleep failed"); } });
    expect(await w.service.restartInPlace({ seatRef: SEAT, reason: "throw during observation" }))
      .toMatchObject({ outcome: "native_unknown", couldNotSee: [expect.stringContaining("observation sleep failed")] });
    expect(w.replacementYields).toEqual([1]);
    expect(w.replacementReads).toBe(2);
    expect(w.events()).toHaveLength(2);
    expect(w.launches).toHaveLength(1);
  });
});
