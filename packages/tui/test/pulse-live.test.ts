import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { buildPulseModel } from "../src/pulse/pulse-model.js";
import { renderExceptionSection } from "../src/pulse/render-pulse.js";
import type { FleetSnapshot, QueueRead } from "../src/types.js";

// A fixed reference clock so age math is deterministic.
const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HR = 60 * MIN;

function liveSnap(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  const base = demoSnapshot();
  // Zero ALL exception + lane sources by default; each test opts into the ones it drives.
  return { ...base, attention: [], blocked: [], inProgress: [], seatActivity: [], pending: [], recentlyFinished: [], ...over };
}

// A ps/activity row for one seat (the PARKED join's right side).
const seat = (session: string, terminalActive: boolean | null, lastActivityAt: string | null) =>
  ({ session, terminalActive, lastActivityAt });

// An in-progress qitem (reuses attn's shape but with a real owner + in-progress state).
const inprog = (over: Partial<QueueRead>): QueueRead =>
  attn({ state: "in-progress", destinationSession: "dev50-guard@openrig-build", claimedAt: ago(50 * MIN), ...over });

const attn = (over: Partial<QueueRead>): QueueRead => ({
  qitemId: "q",
  state: "pending",
  destinationSession: "human-yeah@kernel",
  blockedOn: null,
  handedOffTo: null,
  tier: "human-gate",
  tags: null,
  summary: null,
  body: "",
  claimedAt: null,
  tsUpdated: ago(0),
  ...over,
});

