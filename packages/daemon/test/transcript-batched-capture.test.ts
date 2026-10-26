// #161: transcript rotation captures every due session with a bounded number of tmux calls per round, through the real
// TmuxAdapter over a fake tmux with the real chain semantics (exact `=<name>:` targets, a `;` chain that stops at its
// first failing command, the production exec's output bound), while each session keeps its own cadence, backoff and
// generation guard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import {
  startTranscriptRotation, stopTranscriptRotation, clearAllTranscriptRotationsForTest, getLastCaptureAt, getTranscriptCaptureStats,
} from "../src/domain/transcript-rotation.js";

/** The production exec's stdout bound, which every tmux call shares. */
const TMUX_MAX_BUFFER = 64 * 1024 * 1024;

interface FakeSession { text: string; activity: number }

/** A fake tmux server behind a real TmuxAdapter. Records every argv; `gate` holds capture chains until released. */
function fakeTmux() {
  const sessions = new Map<string, FakeSession>();
  const calls: string[][] = [];
  const fail = { server: false, chained: new Set<string>(), serverAfterListing: false, stall: new Set<string>() };
  let gate: Promise<void> | null = null;
  /** Fake-timer latency of every exec, as on a slow host. */
  const latency = { ms: 0 };
  const run = (argv: string[]): string => {
    if (fail.server) throw new Error("no server running on /tmp/tmux-501/default");
    if (argv[1] === "list-sessions") {
      if (fail.serverAfterListing) fail.server = true;
      return [...sessions.keys()].join("\n") + "\n";
    }
    if (argv[1] === "list-windows") {
      const sized = argv[argv.indexOf("-F") + 1]!.includes("window_width");
      return [...sessions].map(([n, s]) => sized ? `1|${s.activity}|80x24|${n}` : `1|${s.activity}|${n}`).join("\n") + "\n";
    }
    const cmds: string[][] = [[]];
    for (const a of argv.slice(1)) {
      if (a === ";") cmds.push([]);
      else cmds[cmds.length - 1]!.push(a);
    }
    let out = "";
    for (const c of cmds) {
      const name = /^=(.*):$/.exec(c[c.indexOf("-t") + 1]!)?.[1];
      if (name === undefined) throw new Error("expected an exact =name: target");
      if (!sessions.has(name) || (cmds.length > 1 && fail.chained.has(name))) throw new Error(`can't find session: ${name}`);
      if (c[0] === "display-message") { out += `${c[c.length - 1]}\n`; continue; }
      const lines = Number(c[c.indexOf("-S") + 1]!.slice(1));
      out += sessions.get(name)!.text.split("\n").slice(0, -1).slice(-lines).map((l) => l + "\n").join("");
    }
    if (out.length > TMUX_MAX_BUFFER) throw new Error("stdout maxBuffer length exceeded");
    return out;
  };
  const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv) => {
    calls.push(argv);
    if (latency.ms > 0) await new Promise((r) => setTimeout(r, latency.ms));
    if (gate && argv.includes("capture-pane")) await gate;
    // A stalled session's chain never settles, as a hung tmux client.
    if (argv.some((a) => fail.stall.has(a.slice(1, -1)))) await new Promise(() => {});
    return run(argv);
  });
  const captureCalls = () => calls.filter((a) => a.includes("capture-pane"));
  /** Target sessions of every capture call so far, one array per call. */
  const capturedTargets = () => captureCalls().filter((a) => a.includes("capture-pane"))
    .map((a) => a.flatMap((x, i) => (a[i - 1] === "-t" && a[i - 3] === "capture-pane" ? [x.slice(1, -1)] : [])));
  let release: () => void = () => {};
  return {
    adapter, sessions, calls, fail, latency, captureCalls, capturedTargets,
    add: (name: string, text = `${name} output\n`) => sessions.set(name, { text, activity: 1 }),
    write: (name: string, text: string) => { const s = sessions.get(name)!; s.text = text; s.activity += 1; },
    hold: () => { gate = new Promise((resolve) => { release = () => { gate = null; resolve(); }; }); },
    release: () => release(),
  };
}

/** Advance fake time in steps of at most 250 ms. A batch's sessions yield to the real event loop between their writes,
 *  so each step lets them resume before fake time runs on to their result deadline. */
async function advance(ms: number) {
  do {
    const step = Math.min(ms, 250);
    await vi.advanceTimersByTimeAsync(step);
    for (let i = 0; i <= 24; i++) await vi.advanceTimersByTimeAsync(0);
    ms -= step;
  } while (ms > 0);
}

