// 5b82324b — the STRUCTURAL activity cache. Proves structural classification (catching a "Drizzling"
// gerund a verb allowlist misses), plus the two guard-required safety axes:
//   MF1 — a stale positive verdict never survives a capture outage: a null/throw capture INVALIDATES
//         the prior row, and a read REFUSES an observation past the freshness window.
//   MF2 — sweeps are SINGLE-FLIGHT and held until settle: in-flight captures never exceed one sweep
//         (N seats) across many ticks with held captures, then resume on release.

import { describe, it, expect } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatStructuralActivityService } from "../src/domain/seat-structural-activity-service.js";

function mkTmux(content: string | null, counter?: { captures: number }) {
  return {
    capturePaneContent: async () => {
      if (counter) counter.captures++;
      return content;
    },
  } as never;
}

describe("SeatStructuralActivityService — classification", () => {
  it("classifies a mid-work spinner pane (incl. a 'Drizzling' gerund) as agent_active + caches it", async () => {
    const svc = new SeatStructuralActivityService(mkTmux("some output\n⠋ Drizzling… (esc to interrupt)"));
    expect((await svc.pollSeat("dev@rig"))?.state).toBe("agent_active"); // structural markers, NOT a verb allowlist
    expect(svc.getStructuralActivity("dev@rig")?.state).toBe("agent_active");
    expect(svc.getStructuralActivity("dev@rig")?.observedAt).toBeTruthy();
  });

  it("classifies an empty idle prompt as agent_idle", async () => {
    const svc = new SeatStructuralActivityService(mkTmux("output above\n❯ "));
    expect((await svc.pollSeat("dev@rig"))?.state).toBe("agent_idle");
  });

  it("getStructuralActivity is capture-FREE (reads the cache, never re-captures)", async () => {
    const counter = { captures: 0 };
    const svc = new SeatStructuralActivityService(mkTmux("⠹ Working… esc to interrupt", counter));
    await svc.pollSeat("dev@rig");
    svc.getStructuralActivity("dev@rig");
    svc.getStructuralActivity("dev@rig");
    expect(counter.captures).toBe(1); // reads do not capture — no per-request storm
  });
});

describe("SeatStructuralActivityService — MF1: a stale positive never survives a capture outage", () => {
  it("null capture after a positive verdict INVALIDATES the row (no false-live)", async () => {
    let content: string | null = "⠋ Working… esc to interrupt";
    const svc = new SeatStructuralActivityService({ capturePaneContent: async () => content } as never);
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active");
    content = null; // capture goes unavailable
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")).toBeNull(); // invalidated, not a stale positive
  });

  it("THROWING capture after a positive verdict invalidates the row", async () => {
    let mode = "ok";
    const svc = new SeatStructuralActivityService({
      capturePaneContent: async () => {
        if (mode === "throw") throw new Error("tmux gone");
        return "⠋ Working… esc to interrupt";
      },
    } as never);
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active");
    mode = "throw";
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")).toBeNull();
  });

  it("a read REFUSES + evicts an observation past the freshness window (poller made no progress)", async () => {
    let t = Date.parse("2026-08-10T20:00:00.000Z");
    const svc = new SeatStructuralActivityService(
      { capturePaneContent: async () => "⠋ Working… esc to interrupt" } as never,
      () => new Date(t),
      20,
      5000, // staleAfterMs
    );
    await svc.pollSeat("s@rig");
    expect(svc.getStructuralActivity("s@rig")?.state).toBe("agent_active"); // fresh
    t += 5000; // advance past the window; no fresh capture happened
    expect(svc.getStructuralActivity("s@rig")).toBeNull(); // refused + evicted
  });
});

