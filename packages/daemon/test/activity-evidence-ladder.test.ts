import { describe, it, expect, beforeEach } from "vitest";
import {
  SeatActivityService,
  HOOK_AUTHORITY_WINDOW_MS,
  CROSS_RUNG_CONTRADICTION_WINDOW_MS,
  SAMPLING_IDLE_DEBOUNCE_TICKS,
  RUNG_PROMOTION_AGREEMENT_COUNT,
  RUNG_PROMOTION_MIN_WINDOW_MS,
} from "../src/domain/seat-activity-service.js";
import type {
  ActivityEvidence,
  AdapterRungInventory,
  RungHealthEvent,
  ActivityValue,
  EvidenceRungId,
} from "../src/domain/activity-taxonomy.js";

// OPR.0.5.5.19 A3 — the ranked evidence ladder on the ONE oracle. Every pin here drives
// SeatActivityService through its S19 surfaces with an injected clock; no tmux, no
// daemon. The non-inference contract is untouched: nothing in these fixtures ever
// presents queue state to the service.

const SEAT = "node-claude-1";
const SESSION = "dev50-qa@v-openrig-build";

function makeHarness(startMs = 1_000_000) {
  const clock = { now: startMs };
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
  });
  const health: RungHealthEvent[] = [];
  return { clock, svc, health };
}

const CLAUDE_INVENTORY: AdapterRungInventory = {
  adapterId: "claude-code-adapter",
  runtime: "claude-code",
  rungs: [
    { rung: "self-report", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "needs-input-chrome", lifecycleCoverage: "full", initialTrust: "authoritative" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

const CODEX_INVENTORY: AdapterRungInventory = {
  adapterId: "codex-runtime-adapter",
  runtime: "codex",
  rungs: [
    // AM-2: the fixture-verified hook rung enters at TRIAL, never straight to authority.
    { rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "trial" },
    { rung: "window-sampling", lifecycleCoverage: "full", initialTrust: "authoritative" },
  ],
};

let seqCounter = 0;
function ev(
  clock: { now: number },
  rung: EvidenceRungId,
  sourceId: string,
  activity: ActivityValue | undefined,
  extra: Partial<ActivityEvidence> = {},
): ActivityEvidence {
  return {
    seatNodeId: SEAT,
    sessionName: SESSION,
    rung,
    sourceId,
    seq: ++seqCounter,
    observedAt: new Date(clock.now).toISOString(),
    ...(activity ? { activity } : {}),
    ...extra,
  };
}

describe("S19 A3 — the ladder ranks and falls honestly", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
  });

  it("self-report decides working/idle when present, above hooks and sampling", () => {
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working");
    expect(s.decidedBy).toBe("self-report");
  });

  it("self-report absent (unreadable file = no evidence) falls silently to hooks, then sampling, then unknown", () => {
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("unknown"); // nothing yet — honest
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.decidedBy).toBe("window-sampling");
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("lifecycle-hooks");
  });

  it("stale or reordered per-source seq is dropped: a late lower-seq 'working' never revives an idle seat", () => {
    const idle = ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt");
    const lateWorking: ActivityEvidence = { ...ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"), seq: idle.seq - 5 };
    h.svc.reportEvidence(idle);
    h.svc.reportEvidence(lateWorking);
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");
  });

  it("visible needs-input chrome OUTRANKS a working self-report for the needs-input signal only", () => {
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    h.svc.reportEvidence(ev(h.clock, "needs-input-chrome", "tmux:chrome", undefined, {
      needsInput: { count: 1, reason: "permission prompt" },
    }));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("working"); // chrome never decides working/idle
    expect(s.needsInput).toEqual({ count: 1, reason: "permission prompt" });
  });

  it("hook authority is TIME-BOUNDED: expired hook evidence stops deciding and the ladder falls through", () => {
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"));
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working"); // hook fresh, hook decides
    h.clock.now += HOOK_AUTHORITY_WINDOW_MS + 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt");
    expect(s.decidedBy).toBe("window-sampling"); // fell through, no error, no lie
  });
});

describe("S19 A3 — AM-1: alive-and-partial degradation, visible", () => {
  it("persistent hook-vs-sampler contradiction degrades the hook rung to identity-only with a rung-health event", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    const events: RungHealthEvent[] = [];
    h.svc.onRungHealth((e) => events.push(e));

    // The orch-lead specimen shape: the hook source fired once (working) then silently
    // drops every Stop. The sampler keeps seeing idle-at-prompt.
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "working"));
    for (let i = 0; i < 12; i++) {
      h.clock.now += 1_000; // 1Hz sampler cadence
      h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    }
    expect(h.clock.now - 1_000_000).toBeGreaterThan(CROSS_RUNG_CONTRADICTION_WINDOW_MS);

    const s = h.svc.getSeatState(SEAT)!;
    expect(s.activity).toBe("idle-at-prompt"); // never working-forever off a dead-dropping hook
    const hookRung = s.rungs.find((r) => r.rung === "lifecycle-hooks")!;
    expect(hookRung.trust).toBe("identity-only");
    const degradation = events.find((e) => e.rung === "lifecycle-hooks" && e.to === "identity-only");
    expect(degradation, "degradation must be VISIBLE as a rung-health event").toBeDefined();
    expect(degradation!.reason).toMatch(/contradiction|disagree/i);
  });
});

