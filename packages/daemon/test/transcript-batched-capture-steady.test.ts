// #161, real timers: the batch yields to the real event loop between transcript writes, so fake timers would skew
// these. A fake tmux with a fixed latency per exec sits behind the real TmuxAdapter.
import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { startTranscriptRotation, clearAllTranscriptRotationsForTest, getTranscriptCaptureStats } from "../src/domain/transcript-rotation.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const roots: string[] = [];
afterEach(async () => {
  clearAllTranscriptRotationsForTest();
  await sleep(500);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** `sessions` maps a live session to its pane text. `chainError` makes every chained call fail with that message, and
 *  `captureError` every single capture too. `listedOnly` names sessions the listing still shows after they are gone. */
function fakeTmux(latencyMs: number) {
  const sessions = new Map<string, string>();
  const calls: string[] = [];
  const state = { chainError: null as string | null, captureError: null as string | null, listedOnly: new Set<string>(), listError: null as string | null };
  const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv) => {
    calls.push(argv[1]!);
    await sleep(latencyMs);
    if (argv[1] === "list-sessions") {
      if (state.listError) throw new Error(state.listError);
      return [...sessions.keys(), ...state.listedOnly].join("\n") + "\n";
    }
    if (argv[1] === "capture-pane") {
      if (state.captureError) throw new Error(state.captureError);
      const name = argv[argv.indexOf("-t") + 1]!.slice(1, -1);
      if (!sessions.has(name)) throw new Error(`can't find session: ${name}`);
      return sessions.get(name)!;
    }
    if (state.chainError) throw new Error(state.chainError);
    let out = "";
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] !== "display-message") continue;
      const name = argv[i + 3]!.slice(1, -1);
      if (!sessions.has(name)) throw new Error(`can't find session: ${name}`);
      out += `${argv[i + 4]}\n${sessions.get(name)}`;
    }
    return out;
  });
  return { adapter, sessions, calls, state };
}

function start(t: ReturnType<typeof fakeTmux>, names: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "batched-steady-"));
  roots.push(root);
  const live = { lines: 1000, pollIntervalMs: 2000 };
  for (const n of names) startTranscriptRotation(t.adapter, n, path.join(root, n), { ...live }, () => live);
  return (n: string) => fs.readFileSync(path.join(root, n), "utf8");
}

it("a seat that exited on its own and keeps rotating leaves its chunk-mates inside the deadline at 2.6s per exec", async () => {
  const t = fakeTmux(2600);
  const names = Array.from({ length: 8 }, (_, i) => `gone-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} 0\n`);
  const read = start(t, names);
  await sleep(6000);
  t.sessions.delete(names[0]!);
  // The first round after the exit finds it; steady state is measured after that.
  await sleep(7000);
  const before = getTranscriptCaptureStats();
  for (let round = 1; round <= 3; round++) {
    for (const n of names.slice(1)) t.sessions.set(n, `${n} ${round}\n`);
    await sleep(2000);
  }
  await sleep(4000);
  const after = getTranscriptCaptureStats();
  for (const n of names.slice(1)) expect(read(n)).toBe(`${n} 3\n`);
  // Only the dead seat's own reads fail, as with a per-target read each: at most one per 2.6 s exec over the window.
  expect(after.failures - before.failures).toBeLessThanOrEqual(5);
}, 60_000);

it("an unrecognised chain error is not halved: one chain, one listing, and the chunk is left to per-target reads", async () => {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `mismatch-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.state.chainError = t.state.captureError = "protocol version mismatch (client 8, server 7)";
  const got = await t.adapter.capturePanesContent(names, 20);
  expect(t.calls).toEqual(["list-sessions", "display-message"]);
  for (const n of names) expect(got!.has(n), n).toBe(false);
}, 30_000);

/** Rotation over 24 healthy seats whose chained capture fails with an unrecognised error, after `prepare`. */
async function chainErrorRound(prefix: string, prepare: (t: ReturnType<typeof fakeTmux>, first: string) => void) {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `${prefix}-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.state.chainError = "unknown command: display-message";
  prepare(t, names[0]!);
  const read = start(t, names);
  await sleep(3000);
  return { names, read };
}

it("a chain error whose first pane can't be read on its own still updates the other 23 transcripts", async () => {
  const { names, read } = await chainErrorRound("first-gone", (t, first) => { t.sessions.delete(first); t.state.listedOnly.add(first); });
  for (const n of names.slice(1)) expect(read(n), n).toBe(`${n} text\n`);
}, 30_000);

it("a chain error whose first pane captures empty still updates the other 23 transcripts", async () => {
  const { names, read } = await chainErrorRound("first-empty", (t, first) => t.sessions.set(first, ""));
  for (const n of names.slice(1)) expect(read(n), n).toBe(`${n} text\n`);
}, 30_000);

it("a session gone between the listing and the chain is isolated, and the other 23 transcripts update", async () => {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `listed-gone-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.sessions.delete(names[5]!);
  t.state.listedOnly.add(names[5]!);
  const read = start(t, names);
  await sleep(3000);
  for (const n of names.filter((_, i) => i !== 5)) expect(read(n), n).toBe(`${n} text\n`);
}, 30_000);

it("a chain error while the listing fails too leaves the chunk to per-target reads: 26 execs, every transcript updates", async () => {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `unlisted-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.state.chainError = "unknown command: display-message";
  t.state.listError = "list-sessions: lost server reply";
  const read = start(t, names);
  await sleep(3000);
  for (const n of names) expect(read(n), n).toBe(`${n} text\n`);
  const firstRound = t.calls.slice(1, t.calls.indexOf("list-windows", 1));
  expect(firstRound.filter((c) => c === "display-message")).toHaveLength(1);
  expect(firstRound.filter((c) => c === "list-sessions")).toHaveLength(1);
  expect(firstRound.filter((c) => c === "capture-pane")).toHaveLength(24);
  expect(firstRound).toHaveLength(26);
}, 30_000);

it.each([
  ["no server running on /tmp/tmux-1000/default"],
  ["error connecting to /tmp/tmux-1000/default (No such file or directory)"],
])("a server gone (%s) while the listing fails takes the fast path: 2 execs, no per-target reads", async (chainError) => {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `dead-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.state.chainError = chainError;
  t.state.listError = chainError;
  const got = await t.adapter.capturePanesContent(names, 20);
  expect(got).toBeNull();
  expect(t.calls).toEqual(["list-sessions", "display-message"]);
}, 30_000);

it("an error only the chained form hits leaves the chunk out: every seat gets its own capture, 24 reads plus 2 execs", async () => {
  const t = fakeTmux(5);
  const names = Array.from({ length: 24 }, (_, i) => `chain-only-${i}@rig`);
  for (const n of names) t.sessions.set(n, `${n} text\n`);
  t.state.chainError = "unknown command: display-message";
  const read = start(t, names);
  await sleep(3000);
  for (const n of names) expect(read(n)).toBe(`${n} text\n`);
  // Per round, after the activity read: the failed chain, its listing, then the 24 per-target reads main makes.
  const firstRound = t.calls.slice(1, t.calls.indexOf("list-windows", 1));
  expect(firstRound.filter((c) => c === "display-message")).toHaveLength(1);
  expect(firstRound.filter((c) => c === "list-sessions")).toHaveLength(1);
  expect(firstRound.filter((c) => c === "capture-pane")).toHaveLength(24);
  expect(firstRound).toHaveLength(26);
}, 30_000);