describe("SeatStructuralActivityService — MF2: single-flight, held until settle", () => {
  function dbWith2RunningSeats() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    for (const m of ["a", "b"]) {
      const node = rigRepo.addNode(rig.id, `dev.${m}`, { runtime: "claude-code" });
      const sess = reg.registerSession(node.id, `${m}@r`);
      reg.updateStatus(sess.id, "running");
      reg.updateBinding(node.id, { tmuxSession: `${m}@r`, attachmentType: "tmux" });
    }
    return db;
  }

  it("in-flight captures never exceed one sweep (N) across many ticks with held captures; resumes on release", async () => {
    const db = dbWith2RunningSeats();
    const releasers: Array<() => void> = [];
    let started = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    const tmux = {
      capturePaneContent: async () => {
        started++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((res) => releasers.push(res));
        inFlight--;
        return "❯ ";
      },
    } as never;
    const svc = new SeatStructuralActivityService(tmux);

    // Fire three sweeps while the 2 captures are held. Only the first starts captures; the next two
    // hit the single-flight guard and no-op.
    const s1 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2)); // let the first sweep's captures start
    const s2 = svc.pollAllRunningTmuxSeats(db);
    const s3 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2));
    expect(started).toBe(2); // ONE sweep's worth
    expect(maxInFlight).toBe(2); // never 4 or 6 — no overlapping whole-fleet sweeps

    // Release the held captures → the first sweep settles; the skipped sweeps were already resolved.
    releasers.splice(0).forEach((fn) => fn());
    await Promise.all([s1, s2, s3]);

    // A later tick now resumes (single-flight released after settle).
    const s4 = svc.pollAllRunningTmuxSeats(db);
    await new Promise((r) => setTimeout(r, 2));
    expect(started).toBe(4); // resumed: another 2 captures
    expect(maxInFlight).toBe(2); // still bounded to one sweep
    releasers.splice(0).forEach((fn) => fn());
    await s4;
    db.close();
  });
});

describe("SeatStructuralActivityService: a pane with no output since its last capture is not captured again", () => {
  function dbWithSeats(n: number) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    for (let i = 0; i < n; i++) {
      const node = rigRepo.addNode(rig.id, `dev.s${i}`, { runtime: "claude-code" });
      const sess = reg.registerSession(node.id, `s${i}@r`);
      reg.updateStatus(sess.id, "running");
      reg.updateBinding(node.id, { tmuxSession: `s${i}@r`, attachmentType: "tmux" });
    }
    return db;
  }
  function batchTmux(activity: Map<string, number>, text: Map<string, string>) {
    const captured: string[][] = [];
    return {
      captured,
      tmux: {
        capturePaneContent: async () => { throw new Error("per-target read not expected"); },
        capturePanesContent: async (targets: string[], _lines: number, now: () => Date) => {
          captured.push([...targets]);
          return new Map(targets.map((t) => [t, { text: text.get(t) ?? null, capturedAt: now() }]));
        },
        readAllSessionWindowActivity: async () => new Map(activity),
        readAllSessionWindows: async () => new Map([...activity].map(([s, a]) => [s, { activity: a, size: "80x24" }])),
      } as never,
    };
  }

  it("captures only seats whose window_activity moved, and keeps the others' verdicts fresh", async () => {
    let t = Date.parse("2026-10-13T00:00:00.500Z");
    const sec = () => Math.floor(t / 1000);
    const activity = new Map([["s0@r", sec() - 600], ["s1@r", sec() - 600]]);
    const text = new Map([["s0@r", "❯ "], ["s1@r", "✻ Drizzling… (3s · esc to interrupt)\n"]]);
    const { tmux, captured } = batchTmux(activity, text);
    const db = dbWithSeats(2);
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    await svc.pollAllRunningTmuxSeats(db);
    expect(captured).toEqual([["s0@r", "s1@r"]]);
    const firstObservedAt = svc.getStructuralActivity("s0@r")!.observedAt;
    for (let i = 0; i < 8; i++) { t += 1000; await svc.pollAllRunningTmuxSeats(db); }
    expect(captured).toEqual([["s0@r", "s1@r"]]); // nothing written since: no capture
    expect(svc.getStructuralActivity("s0@r")?.state).toBe("agent_idle"); // still served, still fresh
    expect(svc.getStructuralActivity("s1@r")?.state).toBe("agent_active");
    // observedAt stays the capture; checkedAt is the sweep that found the pane unchanged.
    expect(svc.getStructuralActivity("s0@r")).toMatchObject({ observedAt: firstObservedAt, checkedAt: new Date(t).toISOString() });
    text.set("s0@r", "✻ Working… (1s · esc to interrupt)\n");
    activity.set("s0@r", sec());
    t += 1000; await svc.pollAllRunningTmuxSeats(db);
    expect(captured.at(-1)).toEqual(["s0@r"]);
    expect(svc.getStructuralActivity("s0@r")?.state).toBe("agent_active");
    db.close();
  });

  it("output in the same second as the last capture start is captured again", async () => {
    let t = Date.parse("2026-10-13T00:00:00.500Z");
    const activity = new Map([["s0@r", Math.floor(t / 1000)]]);
    const { tmux, captured } = batchTmux(activity, new Map([["s0@r", "❯ "]]));
    const db = dbWithSeats(1);
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    await svc.pollAllRunningTmuxSeats(db);
    t += 1000; await svc.pollAllRunningTmuxSeats(db);
    expect(captured).toHaveLength(2);
    db.close();
  });

  it("no activity listing: every seat is captured every sweep", async () => {
    let t = Date.parse("2026-10-13T00:00:00.500Z");
    const { tmux, captured } = batchTmux(new Map(), new Map([["s0@r", "❯ "]]));
    (tmux as { readAllSessionWindowActivity: () => Promise<null> }).readAllSessionWindowActivity = async () => null;
    const db = dbWithSeats(1);
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    for (let i = 0; i < 3; i++) { await svc.pollAllRunningTmuxSeats(db); t += 1000; }
    expect(captured).toHaveLength(3);
    db.close();
  });
});

