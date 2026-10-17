import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("edge-only batch upsert", () => {
  let db: Database.Database;
  let setup: ReturnType<typeof createTestApp>;
  let rigId: string;
  const repair = { from: "orch.lead", to: "review.reviewer", kind: "delegates_to" };
  const escalation = { from: "review.reviewer", to: "orch.lead", kind: "escalates_to" };
  const local = { from: "dev.build", to: "dev.qa", kind: "collaborates_with" };

  beforeEach(() => {
    db = createFullTestDb();
    setup = createTestApp(db);
    rigId = setup.rigRepo.createRig("edge-repair").id;
    const lead = setup.rigRepo.addNode(rigId, "orch.lead");
    const build = setup.rigRepo.addNode(rigId, "dev.build");
    setup.rigRepo.addNode(rigId, "dev.qa");
    setup.rigRepo.addNode(rigId, "review.reviewer");
    setup.rigRepo.addEdge(rigId, lead.id, build.id, "delegates_to");
  });
  afterEach(() => { vi.restoreAllMocks(); db.close(); });

  const post = (body: unknown, target = rigId) => setup.app.request(`/api/rigs/${target}/edges`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const state = () => setup.rigRepo.getRig(rigId)!;

  it("plans and restores local/cross-pod edges once, with stable IDs on retry", async () => {
    const before = state();
    const edges = [repair, escalation, local, repair, { from: "orch.lead", to: "dev.build", kind: "delegates_to" }];
    const plan = await post({ edges, plan: true });
    expect(plan.status).toBe(200);
    expect((await plan.json()).results.map((r: { outcome: string }) => r.outcome))
      .toEqual(["would_add", "would_add", "would_add", "present"]);
    expect(state()).toEqual(before);

    const response = await post({ edges });
    expect(response.status).toBe(201);
    const added = await response.json();
    expect(added.results.map((r: { outcome: string }) => r.outcome)).toEqual(["added", "added", "added", "present"]);
    const after = state();
    expect(after.nodes).toEqual(before.nodes);
    expect(after.rig).toEqual(before.rig);
    expect(after.edges).toHaveLength(4);
    expect(after.edges).toEqual(expect.arrayContaining(before.edges));
    expect(added.results.slice(0, 3).map((r: { edge: { id: string }; rollback: string }) => r.rollback))
      .toEqual(added.results.slice(0, 3).map((r: { edge: { id: string } }) => `rig edge remove ${rigId} ${r.edge.id}`));

    const retry = await post({ edges });
    expect(retry.status).toBe(200);
    const present = await retry.json();
    expect(present.results.every((r: { outcome: string }) => r.outcome === "present")).toBe(true);
    expect(present.results.map((r: { edge: { id: string } }) => r.edge.id))
      .toEqual(added.results.map((r: { edge: { id: string } }) => r.edge.id));
    expect(state()).toEqual(after);
  });

  it.each([
    { ...escalation, to: "other.only" },
    { ...escalation, kind: "reports_to" },
  ])("rejects an invalid later edge without writing earlier edges: %j", async (invalid) => {
    const other = setup.rigRepo.createRig("other-rig");
    setup.rigRepo.addNode(other.id, "other.only");
    const before = state();
    const foreignBefore = setup.rigRepo.getRig(other.id);
    const response = await post({ edges: [repair, invalid] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: invalid.kind === "reports_to" ? "invalid_kind" : "node_not_found" });
    expect(state()).toEqual(before);
    expect(setup.rigRepo.getRig(other.id)).toEqual(foreignBefore);
  });

  it.each([false, true])("checks cycles formed jointly by a batch (plan=%s)", async (plan) => {
    const before = state();
    // Existing lead -> build, then build -> qa, then qa -> lead via spawned_by.
    const response = await post({ plan, edges: [
      { from: "dev.build", to: "dev.qa", kind: "delegates_to" },
      { from: "orch.lead", to: "dev.qa", kind: "spawned_by" },
    ] });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "edge_cycle" });
    expect(state()).toEqual(before);
  });

  it.each([
    null, [], "edges", {}, { edges: [] }, { edges: null }, { edges: "bad" },
    { edges: [repair, null] }, { edges: [repair, { from: "dev.qa", to: "dev.build" }] },
    { edges: [repair], ...repair }, { ...repair, plan: "true" }, { edges: [repair], plan: 1 },
  ])("rejects malformed or ambiguous input before mutation: %j", async (body) => {
    const before = state();
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, code: "validation_failed" });
    expect(state()).toEqual(before);
  });

  it("rolls back all new rows if a later insert fails", async () => {
    db.exec(`CREATE TRIGGER reject_escalation BEFORE INSERT ON edges
      WHEN NEW.kind = 'escalates_to' BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = state();
    expect((await post({ edges: [repair, escalation] })).status).toBe(500);
    expect(state()).toEqual(before);
  });

  it("concurrent retries create only one copy and preserve legacy duplicate rows", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => post(repair)));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const receipts = await Promise.all(results.map((r) => r.json()));
    expect(new Set(receipts.map((r) => r.edge.id)).size).toBe(1);
    const before = state();
    const edge = before.edges.find((e) => e.id === receipts[0].edge.id)!;
    setup.rigRepo.addEdge(rigId, edge.sourceId, edge.targetId, edge.kind);
    const withLegacyDuplicate = state();
    expect((await post({ edges: [repair, repair] })).status).toBe(200);
    expect(state()).toEqual(withLegacyDuplicate);
  });

  it("cannot remove an edge from another rig or mistake a malformed plan for a write", async () => {
    const edge = state().edges[0]!;
    const other = setup.rigRepo.createRig("other-rig");
    const before = state();
    const foreign = await setup.app.request(`/api/rigs/${other.id}/edges/${edge.id}`, { method: "DELETE" });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ ok: false, code: "edge_not_found" });
    const malformed = await setup.app.request(`/api/rigs/${rigId}/edges/${edge.id}?plan=true`, { method: "DELETE" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "validation_failed" });
    expect(state()).toEqual(before);
  });
});
