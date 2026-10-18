// Real tmux, real timers. Two SeatStructuralActivityService instances read the same tmux
// server: "skip" gets readAllSessionWindows (the PR path), "full" does not, so it captures every seat every sweep.
// A script of screens is printed into the panes at random offsets inside each second; after every step both services
// sweep and their verdicts must be equal for every seat. Includes the first sweep after skipped ones, a seat that
// appears mid-run, a seat whose pane dies, a seat tmux does not list, flip-flops inside one second, and the
// no-output pane changes (select-pane, respawn-pane, zoom) that the activity hint does not see.
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { createFullTestDb } from "./helpers/test-app.js";

const exec = promisify(execFile);
const socket = `openrig-structural-skip-${process.pid}-${Date.now()}`;
const run = async (...args: string[]) => (await exec("tmux", ["-L", socket, "-f", "/dev/null", ...args], { timeout: 5000 })).stdout;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IDLE = "• Done.\\n\\n❯ \\n";
const WORKING = "✻ Drizzling… (12s · esc to interrupt)\\n";
const ASK = "Do you want to proceed?\\n❯ 1. Yes\\n  2. No\\n";
const ERROR = "Error: something failed\\n$ \\n";
const screens = [IDLE, WORKING, ASK, ERROR];
// Clear screen and history, then print: the whole capture is this one screen.
const show = async (seat: string, screen: string, pane = "") => {
  await run("send-keys", "-t", `=${seat}:${pane}`, "-l", `clear; printf '\\033[3J${screen}'`);
  await run("send-keys", "-t", `=${seat}:${pane}`, "Enter");
};
const alive = new Set(["a@r", "b@r", "c@r"]);

let nativeAvailable = process.platform !== "win32";
try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { nativeAvailable = false; }

it.skipIf(!nativeAvailable)("structural verdicts with the skip equal a capture-every-sweep service at every sweep", async () => {
  const db = createFullTestDb();
  const rigRepo = new RigRepository(db);
  const reg = new SessionRegistry(db);
  const rig = rigRepo.createRig("r");
  const seats: string[] = [];
  const addSeat = (name: string) => {
    const node = rigRepo.addNode(rig.id, `dev.${name}`, { runtime: "claude-code" });
    const sess = reg.registerSession(node.id, name);
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: name, attachmentType: "tmux" });
    seats.push(name);
  };
  const shell = ["env", "-i", "PATH=/usr/bin:/bin", "TERM=screen", "PS1=", "bash", "--noprofile", "--norc", "-i"];
  for (const s of ["a@r", "b@r", "c@r"]) { await run("new-session", "-d", "-s", s, "-x", "100", "-y", "20", ...shell); addSeat(s); }
  addSeat("ghost@r"); // in the db, never in tmux: the hint reports nothing for it
  const adapter = new TmuxAdapter(async () => { throw new Error("argv only"); }, undefined, async (argv) => run(...argv.slice(1)));
  const plain = { capturePaneContent: adapter.capturePaneContent.bind(adapter), capturePanesContent: adapter.capturePanesContent.bind(adapter) };
  const skip = new SeatStructuralActivityService(adapter);
  const full = new SeatStructuralActivityService(plain as never);
  const mismatches: string[] = [];
  let sweeps = 0;
  let rng = 7;
  const rand = () => (rng = (rng * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const sweepBoth = async (label: string) => {
    await wait(150); // the printf has landed in both reads
    await skip.pollAllRunningTmuxSeats(db);
    await full.pollAllRunningTmuxSeats(db);
    sweeps += 1;
    for (const s of seats) {
      const a = skip.getStructuralActivity(s)?.state ?? null, b = full.getStructuralActivity(s)?.state ?? null;
      if (a !== b) mismatches.push(`${label} ${s}: skip=${a} full=${b}`);
    }
  };
  try {
    for (const s of ["a@r", "b@r", "c@r"]) await show(s, IDLE);
    await wait(1200);
    await sweepBoth("init");
    for (let step = 0; step < 40; step++) {
      // A random seat writes (or none) at a random offset inside the second.
      while (Date.now() % 1000 > rand() * 1000) await wait(5);
      const live = [...alive];
      if (rand() < 0.45) await show(live[Math.floor(rand() * live.length)]!, screens[Math.floor(rand() * screens.length)]!);
      await sweepBoth(`step${step}`);
      if (step === 10) { await run("new-session", "-d", "-s", "late@r", "-x", "100", "-y", "20", ...shell); await show("late@r", ASK); addSeat("late@r"); alive.add("late@r"); }
      if (step === 15) { await run("kill-session", "-t", "=c@r"); alive.delete("c@r"); }
      if (step === 20) {
        // flip-flops inside one second: three screens, a sweep after each
        for (const scr of [WORKING, ASK, IDLE]) { await show("a@r", scr); await sweepBoth(`flip ${JSON.stringify(scr.slice(0, 8))}`); }
      }
    }
    // No-output changes on seat b: a second pane showing a dialog becomes active; then a respawn; then a zoom.
    await run("split-window", "-d", "-t", "=b@r:", ...shell);
    await wait(500);
    await show("b@r", ASK, ".1");
    await wait(2500);
    for (let i = 0; i < 3; i++) await sweepBoth(`settle${i}`);
    await run("select-pane", "-t", "=b@r:.1"); // no output: what the capture returns changes from b.0 to b.1
    for (let i = 0; i < 3; i++) { await wait(1000); await sweepBoth(`after select-pane ${i}`); }
    await run("respawn-pane", "-k", "-t", "=b@r:.1", "cat"); // screen reinit, nothing printed
    for (let i = 0; i < 3; i++) { await wait(1000); await sweepBoth(`after respawn-pane ${i}`); }
    console.log(`sweeps=${sweeps} mismatches=${mismatches.length}\n${mismatches.join("\n")}`);
    expect(mismatches).toEqual([]);
  } finally {
    await run("kill-server").catch(() => {});
    db.close();
  }
}, 120_000);
