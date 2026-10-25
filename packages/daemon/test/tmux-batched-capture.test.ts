// #308: the structural activity sweep captures every seat's pane with a few tmux calls instead of a fork per seat.
// TmuxAdapter.capturePanesContent runs against a fake tmux with the real chain semantics (exact `=<name>:` targets, a
// `;` chain that stops at its first failing command), in both the shell-string and the argv exec modes; the sweep's use
// of it keeps MF1 (a null capture invalidates) and per-seat fallback.
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

type Panes = Record<string, string>;
/** Runs a tmux argv against `panes` the way tmux does: `;` separates commands, and the first failing one ends it. */
function runTmux(argv: string[], panes: Panes, vanished = new Set<string>(), maxBuffer = Infinity): string {
  if (argv[1] === "list-sessions") return Object.keys(panes).join("\n") + "\n";
  const cmds: string[][] = [[]];
  for (const a of argv.slice(1)) {
    if (a === ";") cmds.push([]);
    else cmds[cmds.length - 1]!.push(a);
  }
  let out = "";
  for (const c of cmds) {
    const target = c[c.indexOf("-t") + 1]!;
    const name = /^=(.*):$/.exec(target)?.[1];
    if (name === undefined) throw new Error(`expected an exact =name: target, got ${target}`);
    if (!(name in panes) || vanished.has(name)) throw Object.assign(new Error(`can't find session: ${name}`), { stdout: out });
    out += c[0] === "display-message" ? `${c[c.length - 1]}\n` : panes[name];
  }
  if (out.length > maxBuffer) throw new Error("stdout maxBuffer length exceeded");
  return out;
}
/** The shell-string mode: split the legacy command back into argv (single quotes, `\;` separators). */
function shellToArgv(cmd: string): string[] {
  const argv: string[] = [];
  for (const m of cmd.matchAll(/'((?:[^']|'"'"')*)'|(\\;)|(\S+)/g)) argv.push(m[1] !== undefined ? m[1].replace(/'"'"'/g, "'") : m[2] ? ";" : m[3]!);
  return argv;
}
/** A pane's text as capture-pane prints it: newline-terminated lines. */
const pane = (n: string) => `• ${n} output\n\n❯ \n`;