let root: string;
const live = { lines: 1000, pollIntervalMs: 2000 };
const resolve = () => live;
const file = (name: string) => path.join(root, `${name}.log`);
const start = (t: ReturnType<typeof fakeTmux>, name: string) => startTranscriptRotation(t.adapter, name, file(name), { ...live }, resolve);
const names = (n: number, prefix = "seat") => Array.from({ length: n }, (_, i) => `${prefix}-${i}@rig`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "batched-capture-"));
  vi.useFakeTimers();
  live.lines = 1000; live.pollIntervalMs = 2000;
});
afterEach(async () => {
  clearAllTranscriptRotationsForTest();
  await advance(6000);
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Start every session at once and let the immediate first ticks settle. */
async function startAll(t: ReturnType<typeof fakeTmux>, all: string[]) {
  for (const n of all) t.add(n);
  for (const n of all) start(t, n);
  await advance(0);
}

/** Make every session active (new output and a new activity hint), then run one cadence and return its capture calls. */
async function activeRound(t: ReturnType<typeof fakeTmux>, all: string[], round: number) {
  for (const n of all) t.write(n, `${n} round ${round}\n`);
  const before = t.captureCalls().length;
  await advance(2000);
  return t.captureCalls().slice(before);
}

describe("batched transcript capture (#161)", () => {
  it("20 active sessions at 2s cadence: one listing and one chained call per round, every transcript rewritten", async () => {
    const t = fakeTmux(); const all = names(20);
    await startAll(t, all);
    for (let round = 1; round <= 3; round++) {
      const calls = await activeRound(t, all, round);
      expect(calls.map((a) => a[1])).toEqual(["display-message"]);
      for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} round ${round}\n`);
    }
  });

  it("30 sessions started in one turn (a daemon boot resume) share their first capture: ceil(30/24) = 2 calls", async () => {
    const t = fakeTmux(); const all = names(30);
    await startAll(t, all);
    expect(t.captureCalls().map((a) => a[1])).toEqual(["display-message", "display-message"]);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} output\n`);
  });

  it("50 active sessions: ceil(50/24) = 3 calls per round", async () => {
    const t = fakeTmux(); const all = names(50);
    await startAll(t, all);
    for (let round = 1; round <= 2; round++) {
      expect(await activeRound(t, all, round)).toHaveLength(3);
      for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} round ${round}\n`);
    }
  });

  it("captures only due sessions; an idle one backs off to its ceiling while a busy one keeps cadence", async () => {
    const t = fakeTmux(); const busy = names(3, "busy"); const idle = names(3, "idle");
    await startAll(t, [...busy, ...idle]);
    const captureTimes = new Map<string, number[]>();
    const began = Date.now();
    for (let step = 1; step <= 16; step++) {
      for (const n of busy) t.write(n, `${n} step ${step}\n`);
      const before = t.capturedTargets().length;
      await advance(1000);
      for (const n of t.capturedTargets().slice(before).flat()) captureTimes.set(n, [...(captureTimes.get(n) ?? []), Date.now() - began]);
      for (const n of busy) {
        if (step % 2 === 0) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} step ${step}\n`);
      }
    }
    for (const n of busy) expect(captureTimes.get(n)).toEqual([2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 16_000]);
    // The idle seats had no output since their first capture: only the full read every 10 s captures them.
    for (const n of idle) expect(captureTimes.get(n)).toEqual([11_000]);
    expect(getTranscriptCaptureStats().idleSeats).toBe(3);
  });

  it("stop() during a batch: no write or liveness for the stopped session, the others are written", async () => {
    const t = fakeTmux(); const all = names(4);
    await startAll(t, all);
    for (const n of all) t.write(n, `${n} late\n`);
    t.hold();
    await advance(2000);
    stopTranscriptRotation(all[0]!);
    t.release();
    await advance(0);
    expect(fs.readFileSync(file(all[0]!), "utf8")).toBe(`${all[0]} output\n`);
    expect(getLastCaptureAt(all[0]!)).toBeUndefined();
    for (const n of all.slice(1)) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} late\n`);
  });

  it("a replacing start during a batch never publishes the old batch's bytes and captures after it settles", async () => {
    const t = fakeTmux(); const all = names(4);
    await startAll(t, all);
    for (const n of all) t.write(n, `${n} old\n`);
    t.hold();
    await advance(2000);
    const replaced = path.join(root, "replaced.log");
    startTranscriptRotation(t.adapter, all[0]!, replaced, { ...live }, resolve);
    await advance(3000);
    expect(fs.existsSync(replaced)).toBe(false);
    t.write(all[0]!, `${all[0]} new\n`);
    t.release();
    await advance(0);
    expect(fs.existsSync(replaced)).toBe(false);
    expect(fs.readFileSync(file(all[0]!), "utf8")).toBe(`${all[0]} output\n`);
    await advance(1000);
    expect(fs.readFileSync(replaced, "utf8")).toBe(`${all[0]} new\n`);
  });

  it("a session the batch leaves out is read per target in the same round", async () => {
    const t = fakeTmux(); const all = names(4);
    await startAll(t, all);
    t.fail.chained.add(all[2]!);
    for (const n of all) t.write(n, `${n} fallback\n`);
    const before = t.calls.length;
    await advance(2000);
    const perTarget = t.calls.slice(before).filter((a) => a[1] === "capture-pane");
    expect(perTarget.map((a) => a[a.indexOf("-t") + 1])).toEqual([`=${all[2]}:`]);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} fallback\n`);
  });

  it("an unreachable tmux counts one failure per due session without a fork each, and leaves freshness alone", async () => {
    const t = fakeTmux(); const all = names(5);
    await startAll(t, all);
    const fresh = all.map((n) => getLastCaptureAt(n));
    t.fail.server = true;
    const before = t.calls.length;
    await advance(2000);
    // The listing runs beside the chain; both fail, which ends the round with no retry or per-target read.
    expect(t.calls.slice(before).filter((a) => a[1] !== "list-windows").map((a) => a[1])).toEqual(["list-sessions", "display-message"]);
    expect(getTranscriptCaptureStats()).toMatchObject({ captures: 10, failures: 5 });
    expect(all.map((n) => getLastCaptureAt(n))).toEqual(fresh);
  });

  it("a batch past the result deadline counts failures, overlaps nothing, and never publishes its late bytes", async () => {
    const t = fakeTmux(); const all = names(4);
    await startAll(t, all);
    const fresh = all.map((n) => getLastCaptureAt(n));
    for (const n of all) t.write(n, `${n} late\n`);
    t.hold();
    await advance(2000);
    const held = t.captureCalls().length;
    await advance(12_000);
    expect(t.captureCalls()).toHaveLength(held);
    expect(getTranscriptCaptureStats().failures).toBe(4);
    t.release();
    await advance(0);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} output\n`);
    expect(all.map((n) => getLastCaptureAt(n))).toEqual(fresh);
    await advance(1000);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} late\n`);
  });

  it("applies live line counts and intervals to the batch", async () => {
    const t = fakeTmux(); const all = names(4);
    for (const n of all) t.add(n, Array.from({ length: 100 }, (_, i) => `${n} ${i}\n`).join(""));
    for (const n of all) start(t, n);
    await advance(0);
    live.lines = 40; live.pollIntervalMs = 1000;
    await advance(1000);
    const chain = t.captureCalls().at(-1)!;
    expect(chain.filter((a) => a === "-40")).toHaveLength(4);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8").split("\n")).toHaveLength(41);
    for (const n of all) t.write(n, `${n} fast\n`);
    await advance(1000);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} fast\n`);
  });

  it("24 wide 1000-line panes (~1.9 MiB) fit one chained call instead of splitting at exec's 1 MiB default", async () => {
    const t = fakeTmux(); const all = names(24);
    const wide = (n: string, r: number) => Array.from({ length: 1000 }, (_, i) => `${n} ${r} ${i} ${"x".repeat(60)}\n`).join("");
    for (const n of all) t.add(n, wide(n, 0));
    for (const n of all) start(t, n);
    await advance(0);
    for (const n of all) t.write(n, wide(n, 1));
    const before = t.captureCalls().length;
    await advance(2000);
    expect(t.captureCalls().slice(before)).toHaveLength(1);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(wide(n, 1));
  });

  it("a slow host (2s per exec): 50 sessions land within 5 s of new output, none hits the deadline", async () => {
    const t = fakeTmux(); const all = names(50);
    await startAll(t, all);
    t.latency.ms = 2000;
    for (let round = 1; round <= 3; round++) {
      for (const n of all) t.write(n, `${n} slow ${round}\n`);
      const written = Date.now();
      while (!all.every((n) => fs.readFileSync(file(n), "utf8") === `${n} slow ${round}\n`)) {
        expect(Date.now() - written).toBeLessThan(5000);
        await advance(250);
      }
    }
    expect(getTranscriptCaptureStats().failures).toBe(0);
  });

  it("a session gone from tmux: the listing drops it from the chain, then it reads per target until it captures again", async () => {
    const t = fakeTmux(); const all = names(5);
    await startAll(t, all);
    t.sessions.delete(all[1]!);
    for (const n of all.filter((n) => n !== all[1])) t.write(n, `${n} after\n`);
    let before = t.calls.length;
    await advance(2000);
    expect(t.calls.slice(before).filter((a) => a[1] !== "list-windows").map((a) => a[1]))
      .toEqual(["list-sessions", "display-message", "display-message"]);
    for (const n of all.filter((n) => n !== all[1])) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} after\n`);
    for (const n of all.filter((n) => n !== all[1])) t.write(n, `${n} later\n`);
    before = t.calls.length;
    await advance(2000);
    const round = t.calls.slice(before).filter((a) => a[1] !== "list-windows");
    expect(round.map((a) => a[1]).sort()).toEqual(["capture-pane", "display-message", "list-sessions"]);
    expect(round.find((a) => a[1] === "capture-pane")).toContain(`=${all[1]}:`);
    for (const n of all.filter((n) => n !== all[1])) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} later\n`);
    // Back in tmux: its per-target read captures, so it rejoins the chain.
    t.add(all[1]!, `${all[1]} back\n`);
    await advance(2000);
    expect(fs.readFileSync(file(all[1]!), "utf8")).toBe(`${all[1]} back\n`);
    for (const n of all) t.write(n, `${n} joined\n`);
    before = t.calls.length;
    await advance(2000);
    expect(t.calls.slice(before).filter((a) => a[1] === "capture-pane")).toEqual([]);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} joined\n`);
  });

  it("a restart while a batch finds the session gone: the old batch can't send the new start to a per-target read", async () => {
    const t = fakeTmux(); const all = names(4);
    await startAll(t, all);
    t.sessions.delete(all[1]!);
    t.hold();
    await advance(2000);
    start(t, all[1]!);
    // Held until the peers are due again, so the new start's first capture shares their next round.
    await advance(2500);
    t.release();
    await advance(0);
    t.add(all[1]!);
    for (const n of all) t.write(n, `${n} next\n`);
    const before = t.calls.length;
    await advance(1000);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} next\n`);
    expect(t.calls.slice(before).filter((a) => a[1] === "capture-pane")).toEqual([]);
  });

  it("a chunk that never settles holds only its own sessions: another chunk's left-out session still reads per target", async () => {
    const t = fakeTmux(); const all = names(30);
    await startAll(t, all);
    // all[0] is in the first chunk (0-23) and fails only inside a chain; all[26] stalls the second chunk (24-29).
    t.fail.chained.add(all[0]!);
    t.fail.stall.add(all[26]!);
    for (const n of all) t.write(n, `${n} split\n`);
    await advance(2000);
    expect(t.calls.filter((a) => a[1] === "capture-pane").map((a) => a[a.indexOf("-t") + 1])).toContain(`=${all[0]}:`);
    for (const n of all.slice(0, 24)) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} split\n`);
    for (const n of all.slice(24)) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} output\n`);
  });

  it("a session killed on a slow host (2s per exec): its peers still land inside the deadline", async () => {
    const t = fakeTmux(); const all = names(5);
    await startAll(t, all);
    t.latency.ms = 2000;
    t.sessions.delete(all[1]!);
    const alive = all.filter((n) => n !== all[1]);
    for (const n of alive) t.write(n, `${n} after kill\n`);
    const fresh = alive.map((n) => getLastCaptureAt(n)!);
    await advance(6000);
    for (const n of alive) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} after kill\n`);
    alive.forEach((n, i) => expect(getLastCaptureAt(n)).toBeGreaterThan(fresh[i]!));
  });

  it("the server dies right after the listing: no split, no per-target retries, one failure per session", async () => {
    const t = fakeTmux(); const all = names(24);
    await startAll(t, all);
    t.fail.serverAfterListing = true;
    for (const n of all) t.write(n, `${n} gone\n`);
    const before = t.calls.length;
    await advance(2000);
    expect(t.calls.slice(before).filter((a) => a[1] !== "list-windows").map((a) => a[1])).toEqual(["list-sessions", "display-message"]);
    expect(getTranscriptCaptureStats().failures).toBe(24);
  });

  it("a slow host (3s per exec, past 2.5 s): the listing runs beside the chain, so batched captures still land", async () => {
    const t = fakeTmux(); const all = names(10);
    await startAll(t, all);
    t.latency.ms = 3000;
    await advance(12_000);
    const before = getTranscriptCaptureStats();
    for (const n of all) t.write(n, `${n} late host\n`);
    await advance(10_000);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(`${n} late host\n`);
    expect(getTranscriptCaptureStats().failures - before.failures).toBe(0);
  });

  it("a session killed while its chain is in flight (1s per exec): the 23 healthy peers are current within 5 s", async () => {
    const t = fakeTmux(); const all = names(24);
    await startAll(t, all);
    t.latency.ms = 1000;
    await advance(10_000);
    const n0 = t.calls.length;
    while (!t.calls.slice(n0).some((a) => a[1] === "display-message")) await vi.advanceTimersByTimeAsync(10);
    t.sessions.delete(all[0]!);
    for (const n of all.slice(1)) t.write(n, `${n} after kill\n`);
    const killedAt = Date.now();
    while (!all.slice(1).every((n) => fs.readFileSync(file(n), "utf8") === `${n} after kill\n`)) {
      expect(Date.now() - killedAt).toBeLessThan(5000);
      await advance(250);
    }
  });

  it("a pane above exec's 1 MiB default is written both in a batch and as a lone per-target read", async () => {
    const t = fakeTmux(); const all = names(3);
    const big = (n: string, r: number) => Array.from({ length: 1000 }, (_, i) => `${n} ${r} ${i} ${"y".repeat(1100)}\n`).join("");
    for (const n of all) t.add(n, big(n, 0));
    for (const n of all) start(t, n);
    await advance(0);
    for (const n of all) expect(fs.readFileSync(file(n), "utf8")).toBe(big(n, 0));
    // Only one session changes: it is the round's single due capture, read per target.
    stopTranscriptRotation(all[1]!); stopTranscriptRotation(all[2]!);
    t.write(all[0]!, big(all[0]!, 1));
    const before = t.calls.length;
    await advance(2000);
    expect(t.calls.slice(before).filter((a) => a[1] === "capture-pane")).toHaveLength(1);
    expect(fs.readFileSync(file(all[0]!), "utf8")).toBe(big(all[0]!, 1));
  });

  it("a session started between shared ticks captures every 2s, as its own timer would", async () => {
    const t = fakeTmux(); t.add("a@rig"); t.add("b@rig");
    start(t, "a@rig");
    await advance(1);
    start(t, "b@rig");
    const began = Date.now();
    const times: number[] = [];
    for (let step = 0; step < 90; step++) {
      t.write("b@rig", `b ${step}\n`);
      const before = t.calls.length;
      await advance(100);
      const round = t.calls.slice(before);
      if (round.some((a) => a.includes("capture-pane") && a.includes("=b@rig:"))) times.push(Date.now() - began);
    }
    // Base cadence: one capture right away, then one per 2s. The shared 1s timer may run it up to half a step early.
    expect(times[0]).toBeLessThanOrEqual(100);
    const gaps = times.slice(1).map((at, i) => at - times[i]!);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(1500);
    for (const gap of gaps) expect(gap).toBeLessThanOrEqual(2100);
    expect(times.length).toBeGreaterThanOrEqual(5);
  });
});

