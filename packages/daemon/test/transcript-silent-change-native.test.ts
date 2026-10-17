// Real tmux, one private server per case. An idle seat runs transcript rotation and the structural sweep through one
// TmuxAdapter, as the daemon wires them. Then one tmux operation that changes the pane's text without printing (a resize
// round trip, a terminal reset, a pane swap, ...) or a capture that fails. Every bound counts the daemon's own steps:
// rotation ticks and structural sweeps that start after the operation has returned, each with a snapshot of what the
// daemon serves at that moment. A loaded host stretches the steps, not the count. TMUX_BIN picks the tmux binary.
import { afterAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import * as rotation from "../src/domain/transcript-rotation.js";
import { startTranscriptRotation, stopTranscriptRotation } from "../src/domain/transcript-rotation.js";
import type { TranscriptIngestHealth } from "../src/domain/transcript-store.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

delete process.env.TMUX; delete process.env.TMUX_PANE;
const TMUX = process.env.TMUX_BIN ?? "tmux";
let nativeAvailable = process.platform !== "win32";
try { execFileSync(TMUX, ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }
const OUT = process.env.SILENT_CHANGE_OUT; // one JSON line per measurement, when set
const WAIT_MS = 30_000;
// Rotation's idle capture interval, from its own constants (rotation ticks every 1 s when it resolves live options).
const TICK_MS = 1000;
const IDLE_CEILING_MS = Math.max(2000, Math.min(rotation.MAX_IDLE_CAPTURE_INTERVAL_MS, rotation.DEFAULT_TRANSCRIPT_STALE_AFTER_MS
  - rotation.ACTIVITY_HINT_DEADLINE_MS - rotation.CAPTURE_RESULT_DEADLINE_MS - TICK_MS));
// A change is in the transcript by the start of this tick after it: the ticks to the next idle capture, one more for a
// window listing taken before the change, and the capture tick itself must have finished.
const TRANSCRIPT_TICKS = Math.ceil(IDLE_CEILING_MS / TICK_MS) + 2;
// A tree that skips quiet panes still reads each in full this often (none on a tree that reads every due pane).
const FULL_READ_MS = (rotation as unknown as { IDLE_FULL_CAPTURE_MS?: number }).IDLE_FULL_CAPTURE_MS ?? 0;
// The longest a failing capture on a quiet pane may wait for that full read.
const MAX_FULL_READ_MS = 10_000;
const exec = promisify(execFile);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = (row: object) => { if (OUT) appendFileSync(OUT, JSON.stringify({ tmux: TMUX, ...row }) + "\n"); };

const PROMPT = String.raw`printf 'Do you want to proceed?\n\342\235\257 1. Yes\n  2. No\n\n\n\n'`;
const LINES = (n: number) => `for i in $(seq 1 ${n}); do echo line-$i; done`;

interface Seat {
  name: string; run: (...a: string[]) => Promise<string>; file: string; store: TranscriptStore; svc: SeatStructuralActivityService;
  // end of the last real rotation (1000-line) and structural (20-line) capture
  lastEnd: { rotation: number; structural: number }; listings: { live: number; max: number }; failCaptures: { on: boolean };
  rotationCalls: { all: number; failed: number };
  // every structural sweep that ran (a timer tick that found one in flight is not a sweep), with the verdict it left
  sweeps: Array<{ at: number; end: number; obs: string | null }>;
  // every rotation tick that ran (one still capturing is not a tick), with the transcript as the previous tick left it
  ticks: Array<{ at: number; file: string | null; failed: number; health: TranscriptIngestHealth }>;
  done: () => Promise<void>;
}

async function seat(name: string, opts: { history: number; screen: string; listingDelayS?: number }): Promise<Seat> {
  const socket = `silent-${name.replace(/\W/g, "")}-${process.pid}`;
  const root = mkdtempSync(join(tmpdir(), `silent-${name.replace(/\W/g, "")}-`));
  writeFileSync(join(root, "tmux.conf"), `set -g history-limit ${opts.history}\n`);
  const base = ["-L", socket, "-f", join(root, "tmux.conf")];
  const run = async (...a: string[]) => (await exec(TMUX, [...base, ...a], { timeout: 15_000, maxBuffer: 16 << 20 })).stdout;
  const lastEnd = { rotation: 0, structural: 0 };
  const listings = { live: 0, max: 0 };
  const failCaptures = { on: false };
  const rotationCalls = { all: 0, failed: 0 };
  const adapter = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined, async (argv) => {
    const args = argv.slice(1);
    const capture = args.includes("capture-pane");
    if (capture && args.includes("-1000")) rotationCalls.all += 1;
    if (capture && failCaptures.on) { if (args.includes("-1000")) rotationCalls.failed += 1; throw new Error("injected capture failure"); }
    const listing = args[0] === "list-windows";
    if (listing) { listings.live += 1; listings.max = Math.max(listings.max, listings.live); }
    try {
      // The delay is a real child: the listing stays a live process for its whole duration.
      const out = listing && opts.listingDelayS
        ? (await exec("sh", ["-c", `sleep ${opts.listingDelayS}; exec "$0" "$@"`, TMUX, ...base, ...args], { timeout: 30_000 })).stdout
        : await run(...args).catch((err) => { if (capture && args.includes("-1000")) rotationCalls.failed += 1; throw err; });
      if (capture) lastEnd[args.includes("-1000") ? "rotation" : "structural"] = Date.now();
      return out;
    } finally { if (listing) listings.live -= 1; }
  });
  await run("new-session", "-d", "-s", name, "-x", "100", "-y", "20", "sh", "-c", `${opts.screen}; exec sleep 100000`);
  await wait(800);
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db), reg = new SessionRegistry(db);
  const node = rigRepo.addNode(rigRepo.createRig("r").id, `dev.${name}`, { runtime: "claude-code" });
  const sess = reg.registerSession(node.id, name);
  reg.updateStatus(sess.id, "running");
  reg.updateBinding(node.id, { tmuxSession: name, attachmentType: "tmux" });
  const store = new TranscriptStore({ transcriptsRoot: root });
  const file = store.getTranscriptPath("r", name);
  const svc = new SeatStructuralActivityService(adapter);
  const sweeps: Seat["sweeps"] = [], ticks: Seat["ticks"] = [];
  const sweep = svc.pollAllRunningTmuxSeats.bind(svc);
  svc.pollAllRunningTmuxSeats = async (d) => {
    const busy = (svc as unknown as { sweeping: boolean }).sweeping, at = Date.now();
    await sweep(d);
    if (!busy) sweeps.push({ at, end: Date.now(), obs: svc.getStructuralActivity(name)?.state ?? null });
  };
  const ropts = { lines: 1000, pollIntervalMs: 2000 };
  // A tick resolves its options right after its overlap guard, before it reads anything.
  startTranscriptRotation(adapter, name, file, ropts, () => {
    ticks.push({ at: Date.now(), file: read(file), failed: rotationCalls.failed, health: store.getIngestHealth("r", name) });
    return ropts;
  });
  svc.start(db, 1000);
  return {
    name, run, file, store, svc, lastEnd, listings, failCaptures, rotationCalls, sweeps, ticks,
    done: async () => { svc.stop(); stopTranscriptRotation(name); await run("kill-server").catch(() => {}); db.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** The `n`th (1-based) of `xs` that started at or after `from`, once it has happened, or null after WAIT_MS. */
async function nth<T extends { at: number }>(xs: T[], from: number, n: number): Promise<T | null> {
  const until = Date.now() + WAIT_MS;
  const find = () => xs.filter((x) => x.at >= from)[n - 1] ?? null;
  while (find() === null && Date.now() < until) await wait(50);
  return find();
}
/** 1-based count of the steps after `from` until `ok` first held, or null. */
const stepsUntil = <T extends { at: number }>(xs: T[], from: number, ok: (x: T) => boolean) => {
  const i = xs.filter((x) => x.at >= from).findIndex(ok);
  return i < 0 ? null : i + 1;
};

const read = (f: string) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
/** What a capture now shows: the transcript should equal a fresh 1000-line read, the verdict a fresh 20-line read's. */
async function truth(s: Seat) {
  const full = await s.run("capture-pane", "-p", "-t", `=${s.name}:`, "-S", "-1000");
  const short = await s.run("capture-pane", "-p", "-t", `=${s.name}:`, "-S", "-20");
  return { full, verdict: short === "" ? null : classifyPaneActivity(short).state };
}

/** After the operation: the transcript as the daemon serves it at the start of tick TRANSCRIPT_TICKS, and the verdict at
 *  the end of the second structural sweep, both counted from when the operation returned. The panes are idle, so the
 *  capture taken right after the operation is the truth for the whole case. */
async function measure(s: Seat, label: string, act: () => Promise<unknown>) {
  await wait(9000); // idle: ticks and sweeps after the first capture are skips
  const before = await truth(s);
  await act();
  const t0 = Date.now();
  const after = await truth(s);
  const [tick, sweep] = await Promise.all([nth(s.ticks, t0, TRANSCRIPT_TICKS), nth(s.sweeps, t0, 2)]);
  const h = s.store.getIngestHealth("r", s.name), obs = s.svc.getStructuralActivity(s.name);
  const row = { case: label, textChanged: before.full !== after.full, verdictBefore: before.verdict, verdictAfter: after.verdict,
    transcriptAtTick: tick ? tick.file === after.full : null, verdictAtSweep: sweep ? sweep.obs === after.verdict : null,
    transcriptTicks: stepsUntil(s.ticks, t0, (x) => x.file === after.full), verdictSweeps: stepsUntil(s.sweeps, t0, (x) => x.obs === after.verdict),
    tickMs: tick && tick.at - t0, sweepMs: sweep && sweep.end - t0,
    capturedAhead: Number(Boolean(h.lastCapturedAt && Date.parse(h.lastCapturedAt) > s.lastEnd.rotation + 500))
      + Number(Boolean(obs && Date.parse(obs.observedAt) > s.lastEnd.structural + 500)) };
  record(row);
  return row;
}

type Op = (s: Seat) => Promise<unknown>;
const roundTrip = (flag: "-x" | "-y", small: number, big: number): Op => async (s) => {
  await s.run("resize-window", "-t", `=${s.name}:`, flag, String(small)); await wait(300); await s.run("resize-window", "-t", `=${s.name}:`, flag, String(big));
};
// changes: the operation is known to change the capture on every tmux tested (3.3a, 3.4, 3.8)
const CASES: Array<{ label: string; history: number; screen: string; op: Op; changes?: boolean }> = [
  { label: "resize round trip 20 > 2 > 20 rows, no scrollback, a prompt on screen", history: 0, screen: PROMPT, op: roundTrip("-y", 2, 20), changes: true },
  { label: "send-keys -R (terminal reset), no scrollback, a prompt on screen", history: 0, screen: PROMPT, op: (s) => s.run("send-keys", "-R", "-t", `=${s.name}:`), changes: true },
  { label: "send-keys -R, with scrollback", history: 2000, screen: `${LINES(40)}; ${PROMPT}`, op: (s) => s.run("send-keys", "-R", "-t", `=${s.name}:`) },
  { label: "resize round trip, with scrollback, cursor at top", history: 2000, screen: `${LINES(15)}; printf '\\033[H'`, op: roundTrip("-y", 2, 20) },
  { label: "resize-pane round trip in a split window", history: 0, screen: PROMPT, op: async (s) => {
    await s.run("split-window", "-d", "-v", "-t", `=${s.name}:`, "sleep 100000"); await s.run("resize-pane", "-t", `=${s.name}:.0`, "-y", "2");
    await wait(300); await s.run("kill-pane", "-t", `=${s.name}:.1`);
  } },
  { label: "break-pane round trip", history: 0, screen: PROMPT, op: async (s) => {
    await s.run("split-window", "-d", "-t", `=${s.name}:`, "sleep 100000"); await s.run("break-pane", "-d", "-s", `=${s.name}:.1`);
    await wait(300); await s.run("kill-window", "-t", `=${s.name}:1`);
  } },
  { label: "swap-pane with a same-size pane", history: 2000, screen: PROMPT, op: async (s) => {
    await s.run("new-session", "-d", "-s", `${s.name}-o`, "-x", "100", "-y", "20", "sh", "-c", "echo other; exec sleep 100000"); await wait(400);
    await s.run("swap-pane", "-s", `=${s.name}-o:0.0`, "-t", `=${s.name}:0.0`);
  } },
  { label: "copy-mode enter and exit (text unchanged)", history: 2000, screen: `${LINES(40)}; ${PROMPT}`, op: async (s) => {
    await s.run("copy-mode", "-t", `=${s.name}:`); await s.run("send-keys", "-t", `=${s.name}:`, "-X", "history-top"); await s.run("send-keys", "-t", `=${s.name}:`, "-X", "cancel");
  } },
  { label: "display-panes and select-layout (text unchanged)", history: 2000, screen: PROMPT, op: async (s) => {
    await s.run("display-panes", "-t", `=${s.name}:`, "-d", "200").catch(() => {}); await s.run("select-layout", "-t", `=${s.name}:`, "tiled");
  } },
];

const seats: Seat[] = [];
afterAll(async () => { for (const s of seats) await s.done(); });

describe.skipIf(!nativeAvailable).concurrent("silent text changes on an idle seat", () => {
  CASES.forEach((c, i) => {
    it(c.label, async () => {
      const s = await seat(`c${i}-s@r`, { history: c.history, screen: c.screen });
      seats.push(s);
      const r = await measure(s, c.label, () => c.op(s));
      if (c.changes) expect(r.textChanged).toBe(true);
      expect(r.transcriptAtTick, `transcript by the start of rotation tick ${TRANSCRIPT_TICKS} after the change`).toBe(true);
      expect(r.verdictAtSweep, "verdict by the end of the second structural sweep after the change").toBe(true);
      expect(r.capturedAhead, "capture times ahead of the last real capture").toBe(0);
    }, WAIT_MS + 40_000);
  });

  const FAILURES: Array<[string, (s: Seat) => Promise<unknown>]> = [
    // capture-pane alone fails while list-windows still lists the seat
    ["injected capture-pane failure", async (s) => { s.failCaptures.on = true; }],
    ["session killed", (s) => s.run("kill-session", "-t", `=${s.name}`)],
    ["tmux server killed", (s) => s.run("kill-server")],
  ];
  for (const [how, act] of FAILURES) it(`a failing capture on an idle seat is noticed: ${how}`, async () => {
    expect(FULL_READ_MS, "a quiet pane is read in full at least every 10 s").toBeLessThanOrEqual(MAX_FULL_READ_MS);
    const s = await seat(`fail${how.length}-s@r`, { history: 2000, screen: PROMPT });
    seats.push(s);
    await wait(9000);
    const lastStructural = s.lastEnd.structural, lastRotation = s.lastEnd.rotation;
    await act(s);
    const t0 = Date.now();
    // Each reader notices at its next capture: every due one on a tree that reads them all, the full read on one that
    // skips quiet panes. Counted from when that capture is due.
    const sweep = await nth(s.sweeps, Math.max(t0, lastStructural + FULL_READ_MS), 2);
    const failedTick = await nth(s.ticks, Math.max(t0, lastRotation + FULL_READ_MS), TRANSCRIPT_TICKS);
    // Ingest reads stale once its last real capture is past the stale window and a capture has been due since.
    const staleTick = await nth(s.ticks, Math.max(t0, lastRotation + Math.max(FULL_READ_MS, rotation.DEFAULT_TRANSCRIPT_STALE_AFTER_MS)), TRANSCRIPT_TICKS);
    const row = { case: `failing capture on an idle seat: ${how}`, verdictDroppedAtSweep: sweep ? sweep.obs === null : null,
      rotationFailedAtTick: failedTick ? failedTick.failed > 0 : null, ingestStaleAtTick: staleTick ? staleTick.health.state !== "live" : null,
      verdictSweeps: stepsUntil(s.sweeps, t0, (x) => x.obs === null), rotationTicks: stepsUntil(s.ticks, t0, (x) => x.failed > 0),
      sweepMs: sweep && sweep.end - t0, failedTickMs: failedTick && failedTick.at - t0, staleTickMs: staleTick && staleTick.at - t0 };
    record(row);
    expect(row.verdictDroppedAtSweep, "verdict dropped by the end of the second sweep once a capture is due").toBe(true);
    expect(row.rotationFailedAtTick, `rotation failed by tick ${TRANSCRIPT_TICKS} once a capture is due`).toBe(true);
    expect(row.ingestStaleAtTick, "ingest not live once the last capture is past the stale window").toBe(true);
  }, WAIT_MS + 50_000);

  it("list-windows delayed 8 s: one listing alive at a time, captures carry on", async () => {
    const s = await seat("slow-s@r", { history: 2000, screen: PROMPT, listingDelayS: 8 });
    seats.push(s);
    let verdictMissing = 0, polls = 0;
    const t0 = Date.now();
    await wait(3000);
    while (Date.now() - t0 < 24_000) {
      polls += 1;
      if (s.svc.getStructuralActivity(s.name) === null) verdictMissing += 1;
      await wait(250);
    }
    const row = { case: "list-windows delayed 8 s", maxLiveListings: s.listings.max, verdictMissingPolls: verdictMissing, polls,
      rotationCaptures: s.rotationCalls.all };
    record(row);
    expect(row.maxLiveListings).toBeLessThanOrEqual(1);
    expect(row.verdictMissingPolls).toBe(0);
    expect(row.rotationCaptures).toBeGreaterThanOrEqual(8);
  }, 60_000);
});