describe("S19 A3 — flap dies, waits don't race", () => {
  it("sampling-decided working→idle debounces for the stated ticks; an authoritative turn boundary bypasses instantly", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");

    // The mid-turn render lull: one idle observation must NOT flip the state…
    h.clock.now += 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");
    // …the stated consecutive count does.
    for (let i = 1; i < SAMPLING_IDLE_DEBOUNCE_TICKS; i++) {
      h.clock.now += 1_000;
      h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "idle-at-prompt"));
    }
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt");

    // Bypass: back to working, then a hook Stop (authoritative idle) publishes instantly.
    h.clock.now += 1_000;
    h.svc.reportEvidence(ev(h.clock, "window-sampling", "tmux:window-activity", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");
    h.svc.reportEvidence(ev(h.clock, "lifecycle-hooks", "claude:hooks", "idle-at-prompt"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("idle-at-prompt"); // no debounce on a real turn boundary
  });

  it("state changes carry a monotonic seq and wait-after-seq observes a fast transient transition (lost-wakeup fixture)", async () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "idle-at-prompt"));
    const s0 = h.svc.getSeatState(SEAT)!;

    const waiter = h.svc.waitForSeatState(SEAT, { afterSeq: s0.seq, timeoutMs: 2_000 });
    // A fast transient: working then immediately idle again. The waiter must resolve
    // with a state whose seq passed afterSeq — a pass-through transition still satisfies.
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "idle-at-prompt"));
    const woke = await waiter;
    expect(woke).not.toBeNull();
    expect(woke!.seq).toBeGreaterThan(s0.seq);
  });
});

describe("S19 A3 — AM-2: symmetric admission (trial → measured promotion)", () => {
  it("a TRIAL rung's evidence never decides state; measured production agreement promotes it, visibly", () => {
    const h = makeHarness();
    const codexSeat = "node-codex-1";
    const codexSession = "orch-lead@v-openrig-build";
    h.svc.declareRungInventory({ seatNodeId: codexSeat, sessionName: codexSession }, CODEX_INVENTORY);
    const events: RungHealthEvent[] = [];
    h.svc.onRungHealth((e) => events.push(e));

    const cev = (rung: EvidenceRungId, sourceId: string, activity: ActivityValue): ActivityEvidence => ({
      seatNodeId: codexSeat,
      sessionName: codexSession,
      rung,
      sourceId,
      seq: ++seqCounter,
      observedAt: new Date(h.clock.now).toISOString(),
      activity,
    });

    // Trial hook says working; authoritative sampling says idle — sampling decides.
    h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", "working"));
    h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", "idle-at-prompt"));
    expect(h.svc.getSeatState(codexSeat)!.activity).toBe("idle-at-prompt");
    expect(h.svc.getSeatState(codexSeat)!.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");

    // Production agreement: trial evidence AGREES with the arbitrated state, spread over
    // more than the minimum window, for the stated count.
    const stepMs = Math.ceil(RUNG_PROMOTION_MIN_WINDOW_MS / RUNG_PROMOTION_AGREEMENT_COUNT) + 1_000;
    for (let i = 0; i < RUNG_PROMOTION_AGREEMENT_COUNT; i++) {
      h.clock.now += stepMs;
      const value: ActivityValue = i % 2 === 0 ? "working" : "idle-at-prompt";
      h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", value));
      h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", value)); // agrees
    }
    const promoted = h.svc.getSeatState(codexSeat)!.rungs.find((r) => r.rung === "lifecycle-hooks")!;
    expect(promoted.trust).toBe("authoritative");
    expect(events.some((e) => e.rung === "lifecycle-hooks" && e.to === "authoritative")).toBe(true);

    // And now the promoted hook rung outranks sampling:
    h.clock.now += 1_000;
    h.svc.reportEvidence(cev("window-sampling", "tmux:window-activity", "idle-at-prompt"));
    h.svc.reportEvidence(cev("lifecycle-hooks", "codex:hooks", "working"));
    expect(h.svc.getSeatState(codexSeat)!.decidedBy).toBe("lifecycle-hooks");
  });
});

describe("S19 A3 — seat-keyed state through an occupant swap", () => {
  it("a swap is its OWN visible event: no activity flicker, no bleed, and rung trust resets (AM-1 corollary)", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CLAUDE_INVENTORY);
    h.svc.reportEvidence(ev(h.clock, "self-report", "claude:pid-json", "working"));
    expect(h.svc.getSeatState(SEAT)!.activity).toBe("working");

    h.clock.now += 1_000;
    h.svc.declareOccupantSwap(SEAT, "gen-successor-1");

    const s = h.svc.getSeatState(SEAT)!;
    expect(s.lastSwap).toEqual({ generation: "gen-successor-1", at: new Date(h.clock.now).toISOString() });
    expect(s.activity).toBe("unknown"); // the swap window reads as the swap event, never idle/working flicker
    // The predecessor's evidence and rung authority never bleed onto the successor:
    expect(s.rungs.every((r) => r.trust === "absent" || r.lastEvidenceAt === null)).toBe(true);

    // Re-declaration starts the successor UNPROMOTED per its inventory's initial trust:
    h.svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, CODEX_INVENTORY);
    const after = h.svc.getSeatState(SEAT)!;
    expect(after.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust).toBe("trial");
  });

  it("two seats are independent (seat-keyed, never session-global)", () => {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: "node-a", sessionName: "a@rig" }, CLAUDE_INVENTORY);
    h.svc.declareRungInventory({ seatNodeId: "node-b", sessionName: "b@rig" }, CLAUDE_INVENTORY);
    h.svc.reportEvidence({ ...ev(h.clock, "self-report", "claude:pid-json", "working"), seatNodeId: "node-a", sessionName: "a@rig" });
    expect(h.svc.getSeatState("node-a")!.activity).toBe("working");
    expect(h.svc.getSeatState("node-b")!.activity).toBe("unknown");
  });
});
