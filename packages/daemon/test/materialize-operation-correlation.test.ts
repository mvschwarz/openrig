import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { makeTopologyDestinationCheck } from "../src/domain/queue-destination-check.js";

const databases: Array<ReturnType<typeof createFullTestDb>> = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createFullTestDb();
  databases.push(db);
  const setup = createTestApp(db);
  const launch = vi.spyOn(setup.nodeLauncher, "launchNode").mockImplementation(async () => {
    throw new Error("materialization must not launch a session");
  });
  const yaml = 'version: "0.2"\nname: prepared-team\npods:\n  - id: core\n    label: Core\n    members:\n      - id: shell\n        runtime: terminal\n        agent_ref: "builtin:terminal"\n        profile: none\n        cwd: /tmp\n    edges: []\nedges: []\n';
  const operationId = randomUUID();
  const call = (changes: { body?: string; root?: string; cwd?: string; target?: string; operation?: string } = {}) =>
    setup.app.request("/api/rigs/import/materialize", { method: "POST", headers: {
      "X-OpenRig-Operation-Id": changes.operation ?? operationId,
      "X-Rig-Root": changes.root ?? "/tmp",
      ...(changes.cwd ? { "X-Cwd-Override": changes.cwd } : {}),
      ...(changes.target ? { "X-Target-Rig-Id": changes.target } : {}),
    }, body: changes.body ?? yaml });
  return { ...setup, db, launch, yaml, call, operationId };
}