describe("PULSE view increment 2 — Exceptions strip LIVE", () => {
  it("▲ NEEDS YOU: rows built from the attention read (subject from summary, age from claimedAt)", () => {
    const snap = liveSnap({
      attention: [
        attn({ qitemId: "q1", summary: "0.5.0 cut packet ready · waiting on you", claimedAt: ago(22 * MIN) }),
        attn({ qitemId: "q2", summary: "slice-20 routing pixels · waiting on you", claimedAt: ago(3 * HR) }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const needs = model.exceptions.find((s) => s.label === "NEEDS YOU");
    expect(needs).toBeDefined();
    expect(needs!.rows.length).toBe(2);
    const text = renderExceptionSection(needs!).map((l) => l.text).join("\n");
    expect(text).toContain("▲ NEEDS YOU (2)");
    expect(text).toContain("0.5.0 cut packet ready · waiting on you");
    expect(text).toContain("22m");
    expect(text).toContain("slice-20 routing pixels · waiting on you");
    expect(text).toContain("3h");
  });

  it("▲ NEEDS YOU: subject falls back to the body head when summary is null", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: null, body: "please cut the 0.5.1 release now\nsecond line ignored" })],
    });
    const model = buildPulseModel(snap, NOW);
    const needs = model.exceptions.find((s) => s.label === "NEEDS YOU")!;
    const text = renderExceptionSection(needs).map((l) => l.text).join("\n");
    expect(text).toContain("please cut the 0.5.1 release now");
    expect(text).not.toContain("second line ignored");
  });

  it("⧗ BLOCKED ON AGENTS: names the blocking AGENT (blockedOn qitem-id resolved to its owner), not the qitem pointer; human-blocked EXCLUDED", () => {
    const snap = liveSnap({
      blocked: [
        // REALISTIC: an agent-block stores a QITEM ID in blockedOn; the blocking
        // AGENT is that qitem's owner, resolved by hydrate into blockerSession.
        attn({
          qitemId: "b1",
          state: "blocked",
          destinationSession: "dev50-driver@openrig-build",
          blockedOn: "qitem-20260805-blkA", // a qitem POINTER — must NOT be shown as the blocker
          blockerSession: "review-r1@openrig-build", // resolved owner = the blocking agent
          tier: null,
          summary: "terminal verdict for 51209941",
          claimedAt: ago(1 * HR),
        }),
        // human-park stores a SESSION in blockedOn → excluded (already under NEEDS YOU)
        attn({
          qitemId: "b2",
          state: "blocked",
          destinationSession: "dev50-qa@openrig-build",
          blockedOn: "human-yeah@kernel",
          tier: null,
          summary: "human sign-off pending",
          claimedAt: ago(2 * HR),
        }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const blocked = model.exceptions.find((s) => s.label === "BLOCKED ON AGENTS");
    expect(blocked).toBeDefined();
    expect(blocked!.rows.length).toBe(1);
    const text = renderExceptionSection(blocked!).map((l) => l.text).join("\n");
    expect(text).toContain("⧗ BLOCKED ON AGENTS (1)");
    expect(text).toContain("dev50-driver@openrig-build");
    // label==referent: the AGENT is named, the qitem POINTER is NOT rendered
    expect(text).toContain("blocked on review-r1@openrig-build");
    expect(text).not.toContain("qitem-20260805-blkA");
    expect(text).toContain("terminal verdict for 51209941");
    // the human-blocked item must NOT leak into BLOCKED ON AGENTS
    expect(text).not.toContain("dev50-qa@openrig-build");
    expect(text).not.toContain("human sign-off pending");
  });

  it("⧗ BLOCKED ON AGENTS: an UNRESOLVED blocker (blockerSession null) falls back to the raw blockedOn — honest, never fabricated", () => {
    const snap = liveSnap({
      blocked: [
        attn({
          qitemId: "b3",
          state: "blocked",
          destinationSession: "dev50-guard@openrig-build",
          blockedOn: "gate:review", // e.g. a gate name — not a qitem id, does not resolve
          blockerSession: null,
          tier: null,
          summary: "awaiting gate",
          claimedAt: ago(30 * MIN),
        }),
      ],
    });
    const model = buildPulseModel(snap, NOW);
    const blocked = model.exceptions.find((s) => s.label === "BLOCKED ON AGENTS")!;
    const text = renderExceptionSection(blocked).map((l) => l.text).join("\n");
    expect(text).toContain("blocked on gate:review"); // honest raw reference, not a fabricated agent
  });

  it("◌ PARKED WITH BATON: rows from in-progress qitems whose owner is IDLE (terminalActive===false) and NOT handed off; idle-duration derived from lastActivityAt at the renderer", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "qitem-20260806-8f3a1b2c", destinationSession: "dev50-guard@openrig-build", summary: "slice 51-06 D2 atom" }),
      ],
      // owner idle: terminalActive false, last output 47m ago
      seatActivity: [seat("dev50-guard@openrig-build", false, ago(47 * MIN))],
    });
    const model = buildPulseModel(snap, NOW);
    const parked = model.exceptions.find((s) => s.label === "PARKED WITH BATON");
    expect(parked).toBeDefined();
    expect(parked!.rows.length).toBe(1);
    const text = renderExceptionSection(parked!).map((l) => l.text).join("\n");
    expect(text).toContain("◌ PARKED WITH BATON (1)");
    expect(text).toContain("dev50-guard@openrig-build");      // owner (baton holder) named
    expect(text).toContain("qitem 8f3a…");                     // qitem-short
    expect(text).not.toContain("qitem-20260806-8f3a1b2c");     // full id pointer NOT rendered
    expect(text).toContain("47m idle");                         // idle-duration from lastActivityAt (renderer nowMs)
    expect(text).toContain("no handoff");
    expect(text).toContain("→ enter: transcript check");       // the drill hint
    // deferred-read placeholder is GONE now the join is live
    expect(text).not.toContain("idle-age read pending");
  });

  it("◌ PARKED WITH BATON exclusions: ACTIVE owner (terminalActive===true), HANDED-OFF baton, and UNKNOWN-activity owner (null) are all excluded (null ≠ idle — honest)", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "qitem-a-active01", destinationSession: "dev50-driver@openrig-build", summary: "actively working" }),
        inprog({ qitemId: "qitem-b-handed02", destinationSession: "dev50-guard@openrig-build", handedOffTo: "review50-r1@openrig-build", summary: "already handed off" }),
        inprog({ qitemId: "qitem-c-unknwn3", destinationSession: "dev50-qa@openrig-build", summary: "no activity signal" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),   // ACTIVE → working, not parked
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),  // idle, but THIS qitem is handed off
        seat("dev50-qa@openrig-build", null, null),               // no signal → honest-unknown, NOT idle
      ],
    });
    const model = buildPulseModel(snap, NOW);
    // all three excluded → the ran join yields zero → SILENCE (section omitted)
    expect(model.exceptions.find((s) => s.label === "PARKED WITH BATON")).toBeUndefined();
  });

  it("empty LIVE join is SILENCE: zero attention/blocked/parked reads omit their sections entirely", () => {
    const model = buildPulseModel(liveSnap(), NOW);
    expect(model.exceptions.find((s) => s.label === "NEEDS YOU")).toBeUndefined();
    expect(model.exceptions.find((s) => s.label === "BLOCKED ON AGENTS")).toBeUndefined();
    // PARKED is now a LIVE ran-join too → zero parked = silence = omitted
    expect(model.exceptions.find((s) => s.label === "PARKED WITH BATON")).toBeUndefined();
  });

  it("FULL-WIDTH: the pulse view spans full cols with NO explorer sidebar", () => {
    const snap = liveSnap({
      attention: [attn({ qitemId: "q1", summary: "cut packet ready", claimedAt: ago(5 * MIN) })],
    });
    const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: NOW }).lines.join("\n");
    // no explorer pane title, no explorer split joint
    expect(body).not.toContain("EXPLORER");
    expect(body).not.toContain("┬");
    // pulse content begins at the left edge (full-width), not after a 30-col sidebar
    const needsLine = body.split("\n").find((l) => l.includes("NEEDS YOU"));
    expect(needsLine).toBeDefined();
    expect(needsLine!.startsWith("▲ NEEDS YOU")).toBe(true);
  });

  it("REGRESSION: a non-pulse view (table) STILL renders the explorer sidebar", () => {
    const snap = liveSnap();
    const v = createViewState({ instanceId: "t", getSnapshot: () => snap });
    // default view is the table (topology section) — explorer must remain
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");
    expect(body).toContain("EXPLORER");
    expect(body).toContain("┬");
  });
});

