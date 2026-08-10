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
