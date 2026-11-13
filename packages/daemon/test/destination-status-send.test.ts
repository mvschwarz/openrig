import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { transportRoutes } from "../src/routes/transport.js";

describe("send destination status preserves the message without forwarding", () => {
  const databases: ReturnType<typeof createDb>[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

  function fixture(status: "missing" | "archived" | "hosted" | "unknown", available: boolean) {
    const db = createDb(); migrate(db, ALL_MIGRATIONS); databases.push(db);
    const outbox = new OutboxHandler(db);
    const destination = "reader@status-target";
    const send = vi.fn(async () => ({ ok: true, sessionName: destination, outcome: "delivered", sent: true }));
    const transport = { resolveSessions: vi.fn(async () => available
      ? { ok: true, sessions: [{ sessionName: destination, rigName: "status-target", nodeLogicalId: "reader" }] }
      : { ok: false, code: "not_found", error: "No session resolved" }), send };
    const advisory = { code: "destination_status", status, destinationSession: destination,
      message: status === "hosted" ? "Valid hosted member; reads the queue without a pane."
        : status === "unknown" ? "Destination status unknown: registry unavailable."
        : status === "archived" ? "Rig status-target is archived; no live seat by this name."
        : "No live seat by this name on this daemon." };
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, db as never);
      c.set("sessionTransport" as never, transport as never);
      c.set("outboxHandler" as never, outbox as never);
      c.set("queueRepo" as never, { destinationAdvisory: () => advisory } as never);
      await next();
    });
    app.route("/api/transport", transportRoutes());
    const post = (extra: Record<string, unknown> = {}) => app.request("/api/transport/send", { method: "POST", headers: {
      "Content-Type": "application/json", "X-OpenRig-Session": "sender@status-source",
    }, body: JSON.stringify({ session: destination, text: "keep this message", exactText: "keep this message", ...extra }) });
    return { db, outbox, destination, send, post, advisory, transport };
  }

  it.each(["missing", "archived", "hosted", "unknown"] as const)("records a %s target without claiming delivery", async status => {
    const f = fixture(status, false);
    const response = await f.post();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "recorded", sent: false, persisted: true,
      destinationStatus: expect.objectContaining({ status, message: f.advisory.message }) });
    expect(body.outboxIds).toHaveLength(1);
    expect(f.outbox.getById(body.outboxIds[0])).toMatchObject({ destinationSession: f.destination,
      body: "keep this message", deliveryState: "failed", deliveredAt: null });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("reports unconfirmed storage when the outbox write fails", async () => {
    const f = fixture("missing", false);
    vi.spyOn(f.outbox, "record").mockImplementation(() => { throw new Error("fixture storage unavailable"); });
    const response = await f.post();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, outcome: "unconfirmed", persisted: null, sent: false });
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    { submitOnly: true },
    { expectedIdentity: { nodeId: "node", sessionName: "reader@status-target", runtime: "codex", nativeId: "native" } },
  ])("preserves a constrained request's unresolved-target result (%j)", async constraint => {
    const f = fixture("missing", false);
    const record = vi.spyOn(f.outbox, "record");
    const response = await f.post(constraint);
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("outcome", "recorded");
    expect(record).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["hosted", "unknown"] as const)("does not block supported %s delivery", async status => {
    const f = fixture(status, true);
    const response = await f.post(); const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, sent: true,
      destinationStatus: expect.objectContaining({ status, message: f.advisory.message }) });
    expect(f.send).toHaveBeenCalledWith(f.destination, "keep this message", expect.anything());
  });
});
