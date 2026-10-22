// Panes that have not written since their last capture are not captured again. These run against a real tmux server
// and check that the transcript never misses output the pane printed: random prints with idle gaps, a burst right
// after a skipped tick, writes inside a capture's own start second, and pane changes that are not output.
import { expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, stopTranscriptRotation, getTranscriptCaptureStats } from "../src/domain/transcript-rotation.js";

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

function server(name: string) {
  const socket = `openrig-skip-${name}-${process.pid}-${Date.now()}`;
  const exec = promisify(execFile);
  const run = async (...args: string[]) => (await exec("tmux", ["-L", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
  let captures = 0;
  const adapter = new TmuxAdapter(async () => { throw new Error("expected argv transport"); }, undefined, async (argv) => {
    if (argv.includes("capture-pane")) captures += 1;
    return run(...argv.slice(1));
  });
  return { run, adapter, captures: () => captures };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const say = (run: (...a: string[]) => Promise<string>, text: string) => run("send-keys", "-t", "seat", "-l", text).then(() => run("send-keys", "-t", "seat", "Enter"));

it.skipIf(!nativeAvailable)("never loses output: random prints, idle gaps, bursts after a skipped tick, same-second writes", async () => {
  const { run, adapter, captures } = server("lost");
  const root = mkdtempSync(join(tmpdir(), "skip-native-"));
  const store = new TranscriptStore({ transcriptsRoot: root });
  const file = store.getTranscriptPath("rig", "seat");
  const opts = { lines: 1000, pollIntervalMs: 1000 };
  // Deterministic schedule (ms after start): idle stretches, single lines, a burst, two writes one tick apart.
  const schedule: Array<[number, string]> = [
    [300, "a"], [4500, "b"], [4600, "c"], [9000, "burst-1"], [9010, "burst-2"], [9020, "burst-3"],
    [13050, "edge-1"], [14050, "edge-2"], [19500, "late"],
  ];
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "30", "cat");
    await wait(200);
    startTranscriptRotation(adapter, "seat", file, opts, () => opts);
    const began = Date.now();
    let mismatches = 0;
    let checks = 0;
    for (const [at, text] of schedule) {
      while (Date.now() - began < at) {
        await wait(50);
      }
      await say(run, text);
    }
    // After the last write, every check once the next tick has run must equal a full capture.
    const until = Date.now() + 8000;
    await wait(2500);
    while (Date.now() < until) {
      checks += 1;
      const want = await run("capture-pane", "-p", "-t", "seat", "-S", "-1000");
      if (readFileSync(file, "utf8") !== want) mismatches += 1;
      expect(store.getIngestHealth("rig", "seat")).toMatchObject({ state: "live", reason: "capture_fresh" });
      await wait(200);
    }
    const transcript = readFileSync(file, "utf8");
    for (const [, text] of schedule) expect(transcript, text).toContain(text);
    expect(mismatches, `${mismatches} of ${checks} checks`).toBe(0);
    // Idle stretches were not captured on every tick.
    expect(captures()).toBeLessThan(20);
  } finally {
    stopTranscriptRotation("seat");
    await run("kill-server").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 40_000);

it.skipIf(!nativeAvailable)("a resize while idle is captured on the next tick, though tmux counts no activity", async () => {
  const { run, adapter } = server("resize");
  const root = mkdtempSync(join(tmpdir(), "skip-resize-"));
  const file = join(root, "seat.log");
  const opts = { lines: 1000, pollIntervalMs: 1000 };
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "120", "-y", "30", "cat");
    await say(run, "x".repeat(110));
    await wait(1200);
    startTranscriptRotation(adapter, "seat", file, opts, () => opts);
    await wait(4000);
    const before = readFileSync(file, "utf8");
    const activity = await run("display-message", "-p", "-t", "seat", "#{window_activity}");
    await run("resize-window", "-t", "seat", "-x", "60", "-y", "30");
    expect(await run("display-message", "-p", "-t", "seat", "#{window_activity}")).toBe(activity); // no activity bump
    const reflowed = await run("capture-pane", "-p", "-t", "seat", "-S", "-1000");
    expect(reflowed).not.toBe(before);
    await wait(2500);
    expect(readFileSync(file, "utf8")).toBe(reflowed);
  } finally {
    stopTranscriptRotation("seat");
    await run("kill-server").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

it.skipIf(!nativeAvailable)("a pane with no window-activity hint keeps the configured capture cadence", async () => {
  const { run, adapter, captures } = server("nohint");
  const root = mkdtempSync(join(tmpdir(), "skip-nohint-"));
  const file = join(root, "seat.log");
  const opts = { lines: 1000, pollIntervalMs: 1000 };
  // An older tmux, or a failing listing: the hint read reports nothing.
  (adapter as unknown as { readAllSessionWindowActivity: () => Promise<null> }).readAllSessionWindowActivity = async () => null;
  (adapter as unknown as { readAllSessionWindows: () => Promise<null> }).readAllSessionWindows = async () => null;
  try {
    await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "30", "cat");
    await say(run, "quiet");
    await wait(300);
    startTranscriptRotation(adapter, "seat", file, opts, () => opts);
    await wait(6200);
    expect(captures()).toBeGreaterThanOrEqual(6);
    expect(getTranscriptCaptureStats().idleSeats).toBe(0);
  } finally {
    stopTranscriptRotation("seat");
    await run("kill-server").catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);


// Pane changes tmux reports neither as activity nor as a window resize: each moves a field of the compared pane key.
async function idleSeat(name: string, opts = { lines: 1000, pollIntervalMs: 1000 }) {
  const { run, adapter, captures } = server(name);
  const root = mkdtempSync(join(tmpdir(), `skip-${name}-`));
  const file = join(root, "seat.log");
  await run("new-session", "-d", "-s", "seat", "-x", "100", "-y", "20", "sh", "-c", "seq 1 30; exec cat");
  await wait(1500);
  startTranscriptRotation(adapter, "seat", file, opts, () => opts);
  await wait(3500); // idle: the ticks after the first capture are skips
  const pane = () => run("capture-pane", "-p", "-t", "=seat:", "-S", "-1000");
  const landsWithin = async (ms: number) => {
    const until = Date.now() + ms;
    const read = () => { try { return readFileSync(file, "utf8"); } catch { return null; } };
    while (Date.now() < until) { if (read() === await pane()) return true; await wait(100); }
    return false;
  };
  const done = async () => { stopTranscriptRotation("seat"); await run("kill-server").catch(() => {}); rmSync(root, { recursive: true, force: true }); };
  return { run, file, pane, landsWithin, captures, done };
}

for (const [label, act] of [
  // A silent respawn: the screen reinitialises and the history goes, but nothing is printed.
  ["respawn-pane -k (a seat restart)", (run: (...a: string[]) => Promise<string>) => run("respawn-pane", "-k", "-t", "=seat:", "cat")],
  ["select-pane to another pane", async (run: (...a: string[]) => Promise<string>) => {
    await run("split-window", "-d", "-t", "=seat:", "sh", "-c", "echo second pane; exec cat");
    await wait(2500); // the split's own output is captured; then the seat is idle again
    await run("select-pane", "-t", "=seat:.1");
  }],
  // Zoom: the window size stays, the active pane's size changes, and its text reflows.
  ["resize-pane -Z (zoom)", async (run: (...a: string[]) => Promise<string>) => {
    await run("split-window", "-d", "-h", "-t", "=seat:", "sh", "-c", "exec cat");
    await run("send-keys", "-t", "=seat:.0", "-l", "x".repeat(70)); await run("send-keys", "-t", "=seat:.0", "Enter");
    await wait(2500);
    await run("resize-pane", "-Z", "-t", "=seat:.0");
  }],
  ["clear-history", (run: (...a: string[]) => Promise<string>) => run("clear-history", "-t", "=seat:")],
] as const) {
  it.skipIf(!nativeAvailable)(`${label}: the transcript equals the pane within one tick`, async () => {
    const seat = await idleSeat(label.split(" ")[0]!.replace(/\W/g, ""));
    try {
      await act(seat.run);
      expect(await seat.landsWithin(2500)).toBe(true);
    } finally { await seat.done(); }
  }, 30_000);
}

it.skipIf(!nativeAvailable)("a transcript deleted or truncated under an idle seat is rewritten within one tick", async () => {
  const seat = await idleSeat("gone");
  try {
    rmSync(seat.file);
    expect(await seat.landsWithin(2500)).toBe(true);
    await wait(2000);
    writeFileSync(seat.file, "");
    expect(await seat.landsWithin(2500)).toBe(true);
  } finally { await seat.done(); }
}, 30_000);

it.skipIf(!nativeAvailable)("a transcript rewritten to the same length by another writer is restored within one tick", async () => {
  const seat = await idleSeat("same");
  try {
    const held = readFileSync(seat.file, "utf8");
    await wait(1100); // a later mtime than rotation's own write, on any filesystem clock
    writeFileSync(seat.file, held.replace(/[0-9]/g, "x"));
    expect(readFileSync(seat.file, "utf8").length).toBe(held.length);
    expect(await seat.landsWithin(2500)).toBe(true);
  } finally { await seat.done(); }
}, 30_000);
