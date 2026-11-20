// A plain `rig send` (POST /api/transport/send) to a seat OpenRig has recorded at its usage limit, with a stated reset,
// is delivered as always (fail open): a wall that leaves an ordinary input box takes the text. The sender's result and
// the send's delivery evidence say the seat was at its limit and when it resets, since its agent isn't expected to read
// the text before then. A usage-limit menu is a choice prompt, refused before any write, so it never reaches this.
//
// Pieces: the real SessionTransport and transport route over a recording tmux adapter, with #3508's reading injected
// as startup wires it (no tmux server, no Claude Code). Native: NOT RUN.
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { SessionTransport } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";
import { transportRoutes } from "../src/routes/transport.js";
import type { WatchdogUsageLimitState } from "../src/domain/watchdog-usage-limit.js";

const seat = "writer@demo";
const NOW = Date.parse("2026-11-19T20:00:00.000Z");
const limited: WatchdogUsageLimitState = { identity: "id-1", limit: { asOf: "2026-11-19T19:40:00.000Z", resetsAt: "2026-11-19T23:00:00.000Z" } };
afterEach(() => { vi.restoreAllMocks(); });

function fixture(opts: { reading?: WatchdogUsageLimitState | null; observe?: boolean; pasteFails?: boolean; readiness?: { state: string; reason: string } } = {}) {
  const db = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }), transaction: (fn: () => void) => fn } as never;
  const writes: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const tmux = {
    probeSession: vi.fn(async () => ({ state: "present" })),
    sendText: vi.fn(async (_: string, text: string) => { writes.push(text); return { ok: !opts.pasteFails }; }),
    sendKeys: vi.fn(async () => { writes.push("ENTER"); return { ok: true }; }),
  };
  Object.assign(tmux, { deliveryGuard: new SeatDeliveryGuard(db, () => ({ nodeId: "node-one", session: seat, pane: "%1", occupant: "generation-one" })) });
  const transport = new SessionTransport({ db, rigRepo: {} as never, sessionRegistry: {} as never, tmuxAdapter: tmux as never,
    eventBus: { emit: (event: Record<string, unknown>) => { events.push(event); } } as never,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), now: () => new Date(NOW), waitForIdlePollMs: 5 });
  const internals = transport as unknown as Record<string, unknown>;
  internals.getSessionMeta = () => ({ runtime: "claude-code", attachmentType: "tmux", nodeId: "node-one", pane: "%1", occupant: "generation-one", resumeToken: "native-one" });
  internals.claudeDeliveryObservation = async () => ({ state: "unknown", detail: "injected process observation" });
  internals.classifySendReadiness = async () => ({ ...(opts.readiness ?? { state: "idle", reason: "fixture" }), evidenceSource: "fixture" });
  internals.diagnoseProducerLink = async () => "fixture";
  internals.resolveSessions = async () => ({ ok: true, sessions: [seat] });
  // As startup wires it, with #3508's reader. (At a daemon without the record, nothing is added.)
  if (opts.observe !== false) transport.setUsageLimitObserver(() => (opts.reading === undefined ? limited : opts.reading));
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("sessionTransport" as never, transport as never); await next(); });
  app.route("/api/transport", transportRoutes());
  const rigSend = async (body: Record<string, unknown>) => {
    const res = await app.request("/api/transport/send", { method: "POST", headers: { "Content-Type": "application/json", "X-OpenRig-Session": "pm@demo" },
      body: JSON.stringify({ session: seat, ...body }) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const evidence = () => events.filter((event) => event.type === "transport.delivery_evidence");
  return { transport, rigSend, writes, evidence };
}
const withoutRecord = (body: Record<string, unknown>) => { const { usageLimit: _u, ...rest } = body; return rest; };

it("a send to a seat at its usage limit is delivered, and the sender's result says it won't be read before the reset", async () => {
  const f = fixture();
  const sender = await f.rigSend({ text: "WORK MESSAGE" });
  expect(sender.status).toBe(200);
  expect(sender.body).toMatchObject({ ok: true, usageLimit: { asOf: limited.limit!.asOf, resetsAt: limited.limit!.resetsAt } });
  expect((sender.body.usageLimit as { notice: string }).notice).toBe(`${seat} was at its usage limit when this send started (OpenRig recorded it at 2026-11-19T19:40:00.000Z; it resets at 2026-11-19T23:00:00.000Z). The message reached its input, or may have; the agent isn't expected to read it before then.`);
  expect(f.writes).toContain("WORK MESSAGE"); // fail open: delivered now, no hold
  expect(f.evidence().map((event) => event.usageLimit)).toEqual([limited.limit]);
});

it("the record is context: the send's own result is the one it gets without it", async () => {
  const noticed = await fixture().rigSend({ text: "WORK MESSAGE" });
  const plain = await fixture({ observe: false }).rigSend({ text: "WORK MESSAGE" });
  expect(withoutRecord(noticed.body)).toEqual(plain.body);
  expect(plain.body).not.toHaveProperty("usageLimit");
});

it.each([
  ["no reading", null],
  ["no recorded limit", { identity: "id-1", limit: null }],
  ["activity after the limit", { ...limited, clearedAt: "2026-11-19T19:50:00.000Z" }],
  ["a reset already passed", { identity: "id-1", limit: { asOf: "2026-11-19T15:00:00.000Z", resetsAt: "2026-11-19T19:00:00.000Z" } }],
] as const)("control: %s gets no record", async (_name, reading) => {
  const f = fixture({ reading: reading as WatchdogUsageLimitState | null });
  const sender = await f.rigSend({ text: "WORK MESSAGE" });
  expect(sender.body).toMatchObject({ ok: true });
  expect(sender.body).not.toHaveProperty("usageLimit");
  expect(f.evidence().every((event) => !("usageLimit" in event))).toBe(true);
});

it("activity recorded before the limit doesn't clear it", async () => {
  const f = fixture({ reading: { ...limited, clearedAt: "2026-11-19T19:30:00.000Z" } });
  expect((await f.rigSend({ text: "WORK MESSAGE" })).body).toHaveProperty("usageLimit");
});

it("a send whose paste failed may still have landed, and keeps its own failure with the record beside it", async () => {
  const noticed = await fixture({ pasteFails: true }).rigSend({ text: "WORK MESSAGE" });
  const plain = await fixture({ pasteFails: true, observe: false }).rigSend({ text: "WORK MESSAGE" });
  expect(plain.body.ok).toBe(false);
  expect(withoutRecord(noticed.body)).toEqual(plain.body);
  expect(noticed.body).toHaveProperty("usageLimit");
});

it("a usage-limit menu is a choice prompt: refused before any write, so no record and nothing typed", async () => {
  const f = fixture({ readiness: { state: "needs_input", reason: "selection_prompt" } });
  const sender = await f.rigSend({ text: "WORK MESSAGE" });
  expect(sender.body.ok).toBe(false);
  expect(f.writes).toEqual([]);
  expect(sender.body).not.toHaveProperty("usageLimit");
});

it("an unreadable reading never changes a send", async () => {
  const f = fixture({ observe: false });
  f.transport.setUsageLimitObserver(() => { throw new Error("database busy"); });
  const sender = await f.rigSend({ text: "WORK MESSAGE" });
  expect(sender.body).toMatchObject({ ok: true });
  expect(sender.body).not.toHaveProperty("usageLimit");
});
