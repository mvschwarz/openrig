import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { LegacyRigSpecCodec } from "../src/domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../src/domain/rigspec-schema.js";
import type { LegacyRigSpec } from "../src/domain/types.js";

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
