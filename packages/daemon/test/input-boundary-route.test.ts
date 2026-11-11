// The hook route hands a prompt hook's fingerprint to the correlator: a matching write records the input boundary, and a
// malformed fingerprint is dropped without refusing the hook.
import { afterEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
import { inputBoundaryCorrelatorFor } from "../src/domain/input-boundary-correlator.js";
import { activityRoutes } from "../src/routes/activity.js";

const TOKEN = "test-token";
const SESSION = "dev-impl@r";
const SHA = "a".repeat(64);
const closeDbs: Array<() => void> = [];
afterEach(() => { for (const close of closeDbs.splice(0)) close(); });

function makeApp() {
  const db = createFullTestDb();
  closeDbs.push(() => db.close());
  const bus = new EventBus(db);
  inputBoundaryCorrelatorFor(bus);
  const store = { db, recordHookEvent: () => ({ ok: true as const, activity: { state: "running", reason: "prompt", evidenceSource: "hook", sampledAt: new Date().toISOString(), evidence: null, runtime: "claude-code" }, event: {} }) };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("agentActivityStore" as never, store as never);
    c.set("activityHookToken" as never, TOKEN as never);
    c.set("eventBus" as never, bus as never);
    await next();
  });
  app.route("/api/activity", activityRoutes);
  const post = (fields: Record<string, unknown>) => app.request("/api/activity/hooks", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ runtime: "claude-code", sessionName: SESSION, hookEvent: "UserPromptSubmit", generation: "gen-1",
      occurredAt: "2026-11-11T03:00:01.000Z", ...fields }),
  });
  const written = () => bus.emit({
    type: "transport.delivery_evidence", sessionName: SESSION, seatKind: "tmux", pane: "%1", occupantGeneration: "gen-1",
    messageId: "m1", attemptId: "a1", admitted: "none", written: "submitted", terminalObserved: { outcome: null, verified: null },
    inputBoundary: "unknown", source: "send_result", wireSha256: SHA, wireBytes: 5, writtenAt: "2026-11-11T03:00:00.000Z",
  });
  const observed = () => db.prepare("SELECT payload FROM events WHERE type = 'transport.input_boundary'").all() as Array<{ payload: string }>;
  return { post, written, observed };
}

describe("the hook route and the input boundary", () => {
  it("records the boundary when a prompt hook's fingerprint matches the one write", async () => {
    const { post, written, observed } = makeApp();
    written();
    const res = await post({ promptSha256: SHA, promptBytes: 5, nativePromptId: "p-1" });
    expect(res.status).toBe(200);
    expect(observed().map((row) => JSON.parse(row.payload))).toMatchObject([{ messageId: "m1", nativePromptId: "p-1", observed: "UserPromptSubmit" }]);
  });

  it("drops a malformed fingerprint or a missing generation and still records the hook", async () => {
    const { post, written, observed } = makeApp();
    written();
    expect((await post({ promptSha256: "not-a-sha", promptBytes: 5 })).status).toBe(200);
    expect((await post({ promptSha256: SHA, promptBytes: -1 })).status).toBe(200);
    expect((await post({ promptSha256: SHA, promptBytes: 5, generation: null })).status).toBe(200);
    expect(observed()).toEqual([]);
  });
});