/** Seeded PRNG: a failing seed replays. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

describe("batched transcript capture: generative", () => {
  // The same random schedule of starts, stops and output against a batching adapter and one without
  // capturePanesContent (one capture per session, the per-session path): the writes match event for event.
  it("writes the same (time, session, bytes) events as per-session capture under random interleavings", async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const runs: string[][] = [];
      for (const batched of [true, false]) {
        const random = rng(seed);
        const t = fakeTmux();
        const adapter = batched ? t.adapter : Object.assign(Object.create(t.adapter), { capturePanesContent: undefined }) as TmuxAdapter;
        const all = names(6);
        for (const n of all) t.add(n);
        const running = new Set<string>();
        const events: string[] = [];
        const seen = new Map<string, string>();
        const began = Date.now();
        for (let step = 0; step < 40; step++) {
          for (const n of all) {
            const roll = random();
            if (roll < 0.08) { stopTranscriptRotation(n); running.delete(n); }
            else if (roll < 0.2 && !running.has(n)) { startTranscriptRotation(adapter, n, file(n), { ...live }, resolve); running.add(n); }
            else if (roll < 0.5) t.write(n, `${n} ${step}\n`);
          }
          await advance(Math.floor(random() * 4) * 250);
          for (const n of all) {
            const bytes = fs.existsSync(file(n)) ? fs.readFileSync(file(n), "utf8") : "";
            if (seen.get(n) !== bytes) { events.push(`${Date.now() - began} ${n} ${bytes}`); seen.set(n, bytes); }
          }
        }
        runs.push(events);
        clearAllTranscriptRotationsForTest();
        await advance(6000);
        fs.rmSync(root, { recursive: true, force: true }); fs.mkdirSync(root);
      }
      expect(runs[0], `seed ${seed}`).toEqual(runs[1]);
      expect(runs[0]!.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  }, 180_000); // 25 seeds twice, with a loop turn per batched write: tens of seconds on a loaded host
});

