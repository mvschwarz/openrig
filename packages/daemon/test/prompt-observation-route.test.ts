// A harness's prompt hook is recorded as its own raw observation, never as a message's attribution: no harness reports a
// prompt's origin, so a delivery record's input boundary stays unknown even when the texts match.
import { afterEach, describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createFullTestDb } from "./helpers/test-app.js";
import { EventBus } from "../src/domain/event-bus.js";
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
      occurredAt: "2026-11-11T03:00:01.000Z", promptSha256: SHA, promptBytes: 5, ...fields }),
  });
  const rows = () => (db.prepare("SELECT type, node_id, payload FROM events ORDER BY seq").all() as Array<{ type: string; node_id: string | null; payload: string }>)
    .map((row) => ({ type: row.type, nodeId: row.node_id, ...JSON.parse(row.payload) }));
  return { bus, post, rows };
}

describe("the prompt hook's raw observation", () => {
  it("records what the hook reported, with no node, and attributes no message even when a write's text matches", async () => {
    const { bus, post, rows } = makeApp();
    bus.emit({ type: "transport.delivery_evidence", sessionName: SESSION, seatKind: "tmux", pane: "%1", occupantGeneration: "gen-1",
      messageId: "m1", attemptId: "a1", admitted: "none", written: "submitted", terminalObserved: { outcome: null, verified: null },
      inputBoundary: "unknown", source: "send_result", wireSha256: SHA, wireBytes: 5, writtenAt: "2026-11-11T03:00:00.000Z" });
    const res = await post({ sessionId: "native-session-1", nativePromptId: "p-1", turnId: "t-1" });
    expect(res.status).toBe(200);
    expect(rows().map((row) => row.type)).toEqual(["transport.delivery_evidence", "transport.prompt_observation"]);
    expect(rows()[1]).toEqual({ type: "transport.prompt_observation", nodeId: null, sessionName: SESSION, occupantGeneration: "gen-1",
      runtime: "claude-code", source: "UserPromptSubmit", nativeSessionId: "native-session-1", nativePromptId: "p-1", nativeTurnId: "t-1",
      promptSha256: SHA, promptBytes: 5, observedAt: "2026-11-11T03:00:01.000Z" });
    expect(rows()[0]).toMatchObject({ messageId: "m1", inputBoundary: "unknown" });
  });

  it("records nothing without a valid fingerprint and length, leaves out a bad id, reads a time as an instant, and answers the hook each time", async () => {
    const { post, rows } = makeApp();
    for (const fields of [{ promptSha256: "not-a-sha" }, { promptBytes: -1 }, { promptBytes: 1.5 }, { promptSha256: undefined }]) {
      expect((await post(fields)).status).toBe(200);
    }
    expect(rows()).toEqual([]);
    expect((await post({ nativePromptId: "bad id/..", occurredAt: "not a time", generation: null })).status).toBe(200);
    expect((await post({ occurredAt: "2026-11-11T05:00:01+02:00" })).status).toBe(200);
    expect(rows()).toMatchObject([
      { type: "transport.prompt_observation", nativePromptId: null, observedAt: null, occupantGeneration: null },
      { type: "transport.prompt_observation", observedAt: "2026-11-11T03:00:01.000Z" },
    ]);
  });
});
