import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SeatDeliveryGuard, UNATTRIBUTED_GUARD_ACTOR, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { seatRoutes } from "../src/routes/seat.js";

// #2350: `rig seat set-typing-guard` from an ordinary terminal sends no X-OpenRig-Session. The change applies and the
// preference and its audit row record an explicit unattributed actor; a seat identity is recorded as before, and the
// request body or the target's name never stands in for one. Validation, activation and held messages are unchanged.

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));

function fixture() {
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO rigs(id,name) VALUES ('rig','test');
    INSERT INTO nodes(id,rig_id,logical_id) VALUES ('a','rig','worker');
    INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES ('ba','a','worker@test','%1');
    INSERT INTO occupant_tenures(id,node_id,generation_ordinal,generation_uuid,kind) VALUES ('ga','a',1,'g1','fresh');
    INSERT INTO sessions(id,node_id,session_name,status) VALUES ('sa','a','worker@test','running');`);
  const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
  const writes: string[] = [];
  const tmux = new TmuxAdapter(async command => { writes.push(command); return ""; });
  tmux.deliveryGuard = guard;
  const rigRepo = new RigRepository(db);
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("tmuxAdapter" as never, tmux); c.set("rigRepo" as never, rigRepo); await next(); });
  app.route("/api/seat", seatRoutes);
  /** `session` undefined sends no X-OpenRig-Session header, as the CLI does without OPENRIG_SESSION_NAME. */
  const post = (body: unknown, session?: string, seat = "worker@test") => app.request(`/api/seat/set-typing-guard/${seat}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(session === undefined ? {} : { "x-openrig-session": session }) },
    body: JSON.stringify(body),
  });
  const recorded = () => ({
    preference: db.prepare("SELECT actor, reason FROM seat_delivery_guards WHERE node_id='a'").all(),
    audit: db.prepare("SELECT actor, reason FROM seat_delivery_guard_changes WHERE node_id='a' ORDER BY id").all(),
  });
  return { guard, post, recorded, writes };
}

const SHAPE_REFUSAL = { error: "Supply exactly one enabled boolean or mode, and a reason" };
const INVALID_BODIES: Array<[unknown, Record<string, unknown>]> = [
  [{ reason: "missing control" }, SHAPE_REFUSAL], [{ mode: "hold" }, SHAPE_REFUSAL], [{ mode: "hold", reason: "   " }, SHAPE_REFUSAL],
  [{ enabled: true, mode: "hold", reason: "ambiguous" }, SHAPE_REFUSAL], [{ enabled: "true", reason: "wrong type" }, SHAPE_REFUSAL],
  [{ mode: "draft-aware", maxAttempts: 3, reason: "obsolete" }, SHAPE_REFUSAL], [{ mode: "automatic", reason: "unknown mode" }, { code: "invalid_typing_guard" }],
];

describe("set-typing-guard route attribution", () => {
  it.each([["no header", undefined], ["a blank header", "   "]])("applies a request with %s and records the unattributed actor", async (_label, session) => {
    const f = fixture();
    const response = await f.post({ mode: "draft-aware", reason: "typing by hand", actor: "spoof@test" }, session);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ desiredMode: "draft-aware", effectiveMode: "draft-aware", pending: false });
    expect(f.recorded()).toEqual({
      preference: [{ actor: UNATTRIBUTED_GUARD_ACTOR, reason: "typing by hand" }],
      audit: [{ actor: UNATTRIBUTED_GUARD_ACTOR, reason: "typing by hand" }],
    });
    expect(f.writes).toEqual([]);
  });

  it("records a seat identity as given, not the body actor or the target's name", async () => {
    const f = fixture();
    expect((await f.post({ mode: "urgent-only", reason: "reviewing", actor: "spoof@test" }, "lead@test")).status).toBe(200);
    expect(f.guard.preference("a")).toMatchObject({ desiredMode: "hold", desiredLevel: "urgent-only", pending: false });
    expect(f.recorded()).toEqual({ preference: [{ actor: "lead@test", reason: "reviewing" }], audit: [{ actor: "lead@test", reason: "reviewing" }] });
  });

  it("keeps an unattributed change in the audit after a seat's later change", async () => {
    const f = fixture();
    expect((await f.post({ mode: "hold", reason: "from a terminal" })).status).toBe(200);
    expect((await f.post({ mode: "off", reason: "back to normal" }, "lead@test")).status).toBe(200);
    expect(f.recorded()).toEqual({
      preference: [{ actor: "lead@test", reason: "back to normal" }],
      audit: [{ actor: UNATTRIBUTED_GUARD_ACTOR, reason: "from a terminal" }, { actor: "lead@test", reason: "back to normal" }],
    });
  });

  it.each(INVALID_BODIES)("still refuses invalid input without a seat identity and records nothing: %j", async (body, refusal) => {
    const f = fixture();
    const response = await f.post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject(refusal);
    expect(f.recorded()).toEqual({ preference: [], audit: [] });
  });

  it("still refuses an unknown target without a seat identity and records nothing", async () => {
    const f = fixture();
    const response = await f.post({ mode: "hold", reason: "wrong seat" }, undefined, "nobody@test");
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "guard_target_unknown" });
    expect(f.recorded()).toEqual({ preference: [], audit: [] });
  });
});

describe("SeatDeliveryGuard.set attribution", () => {
  it("records the unattributed actor on the preference and its audit row when no identity is given", async () => {
    const f = fixture();
    expect(await f.guard.set("a", { mode: "sends-only" }, null, "typing by hand")).toMatchObject({ desiredMode: "off", desiredLevel: "sends-only", pending: false });
    expect(f.recorded()).toEqual({
      preference: [{ actor: UNATTRIBUTED_GUARD_ACTOR, reason: "typing by hand" }],
      audit: [{ actor: UNATTRIBUTED_GUARD_ACTOR, reason: "typing by hand" }],
    });
  });

  it("records a given identity unchanged", async () => {
    const f = fixture();
    await f.guard.set("a", { mode: "draft-aware" }, "lead@test", "keep my draft");
    expect(f.recorded()).toEqual({ preference: [{ actor: "lead@test", reason: "keep my draft" }], audit: [{ actor: "lead@test", reason: "keep my draft" }] });
  });

  it.each([
    ["an unknown mode", { mode: "automatic" }, null, "focus", "invalid_typing_guard"],
    ["a blank reason", { mode: "hold" }, null, "  ", "guard_reason_required"],
    ["a blank identity, which is not the same as none", { mode: "hold" }, "  ", "focus", "guard_reason_required"],
  ] as const)("rejects %s and records nothing", async (_label, value, actor, reason, code) => {
    const f = fixture();
    await expect(f.guard.set("a", value, actor, reason)).rejects.toMatchObject({ code });
    expect(f.recorded()).toEqual({ preference: [], audit: [] });
  });
});
