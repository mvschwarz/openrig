import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { LegacyRigSpec } from "../src/domain/types.js";
import { defaultResolveOrchestrator, resolveRigRepresentative } from "../src/domain/queue-owner.js";

// One typed edge on an existing rig, through the real route, converge op and repository.
describe("POST and DELETE /api/rigs/:rigId/edges", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let rigId: string;

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    rigId = setup.rigRepo.createRig("edge-rig").id;
    const lead = setup.rigRepo.addNode(rigId, "orch.lead");
    const build = setup.rigRepo.addNode(rigId, "dev.build");
    setup.rigRepo.addNode(rigId, "dev.qa");
    const review = setup.rigRepo.addNode(rigId, "review.r1");
    // Edges the rig already has, which no edge operation may touch.
    setup.rigRepo.addEdge(rigId, lead.id, build.id, "delegates_to");
    setup.rigRepo.addEdge(rigId, lead.id, review.id, "can_observe");
  });

  afterEach(() => { db.close(); });

  const add = (body: Record<string, unknown>, rig = rigId) => setup.app.request(`/api/rigs/${rig}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const remove = (edgeId: string, plan = false, rig = rigId) =>
    setup.app.request(`/api/rigs/${rig}/edges/${edgeId}${plan ? "?plan=1" : ""}`, { method: "DELETE" });
  const state = () => {
    const rig = setup.rigRepo.getRig(rigId)!;
    return { nodes: rig.nodes, edges: [...rig.edges].sort((a, b) => a.id.localeCompare(b.id)) };
  };

  it("plans without writing, adds one edge, and repeats as a no-op with the same receipt", async () => {
    const before = state();
    const planned = await add({ from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: true });
    expect(planned.status).toBe(200);
    expect(await planned.json()).toMatchObject({ ok: true, outcome: "would_add", edge: { kind: "delegates_to", from: { logicalId: "orch.lead" }, to: { logicalId: "dev.qa" } } });
    expect(state()).toEqual(before);

    const added = await add({ from: "orch.lead", to: "dev.qa", kind: "delegates_to" });
    expect(added.status).toBe(201);
    const receipt = await added.json() as { outcome: string; edge: { id: string }; rollback: string };
    expect(receipt).toMatchObject({ ok: true, outcome: "added", rollback: `rig edge remove ${rigId} ${receipt.edge.id}` });
    const after = state();
    expect(after.nodes).toEqual(before.nodes);
    expect(after.edges.filter((edge) => edge.id !== receipt.edge.id)).toEqual(before.edges);
    expect(after.edges).toHaveLength(before.edges.length + 1);

    const again = await add({ from: "orch.lead", to: "dev.qa", kind: "delegates_to" });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, outcome: "present", edge: { id: receipt.edge.id } });
    expect(state()).toEqual(after);

    const otherKind = await add({ from: "dev.build", to: "dev.qa", kind: "collaborates_with" });
    expect(otherKind.status).toBe(201);
    expect(state().edges).toHaveLength(before.edges.length + 2);
  });

  it("rolls back only the edge it added, and a second removal finds nothing", async () => {
    const before = state();
    const added = await (await add({ from: "orch.lead", to: "dev.qa", kind: "delegates_to" })).json() as { edge: { id: string } };

    const planned = await remove(added.edge.id, true);
    expect(planned.status).toBe(200);
    expect(await planned.json()).toMatchObject({ ok: true, outcome: "would_remove", edge: { id: added.edge.id } });
    expect(state().edges).toHaveLength(before.edges.length + 1);

    const removed = await remove(added.edge.id);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({ ok: true, outcome: "removed", edge: { id: added.edge.id, kind: "delegates_to", from: { logicalId: "orch.lead" }, to: { logicalId: "dev.qa" } } });
    expect(state()).toEqual(before);

    const again = await remove(added.edge.id);
    expect(again.status).toBe(404);
    expect(await again.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    expect(state()).toEqual(before);
  });

  it("refuses a launch-order cycle in either launch kind, and writes nothing", async () => {
    const before = state();
    for (const body of [
      { from: "dev.build", to: "orch.lead", kind: "delegates_to" },
      { from: "orch.lead", to: "dev.build", kind: "spawned_by" },
      { from: "dev.qa", to: "dev.qa", kind: "delegates_to" },
    ]) {
      const refused = await add(body);
      expect(refused.status).toBe(400);
      expect(await refused.json()).toMatchObject({ ok: false, code: "edge_cycle" });
    }
    expect(state()).toEqual(before);

    // A kind that doesn't order launch can run against the delegation.
    expect((await add({ from: "dev.build", to: "orch.lead", kind: "collaborates_with" })).status).toBe(201);
  });

  it("refuses an unknown rig, seat or kind, and a malformed body, without writing", async () => {
    const before = state();
    const cases: Array<[Response, number, string]> = [
      [await add({ from: "orch.lead", to: "dev.qa", kind: "delegates_to" }, "no-such-rig"), 404, "rig_not_found"],
      [await add({ from: "orch.lead", to: "dev.absent", kind: "delegates_to" }), 400, "node_not_found"],
      [await add({ from: "orch.lead", to: "dev.qa", kind: "reports_to" }), 400, "invalid_kind"],
      [await add({ from: "orch.lead", kind: "delegates_to" }), 400, "validation_failed"],
      [await remove("no-such-edge"), 404, "edge_not_found"],
    ];
    for (const [response, status, code] of cases) {
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ ok: false, code });
    }
    const unknown = await (await add({ from: "orch.lead", to: "dev.absent", kind: "delegates_to" })).json() as { message: string };
    expect(unknown.message).toContain("'dev.absent'");
    expect(state()).toEqual(before);
  });

  it.each([null, [], "edge", {}, { from: "orch.lead", to: "dev.qa", kind: "delegates_to", plan: "true" }])(
    "refuses a body that isn't one edge before any write: %j",
    async (body) => {
      const before = state();
      const response = await setup.app.request(`/api/rigs/${rigId}/edges`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, code: "validation_failed" });
      expect(state()).toEqual(before);
    },
  );

  it("concurrent repeats add one copy, and a duplicate row from another path is left as it is", async () => {
    const edge = { from: "orch.lead", to: "dev.qa", kind: "delegates_to" };
    const results = await Promise.all(Array.from({ length: 6 }, () => add(edge)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const receipts = await Promise.all(results.map((r) => r.json() as Promise<{ edge: { id: string } }>));
    expect(new Set(receipts.map((r) => r.edge.id)).size).toBe(1);
    const added = state().edges.find((e) => e.id === receipts[0]!.edge.id)!;
    setup.rigRepo.addEdge(rigId, added.sourceId, added.targetId, added.kind);
    const withDuplicate = state();
    expect((await add(edge)).status).toBe(200);
    expect(state()).toEqual(withDuplicate);
  });

  it.each(["collaborates_with", "escalates_to"])("a flat legacy rig's export still imports after adding a %s edge", async (kind) => {
    const legacy = setup.rigRepo.createRig("legacy-rig");
    for (const id of ["lead", "worker"]) setup.rigRepo.addNode(legacy.id, id, { runtime: "claude-code", cwd: "/workspace" });
    const reimport = () => LegacyRigSpecSchema.validate(LegacyRigSpecCodec.parse(
      LegacyRigSpecCodec.serialize(setup.rigSpecExporter.exportRig(legacy.id) as LegacyRigSpec)));
    expect(reimport()).toMatchObject({ valid: true });
    expect((await add({ from: "lead", to: "worker", kind }, legacy.id)).status).toBe(201);
    expect(reimport()).toMatchObject({ valid: true, errors: [] });
  });

  it("removes an edge only through its own rig, and a malformed plan is never a write", async () => {
    const edge = state().edges[0]!;
    const other = setup.rigRepo.createRig("other-rig");
    const before = state();
    const foreign = await remove(edge.id, false, other.id);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    const malformed = await setup.app.request(`/api/rigs/${rigId}/edges/${edge.id}?plan=true`, { method: "DELETE" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "validation_failed" });
    expect(state()).toEqual(before);
  });
});

// A delegates_to change can move where a seat's stuck work goes, or who receives a person's
// message to the rig. The receipt names what moved, as the queue's own resolvers read it.
describe("an edge receipt names the routing it moves", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let rigId: string;
  const ids: Record<string, string> = {};

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    rigId = setup.rigRepo.createRig("route-rig").id;
    // Sessions oldest first: a seat's chosen orchestrator is its most recently started parent.
    const seats: Array<[string, string, string]> = [
      ["ops.old", "ops-old@route-rig", "2026-09-01 00:00:00"],
      ["orch.lead", "orch-lead@route-rig", "2026-10-01 00:00:00"],
      ["dev.qa", "dev-qa@route-rig", "2026-10-02 00:00:00"],
      ["dev.build", "dev-build@route-rig", "2026-10-03 00:00:00"],
    ];
    for (const [logicalId, session, createdAt] of seats) {
      ids[logicalId] = setup.rigRepo.addNode(rigId, logicalId).id;
      db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES (?, ?, ?, 'running', ?)")
        .run(`s-${logicalId}`, ids[logicalId], session, createdAt);
    }
    // orch.lead is the rig's one delegation root, over dev.qa and dev.build.
    setup.rigRepo.addEdge(rigId, ids["orch.lead"]!, ids["dev.qa"]!, "delegates_to");
    setup.rigRepo.addEdge(rigId, ids["orch.lead"]!, ids["dev.build"]!, "delegates_to");
  });

  afterEach(() => { db.close(); });

  const add = (from: string, to: string, kind = "delegates_to") => setup.app.request(`/api/rigs/${rigId}/edges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to, kind }),
  });
  type Receipt = { outcome: string; edge: { id: string }; routing?: unknown };

  it("an add that changes a seat's chosen orchestrator says from whom to whom", async () => {
    expect(defaultResolveOrchestrator(db, "dev-build@route-rig")).toBe("orch-lead@route-rig");
    const receipt = await (await add("dev.qa", "dev.build")).json() as Receipt;
    expect(receipt.outcome).toBe("added");
    expect(receipt.routing).toEqual({ orchestrator: { seat: "dev-build@route-rig", from: "orch-lead@route-rig", to: "dev-qa@route-rig" } });
    expect(defaultResolveOrchestrator(db, "dev-build@route-rig")).toBe("dev-qa@route-rig");
  });

  it("an add that gives the rig a second delegation root says it lost its representative, and the rollback says it's back", async () => {
    expect(resolveRigRepresentative(db, "route-rig")).toBe("orch-lead@route-rig");
    const added = await (await add("ops.old", "dev.build")).json() as Receipt;
    expect(added.routing).toEqual({ representative: { from: "orch-lead@route-rig", to: null } });
    expect(resolveRigRepresentative(db, "route-rig")).toBeNull();

    const removed = await (await setup.app.request(`/api/rigs/${rigId}/edges/${added.edge.id}`, { method: "DELETE" })).json() as Receipt;
    expect(removed.outcome).toBe("removed");
    expect(removed.routing).toEqual({ representative: { from: null, to: "orch-lead@route-rig" } });
  });

  it("an archived earlier generation with the rig's name doesn't hide that change", async () => {
    // An archived rig with the same name, such as the earlier generation a relaunch archives.
    setup.rigRepo.archiveRig(setup.rigRepo.createRig("route-rig").id);
    expect(resolveRigRepresentative(db, "route-rig")).toBe("orch-lead@route-rig");
    const added = await (await add("ops.old", "dev.build")).json() as Receipt;
    expect(added.routing).toEqual({ representative: { from: "orch-lead@route-rig", to: null } });
  });

  it("an ordinary add that moves nothing says nothing extra", async () => {
    setup.rigRepo.addEdge(rigId, ids["orch.lead"]!, ids["ops.old"]!, "delegates_to");
    // dev.build keeps its more recent parent, and the rig keeps its one root.
    const delegation = await (await add("ops.old", "dev.build")).json() as Receipt;
    expect(delegation.outcome).toBe("added");
    expect(delegation).not.toHaveProperty("routing");
    const other = await (await add("dev.qa", "dev.build", "collaborates_with")).json() as Receipt;
    expect(other.outcome).toBe("added");
    expect(other).not.toHaveProperty("routing");
  });
});