describe("PULSE view increment 3 — Lanes LIVE (NOW / JUST FINISHED / UP NEXT + live footer)", () => {
  it("NOW: active seats (terminalActive===true) joined to their in-progress work; idle/unknown owners excluded", () => {
    const snap = liveSnap({
      inProgress: [
        inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "pulse incr-3 build" }),
        inprog({ qitemId: "n2", destinationSession: "dev50-guard@openrig-build", summary: "guard busywork" }),
        inprog({ qitemId: "n3", destinationSession: "dev50-qa@openrig-build", summary: "qa matrix leg" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),   // ACTIVE → NOW (with work)
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),  // IDLE → PARKED, never NOW
        seat("dev50-qa@openrig-build", null, null),               // UNKNOWN signal → excluded (null ≠ active)
        seat("dev50-planner@openrig-build", true, ago(30_000)),   // ACTIVE, no in-progress qitem → bare NOW row
      ],
    });
    const now = buildPulseModel(snap, NOW).lanes[0];
    expect(now.label).toBe("NOW");
    const labels = now.rows.map((r) => r.label);
    // active owner + its work
    expect(labels.some((l) => l.includes("dev50-driver@openrig-build") && l.includes("pulse incr-3 build"))).toBe(true);
    // active seat with NO in-progress qitem is still running → shown bare (honest)
    expect(labels.some((l) => l.includes("dev50-planner@openrig-build"))).toBe(true);
    // idle owner belongs under PARKED, NOT here; unknown-signal owner excluded
    expect(labels.some((l) => l.includes("dev50-guard@openrig-build"))).toBe(false);
    expect(labels.some((l) => l.includes("dev50-qa@openrig-build"))).toBe(false);
    // NOW has no overflow: header count == rendered referent
    expect(now.count).toBe(now.rows.length);
    expect(now.count).toBe(2);
    expect(now.rows.every((r) => r.glyph === "●")).toBe(true);
  });

  it("JUST FINISHED: recent done/handed-off newest-FINISHED-first (tsUpdated desc) with HH:MM times", () => {
    const snap = liveSnap({
      recentlyFinished: [
        // served in ts_created order (NOT finish order) — the view re-sorts by tsUpdated
        attn({ qitemId: "f1", state: "done", summary: "older close-out", tsUpdated: "2026-08-06T10:58:00.000Z" }),
        attn({ qitemId: "f2", state: "handed-off", summary: "newest fold receipt", tsUpdated: "2026-08-06T11:44:00.000Z" }),
        attn({ qitemId: "f3", state: "done", summary: "mid terminal CLEAR", tsUpdated: "2026-08-06T11:20:00.000Z" }),
      ],
    });
    const jf = buildPulseModel(snap, NOW).lanes[1];
    expect(jf.label).toBe("JUST FINISHED");
    expect(jf.rows.map((r) => r.label)).toEqual(["newest fold receipt", "mid terminal CLEAR", "older close-out"]);
    expect(jf.rows.map((r) => r.time)).toEqual(["11:44", "11:20", "10:58"]);
    expect(jf.rows.every((r) => r.glyph === "✓")).toBe(true);
    expect(jf.count).toBe(3);
  });

  it("UP NEXT: pending in the SERVED order (verbatim — no client priority synthesis); beyond the cap shows a '…' overflow row with the TRUE total count", () => {
    const pend = Array.from({ length: 6 }, (_, i) => attn({ qitemId: `p${i}`, state: "pending", summary: `pending item ${i}`, claimedAt: null }));
    const un = buildPulseModel(liveSnap({ pending: pend }), NOW).lanes[2];
    expect(un.label).toBe("UP NEXT");
    expect(un.count).toBe(6); // TRUE total (honesty floor — header is the referent total)
    expect(un.rows.length).toBe(5); // display cap
    // served order preserved; the last rendered row is the overflow marker
    expect(un.rows.slice(0, 4).map((r) => r.label)).toEqual(["pending item 0", "pending item 1", "pending item 2", "pending item 3"]);
    expect(un.rows[4]?.label).toBe("…");
    expect(un.rows.some((r) => r.label === "pending item 5")).toBe(false); // beyond-cap real item not fabricated as shown
    expect(un.rows.slice(0, 4).every((r) => r.glyph === "○")).toBe(true);
  });

  it("UP NEXT: only UNCLAIMED pending (claimedAt null) — a claimed straggler is excluded", () => {
    const un = buildPulseModel(liveSnap({
      pending: [
        attn({ qitemId: "u1", state: "pending", summary: "unclaimed work", claimedAt: null }),
        attn({ qitemId: "c1", state: "pending", summary: "claimed already", claimedAt: ago(5 * MIN) }),
      ],
    }), NOW).lanes[2];
    expect(un.rows.map((r) => r.label)).toEqual(["unclaimed work"]);
    expect(un.count).toBe(1);
  });

  it("FOOTER counts are LIVE and EQUAL their referent sets (active=NOW · parked=PARKED · waiting-you=NEEDS YOU); updated-ago derived from hydratedAt", () => {
    const snap = liveSnap({
      attention: [
        attn({ qitemId: "a1", summary: "gate one", claimedAt: ago(2 * MIN) }),
        attn({ qitemId: "a2", summary: "gate two", claimedAt: ago(3 * MIN) }),
      ],
      inProgress: [
        inprog({ qitemId: "n1", destinationSession: "dev50-driver@openrig-build", summary: "working" }),
        inprog({ qitemId: "pk", destinationSession: "dev50-guard@openrig-build", summary: "parked baton" }),
      ],
      seatActivity: [
        seat("dev50-driver@openrig-build", true, ago(1 * MIN)),
        seat("dev50-guard@openrig-build", false, ago(47 * MIN)),
      ],
      hydratedAt: ago(2000),
    });
    const model = buildPulseModel(snap, NOW);
    expect(model.footer.active).toBe(1); // NOW: driver only
    expect(model.footer.parked).toBe(1); // PARKED: guard
    expect(model.footer.waitingYou).toBe(2); // NEEDS YOU: two gates
    expect(model.footer.updatedAgo).toBe("2s ago");
    // label==referent: the footer numbers ARE the built referent sets (never divergent)
    expect(model.footer.active).toBe(model.lanes[0].rows.length);
    expect(model.footer.parked).toBe(model.exceptions.find((s) => s.label === "PARKED WITH BATON")?.rows.length ?? 0);
    expect(model.footer.waitingYou).toBe(model.exceptions.find((s) => s.label === "NEEDS YOU")?.rows.length ?? 0);
  });

  it("FOOTER updated-ago is an honest '—' when no hydration timestamp exists yet (never a fabricated age)", () => {
    expect(buildPulseModel(liveSnap({ hydratedAt: undefined }), NOW).footer.updatedAgo).toBe("—");
  });

  it("◌ PARKED age-unknown belt: an idle owner (terminalActive false) with NO lastActivityAt renders 'idle (age unknown)', never a bare/fabricated duration", () => {
    const snap = liveSnap({
      inProgress: [inprog({ qitemId: "qitem-x-noagey1", destinationSession: "dev50-guard@openrig-build", summary: "stranded" })],
      seatActivity: [seat("dev50-guard@openrig-build", false, null)], // idle owner, but NO activity stamp
    });
    const parked = buildPulseModel(snap, NOW).exceptions.find((s) => s.label === "PARKED WITH BATON")!;
    expect(parked).toBeDefined();
    const text = renderExceptionSection(parked).map((l) => l.text).join("\n");
    expect(text).toContain("idle (age unknown)");
    expect(text).not.toContain("in-progress  idle"); // never the bare double-space form
  });

  it("empty lanes are HONEST: zero live lane sources render empty lanes with (0), not stale demo rows", () => {
    const model = buildPulseModel(liveSnap(), NOW);
    expect(model.lanes.map((l) => [l.label, l.count])).toEqual([
      ["NOW", 0],
      ["JUST FINISHED", 0],
      ["UP NEXT", 0],
    ]);
    expect(model.lanes.every((l) => l.rows.length === 0)).toBe(true);
    // and the old static demo lane content must be GONE from the live builder
    expect(model.lanes.flatMap((l) => l.rows.map((r) => r.label)).join(" ")).not.toContain("slice 51-01 stub");
  });
});
