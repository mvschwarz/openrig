// Slice 04 (OPR.0.7.0.4) 04-A2 — a saved legacy mode and an operating posture (human-led / delegated) are kept side by
// side at one target: a write replaces only its own category's binding there. Through the real store, migrations,
// routes and posture service, on a private in-memory database.
import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import { OperatingPostureService } from "../src/domain/rig-mode/operating-posture.js";
import { RECOMMENDED_MODE_DEFAULTS } from "../src/domain/rig-mode/rig-mode-defaults.js";
import type { OperatorContextMode, OperatorContextScope } from "../src/domain/rig-mode/rig-mode-types.js";
import { rigModeRoutes } from "../src/routes/rig-mode.js";

type Mode = Exclude<OperatorContextMode, never>;
const record = (mode: Mode, scope: OperatorContextScope) => ({
  ...RECOMMENDED_MODE_DEFAULTS[mode as keyof typeof RECOMMENDED_MODE_DEFAULTS], scope, expiry_or_stale_rule: "none", evidence_citation: `operator chose ${mode}`,
});

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((f) => f()));

function setup(migrations = ALL_MIGRATIONS) {
  const db = createDb(); migrate(db, migrations); cleanup.push(() => db.close());
  let tick = 0;
  // A strictly later clock per write, so "latest set" is unambiguous unless a test pins a tie.
  const modes = new RigModeStore(db, { now: () => new Date(Date.UTC(2026, 9, 14, 18, 0, tick++)) });
  const rig = new RigRepository(db).createRig("demo");
  const service = new OperatingPostureService(db, modes, () => "/nonexistent-home");
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("rigModeStore" as never, modes); c.set("operatingPosture" as never, service); await next(); });
  app.route("/api/rig-mode", rigModeRoutes({ bearerToken: "isolated-operator" }));
  const auth = { authorization: "Bearer isolated-operator" };
  const put = async (mode: Mode, scope: OperatorContextScope, qualifier: string) => {
    const res = await app.request(`/api/rig-mode/bindings/${scope}/${encodeURIComponent(qualifier)}`, {
      method: "PUT", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ mode, record: record(mode, scope) }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { binding: { id: string; mode: string; qualifier: string } };
  };
  const del = async (scope: string, qualifier: string, category?: string) =>
    (await app.request(`/api/rig-mode/bindings/${scope}/${encodeURIComponent(qualifier)}${category ? `?category=${category}` : ""}`, { method: "DELETE", headers: auth })).json() as
      Promise<{ removed: boolean; category?: string; remaining?: { mode: string } | null }>;
  const get = async (path: string) => (await app.request(path)).json() as Promise<Record<string, any>>;
  const rows = () => db.prepare("SELECT id, scope, qualifier, mode FROM operator_context_mode_bindings ORDER BY id").all();
  return { db, modes, rig, service, app, put, del, get, rows };
}

