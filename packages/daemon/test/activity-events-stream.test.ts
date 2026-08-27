import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { activityRoutes } from "../src/routes/activity.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import type { EventBus } from "../src/domain/event-bus.js";

// OPR.0.5.5.19 AM-R18 — the push substrate: the oracle EMITS arbitrated state changes
// onto the event bus, and GET /api/activity/events streams them (SSE) to the open TUI
// view. Change-notification only — the payload carries identity + seq, never a second
// activity derivation; the view rehydrates from /api/ps (the desk-accepted shape).

const SEAT = "node-ev-1";
const SESSION = "dev50-qa@v-openrig-build";

function makeSvc(emit: ReturnType<typeof vi.fn>, clock: { now: number }) {
  const svc = new SeatActivityService({
    tmux: { readPaneLastActivity: async () => null },
    defaultWindowSeconds: 3,
    now: () => new Date(clock.now),
    eventBus: { emit } as unknown as EventBus,
  });
  svc.declareRungInventory({ seatNodeId: SEAT, sessionName: SESSION }, {
    adapterId: "claude-code-adapter", runtime: "claude-code",
    rungs: [{ rung: "lifecycle-hooks", lifecycleCoverage: "full", initialTrust: "authoritative" }],
  });
  return svc;
}

describe("S19 AM-R18 — the oracle emits arbitrated state changes", () => {
  it("a transition emits seat.activity_changed with seat identity + monotonic seq (notification, not derivation)", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({
      seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks",
      seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working",
    });
    const calls = emit.mock.calls.map((c) => c[0] as { type: string; seatNodeId?: string; seq?: number });
    const changed = calls.filter((e) => e.type === "seat.activity_changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.seatNodeId).toBe(SEAT);
    expect(changed[0]!.seq).toBe(1);
  });

  it("a NON-transition (same state re-reported) emits nothing — pushes fire on change only", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    emit.mockClear();
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 2, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    expect(emit.mock.calls.filter((c) => (c[0] as { type: string }).type === "seat.activity_changed")).toHaveLength(0);
  });

  it("an occupant swap emits the change event too (the swap is a visible push)", () => {
    const emit = vi.fn();
    const clock = { now: 7_000_000 };
    const svc = makeSvc(emit, clock);
    svc.reportEvidence({ seatNodeId: SEAT, sessionName: SESSION, rung: "lifecycle-hooks", sourceId: "claude-code:hooks", seq: 1, observedAt: new Date(clock.now).toISOString(), activity: "working" });
    emit.mockClear();
    svc.declareOccupantSwap(SEAT, "gen-next");
    expect(emit.mock.calls.some((c) => (c[0] as { type: string }).type === "seat.activity_changed")).toBe(true);
  });
});

describe("S19 AM-R18 — GET /api/activity/events streams pushes (SSE)", () => {
  it("a driven oracle change reaches a connected stream as one SSE data line; disconnect unsubscribes", async () => {
    const subscribers = new Set<(e: unknown) => void>();
    const fakeBus = {
      subscribe: (cb: (e: unknown) => void) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, fakeBus as never); await next(); });
    app.route("/api/activity", activityRoutes);

    const res = await app.request("/api/activity/events");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(subscribers.size).toBe(1);

    const reader = res.body!.getReader();
    // Drive a push through the bus while the stream is open:
    for (const cb of subscribers) cb({ type: "seat.activity_changed", seatNodeId: SEAT, seq: 42 });
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("seat.activity_changed");
    expect(chunk).toContain('"seq":42');
    // Notification-only: the SSE payload never carries a derived display/vocabulary field.
    expect(chunk).not.toMatch(/"display"|"terminalActive"/);

    await reader.cancel();
    await new Promise((r) => setTimeout(r, 20));
    expect(subscribers.size).toBe(0); // disconnect released the subscription
  });

  it("unrelated bus events are filtered out — only activity/rung-health pushes stream", async () => {
    const subscribers = new Set<(e: unknown) => void>();
    const fakeBus = { subscribe: (cb: (e: unknown) => void) => { subscribers.add(cb); return () => subscribers.delete(cb); } };
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, fakeBus as never); await next(); });
    app.route("/api/activity", activityRoutes);
    const res = await app.request("/api/activity/events");
    const reader = res.body!.getReader();
    for (const cb of subscribers) {
      cb({ type: "queue.item_created", qitemId: "x" }); // not ours — filtered
      cb({ type: "seat.rung_health", seatNodeId: SEAT, rung: "lifecycle-hooks" });
    }
    const { value } = await reader.read();
    const chunk = new TextDecoder().decode(value);
    expect(chunk).toContain("seat.rung_health");
    expect(chunk).not.toContain("queue.item_created");
    await reader.cancel();
  });
});
