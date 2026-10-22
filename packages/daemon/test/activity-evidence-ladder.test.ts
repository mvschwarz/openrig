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
    // N agreements span N-1 intervals — size the step so the TOTAL span crosses the window.
    const stepMs = Math.ceil(RUNG_PROMOTION_MIN_WINDOW_MS / (RUNG_PROMOTION_AGREEMENT_COUNT - 1)) + 1_000;
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

// A Codex seat with the core plugin installed can run the relay twice for one event: once as the plugin's hook and once
// as the daemon's managed hook. Each post is tagged with the route it ran as, and promotion counts agreements per route,
// so one event can't count twice toward the bar. A disagreement from any route still resets every route's run.
describe("AM-2 promotion counts agreements per relay route", () => {
  const CODEX_SEAT = "node-codex-route";
  const CODEX_SESSION = "impl@route-rig";

  function trialSeat() {
    const h = makeHarness();
    h.svc.declareRungInventory({ seatNodeId: CODEX_SEAT, sessionName: CODEX_SESSION }, CODEX_INVENTORY);
    const base = (rung: EvidenceRungId, sourceId: string): ActivityEvidence => ({
      seatNodeId: CODEX_SEAT, sessionName: CODEX_SESSION, rung, sourceId, seq: ++seqCounter,
      observedAt: new Date(h.clock.now).toISOString(),
    });
    const sample = (activity: ActivityValue) =>
      h.svc.reportEvidence({ ...base("window-sampling", "tmux:window-activity"), activity });
    const hook = (activity: ActivityValue, route?: ActivityEvidence["route"]) =>
      h.svc.reportEvidence({ ...base("lifecycle-hooks", "codex:hooks"), activity, ...(route ? { route } : {}) });
    const trust = () => h.svc.getSeatState(CODEX_SEAT)!.rungs.find((r) => r.rung === "lifecycle-hooks")!.trust;
    return { h, base, sample, hook, trust };
  }
  // n events spread so their first and last are more than the minimum window apart.
  const stepFor = (n: number) => Math.ceil(RUNG_PROMOTION_MIN_WINDOW_MS / (n - 1)) + 1_000;

  it("25 real events posted by both routes don't promote; the next disagreement is still decided by sampling", () => {
    const s = trialSeat();
    const events = RUNG_PROMOTION_AGREEMENT_COUNT / 2;
    for (let i = 0; i < events; i++) {
      s.h.clock.now += stepFor(events);
      s.sample("working");
      s.hook("working", "plugin");
      s.hook("working", "managed");
    }
    expect(s.trust()).toBe("trial");
    s.h.clock.now += 1_000;
    s.sample("idle-at-prompt");
    s.hook("working", "plugin");
    expect(s.h.svc.getSeatState(CODEX_SEAT)!.decidedBy).toBe("window-sampling");
  });

  it("one route's 50 agreements over the window promote, repeated identical events included", () => {
    const s = trialSeat();
    const n = RUNG_PROMOTION_AGREEMENT_COUNT;
    for (let i = 0; i < n; i++) {
      s.h.clock.now += stepFor(n);
      s.sample("working");
      s.hook("working", "plugin"); // the same activity again and again, no turn id: each is a real event and counts
    }
    expect(s.trust()).toBe("authoritative");
    s.h.clock.now += 1_000;
    s.sample("idle-at-prompt");
    s.hook("working", "managed");
    expect(s.h.svc.getSeatState(CODEX_SEAT)!.decidedBy).toBe("lifecycle-hooks");
  });

  it("routes that cover different stretches don't add together (30 + 30)", () => {
    const s = trialSeat();
    const total = 60;
    for (let i = 0; i < total; i++) {
      s.h.clock.now += stepFor(total);
      s.sample("working");
      s.hook("working", i < 30 ? "managed" : "plugin");
    }
    expect(s.trust()).toBe("trial");
  });

  it("a disagreement from the other route resets this route's count and its clock", () => {
    const s = trialSeat();
    const n = RUNG_PROMOTION_AGREEMENT_COUNT;
    for (let i = 0; i < n - 1; i++) {
      s.h.clock.now += stepFor(n - 1);
      s.sample("working");
      s.hook("working", "plugin");
    }
    // 49 plugin agreements over more than the window. The managed route now disagrees.
    s.h.clock.now += 1_000;
    s.sample("working");
    s.hook("idle-at-prompt", "managed");
    // One more plugin agreement would have been the 50th: the count was reset, so it isn't.
    s.h.clock.now += 1_000;
    s.sample("working");
    s.hook("working", "plugin");
    expect(s.trust()).toBe("trial");
    // The clock was reset too: 50 agreements since the reset, but inside the window, don't promote.
    for (let i = 0; i < n - 1; i++) {
      s.h.clock.now += 1_000;
      s.sample("working");
      s.hook("working", "plugin");
    }
    expect(s.trust()).toBe("trial");
    // Once the window has passed since the first agreement after the reset, the next one promotes.
    s.h.clock.now += RUNG_PROMOTION_MIN_WINDOW_MS;
    s.sample("working");
    s.hook("working", "plugin");
    expect(s.trust()).toBe("authoritative");
  });

  it("untagged posts count as one route of their own, as before, and an unrecognised label is a separate route", () => {
    const untagged = trialSeat();
    const n = RUNG_PROMOTION_AGREEMENT_COUNT;
    for (let i = 0; i < n; i++) {
      untagged.h.clock.now += stepFor(n);
      untagged.sample("working");
      untagged.hook("working");
    }
    expect(untagged.trust()).toBe("authoritative");

    const mixed = trialSeat();
    const half = n / 2;
    for (let i = 0; i < half; i++) {
      mixed.h.clock.now += stepFor(half);
      mixed.sample("working");
      mixed.hook("working");
      mixed.hook("working", "unrecognised");
      mixed.hook("working", "managed");
    }
    expect(mixed.trust()).toBe("trial");
  });

  it("a permission request from the other route neither counts nor resets, as before", () => {
    const s = trialSeat();
    const n = RUNG_PROMOTION_AGREEMENT_COUNT;
    for (let i = 0; i < n - 1; i++) {
      s.h.clock.now += stepFor(n - 1);
      s.sample("working");
      s.hook("working", "plugin");
    }
    s.h.svc.reportEvidence({ ...s.base("lifecycle-hooks", "codex:hooks"), route: "managed", permissionRequest: { id: "turn-1" } });
    expect(s.trust()).toBe("trial");
    expect(s.h.svc.getSeatState(CODEX_SEAT)!.needsInput.count).toBe(0); // unconfirmed until the prompt is seen, unchanged
    s.h.clock.now += 1_000;
    s.sample("working");
    s.hook("working", "plugin");
    expect(s.trust()).toBe("authoritative");
  });
});