describe("a saved mode and a posture kept side by side", () => {
  // The rig's canonical id and its name are two stored qualifiers; posture writes always land on the id.
  for (const form of ["canonical id", "name"] as const) {
    for (const order of ["mode then posture", "posture then mode"] as const) {
      it(`${order}, the mode written by ${form}: both kept and readable, the posture consumer reads the posture`, async () => {
        const t = setup();
        const target = form === "canonical id" ? t.rig.id : "demo";
        const writeMode = () => t.put("focus", "rig", target);
        const writePosture = () => t.put("delegated", "rig", "demo");
        if (order === "mode then posture") { await writeMode(); await writePosture(); } else { await writePosture(); await writeMode(); }

        expect(t.rows()).toEqual(expect.arrayContaining([
          expect.objectContaining({ qualifier: target, mode: "focus" }),
          expect.objectContaining({ qualifier: t.rig.id, mode: "delegated" }),
        ]));
        expect(t.rows()).toHaveLength(2);
        // The posture consumer and authority, whatever was written last.
        expect(t.service.resolve({ rigId: t.rig.id })).toMatchObject({ posture: "delegated", source: "binding", grantsAuthority: false });
        const effective = await t.get(`/api/rig-mode/effective?rig=demo`);
        expect(effective.operatingPosture).toMatchObject({ posture: "delegated", grantsAuthority: false });
        expect(effective.categories.mode).toMatchObject({ mode: "focus", qualifier: target });
        expect(effective.categories.posture).toMatchObject({ mode: "delegated", qualifier: t.rig.id });
        // The legacy primary result keeps its meaning: at equal specificity a raw-name binding is preferred (as on
        // main); at one stored target the latest set is the one shown.
        const primary = form === "name" ? "focus" : order === "mode then posture" ? "delegated" : "focus";
        expect(effective.effective.binding.mode).toBe(primary);
      });
    }
  }

  it("a later write replaces only its own category, keeping the row's id", async () => {
    const t = setup();
    const first = await t.put("focus", "rig", t.rig.id);
    await t.put("delegated", "rig", "demo");
    const again = await t.put("debug", "rig", t.rig.id);
    expect(again.binding.id).toBe(first.binding.id);
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: `posture@rig:${t.rig.id}`, mode: "delegated" }),
      expect.objectContaining({ id: `rig:${t.rig.id}`, mode: "debug" }),
    ]);
    await t.put("human-led", "rig", "demo");
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: `posture@rig:${t.rig.id}`, mode: "human-led" }),
      expect.objectContaining({ id: `rig:${t.rig.id}`, mode: "debug" }),
    ]);
  });

  it("a second category's id can't be mistaken for a legacy id, even for qualifiers ending in :mode or :posture", () => {
    const t = setup();
    // Legacy-shaped rows whose qualifiers end like a category.
    t.modes.setBinding("rig", "x:posture", "focus", record("focus", "rig"));
    t.modes.setBinding("rig", "x:mode", "sleep", record("sleep", "rig"));
    t.modes.setBinding("rig", "x", "debug", record("debug", "rig"));
    t.modes.setBinding("rig", "x", "delegated", record("delegated", "rig"));
    expect(t.rows()).toEqual([
      expect.objectContaining({ id: "posture@rig:x", qualifier: "x", mode: "delegated" }),
      expect.objectContaining({ id: "rig:x", qualifier: "x", mode: "debug" }),
      expect.objectContaining({ id: "rig:x:mode", qualifier: "x:mode", mode: "sleep" }),
      expect.objectContaining({ id: "rig:x:posture", qualifier: "x:posture", mode: "focus" }),
    ]);
    for (const q of ["x", "x:mode", "x:posture"]) expect(t.modes.getBinding("rig", q)?.qualifier).toBe(q);
    // Resolution accepts every one of these ids as valid.
    expect(t.modes.resolveEffective({ rigId: "x" }, ["human-led", "delegated"])?.binding.id).toBe("posture@rig:x");
    expect(t.modes.resolveEffective({ rigId: "x:posture" })?.binding.mode).toBe("focus");
  });

  it("an opaque legacy target (not a rig) still takes a mode by name, and a posture there is still refused as on main", async () => {
    const t = setup();
    await t.put("focus", "rig", "no-such-rig");
    const res = await t.app.request("/api/rig-mode/bindings/rig/no-such-rig", {
      method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer isolated-operator" },
      body: JSON.stringify({ mode: "delegated", record: record("delegated", "rig") }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scope_unresolved" });
    expect(t.rows()).toEqual([expect.objectContaining({ id: "rig:no-such-rig", mode: "focus" })]);
  });
});

describe("reads and unset where both are kept", () => {
  it("a direct read shows the latest set binding and lists each category; it canonicalises only on a miss, as on main", async () => {
    const t = setup();
    await t.put("focus", "rig", t.rig.id);
    await t.put("delegated", "rig", "demo");
    const byId = await t.get(`/api/rig-mode/bindings/rig/${t.rig.id}`);
    expect(byId.binding.mode).toBe("delegated");
    expect(byId.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated", "focus"]);
    // By name: no row is stored under "demo", so the read canonicalises.
    const byName = await t.get("/api/rig-mode/bindings/rig/demo");
    expect(byName.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated", "focus"]);
  });

  it("unset without a category removes the latest set one and says what's still kept; with one, exactly that one", async () => {
    const t = setup();
    await t.put("focus", "rig", t.rig.id);
    await t.put("delegated", "rig", "demo");
    expect(await t.del("rig", t.rig.id)).toMatchObject({ removed: true, category: "posture", remaining: { mode: "focus" } });
    // The kept mode is now what the primary effective read shows.
    expect((await t.get("/api/rig-mode/effective?rig=" + t.rig.id)).effective.binding.mode).toBe("focus");
    await t.put("delegated", "rig", "demo");
    expect(await t.del("rig", t.rig.id, "mode")).toMatchObject({ removed: true, category: "mode", remaining: { mode: "delegated" } });
    expect(await t.del("rig", t.rig.id, "mode")).toEqual({ removed: false });
    expect(await t.del("rig", "demo", "posture")).toMatchObject({ removed: true, category: "posture", remaining: null });
    expect(await t.del("rig", t.rig.id)).toEqual({ removed: false });
    const bad = await t.app.request(`/api/rig-mode/bindings/rig/${t.rig.id}?category=other`, { method: "DELETE", headers: { authorization: "Bearer isolated-operator" } });
    expect(bad.status).toBe(400);
  });

  it("a same-millisecond tie is broken the same way for the read and the unset: by id", () => {
    const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
    const same = new RigModeStore(db, { now: () => new Date("2026-10-14T18:00:00.000Z") });
    same.setBinding("rig", "r1", "delegated", record("delegated", "rig"));
    same.setBinding("rig", "r1", "focus", record("focus", "rig"));
    // The posture came first, so it holds "rig:r1" and the mode is "mode@rig:r1", which sorts first on the tie.
    expect(same.getBinding("rig", "r1")?.id).toBe("mode@rig:r1");
    expect(same.removeBinding("rig", "r1")?.id).toBe("mode@rig:r1");
    expect(same.getBinding("rig", "r1")?.mode).toBe("delegated");
  });
});

describe("migration 109 on surviving rows", () => {
  it("keeps every row, id and record from a database at main's schema, and lets the categories coexist afterwards", () => {
    const db = createDb(); cleanup.push(() => db.close());
    migrate(db, ALL_MIGRATIONS.filter((m) => m.name !== "109_mode_posture_coexist.sql"));
    const old = new RigModeStore(db, { now: () => new Date("2026-10-01T00:00:00.000Z") });
    const rig = new RigRepository(db).createRig("legacy");
    // Real-shaped rows: modes by id and by name, a posture by id, the host, a mission and a qitem.
    old.setBinding("rig", rig.id, "focus", record("focus", "rig"));
    old.setBinding("rig", "legacy", "sleep", record("sleep", "rig"));
    old.setBinding("rig", "other-rig-id", "delegated", record("delegated", "rig"));
    old.setBinding("global_host", null, "desk", record("desk", "global_host"));
    old.setBinding("mission", "alpha/release", "human-led", record("human-led", "mission"));
    old.setBinding("qitem", "q:mode", "debug", record("debug", "qitem"));
    const before = db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all();
    expect(before).toHaveLength(6);

    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all()).toEqual(before);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'operator_context_mode_bindings'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexes).toContain("idx_operator_context_mode_bindings_scope_qualifier_category");
    expect(indexes).not.toContain("idx_operator_context_mode_bindings_scope_qualifier");
    // Applying the full list again is a no-op (the runner records applied migrations by name).
    migrate(db, ALL_MIGRATIONS);
    expect(db.prepare("SELECT * FROM operator_context_mode_bindings ORDER BY id").all()).toEqual(before);

    const store = new RigModeStore(db, { now: () => new Date("2026-10-14T00:00:00.000Z") });
    for (const r of before as Array<{ scope: OperatorContextScope; qualifier: string | null; id: string }>) {
      expect(store.getBinding(r.scope, r.qualifier)?.id).toBe(r.id);
    }
    // The surviving id-form mode now keeps a posture beside it.
    store.setBinding("rig", rig.id, "delegated", record("delegated", "rig"));
    expect(store.getBindings("rig", rig.id).map((b) => [b.id, b.mode])).toEqual([[`posture@rig:${rig.id}`, "delegated"], [`rig:${rig.id}`, "focus"]]);
    // Still one row per category: the unique index refuses a second posture there.
    expect(() => db.prepare("INSERT INTO operator_context_mode_bindings VALUES ('dup', 'rig', ?, 'human-led', '{}', 'x', 'operator')").run(rig.id)).toThrow(/UNIQUE/);
  });
});

describe("round 1: the write target a preview reads, and unset by category through its own path", () => {
  it("?for=posture reads where a posture write lands (the canonical id), so a posture written by name shows what it displaces there", async () => {
    const t = setup();
    await t.put("delegated", "rig", "demo");
    await t.put("focus", "rig", "demo");
    const posture = await t.get("/api/rig-mode/bindings/rig/demo?for=posture");
    expect(posture.writeTarget).toBe(`rig:${t.rig.id}`);
    expect(posture.bindings.map((b: { mode: string }) => b.mode)).toEqual(["delegated"]);
    // A saved mode lands as given: the name's own stored target.
    const mode = await t.get("/api/rig-mode/bindings/rig/demo?for=mode");
    expect(mode).toMatchObject({ writeTarget: "rig:demo", bindings: [expect.objectContaining({ mode: "focus", qualifier: "demo" })] });
    expect(await t.get("/api/rig-mode/bindings/global_host?for=mode")).toEqual({ writeTarget: "global_host:host", bindings: [] });
    // Without ?for, main's read is unchanged: the name's stored binding.
    expect((await t.get("/api/rig-mode/bindings/rig/demo")).binding.mode).toBe("focus");
  });

  it("?for=posture on a target a posture write can't resolve answers as that write would: scope_unresolved", async () => {
    const t = setup();
    const res = await t.app.request("/api/rig-mode/bindings/rig/no-such-rig?for=posture");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "scope_unresolved" });
    expect((await t.app.request("/api/rig-mode/bindings/rig/demo?for=other")).status).toBe(400);
  });

  it("DELETE …/categories/<category> removes exactly that category, for a qualified scope and for global_host", async () => {
    const t = setup();
    await t.put("focus", "rig", t.rig.id);
    await t.put("delegated", "rig", "demo");
    const del = (path: string) => t.app.request(path, { method: "DELETE", headers: { authorization: "Bearer isolated-operator" } });
    expect(await (await del(`/api/rig-mode/bindings/rig/${t.rig.id}/categories/mode`)).json()).toMatchObject({ removed: true, category: "mode", remaining: { mode: "delegated" } });
    expect(await (await del(`/api/rig-mode/bindings/rig/${t.rig.id}/categories/mode`)).json()).toEqual({ removed: false });
    // By name: nothing of that category is stored under "demo", so it canonicalises, as the plain delete does.
    expect(await (await del("/api/rig-mode/bindings/rig/demo/categories/posture")).json()).toMatchObject({ removed: true, category: "posture", remaining: null });
    t.modes.setBinding("global_host", null, "desk", record("desk", "global_host"));
    t.modes.setBinding("global_host", null, "human-led", record("human-led", "global_host"));
    expect(await (await del("/api/rig-mode/bindings/global_host/categories/posture")).json()).toMatchObject({ removed: true, category: "posture", remaining: { mode: "desk" } });
    expect((await del("/api/rig-mode/bindings/rig/categories/mode")).status).toBe(400);
    expect((await del(`/api/rig-mode/bindings/rig/${t.rig.id}/categories/other`)).status).toBe(400);
    expect((await t.app.request(`/api/rig-mode/bindings/rig/${t.rig.id}/categories/mode`, { method: "DELETE" })).status).toBe(401);
  });
});