describe("no-launch materialization operation correlation", () => {
  const emptyPodYaml = 'version: "0.2"\nname: prepared-team\npods:\n  - id: empty\n    label: Empty\n    members: []\n    edges: []\nedges: []\n';

  it.each([false, true])("records and replays a committed empty pod (existing target: %s)", async target => {
    const { call, rigRepo, db, operationId, launch } = fixture();
    if (target) expect((await call({ operation: randomUUID() })).status).toBe(201);
    const targetRig = target ? rigRepo.findRigsByName("prepared-team")[0]!.id : undefined;
    const request = { body: emptyPodYaml, target: targetRig };
    const first = await call(request);
    expect(first.status).toBe(201);
    const result = await first.json();
    const rigId = rigRepo.findRigsByName("prepared-team")[0]!.id;
    if (target) expect(rigId).toBe(targetRig);
    expect(result).toMatchObject({ rigId, nodes: [], operation: { operationId, rigId, nodeIds: [],
      current: { rig: { id: rigId, exists: true, archivedAt: null }, nodes: [] } } });
    const replay = await call(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ replayed: true, operation: result.operation });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM pods").get()).toEqual({ n: target ? 2 : 1 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: target ? 1 : 0 });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps a failed empty-pod operation unconfirmed (existing target: %s)", async target => {
    const { call, rigRepo, db, launch } = fixture();
    if (target) expect((await call({ operation: randomUUID() })).status).toBe(201);
    const targetRig = target ? rigRepo.findRigsByName("prepared-team")[0]!.id : undefined;
    db.exec("CREATE TRIGGER reject_empty_pod BEFORE INSERT ON pods WHEN NEW.namespace = 'empty' BEGIN SELECT RAISE(ABORT, 'pod failed'); END");
    const request = { body: emptyPodYaml, target: targetRig };
    expect((await call(request)).status).toBe(500);
    const replay = await call(request);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { rigId: null, nodeIds: [],
      current: { rig: null, nodes: [] } } });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: target ? 1 : 0 });
    expect(db.prepare("SELECT count(*) AS n FROM pods").get()).toEqual({ n: target ? 1 : 0 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: target ? 1 : 0 });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(launch).not.toHaveBeenCalled();
  });

  it("recovers the exact rig and node ids after a lost response, with real destination admission and no sessions", async () => {
    const { db, rigRepo, eventBus, call, operationId, launch } = fixture();
    const queue = new QueueRepository(db, eventBus, { validateRig: makeTopologyDestinationCheck({
      findRigsByName: name => rigRepo.findRigsByName(name),
      loadHumanRegistry: () => ({ ok: true, entities: [] }), sharedChannels: () => [],
    }) });
    const task = { qitemId: "qitem-prepared-team-day", sourceSession: "setup@system", destinationSession: "core-shell@prepared-team",
      tier: "task" as const, summary: "Start the day", tags: ["start-of-day"], body: "Own-team daily recipe", nudge: false };
    await expect(queue.create(task)).rejects.toMatchObject({ code: "unknown_destination_rig" });
    // Commit, then discard the response: the next request must recover ids from native state.
    expect((await call()).status).toBe(201);
    const rig = rigRepo.findRigsByName("prepared-team")[0]!;
    const nodeIds = rigRepo.getRig(rig.id)!.nodes.map(node => node.id);
    const replay = await call();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, operation: {
      operationId, rigId: rig.id, nodeIds, current: { rig: { id: rig.id, exists: true },
        nodes: nodeIds.map(id => ({ id, exists: true, latestSession: null })) },
    } });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM sessions").get()).toEqual({ n: 0 });
    expect(launch).not.toHaveBeenCalled();
    await expect(queue.create(task)).resolves.toMatchObject({ qitemId: task.qitemId });
    const parked = queue.update({ qitemId: task.qitemId, actorSession: task.sourceSession, state: "blocked",
      blockedOn: "external:new-day", wakeAfterSeconds: 86400 });
    expect(parked.waiting?.nextBackstop).toMatchObject({ mechanism: expect.stringMatching(/^watchdog:/), dueAt: expect.any(String) });
  });

  it("returns the first request's recorded identities in its ordinary response", async () => {
    const { call, rigRepo, operationId } = fixture();
    const first = await call();
    expect(first.status).toBe(201);
    const result = await first.json();
    const rig = rigRepo.findRigsByName("prepared-team")[0]!;
    expect(result.operation).toMatchObject({ contract: "operation-correlation.v1", operationId, rigId: rig.id,
      nodeIds: rigRepo.getRig(rig.id)!.nodes.map(node => node.id) });
    expect((await (await call()).json()).operation).toEqual(result.operation);
  });

  it.each(["spec", "root", "cwd", "target"])("rejects changed %s under the same operation before creating topology", async changed => {
    const { call, yaml, db } = fixture();
    expect((await call()).status).toBe(201);
    const changes = changed === "spec" ? { body: yaml + "\n" } : changed === "root" ? { root: "/different-root" }
      : changed === "cwd" ? { cwd: "/different-cwd" } : { target: "another-rig" };
    const conflict = await call(changes);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "operation_id_conflict" });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 1 });
  });

  it("rejects invalid operation ids before reserving or creating anything", async () => {
    const { call, db } = fixture();
    expect((await call({ operation: "invalid" })).status).toBe(400);
    expect(db.prepare("SELECT count(*) AS n FROM operation_correlations").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
  });

  it("preserves an empty receipt after failed validation without phantom topology or a second execution", async () => {
    const { call, yaml, db } = fixture();
    const invalid = { body: yaml.replace("    label: Core\n", "") };
    expect((await call(invalid)).status).toBe(400);
    const replay = await call(invalid);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { rigId: null, nodeIds: [] } });
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 0 });
  });

  it("rolls back rig and node writes when transactional correlation recording fails", async () => {
    const { call, db } = fixture();
    db.exec("CREATE TRIGGER reject_materialize_record BEFORE UPDATE ON operation_correlations WHEN NEW.node_ids_json <> '[]' BEGIN SELECT RAISE(ABORT, 'record failed'); END");
    expect((await call()).status).toBe(500);
    expect(db.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT rig_id, node_ids_json FROM operation_correlations").get()).toEqual({ rig_id: null, node_ids_json: "[]" });
  });

  it("keeps uncorrelated materialization backward compatible", async () => {
    const { app, yaml, launch } = fixture();
    const response = await app.request("/api/rigs/import/materialize", {
      method: "POST", headers: { "X-Rig-Root": "/tmp" }, body: yaml,
    });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result).toMatchObject({ specName: "prepared-team", nodes: [{ logicalId: "core.shell", status: "materialized" }] });
    expect(result).not.toHaveProperty("operation");
    expect(launch).not.toHaveBeenCalled();
  });
});
