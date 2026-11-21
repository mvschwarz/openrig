import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, UNATTRIBUTED_GUARD_ACTOR, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { seatRoutes } from "../src/routes/seat.js";

// #3587: `rig seat retire-held-message` from an ordinary terminal sends no X-OpenRig-Session. The
// retirement still applies, and the recorded actor is explicit; a seat identity is recorded as before,
// and neither the request body nor the target seat's name stands in for one. The reason stays required.

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function fixture() {
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker'),('b','rig','sibling');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1'),('bb','b','sibling@test','%2');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh'),('gb','b',1,'g2','fresh');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running'),('sb','b','sibling@test','running');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const tmux = new TmuxAdapter(async () => "");
  tmux.deliveryGuard = guard;
  const outbox = new OutboxHandler(db);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, new RigRepository(db)); await next(); });
  app.route("/api/seat", seatRoutes);
  const hold = (id = "held-1") => {
    outbox.record({ outboxId: id, senderSession: "sender@test", destinationSession: "worker@test", body: "read me" });
    db.prepare("UPDATE outbox_entries SET delivery_state='retained', guard_binding=? WHERE outbox_id=?")
      .run(JSON.stringify({ nodeId: "a", session: "worker@test", occupant: null, pane: null }), id);
  };
  /** `session` undefined sends no X-OpenRig-Session header, as the CLI does without OPENRIG_SESSION_NAME. */
  const retire = (id: string, body: unknown, session?: string, seat = "worker@test") => app.request(`/api/seat/retire-held-message/${seat}/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session === undefined ? {} : { "x-openrig-session": session }) },
    body: JSON.stringify(body),
  });
  const retiredBy = (id = "held-1") => (db.prepare("SELECT retired_by, retirement_reason FROM outbox_entries WHERE outbox_id=?").get(id)) as { retired_by: string; retirement_reason: string };
  return { db, guard, outbox, hold, retire, retiredBy };
}

describe("retire-held-message route attribution", () => {
  it.each([["no header", undefined], ["a blank header", "   "]])("retires with %s and records the unattributed actor", async (_label, session) => {
    const f = fixture(); f.hold();
    const response = await f.retire("held-1", { reason: "read outside the pane", actor: "spoof@test" }, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ entry: { deliveryState: "retired", retiredBy: UNATTRIBUTED_GUARD_ACTOR, retirementReason: "read outside the pane" } });
    expect(f.retiredBy()).toEqual({ retired_by: UNATTRIBUTED_GUARD_ACTOR, retirement_reason: "read outside the pane" });
  });

  it("records the seat identity from the transport, not the body actor or the target's name", async () => {
    const f = fixture(); f.hold();
    const response = await f.retire("held-1", { reason: "reviewed", actor: "spoof@test" }, "lead@test");
    expect(response.status).toBe(200);
    expect(f.retiredBy()).toEqual({ retired_by: "lead@test", retirement_reason: "reviewed" });
  });

  it("still requires a reason with no seat identity and retires nothing", async () => {
    const f = fixture(); f.hold();
    const response = await f.retire("held-1", { reason: "   " });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Reason required");
    expect(f.retiredBy().retired_by).toBeNull();
  });

  it("still refuses another seat's held message with no seat identity", async () => {
    const f = fixture(); f.hold();
    const response = await f.retire("held-1", { reason: "read" }, undefined, "sibling@test");
    expect(response.status).toBe(404);
    expect(f.retiredBy().retired_by).toBeNull();
  });
});