describe("SeatStructuralActivityService: the skip yields the same states as capturing every sweep", () => {
  function dbWithSeat() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.s0", { runtime: "claude-code" });
    const sess = reg.registerSession(node.id, "s0@r");
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: "s0@r", attachmentType: "tmux" });
    return db;
  }
  // A pane as tmux reports it: the text, and window_activity bumped (to the current second) on every write.
  const IDLE = "• Done.\n\n❯ \n";
  const WORKING = "✻ Drizzling… (12s · esc to interrupt)\n";
  const ASK = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
  // [second, screen or null for no write]: idle stretches, a write right after a skipped sweep, same-second writes.
  const script: Array<string | null> = [IDLE, null, null, null, WORKING, null, null, WORKING, ASK, null, null, IDLE, null,
    null, null, null, WORKING, IDLE, null, null];

  it("every sweep's verdict matches a service that captures every seat every sweep", async () => {
    const db = dbWithSeat();
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    let text = "";
    let activity = 0;
    const captured = { skip: 0, full: 0 };
    const tmux = (who: "skip" | "full", hints: boolean) => ({
      capturePaneContent: async () => { throw new Error("per-target read not expected"); },
      capturePanesContent: async (targets: string[], _l: number, now: () => Date) => {
        captured[who] += targets.length;
        return new Map(targets.map((s) => [s, { text, capturedAt: now() }]));
      },
      ...(hints ? { readAllSessionWindows: async () => new Map([["s0@r", { activity, size: "80x24" }]]) } : {}),
    }) as never;
    const skip = new SeatStructuralActivityService(tmux("skip", true), () => new Date(t), 20, 5000);
    const full = new SeatStructuralActivityService(tmux("full", false), () => new Date(t), 20, 5000);
    for (const screen of script) {
      // A write lands at a random moment inside the second, before or after the sweep reads.
      if (screen !== null) { text = screen; activity = Math.floor(t / 1000); }
      await skip.pollAllRunningTmuxSeats(db);
      await full.pollAllRunningTmuxSeats(db);
      expect(skip.getStructuralActivity("s0@r")?.state, `t=${t}`).toBe(full.getStructuralActivity("s0@r")?.state);
      t += 1000;
    }
    expect(captured.full).toBe(script.length);
    expect(captured.skip).toBeLessThan(captured.full);
    db.close();
  });
});

