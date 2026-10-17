// Pi model-divergence read at the MONITOR WIRING: the record that settles or proclaims must be the
// current runner's own — never an earlier runner's sidecar, a resumed file's previous-pin records, or
// a fork parent's copied entries. Everything ambiguous stays pending (no refusal, no proclamation).

import { describe, it, expect, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelDivergenceMonitor, piPinModel, type PinnedSeat } from "../src/domain/model-divergence/model-divergence-monitor.js";
import { readCurrentPiOccupantModel, type ProcessRow } from "../src/domain/model-divergence/current-generation-record.js";

const SESSION = "dev-impl@r";
const PANE = "%7";
const PANE_PID = 4100;
const PIN = "anthropic/claude-fable-5";
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
}

function fixture(lines: string[], overrides: Partial<Omit<Fixture, "sessionsDir" | "sessionFile">> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-emo-"));
  dirs.push(root);
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
    ...overrides,
  };
}

function processes(f: Fixture): ProcessRow[] {
  const rows: ProcessRow[] = [{ pid: PANE_PID, ppid: 1, command: "-bash", startedAt: lstart(f.bootAt) }];
  if (f.paneLaunchId) {
    rows.push({
      pid: PANE_PID + 1,
      ppid: PANE_PID,
      command: `node /opt/openrig/dist/adapters/pi-runner.js --session-name ${SESSION} --state-root /s --cwd /p --launch-id ${f.paneLaunchId} --approve --model ${PIN}`,
      startedAt: lstart(f.runnerStart),
    });
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
    runner: { state: f.sidecar, sessionsDir: f.sessionsDir },
  }, {
    getPanePid: async (target) => (target === PANE ? PANE_PID : null),
    listProcesses: async () => processes(f),
  }, (path) => {
    try { return realpathSync(path); } catch { return null; }
  });
}

function monitorFor(f: Fixture, runtime = "pi") {
  const seat: PinnedSeat = { nodeId: "n1", sessionName: SESSION, rigId: "rig-1", rigName: "r", runtime, pinnedModel: f.pin, generation: "gen-1" };
  const sent: string[] = [];
  const monitor = new ModelDivergenceMonitor({
    listPinnedSeats: () => [seat],
    readEffectiveModel: () => read(f),
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

describe("Pi pin with a :<thinking level> suffix", () => {
  it("sets aside only a trailing level Pi accepts, keeping any other suffix", () => {
    expect(piPinModel("anthropic/claude-fable-5:high")).toBe("anthropic/claude-fable-5");
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
      expect(piPinModel(` openrouter/x-ai/grok-4:${level} `)).toBe("openrouter/x-ai/grok-4");
    }
    expect(piPinModel("openrouter/meta/llama-4:free")).toBe("openrouter/meta/llama-4:free");
    expect(piPinModel("anthropic/claude-fable-5:HIGH")).toBe("anthropic/claude-fable-5:HIGH"); // Pi's levels are case-sensitive
    expect(piPinModel("anthropic/claude-fable-5:free:low")).toBe("anthropic/claude-fable-5:free");
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

  it("the suffix is set aside for Pi seats only", async () => {
    const f = fixture([header(T0), assistant(RUNNER_START + 5_000, "claude-fable-5")], { pin: `${PIN}:low` });
    expect((await pass(monitorFor(f, "omp"))).fired).toHaveLength(1);
  });
});
