// Pi model-divergence read at the MONITOR WIRING: the record that settles or proclaims must be the
// current runner's own — never an earlier runner's sidecar, a resumed file's previous-pin records, or
// a fork parent's copied entries. Everything ambiguous stays pending (no refusal, no proclamation).

import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelDivergenceMonitor, type ModelDivergenceMonitorDeps, type PinnedSeat } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { readCurrentPiOccupantModel, type ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";
import { buildPiRunnerCommand } from "../src/adapters/pi-runner-protocol.js";
import { piPinReadings } from "../src/domain/model-divergence/effective-model-readers.js";

const SESSION = "dev-impl@r";
const PANE = "%7";
const PANE_PID = 4100;
const PIN = "anthropic/claude-fable-5";
const ENTRY = "/opt/openrig/dist/adapters/pi-runner.js";
const STATE_ROOT = "/s";
const OTHER = "claude-opus-5";

/** The `ps lstart` (LC_ALL=C) spelling of a local time, as the census reports a process start. */
function lstart(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${day} ${month} ${String(d.getDate()).padStart(2, " ")} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`;
}
const sqliteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const iso = (ms: number) => new Date(ms).toISOString();

const T0 = Date.parse("2026-10-17T09:00:00.000Z"); // the session file's creation
const BOOT = T0 + 60_000; // the occupant tenure's boot
const RUNNER_START = T0 + 10 * 60_000; // the pane's live runner start (a resume, later than BOOT)

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

let entrySeq = 0;
function header(createdMs: number, parentSession?: string): string {
  return JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: iso(createdMs), cwd: "/p", ...(parentSession ? { parentSession } : {}) });
}
function assistant(atMs: number, model: string | null, opts: { provider?: string | null; stopReason?: string; id?: string } = {}): string {
  const provider = opts.provider === undefined ? "anthropic" : opts.provider;
  return JSON.stringify({
    type: "message",
    id: opts.id ?? `e${++entrySeq}`,
    parentId: null,
    timestamp: iso(atMs),
    message: { role: "assistant", ...(provider ? { provider } : {}), ...(model ? { model } : {}), stopReason: opts.stopReason ?? "stop", usage: { input: 1, output: 1 } },
  });
}
function user(atMs: number, text = "q"): string {
  return JSON.stringify({ type: "message", id: `e${++entrySeq}`, parentId: null, timestamp: iso(atMs), message: { role: "user", content: text } });
}

interface Fixture {
  sessionsDir: string;
  sessionFile: string;
  sidecar: { ready?: boolean; launchId?: string; sessionFile?: string; exited?: unknown } | null;
  paneLaunchId: string | null;
  runnerStart: number;
  bootAt: number;
  pin: string;
  /** The adapter's runner entry path and state root. */
  entryPath: string;
  stateRoot: string;
  /** Replaces the pane's processes under its shell (default: the managed runner and its Pi child). */
  paneChildren?: ProcessRow[];
  /** The pane's own process (default: a login bash). */
  paneRoot?: string;
}

/** `modelsJson`: the seat's Pi models.json under a state root in the temp folder (null = that
 *  state root with no file). Without it the state root is STATE_ROOT. */
function fixture(lines: string[], overrides: Partial<Omit<Fixture, "sessionsDir" | "sessionFile">> & { modelsJson?: string | null } = {}): Fixture {
  const { modelsJson, ...rest } = overrides;
  const root = mkdtempSync(join(tmpdir(), "pi-emo-"));
  dirs.push(root);
  if (typeof modelsJson === "string") {
    mkdirSync(join(root, SESSION, "agent"), { recursive: true });
    writeFileSync(join(root, SESSION, "agent", "models.json"), modelsJson);
  }
  const sessionsDir = join(root, SESSION, "sessions");
  mkdirSync(join(sessionsDir, "--p--"), { recursive: true });
  const sessionFile = join(sessionsDir, "--p--", "2026-10-17_s1.jsonl");
  writeFileSync(sessionFile, lines.map((l) => `${l}\n`).join(""));
  return {
    sessionsDir,
    sessionFile,
    sidecar: { ready: true, launchId: "L2", sessionFile },
    paneLaunchId: "L2",
    runnerStart: RUNNER_START,
    bootAt: BOOT,
    pin: PIN,
    entryPath: ENTRY,
    stateRoot: modelsJson === undefined ? STATE_ROOT : root,
    ...rest,
  };
}

/** The managed runner command as ps shows it, built by the launch builder itself so the reader's
 *  expected argument order cannot drift from it: argv joined by spaces, shell quoting removed. */
function runnerCommand(f: Pick<Fixture, "entryPath" | "stateRoot">, launchId: string, opts: { node?: string; entryPath?: string; stateRoot?: string } = {}): string {
  const built = buildPiRunnerCommand({
    runtime: "pi", runnerEntryPath: opts.entryPath ?? f.entryPath, sessionName: SESSION, stateRoot: opts.stateRoot ?? f.stateRoot,
    cwd: "/p", trust: "approve", model: PIN, launchId,
  });
  const ps = built.replace(/'([^']*)'/g, "$1");
  return opts.node ? ps.replace(/^node /, `${opts.node} `) : ps;
}

function processes(f: Fixture): ProcessRow[] {
  const rows: ProcessRow[] = [{ pid: PANE_PID, ppid: 1, command: f.paneRoot ?? "-bash", startedAt: lstart(f.bootAt) }];
  if (f.paneChildren) return [...rows, ...f.paneChildren];
  if (f.paneLaunchId) {
    rows.push({ pid: PANE_PID + 1, ppid: PANE_PID, command: runnerCommand(f, f.paneLaunchId), startedAt: lstart(f.runnerStart) });
    rows.push({ pid: PANE_PID + 2, ppid: PANE_PID + 1, command: "pi --mode rpc --model anthropic/claude-fable-5", startedAt: lstart(f.runnerStart) });
  }
  return rows;
}

function read(f: Fixture) {
  return readCurrentPiOccupantModel({
    sessionName: SESSION,
    pinnedModel: f.pin,
    generation: "gen-1",
    occupantBootAt: sqliteUtc(f.bootAt),
    binding: { tmuxSession: SESSION, tmuxPane: PANE },
    runner: { state: f.sidecar, sessionsDir: f.sessionsDir, entryPath: f.entryPath, stateRoot: f.stateRoot },
  }, {
    getPanePid: async (target) => (target === PANE ? PANE_PID : null),
    listProcesses: async () => processes(f),
  }, (path) => {
    try { return realpathSync(path); } catch { return null; }
  });
}

function monitorFor(f: Fixture, runtime = "pi", readEffectiveModel: ModelDivergenceMonitorDeps["readEffectiveModel"] = () => read(f)) {
  const seat: PinnedSeat = { nodeId: "n1", sessionName: SESSION, rigId: "rig-1", rigName: "r", runtime, pinnedModel: f.pin, generation: "gen-1" };
  const sent: string[] = [];
  const monitor = new ModelDivergenceMonitor({
    listPinnedSeats: () => [seat],
    readEffectiveModel,
    sendToSession: async (target) => { sent.push(target); return { ok: true }; },
    resolveOrchSeats: () => ["orch-lead@r"],
    resolveOperatorSeat: () => "operator-admin@kernel",
    resolveOversightSeat: () => "watch-lead@oversight",
    recordProclamation: () => {},
    warn: () => {},
  });
  return { monitor, sent };
}

/** One pass: what fired, and whether the generation is still pending. */
async function pass(m: ReturnType<typeof monitorFor>) {
  const fired = await m.monitor.checkOnce();
  return { fired, pending: m.monitor.pendingSeats() };
}

describe("Pi effective-model read is tied to the pane's live runner", () => {
  it("an OLD sidecar after a NEW launch stays pending, even over an own-looking mismatching record", async () => {
    const f = fixture([header(T0), user(RUNNER_START + 5_000), assistant(RUNNER_START + 6_000, OTHER)], { sidecar: { ready: true, launchId: "L1", sessionFile: "" } });
    f.sidecar!.sessionFile = f.sessionFile;
    const m = monitorFor(f);
    const r = await pass(m);
    expect(r.fired).toEqual([]);
    expect(r.pending[0]?.reason).toMatch(/launch L1 is not the pane's live runner launch L2/);
  });

  it("no managed runner under the registered pane, a not-ready or exited sidecar: all pending", async () => {
    const lines = [header(T0), assistant(RUNNER_START + 6_000, OTHER)];
    for (const overrides of [{ paneLaunchId: null }, { sidecar: { ready: false, launchId: "L2" } }, { sidecar: { ready: true, launchId: "L2", exited: { code: 0 } } }]) {
      const f = fixture(lines, overrides);
      if (f.sidecar) f.sidecar.sessionFile = f.sessionFile;
      const r = await pass(monitorFor(f));
      expect(r.fired).toEqual([]);
      expect(r.pending).toHaveLength(1);
    }
  });

  it("a session file outside the seat's sessions folder stays pending", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 6_000, OTHER)]);
    const elsewhere = mkdtempSync(join(tmpdir(), "pi-emo-other-"));
    dirs.push(elsewhere);
    const foreign = join(elsewhere, "x.jsonl");
    writeFileSync(foreign, `${header(T0)}\n${assistant(RUNNER_START + 6_000, OTHER)}\n`);
    f.sidecar = { ready: true, launchId: "L2", sessionFile: foreign };
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    expect(r.pending[0]?.reason).toMatch(/not under the seat's sessions folder/);
  });
});

describe("Pi effective-model read counts only the current occupant's own records", () => {
  it("an OLD MATCHING record (before this runner) never settles; a later own mismatch still proclaims", async () => {
    const f = fixture([header(T0), assistant(BOOT + 5_000, "claude-fable-5")]);
    const m = monitorFor(f);
    expect((await pass(m)).pending[0]?.reason).toMatch(/predates the current runner/);
    appendFileSync(f.sessionFile, `${assistant(RUNNER_START + 30_000, OTHER)}\n`);
    const r = await pass(m);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]!.effectiveModel).toBe(`anthropic/${OTHER}`);
  });

  it("an OLD MISMATCHING record (before this runner) never proclaims", async () => {
    const f = fixture([header(T0), assistant(BOOT + 5_000, OTHER)]);
    const m = monitorFor(f);
    for (let i = 0; i < 3; i++) expect((await pass(m)).fired).toEqual([]);
    expect(m.sent).toEqual([]);
  });

  it("a record inside the runner's starting second is undecidable and stays pending", async () => {
    const f = fixture([header(T0), assistant(Math.floor(RUNNER_START / 1000) * 1000 + 400, OTHER)]);
    expect((await pass(monitorFor(f))).fired).toEqual([]);
  });

  it("a RESUMED seat with a CHANGED pin: the previous pin's records stay pending; the first own record settles", async () => {
    // Continuation tenure (BOOT unchanged), same session file, runner relaunched with the new pin.
    const f = fixture([header(T0), user(BOOT + 1_000), assistant(BOOT + 2_000, OTHER), assistant(BOOT + 9_000, OTHER)]);
    const m = monitorFor(f);
    expect((await pass(m)).fired).toEqual([]);
    appendFileSync(f.sessionFile, `${user(RUNNER_START + 20_000)}\n${assistant(RUNNER_START + 21_000, "claude-fable-5")}\n`);
    const r = await pass(m);
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]); // settled on the match
    appendFileSync(f.sessionFile, `${assistant(RUNNER_START + 40_000, OTHER)}\n`);
    expect((await pass(m)).fired).toEqual([]); // one verdict per generation
  });

  it("a FORK's inherited entries stay pending; a later valid own record decides", async () => {
    const forkAt = RUNNER_START + 2_000;
    const f = fixture([header(forkAt, "/s/parent/sessions/p.jsonl"), user(T0 + 1_000), assistant(T0 + 2_000, OTHER)]);
    const m = monitorFor(f);
    expect((await pass(m)).pending[0]?.reason).toMatch(/inherited from the fork parent/);
    appendFileSync(f.sessionFile, `${user(forkAt + 10_000)}\n${assistant(forkAt + 11_000, OTHER)}\n`);
    const r = await pass(m);
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]!.effectiveModel).toBe(`anthropic/${OTHER}`);
  });

  it("a fork entry in the header's own millisecond is undecidable without the parent's ids: pending", async () => {
    const forkAt = RUNNER_START + 2_000;
    const f = fixture([header(forkAt, "/s/parent/sessions/p.jsonl"), assistant(forkAt, OTHER)]);
    expect((await pass(monitorFor(f))).pending[0]?.reason).toMatch(/undecidable fork origin/);
  });

  it("a model record followed by a large amount of later output (past one 512KB window) still settles", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")]);
    for (let i = 0; i < 1500; i++) appendFileSync(f.sessionFile, `${JSON.stringify({ type: "message", id: `t${i}`, timestamp: iso(RUNNER_START + 6_000), message: { role: "toolResult", content: "x".repeat(1000) } })}\n`);
    const m = monitorFor(f);
    const r = await pass(m);
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});

describe("Pi pin and record spellings", () => {
  it("a bare pin that does not resolve to provider/model stays pending, never proclaims", async () => {
    for (const pin of ["claude-fable-5", "fable", "  "]) {
      const f = fixture([header(T0), assistant(RUNNER_START + 5_000, OTHER)], { pin });
      const r = await pass(monitorFor(f));
      expect(r.fired).toEqual([]);
      expect(r.pending[0]?.reason).toMatch(/does not resolve to a provider\/model id/);
    }
  });

  it("a newest record with no provider stays pending and does NOT fall back to an older record", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 5_000, OTHER), assistant(RUNNER_START + 6_000, "claude-fable-5", { provider: null })]);
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    expect(r.pending[0]?.reason).toMatch(/names no provider and model/);
  });

  it("an error or aborted turn is skipped for the determinate record before it", async () => {
    const f = fixture([
      header(T0),
      assistant(RUNNER_START + 5_000, "claude-fable-5"),
      assistant(RUNNER_START + 6_000, OTHER, { stopReason: "error" }),
      assistant(RUNNER_START + 7_000, OTHER, { stopReason: "aborted" }),
    ]);
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("compares `model`, never `responseModel`", async () => {
    const line = JSON.parse(assistant(RUNNER_START + 5_000, "claude-fable-5")) as { message: Record<string, unknown> };
    line.message["responseModel"] = "claude-fable-5-20261001";
    const f = fixture([header(T0), JSON.stringify(line)]);
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});

describe("Pi runner must match the supported managed-launch shape", () => {
  const at = lstart(RUNNER_START);
  const child = (pid: number, ppid: number, command: string): ProcessRow => ({ pid, ppid, command, startedAt: at });
  const matching = [header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")];
  const mismatching = [header(T0), assistant(RUNNER_START + 5_000, OTHER)];

  async function pendingReason(f: Fixture): Promise<string | undefined> {
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    return r.pending[0]?.reason;
  }

  it("the short form settles: node and the adapter's entry path, a direct child of the pane's shell", async () => {
    const r = await pass(monitorFor(fixture(matching)));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("the staged and env-wrapper forms settle once they exec the runner, and stay pending before", async () => {
    const staged = fixture(matching);
    const runner = runnerCommand(staged, "L2");
    for (const before of [`/bin/sh /tmp/openrig-launch-1`, `/usr/bin/env OPENRIG_NODE_ID=n1 PATH=/rig/bin:/usr/bin ${runner}`]) {
      const f = fixture(matching, { paneChildren: [child(PANE_PID + 1, PANE_PID, before)] });
      expect((await pass(monitorFor(f))).pending).toHaveLength(1);
    }
    const r = await pass(monitorFor(fixture(matching, { paneChildren: [child(PANE_PID + 1, PANE_PID, runner)] })));
    expect(r.pending).toEqual([]);
  });

  it("a real runner nested inside another program stays pending, even when it wrote the sidecar", async () => {
    const f = fixture(mismatching, {
      sidecar: { ready: true, launchId: "L3" },
      paneChildren: [child(PANE_PID + 1, PANE_PID, "vim notes.md"), child(PANE_PID + 2, PANE_PID + 1, "sh"), child(PANE_PID + 3, PANE_PID + 2, runnerCommand({ entryPath: ENTRY, stateRoot: STATE_ROOT }, "L3"))],
    });
    f.sidecar!.sessionFile = f.sessionFile;
    expect(await pendingReason(f)).toMatch(/not a direct child of the pane's shell/);
  });

  it("a non-runner process whose arguments carry the flags stays pending", async () => {
    const f = fixture(mismatching, { paneChildren: [child(PANE_PID + 1, PANE_PID, `grep -- --session-name ${SESSION} --launch-id L2`)] });
    expect(await pendingReason(f)).toMatch(/does not start with the managed runner arguments/);
  });

  it("a runner from another path, through another node spelling, or with another state root stays pending", async () => {
    const shapes: Array<[Parameters<typeof runnerCommand>[2], RegExp]> = [
      [{ entryPath: "/tmp/copy/pi-runner.js" }, /managed runner arguments/],
      [{ node: "/usr/bin/node" }, /managed runner arguments/],
      [{ stateRoot: "/elsewhere" }, /managed runner arguments/],
    ];
    for (const [opts, reason] of shapes) {
      const f = fixture(mismatching, { paneChildren: [child(PANE_PID + 1, PANE_PID, runnerCommand({ entryPath: ENTRY, stateRoot: STATE_ROOT }, "L2", opts))] });
      expect(await pendingReason(f)).toMatch(reason);
    }
  });

  it("several candidates at once stay pending, even when one is the managed runner", async () => {
    const f = fixture(mismatching, {
      paneChildren: [
        child(PANE_PID + 1, PANE_PID, runnerCommand({ entryPath: ENTRY, stateRoot: STATE_ROOT }, "L2")),
        child(PANE_PID + 2, PANE_PID, "vim"),
        child(PANE_PID + 3, PANE_PID + 2, runnerCommand({ entryPath: ENTRY, stateRoot: STATE_ROOT }, "L2")),
      ],
    });
    expect(await pendingReason(f)).toMatch(/2 processes under registered pane %7 name dev-impl@r with a launch id/);
  });

  it("an entry path and state root containing spaces still match", async () => {
    const spaced = { entryPath: "/opt/Open Rig/dist/adapters/pi-runner.js", stateRoot: "/home/a b/.openrig/state/pi" };
    const r = await pass(monitorFor(fixture(matching, spaced)));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
    const other = await pass(monitorFor(fixture(mismatching, spaced)));
    expect(other.fired).toHaveLength(1);
    // The whole spaced path must match, not its first word.
    const sibling = fixture(mismatching, { ...spaced, paneChildren: [child(PANE_PID + 1, PANE_PID, runnerCommand({ ...spaced, entryPath: "/opt/Open Other/pi-runner.js" }, "L2"))] });
    expect(await pendingReason(sibling)).toMatch(/managed runner arguments/);
  });
});

describe("Pi runner arguments and pane process must be unambiguous", () => {
  const at = lstart(RUNNER_START);
  const managed = { entryPath: ENTRY, stateRoot: STATE_ROOT };
  const mismatching = [header(T0), assistant(RUNNER_START + 5_000, OTHER)];
  const withRunner = (command: string, overrides: Partial<Fixture> = {}) =>
    fixture(mismatching, { paneChildren: [{ pid: PANE_PID + 1, ppid: PANE_PID, command, startedAt: at }], ...overrides });

  async function pendingReason(f: Fixture): Promise<string | undefined> {
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    return r.pending[0]?.reason;
  }

  it("a state root or entry path that only starts with the expected one stays pending", async () => {
    expect(await pendingReason(withRunner(runnerCommand(managed, "L2", { stateRoot: `${STATE_ROOT} backup` })))).toMatch(/managed runner arguments/);
    expect(await pendingReason(withRunner(runnerCommand(managed, "L2", { entryPath: `${ENTRY} backup/runner.js` })))).toMatch(/managed runner arguments/);
  });

  it("a repeated identity flag, or --runtime, stays pending", async () => {
    for (const extra of [" --launch-id L9", ` --session-name ${SESSION}`, " --state-root /s", " --cwd /q", " --runtime omp"]) {
      expect(await pendingReason(withRunner(`${runnerCommand(managed, "L2")}${extra}`))).toMatch(/ambiguous identity arguments/);
    }
  });

  it("a pane whose own process is not a shell stays pending, with the exact runner under it", async () => {
    expect(await pendingReason(withRunner(runnerCommand(managed, "L2"), { paneRoot: "vim notes.md" }))).toMatch(/is not a shell/);
  });

  it("login and path spellings of a shell as the pane's process still match", async () => {
    for (const paneRoot of ["-zsh", "/usr/bin/fish", "bash"]) {
      expect((await pass(monitorFor(withRunner(runnerCommand(managed, "L2"), { paneRoot })))).fired).toHaveLength(1);
    }
  });
});

describe("Pi pin with a :<thinking level> suffix", () => {
  it("reads a pin as Pi does: the whole pin first, then each trailing level removed in turn", () => {
    expect(piPinReadings("anthropic/claude-fable-5:high")).toEqual(["anthropic/claude-fable-5:high", "anthropic/claude-fable-5"]);
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(piPinReadings(` openrouter/x-ai/grok-4:${level} `)).toEqual([`openrouter/x-ai/grok-4:${level}`, "openrouter/x-ai/grok-4"]);
    }
    expect(piPinReadings("openrouter/meta/llama-4:free")).toEqual(["openrouter/meta/llama-4:free"]);
    expect(piPinReadings("anthropic/claude-fable-5:HIGH")).toEqual(["anthropic/claude-fable-5:HIGH"]); // Pi's levels are case-sensitive
    expect(piPinReadings("anthropic/claude-fable-5:free:low")).toEqual(["anthropic/claude-fable-5:free:low", "anthropic/claude-fable-5:free"]);
    expect(piPinReadings("anthropic/claude-fable-5:low:high")).toEqual(["anthropic/claude-fable-5:low:high", "anthropic/claude-fable-5:low", "anthropic/claude-fable-5"]);
  });

  it("a model id that really ends in a level, and a chained suffix, both settle on what Pi ran", async () => {
    const own = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5:high")], { pin: `${PIN}:high` });
    expect((await pass(monitorFor(own))).pending).toEqual([]);
    const chained = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")], { pin: `${PIN}:low:high` });
    const r = await pass(monitorFor(chained));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("a suffixed pin settles on a record of its model and proclaims a different model with the raw pin", async () => {
    const same = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")], { pin: `${PIN}:low` });
    const settled = await pass(monitorFor(same));
    expect(settled.fired).toEqual([]);
    expect(settled.pending).toEqual([]);

    const other = fixture([header(T0), assistant(RUNNER_START + 5_000, OTHER)], { pin: `${PIN}:low` });
    const r = await pass(monitorFor(other));
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]!.pinnedModel).toBe(`${PIN}:low`);
    expect(r.fired[0]!.effectiveModel).toBe(`anthropic/${OTHER}`);
  });

  it("a bare model with a level suffix still does not resolve to provider/model", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")], { pin: "claude-fable-5:high" });
    const r = await pass(monitorFor(f));
    expect(r.fired).toEqual([]);
    expect(r.pending[0]?.reason).toMatch(/does not resolve to a provider\/model id/);
  });

  it("the suffix is set aside for Pi seats only: another runtime's read compares the raw pin", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")], { pin: `${PIN}:low` });
    const withoutReadings = async () => {
      const r = await read(f);
      return r.ok ? { ok: true as const, model: r.model } : r;
    };
    expect((await pass(monitorFor(f, "omp", withoutReadings))).fired).toHaveLength(1);
  });
});

describe("Pi pin that is itself a model id in the seat's models.json", () => {
  const lab = (...ids: string[]) => JSON.stringify({ providers: { lab: { baseUrl: "http://lab", api: "openai-completions", models: ids.map((id) => ({ id })) } } });
  const seat = (record: string, pin: string, modelsJson: string | null) =>
    fixture([header(T0), assistant(RUNNER_START + 5_000, record, { provider: "lab" })], { pin, modelsJson });

  it("a pin that names a defined model is read literally, so the stripped model is a divergence", async () => {
    const r = await pass(monitorFor(seat("y", "lab/y:high", lab("y:high", "y"))));
    expect(r.fired).toHaveLength(1);
    expect(r.fired[0]!.pinnedModel).toBe("lab/y:high");
    expect(r.fired[0]!.effectiveModel).toBe("lab/y");
    expect((await pass(monitorFor(seat("y:high", "lab/y:high", lab("y:high", "y"))))).fired).toEqual([]);
    // Pi's own models.json reading (comments, trailing commas) and its case-insensitive exact match.
    const commented = `// lab models\n{ "providers": { "lab": { "models": [{ "id": "Y:High" }, { "id": "y" },] } } }`;
    expect((await pass(monitorFor(seat("y", "lab/y:high", commented)))).fired).toHaveLength(1);
    expect((await pass(monitorFor(seat("y", "lab/Y:high", lab("y:high", "y"))))).fired).toHaveLength(1);
  });

  it("a chained suffix is read up to the first defined model", async () => {
    expect((await pass(monitorFor(seat("y", "lab/y:low:high", lab("y:low", "y"))))).fired).toHaveLength(1);
    const r = await pass(monitorFor(seat("y:low", "lab/y:low:high", lab("y:low", "y"))));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  it("the ordinary suffix case is unchanged: only the model is defined, or no models.json at all", async () => {
    for (const modelsJson of [lab("y"), JSON.stringify({ providers: { other: { models: [{ id: "y:high" }] } } }), "{}", null]) {
      const r = await pass(monitorFor(seat("y", "lab/y:high", modelsJson)));
      expect(r.fired).toEqual([]);
      expect(r.pending).toEqual([]);
    }
  });

  it("a models.json that can't be read as Pi's config leaves a suffixed pin pending, never settled or proclaimed", async () => {
    const bad = ["{ not json", "[]", JSON.stringify({ providers: [] }), JSON.stringify({ providers: { lab: { models: {} } } }), JSON.stringify({ providers: { lab: { models: [{ name: "y" }] } } })];
    for (const modelsJson of bad) {
      const r = await pass(monitorFor(seat("y", "lab/y:high", modelsJson)));
      expect(r.fired).toEqual([]);
      expect(r.pending[0]?.reason).toMatch(/models\.json .* could not be read as Pi's model config/);
    }
  });

  it("with a models.json that can't be read as Pi's config, a record matching no reading of the pin is a divergence", async () => {
    const bad = ["{ not json", "[]", JSON.stringify({ providers: [] }), JSON.stringify({ providers: { lab: { models: {} } } }), JSON.stringify({ providers: { lab: { models: [{ name: "y" }] } } })];
    for (const modelsJson of bad) {
      const m = monitorFor(seat("z", "lab/y:high", modelsJson));
      const r = await pass(m);
      expect(r.pending).toEqual([]);
      expect(r.fired).toHaveLength(1);
      expect(r.fired[0]).toMatchObject({ sessionName: SESSION, runtime: "pi", pinnedModel: "lab/y:high", effectiveModel: "lab/z" });
      expect(m.sent).toEqual(["orch-lead@r", "operator-admin@kernel", "watch-lead@oversight"]);
    }
  });

  it("a pin without a level suffix never reads models.json", async () => {
    const r = await pass(monitorFor(seat("y", "lab/y", "{ not json")));
    expect(r.fired).toEqual([]);
    expect(r.pending).toEqual([]);
  });
});