describe("SeatStructuralActivityService: what the skip must not hide", () => {
  function dbWith(runtime: string) {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const reg = new SessionRegistry(db);
    const rig = rigRepo.createRig("r");
    const node = rigRepo.addNode(rig.id, "dev.s0", { runtime });
    const sess = reg.registerSession(node.id, "s0@r");
    reg.updateStatus(sess.id, "running");
    reg.updateBinding(node.id, { tmuxSession: "s0@r", attachmentType: "tmux" });
    return db;
  }
  const quiet = (window: () => Promise<Map<string, { activity: number; size: string }> | null>, text: () => string) => {
    const captured = { n: 0 };
    return {
      captured,
      tmux: {
        capturePaneContent: async () => { throw new Error("per-target read not expected"); },
        capturePanesContent: async (targets: string[], _l: number, now: () => Date) => {
          captured.n += targets.length;
          return new Map(targets.map((s) => [s, { text: text(), capturedAt: now() }]));
        },
        readAllSessionWindows: window,
      } as never,
    };
  };

  it("a pane switch to a dialog changes the pane key, so the next sweep reads it", async () => {
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    const activity = Math.floor(t / 1000) - 600;
    let key = "80x24:%0:100:80x24:50";
    let text = "• Done.\n\n❯ \n";
    const { tmux } = quiet(async () => new Map([["s0@r", { activity, size: key }]]), () => text);
    const db = dbWith("claude-code");
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    for (let i = 0; i < 4; i++) { await svc.pollAllRunningTmuxSeats(db); t += 1000; }
    expect(svc.getStructuralActivity("s0@r")?.state).toBe("agent_idle");
    // select-pane: no output, so window_activity stays; the active pane id changes and its screen is a dialog.
    key = "80x24:%1:101:80x24:0"; text = "Do you want to proceed?\n❯ 1. Yes\n  2. No\n";
    await svc.pollAllRunningTmuxSeats(db);
    expect(svc.getStructuralActivity("s0@r")?.state).toBe("attention");
    db.close();
  });

  it("a window listing that hangs 8 s leaves the verdict present: the sweep captures every seat after 1 s", async () => {
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    const hang = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000));
    const { tmux, captured } = quiet(hang, () => "• Done.\n\n❯ \n");
    const db = dbWith("claude-code");
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    const began = Date.now();
    for (let i = 0; i < 6; i++) {
      await svc.pollAllRunningTmuxSeats(db);
      t += 1000;
      expect(svc.getStructuralActivity("s0@r")?.state).toBe("agent_idle");
    }
    expect(captured.n).toBe(6);
    expect(Date.now() - began).toBeLessThan(6 * 1000 + 1500);
    db.close();
  }, 20_000);

  it("a listing that hangs 8 s stays the only one: no sweep starts another while it is pending", async () => {
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    let live = 0, max = 0, started = 0;
    const hang = () => { started += 1; live += 1; max = Math.max(max, live);
      return new Promise<null>((resolve) => setTimeout(() => { live -= 1; resolve(null); }, 8000)); };
    const { tmux, captured } = quiet(hang, () => "• Done.\n\n❯ \n");
    const db = dbWith("claude-code");
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    for (let i = 0; i < 6; i++) {
      await svc.pollAllRunningTmuxSeats(db);
      t += 1000;
      expect(svc.getStructuralActivity("s0@r")?.state).toBe("agent_idle");
    }
    expect(max).toBe(1);
    expect(started).toBe(1);
    expect(captured.n).toBe(6); // fallback captures carry on
    db.close();
  }, 20_000);

  it("an unchanged seat is read in full every 10 s, so a failing capture drops its verdict within 10 s", async () => {
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    const activity = Math.floor(t / 1000) - 600;
    let fail = false;
    const captured = { n: 0 };
    const tmux = {
      capturePaneContent: async () => null,
      capturePanesContent: async (targets: string[], _l: number, now: () => Date) => {
        captured.n += targets.length;
        return new Map(targets.map((s) => [s, { text: fail ? null : "• Done.\n\n❯ \n", capturedAt: now() }]));
      },
      readAllSessionWindows: async () => new Map([["s0@r", { activity, size: "k" }]]),
    } as never;
    const db = dbWith("claude-code");
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    await svc.pollAllRunningTmuxSeats(db);
    fail = true;
    let droppedAfter: number | null = null;
    for (let i = 1; i <= 12 && droppedAfter === null; i++) {
      t += 1000; await svc.pollAllRunningTmuxSeats(db);
      if (svc.getStructuralActivity("s0@r") === null) droppedAfter = i;
    }
    expect(droppedAfter).toBe(10);
    expect(captured.n).toBe(2);
    db.close();
  });

  it("a Codex seat keeps being read while the limit-banner emitter is attached: its at_limit row is refreshed by the read", async () => {
    let t = Date.parse("2026-10-13T00:00:00.400Z");
    const activity = Math.floor(t / 1000) - 600;
    const banner = "■ You've hit your usage limit. Upgrade to Pro (...), visit\nhttps://chatgpt.com/codex/settings/usage to purchase more credits or try again at 4:14 AM.\n";
    const { tmux, captured } = quiet(async () => new Map([["s0@r", { activity, size: "80x24:%0:100:80x24:0" }]]), () => banner);
    const db = dbWith("codex");
    const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
    const seen: Date[] = [];
    svc.attachCodexLimitBanner((_s, b, at) => { if (b) seen.push(at); });
    for (let i = 0; i < 10; i++) { await svc.pollAllRunningTmuxSeats(db); t += 1000; }
    expect(captured.n).toBe(10);
    expect(seen).toHaveLength(10);
    db.close();
  });

  it("a Codex seat without the emitter, and any other runtime, is still skipped when unchanged", async () => {
    for (const runtime of ["codex", "claude-code"]) {
      let t = Date.parse("2026-10-13T00:00:00.400Z");
      const activity = Math.floor(t / 1000) - 600;
      const { tmux, captured } = quiet(async () => new Map([["s0@r", { activity, size: "k" }]]), () => "❯ \n");
      const db = dbWith(runtime);
      const svc = new SeatStructuralActivityService(tmux, () => new Date(t), 20, 5000);
      for (let i = 0; i < 10; i++) { await svc.pollAllRunningTmuxSeats(db); t += 1000; }
      expect(captured.n, runtime).toBe(1);
      db.close();
    }
  });
});