describe("TmuxAdapter.capturePanesContent (#308)", () => {
  for (const mode of ["shell", "argv"] as const) {
    /** A TmuxAdapter over the fake tmux in this test's exec mode, recording every tmux argv it runs. */
    function adapter(panes: Panes, opts: { vanished?: Set<string>; noServer?: boolean; maxBuffer?: number } = {}) {
      const calls: string[][] = [];
      const run = (argv: string[]) => {
        calls.push(argv);
        if (opts.noServer) throw new Error("no server running on /tmp/tmux-501/default");
        return runTmux(argv, panes, opts.vanished, opts.maxBuffer);
      };
      const exec = async (cmd: string) => run(shellToArgv(cmd));
      const a = mode === "argv" ? new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async (argv: string[]) => run(argv))
        : new TmuxAdapter(exec);
      return { a, calls };
    }

    it(`${mode}: one listing + one chained call; text as capture-pane prints it; a missing seat is null, no fork`, async () => {
      const { a, calls } = adapter({ "a@r": pane("a"), "b.x@r": pane("b.x"), "o'q@r": pane("o'q") });
      const got = await a.capturePanesContent(["a@r", "gone@r", "b.x@r", "o'q@r"], 20);
      // The missing seat fails the first chain; the listing beside it drops the seat for the one retry.
      expect(calls.map((c) => c[1])).toEqual(["list-sessions", "display-message", "display-message"]);
      expect(Object.fromEntries([...got!].map(([k, v]) => [k, v.text]))).toEqual({ "gone@r": null, "a@r": pane("a"), "b.x@r": pane("b.x"), "o'q@r": pane("o'q") });
    });

    it(`${mode}: 50 distinct live sessions = 1 listing + 3 chained calls of at most 24`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}@r`, pane(`s${i}`)]));
      const { a, calls } = adapter(panes);
      const got = await a.capturePanesContent(Object.keys(panes), 20);
      expect(calls).toHaveLength(1 + 3);
      for (const c of calls.slice(1)) expect(c.filter((x) => x === "capture-pane").length).toBeLessThanOrEqual(24);
      for (let i = 0; i < 50; i++) expect(got!.get(`s${i}@r`)?.text).toBe(pane(`s${i}`));
    });

    it(`${mode}: a session that vanished after the listing is isolated by halving; only it is left out`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`s${i}@r`, pane(`s${i}`)]));
      const { a, calls } = adapter(panes, { vanished: new Set(["s30@r"]) });
      const got = await a.capturePanesContent(Object.keys(panes), 20);
      for (let i = 0; i < 50; i++) expect(got!.has(`s${i}@r`), `s${i}`).toBe(i !== 30);
      expect(calls.length).toBeLessThan(1 + 3 + 24);
    });

    it(`${mode}: each pane keeps the time its own chunk was read; a slow later chunk doesn't renew earlier ones (#309 review)`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}@r`, pane(`s${i}`)]));
      let clock = 1_000_000;
      const now = () => new Date(clock);
      const { a } = adapter(panes);
      const run = (a as unknown as { run: (argv: string[], legacy?: string) => Promise<string> }).run.bind(a);
      (a as unknown as { run: unknown }).run = async (argv: string[], legacy?: string) => {
        const out = await run(argv, legacy);
        if (argv.includes("capture-pane")) clock += argv.includes("=s24@r:") ? 6_000 : 100; // the second chunk is slow
        return out;
      };
      const got = await a.capturePanesContent(Object.keys(panes), 20, now);
      expect(got!.get("s0@r")!.capturedAt.getTime()).toBe(1_000_100);
      expect(got!.get("s23@r")!.capturedAt.getTime()).toBe(1_000_100);
      expect(got!.get("s24@r")!.capturedAt.getTime()).toBe(1_006_100);
    });

    it(`${mode}: a chunk whose output overflows the exec buffer is split until it fits`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`w${i}@r`, `w${i}:` + "x".repeat(40_000) + "\n"]));
      const { a, calls } = adapter(panes, { maxBuffer: 300_000 });
      const got = await a.capturePanesContent(Object.keys(panes), 20);
      for (const n of Object.keys(panes)) expect(got!.get(n)?.text).toBe(panes[n]);
      expect(calls).toHaveLength(1 + 1 + 2 + 4);
    });

    it(`${mode}: the listing runs beside the first chain, so a healthy batch costs one exec of latency`, async () => {
      const { a, calls } = adapter({ "a@r": pane("a"), "b@r": pane("b") });
      let inFlight = 0, peak = 0;
      const run = (a as unknown as { run: (argv: string[], legacy?: string) => Promise<string> }).run.bind(a);
      (a as unknown as { run: unknown }).run = async (argv: string[], legacy?: string) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try { return await run(argv, legacy); } finally { inFlight--; }
      };
      const got = await a.capturePanesContent(["a@r", "b@r"], 20);
      expect(peak).toBe(2);
      expect(calls.map((c) => c[1])).toEqual(["list-sessions", "display-message"]);
      expect(got!.get("b@r")?.text).toBe(pane("b"));
    });

    it(`${mode}: a server gone after the listing fails the chunk at once: no halving, every target null`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`s${i}@r`, pane(`s${i}`)]));
      let listed = false;
      const { a, calls } = adapter(panes);
      const run = (a as unknown as { run: (argv: string[], legacy?: string) => Promise<string> }).run.bind(a);
      (a as unknown as { run: unknown }).run = async (argv: string[], legacy?: string) => {
        if (argv[1] === "list-sessions") { listed = true; return run(argv, legacy); }
        await new Promise((r) => setTimeout(r, 5));
        if (listed) throw new Error("no server running on /tmp/tmux-501/default");
        return run(argv, legacy);
      };
      const got = await a.capturePanesContent(Object.keys(panes), 20);
      expect(calls.map((c) => c[1])).toEqual(["list-sessions"]);
      for (const n of Object.keys(panes)) expect(got!.get(n)?.text).toBeNull();
    });

    it(`${mode}: a session that vanished after the listing is isolated by halving both halves at once`, async () => {
      const panes = Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`s${i}@r`, pane(`s${i}`)]));
      const { a } = adapter(panes, { vanished: new Set(["s3@r"]) });
      let inFlight = 0, peak = 0;
      const run = (a as unknown as { run: (argv: string[], legacy?: string) => Promise<string> }).run.bind(a);
      (a as unknown as { run: unknown }).run = async (argv: string[], legacy?: string) => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((r) => setTimeout(r, 5));
        try { return await run(argv, legacy); } finally { inFlight--; }
      };
      const got = await a.capturePanesContent(Object.keys(panes), 20);
      for (const n of Object.keys(panes)) expect(got!.has(n), n).toBe(n !== "s3@r");
      expect(peak).toBeGreaterThanOrEqual(2);
    });

    it(`${mode}: no listing -> null; a pane printing another call's marker text can't split the output`, async () => {
      expect(await adapter({ "a@r": pane("a") }, { noServer: true }).a.capturePanesContent(["a@r"], 20)).toBeNull();
      const spoof = "__openrig_capture_00000000000000000000000000000000_1__\n";
      const got = await adapter({ "a@r": `x\n${spoof}y\n`, "b@r": pane("b") }).a.capturePanesContent(["a@r", "b@r"], 20);
      expect(got!.get("a@r")?.text).toBe(`x\n${spoof}y\n`);
      expect(got!.get("b@r")?.text).toBe(pane("b"));
    });
  }
});

describe("SeatStructuralActivityService sweep with the batched capture (#308)", () => {
  /** A test DB with one running, tmux-bound seat per name (`<name>@r`). */
  function dbWithRunningSeats(names: string[]) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    for (const n of names) {
      const node = rigRepo.addNode(rig.id, `dev.${n}`, { runtime: "claude-code" });
      const sess = reg.registerSession(node.id, `${n}@r`);
      reg.updateStatus(sess.id, "running");
      reg.updateBinding(node.id, { tmuxSession: `${n}@r`, attachmentType: "tmux" });
    }
    return db;
  }

  it("one batch per sweep, no per-seat capture; a seat the batch maps to null loses its cached row (MF1)", async () => {
    const db = dbWithRunningSeats(["a", "b", "c"]);
    let batches = 0, single = 0;
    const tmux = {
      capturePanesContent: async (targets: string[]) => {
        batches++;
        return new Map(targets.map((t) => [t, { text: t === "c@r" ? null : t === "a@r" ? "⠋ Working… (esc to interrupt)" : "out\n❯ ", capturedAt: new Date() }]));
      },
      capturePaneContent: async () => { single++; return "❯ "; },
    } as never;
    const svc = new SeatStructuralActivityService(tmux);
    (svc as unknown as { latestBySession: Map<string, unknown> }).latestBySession.set("c@r", { state: "agent_idle", reason: "x", evidence: null, observedAt: new Date().toISOString() });
    await svc.pollAllRunningTmuxSeats(db);
    expect([batches, single]).toEqual([1, 0]);
    expect(svc.getStructuralActivity("a@r")?.state).toBe("agent_active");
    expect(svc.getStructuralActivity("b@r")?.state).toBe("agent_idle");
    expect(svc.getStructuralActivity("c@r")).toBeNull();
  });

  it("an observation keeps its capture's own time: after a slow sweep an early capture is not renewed and expires (#309 review)", async () => {
    const db = dbWithRunningSeats(["a", "b"]);
    let clock = Date.parse("2026-10-01T12:00:00.000Z");
    const capturedEarly = new Date(clock);
    const tmux = {
      capturePanesContent: async () => {
        clock += 5_200; // a later chunk held the sweep for 5.2 s
        return new Map([["a@r", { text: "⠋ Working… (esc to interrupt)", capturedAt: capturedEarly }], ["b@r", { text: "out\n❯ ", capturedAt: new Date(clock) }]]);
      },
      capturePaneContent: async () => "❯ ",
    } as never;
    const svc = new SeatStructuralActivityService(tmux, () => new Date(clock));
    await svc.pollAllRunningTmuxSeats(db);
    // a's text is 5.2 s old: past the 5 s freshness window, so it is not served as current
    expect(svc.getStructuralActivity("a@r")).toBeNull();
    expect(svc.getStructuralActivity("b@r")?.observedAt).toBe(new Date(clock).toISOString());
  });

  it("a seat the batch left out, or a failed/absent batch, is captured per seat as before", async () => {
    const db = dbWithRunningSeats(["a", "b"]);
    const perSeat: string[] = [];
    const partial = {
      capturePanesContent: async () => new Map([["a@r", { text: "out\n❯ ", capturedAt: new Date() }]]),
      capturePaneContent: async (t: string) => { perSeat.push(t); return "⠹ Working… esc to interrupt"; },
    } as never;
    const svc = new SeatStructuralActivityService(partial);
    await svc.pollAllRunningTmuxSeats(db);
    expect(perSeat).toEqual(["b@r"]);
    expect(svc.getStructuralActivity("b@r")?.state).toBe("agent_active");
    const failed: string[] = [];
    const down = new SeatStructuralActivityService({
      capturePanesContent: async () => { throw new Error("tmux gone"); },
      capturePaneContent: async (t: string) => { failed.push(t); return null; },
    } as never);
    await down.pollAllRunningTmuxSeats(db);
    expect(failed.sort()).toEqual(["a@r", "b@r"]);
  });
});
