import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { reserveOperation } from "../src/domain/operation-correlation.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

const opened: Array<ReturnType<typeof createDb>> = [];
const db = () => { const value = createFullTestDb(); opened.push(value); return value; };
const id = () => randomUUID();
afterEach(() => { for (const value of opened.splice(0)) value.close(); });

describe("operation correlation", () => {
  it("returns a capability marker for the three supported kinds", async () => {
    const { app } = createTestApp(db());
    const response = await app.request("/api/operations/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ contract: "operation-correlation.v1", kinds: ["rig.create", "rig.import", "member.add"] });
  });

  it("reserves a legacy import before paused preflight so a concurrent replay has one executor", async () => {
    const database = db();
    const setup = createTestApp(database);
    let entered!: () => void;
    const atPreflight = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const original = setup.rigSpecPreflight.check.bind(setup.rigSpecPreflight);
    const check = vi.spyOn(setup.rigSpecPreflight, "check").mockImplementation(async (spec) => {
      entered(); await paused; return original(spec);
    });
    const operationId = id();
    const yaml = "schema_version: 1\nname: correlated-import\nversion: 1.0.0\nnodes:\n  - id: worker\n    runtime: claude-code\n    cwd: /\nedges: []\n";
    const call = () => setup.app.request("/api/rigs/import", { method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: yaml });
    const first = call();
    await atPreflight;
    const replay = await call();
    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.nodeIds).toEqual([]);
    release();
    await first;
    expect(check).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
  });

  it("records pod terminal imports and added members without including later unrelated nodes", async () => {
    const database = db();
    const setup = createTestApp(database);
    const yaml = 'version: "0.2"\nname: operation-pod\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: shell\n        runtime: terminal\n        agent_ref: "builtin:terminal"\n        profile: none\n        cwd: /tmp\n    edges: []\nedges: []\n';
    const importId = id();
    const postImport = (root = "/tmp", cwdOverride?: string) => setup.app.request("/api/rigs/import", {
      method: "POST", headers: { "X-OpenRig-Operation-Id": importId, "X-Rig-Root": root,
        ...(cwdOverride ? { "X-Cwd-Override": cwdOverride } : {}) }, body: yaml,
    });
    const first = await postImport();
    expect(first.status).toBe(201);
    const imported = await first.json();
    expect(imported.operation.rigId).toBe(imported.rigId);
    expect(imported.operation.nodeIds).toHaveLength(1);
    expect((await postImport("/different-root")).status).toBe(409);
    expect((await postImport("/tmp", "/different-cwd")).status).toBe(409);
    const replay = await postImport();
    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.nodeIds).toEqual(imported.operation.nodeIds);

    const memberId = id();
    const memberBody = JSON.stringify({ member: { id: "second", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }, rigRoot: "/tmp" });
    const memberRoute = `/api/rigs/${imported.rigId}/pods/dev/members`;
    const add = (route = memberRoute) => setup.app.request(route, { method: "POST", headers: { "X-OpenRig-Operation-Id": memberId }, body: memberBody });
    const added = await add();
    expect(added.status).toBe(201);
    const addedBody = await added.json();
    expect(addedBody.operation.nodeIds).toEqual([addedBody.result.node.nodeId]);
    expect((await (await postImport()).json()).operation.nodeIds).toEqual(imported.operation.nodeIds);
    expect((await add(`/api/rigs/${imported.rigId}/pods/other/members`)).status).toBe(409);
    const newId = id();
    const duplicate = await setup.app.request(memberRoute, { method: "POST", headers: { "X-OpenRig-Operation-Id": newId }, body: memberBody });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).existingNodeId).toBe(addedBody.result.node.nodeId);
    const ordinaryDuplicate = await setup.app.request(memberRoute, { method: "POST", body: memberBody });
    expect(await ordinaryDuplicate.json()).not.toHaveProperty("existingNodeId");
  });

  it("returns the exact node ID for a collision created during awaited add-member preflight", async () => {
    const database = db();
    const setup = createTestApp(database, { podInstantiatorFsOps: {
      exists: (p) => p.endsWith("/agents/impl/agent.yaml"),
      readFile: () => 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []',
    } });
    const rig = setup.rigRepo.createRig("late-collision");
    const pod = new PodRepository(database).createPod(rig.id, "dev", "Dev");
    let entered!: () => void;
    const atPreflight = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const deps = Reflect.get(setup.podInstantiator, "deps") as { exec?: (command: string) => Promise<string> };
    deps.exec = async () => { entered(); await paused; return "1.0.0"; };
    const operationId = id();
    const request = JSON.stringify({ member: { id: "impl", runtime: "pi", agent_ref: "local:agents/impl", profile: "default", cwd: "/tmp" }, rigRoot: "/tmp" });
    const first = setup.app.request(`/api/rigs/${rig.id}/pods/dev/members`, {
      method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: request,
    });
    await atPreflight;
    const otherNode = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "pi", podId: pod.id });
    release();
    const response = await first;
    expect(response.status).toBe(409);
    const conflict = await response.json();
    expect(conflict.code).toBe("member_conflict");
    expect(conflict.existingNodeId).toBe(otherNode.id);
    expect(conflict.operation.nodeIds).toEqual([]);
    expect(conflict.operation.rigId).toBeNull();
    const replay = await setup.app.request(`/api/rigs/${rig.id}/pods/dev/members`, {
      method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: request,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json()).operation.nodeIds).toEqual([]);
  });

  it("rejects malformed IDs before effects and preserves the no-header shape", async () => {
    const database = db();
    const { app } = createTestApp(database);
    const invalid = await app.request("/api/rigs", { method: "POST", headers: { "X-OpenRig-Operation-Id": "not-a-uuid" }, body: '{"name":"one"}' });
    expect(invalid.status).toBe(400);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    const ordinary = await (await app.request("/api/rigs", { method: "POST", body: '{"name":"one"}' })).json();
    expect(ordinary).not.toHaveProperty("operation");
  });

  it("binds exact request bytes, kind and targets and replays fresh deleted state", async () => {
    const database = db();
    const { app, rigRepo } = createTestApp(database);
    const operationId = id();
    const call = (body: string, route = "/api/rigs") => app.request(route, {
      method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body,
    });
    const first = await call('{"name":"one"}');
    expect(first.status).toBe(201);
    const created = await first.json();
    expect(created.operation.rigId).toBe(created.id);
    expect((await (await call('{"name":"one"}')).json())).toEqual({ replayed: true, operation: created.operation });
    expect((await call('{ "name":"one"}')).status).toBe(409);
    expect((await call('{"name":"one"}', "/api/rigs/import")).status).toBe(400); // invalid YAML is rejected before reservation
    const conflict = reserveOperation(database, operationId, "member.add", [created.id, "dev"], '{"name":"one"}');
    expect(conflict.state).toBe("conflict");
    rigRepo.deleteRig(created.id);
    const replay = await (await call('{"name":"one"}')).json();
    expect(replay.operation.rigId).toBe(created.id);
    expect(replay.operation.current.rig).toEqual({ id: created.id, exists: false, archivedAt: null });
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
  });

  it("projects only recorded nodes and current latest sessions", () => {
    const database = db();
    const { rigRepo } = createTestApp(database);
    const operation = reserveOperation(database, id(), "member.add", ["rig", "dev"], "request");
    expect(operation.state).toBe("fresh");
    if (operation.state !== "fresh") return;
    const rig = rigRepo.createRig("sample");
    const node = rigRepo.addNode(rig.id, "dev.first", {});
    rigRepo.addNode(rig.id, "dev.later", {});
    operation.recordCreated(rig.id, node.id);
    expect(operation.read().nodeIds).toEqual([node.id]);
    database.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)")
      .run("session-a", node.id, "test", "stopped", "ready");
    expect(operation.read().current.nodes[0]!.latestSession).toEqual({ id: "session-a", status: "stopped", startupStatus: "ready" });
    database.prepare("UPDATE sessions SET status = 'running' WHERE id = 'session-a'").run();
    expect(operation.read().current.nodes[0]!.latestSession.status).toBe("running");
    database.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);
    expect(operation.read().current.nodes[0]).toEqual({ id: node.id, exists: false, latestSession: null });
  });

  it("reopens a file-backed database and keeps old broad receipts separate", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-correlation-"));
    const filename = path.join(directory, "test.db");
    try {
      const first = createDb(filename); migrate(first, ALL_MIGRATIONS.filter((migration) => migration.name !== "127_operation_correlation.sql"));
      first.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("existing-rig", "preserved");
      first.prepare("UPDATE rigs SET permission_policy = ? WHERE id = ?").run("builtin:standard", "existing-rig");
      first.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime, codex_config_profile, permission_policy) VALUES (?, ?, ?, ?, ?, ?)")
        .run("existing-node", "existing-rig", "dev.worker", "codex", "review", "builtin:standard");
      first.prepare("INSERT INTO sessions (id, node_id, session_name, status, startup_status) VALUES (?, ?, ?, ?, ?)")
        .run("existing-session", "existing-node", "dev-worker@test", "stopped", "ready");
      first.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)")
        .run("existing-snapshot", "existing-rig", "manual", '{"saved":true}');
      first.exec("CREATE TABLE operation_receipts (operation_id TEXT PRIMARY KEY)");
      first.prepare("INSERT INTO operation_receipts VALUES (?)").run("old-id");
      first.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run("126_operation_receipts.sql");
      const preserved = Object.fromEntries(["rigs", "nodes", "sessions", "snapshots", "operation_receipts"]
        .map((table) => [table, first.prepare(`SELECT * FROM ${table}`).all()]));
      migrate(first, ALL_MIGRATIONS);
      for (const [table, rows] of Object.entries(preserved)) {
        expect(first.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
      }
      const operationId = id();
      const reservation = reserveOperation(first, operationId, "rig.create", [], '{"name":"saved"}');
      expect(reservation.state).toBe("fresh");
      if (reservation.state !== "fresh") return;
      const { rigRepo } = createTestApp(first);
      first.transaction(() => { const rig = rigRepo.createRig("saved"); reservation.recordCreated(rig.id); })();
      first.close();
      const reopened = createDb(filename); migrate(reopened, ALL_MIGRATIONS);
      expect(reserveOperation(reopened, operationId, "rig.create", [], '{"name":"saved"}').state).toBe("replay");
      expect(reopened.prepare("SELECT operation_id FROM operation_receipts").get()).toEqual({ operation_id: "old-id" });
      expect(reopened.prepare("SELECT name FROM rigs WHERE id = 'existing-rig'").get()).toEqual({ name: "preserved" });
      expect(reopened.prepare("SELECT name FROM schema_migrations WHERE name = '127_operation_correlation.sql'").get())
        .toEqual({ name: "127_operation_correlation.sql" });
      expect(reserveOperation(reopened, id(), "rig.create", [], "new").state).toBe("fresh");
      reopened.close();
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it("replays through the public route after a child exits between commit and HTTP response", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-crash-"));
    const filename = path.join(directory, "test.db");
    const prepared = createDb(filename); migrate(prepared, ALL_MIGRATIONS); prepared.close();
    const fixture = fileURLToPath(new URL("./fixtures/operation-crash-child.mjs", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx", fixture, filename], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk.toString(); });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        child.stdout.on("data", (chunk) => {
          output += chunk.toString();
          const found = /PORT:(\d+)/.exec(output);
          if (found) resolve(Number(found[1]));
        });
        child.once("exit", (code) => reject(new Error(`Child exited before listen: ${code}: ${errors}`)));
      });
      const operationId = id();
      await expect(fetch(`http://127.0.0.1:${port}/api/rigs`, {
        method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: '{"name":"crash-test"}',
      })).rejects.toThrow();
      const code = child.exitCode ?? await new Promise<number | null>((resolve) => child.once("exit", resolve));
      expect(code).toBe(37);
      const reopened = createDb(filename); migrate(reopened, ALL_MIGRATIONS);
      const { app } = createTestApp(reopened);
      const replay = await app.request("/api/rigs", {
        method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: '{"name":"crash-test"}',
      });
      expect(replay.status).toBe(200);
      const body = await replay.json();
      expect(body.replayed).toBe(true);
      expect(body.operation.rigId).toBe(body.operation.current.rig.id);
      expect(reopened.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 1 });
      reopened.close();
    } finally { child.kill(); fs.rmSync(directory, { recursive: true, force: true }); }
  }, 10000);

  it("rolls back the actual bare-create route when correlation recording fails", async () => {
    const database = db();
    const { app } = createTestApp(database);
    const operationId = id();
    const call = () => app.request("/api/rigs", {
      method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: '{"name":"rollback"}',
    });
    database.exec("CREATE TRIGGER fail_correlation BEFORE UPDATE ON operation_correlations BEGIN SELECT RAISE(ABORT, 'recording failed'); END");
    expect((await call()).status).toBe(500);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT operation_id, rig_id, node_ids_json FROM operation_correlations").get())
      .toEqual({ operation_id: operationId, rig_id: null, node_ids_json: "[]" });
    database.exec("DROP TRIGGER fail_correlation");
    const replay = await call();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, operation: { rigId: null, nodeIds: [] } });
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
  });

  it("rolls back the actual pod-import rig insert when recording fails", async () => {
    const database = db();
    const { app } = createTestApp(database);
    const operationId = id();
    const yaml = 'version: "0.2"\nname: rig-record-fails\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: shell\n        runtime: terminal\n        agent_ref: "builtin:terminal"\n        profile: none\n        cwd: /tmp\n    edges: []\nedges: []\n';
    const call = () => app.request("/api/rigs/import", { method: "POST",
      headers: { "X-OpenRig-Operation-Id": operationId, "X-Rig-Root": "/tmp" }, body: yaml });
    database.exec("CREATE TRIGGER fail_rig_record BEFORE UPDATE ON operation_correlations WHEN NEW.rig_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'rig recording failed'); END");
    expect((await call()).status).toBe(500);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT operation_id, rig_id, node_ids_json FROM operation_correlations").get())
      .toEqual({ operation_id: operationId, rig_id: null, node_ids_json: "[]" });
    database.exec("DROP TRIGGER fail_rig_record");
    expect((await call()).status).toBe(200);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
  });

  it("keeps committed IDs after a public import cleans up total launch failure", async () => {
    const database = db();
    const setup = createTestApp(database);
    const launch = vi.spyOn(setup.nodeLauncher, "launchNode").mockResolvedValue({ ok: false, code: "forced_failure", message: "fixture launch failed" });
    const operationId = id();
    const yaml = "schema_version: 1\nname: failed-launch-import\nversion: 1.0.0\nnodes:\n  - id: worker\n    runtime: claude-code\n    cwd: /\nedges: []\n";
    const call = () => setup.app.request("/api/rigs/import", { method: "POST", headers: { "X-OpenRig-Operation-Id": operationId }, body: yaml });
    const first = await call();
    expect(first.status).toBe(500);
    const failed = await first.json();
    expect(failed.operation.nodeIds).toHaveLength(1);
    expect(failed.operation.rigId).toBeTruthy();
    expect(failed.operation.current.rig.exists).toBe(false);
    expect(failed.operation.current.nodes[0].exists).toBe(false);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
    const replay = await call();
    expect(replay.status).toBe(200);
    const current = (await replay.json()).operation;
    expect(current.rigId).toBe(failed.operation.rigId);
    expect(current.nodeIds).toEqual(failed.operation.nodeIds);
    expect(current.current.rig.exists).toBe(false);
    expect(current.current.nodes[0].exists).toBe(false);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });
  });

  it("rolls back terminal insert recording failures while preserving a successful sibling", async () => {
    const database = db();
    const { podInstantiator } = createTestApp(database);
    const yaml = 'version: "0.2"\nname: partial-correlation\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: first\n        runtime: terminal\n        agent_ref: "builtin:terminal"\n        profile: none\n        cwd: /tmp\n      - id: second\n        runtime: terminal\n        agent_ref: "builtin:terminal"\n        profile: none\n        cwd: /tmp\n    edges: []\nedges: []\n';
    const operation = reserveOperation(database, id(), "rig.import", [], yaml, ["/tmp", null]);
    expect(operation.state).toBe("fresh");
    if (operation.state !== "fresh") return;
    let nodeRecords = 0;
    const outcome = await podInstantiator.instantiate(yaml, "/tmp", { recordCreated: (rigId, nodeId) => {
      if (nodeId && ++nodeRecords === 1) throw new Error("injected terminal recording failure");
      operation.recordCreated(rigId, nodeId);
    } });
    expect(outcome.ok).toBe(true);
    expect(operation.read().nodeIds).toHaveLength(1);
    expect(database.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 1 });
  });

  it("rolls back legacy and pod agent insert failures at their transactions", async () => {
    const database = db();
    const setup = createTestApp(database, { podInstantiatorFsOps: {
      exists: (p) => p.endsWith("/agents/impl/agent.yaml"),
      readFile: () => 'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []',
    } });
    const legacy = {
      name: "legacy-rollback", version: "1.0.0", nodes: [{ id: "worker", runtime: "claude-code", cwd: "/" }], edges: [],
    } as Parameters<typeof setup.rigInstantiator.instantiate>[0];
    const legacyOutcome = await setup.rigInstantiator.instantiate(legacy, { recordCreated: (_rigId, nodeId) => {
      if (nodeId) throw new Error("legacy node recording failed");
    } });
    expect(legacyOutcome.ok).toBe(false);
    expect(database.prepare("SELECT count(*) AS n FROM rigs").get()).toEqual({ n: 0 });

    const yaml = 'version: "0.2"\nname: agent-rollback\npods:\n  - id: dev\n    label: Dev\n    members:\n      - id: impl\n        runtime: claude-code\n        agent_ref: "local:agents/impl"\n        profile: default\n        cwd: /tmp\n    edges: []\nedges: []\n';
    const podOutcome = await setup.podInstantiator.instantiate(yaml, "/tmp", { recordCreated: (_rigId, nodeId) => {
      if (nodeId) throw new Error("pod agent recording failed");
    } });
    expect(podOutcome.ok).toBe(false);
    expect(database.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual({ n: 0 });

    const successYaml = yaml.replace("agent-rollback", "agent-recorded");
    const operation = reserveOperation(database, id(), "rig.import", [], successYaml, ["/tmp", null]);
    expect(operation.state).toBe("fresh");
    if (operation.state !== "fresh") return;
    const success = await setup.podInstantiator.instantiate(successYaml, "/tmp", { recordCreated: operation.recordCreated });
    expect(success.ok).toBe(true);
    expect(operation.read().nodeIds).toHaveLength(1);
  });

  it("rolls back an add-member insert if its correlation update fails", async () => {
    const database = db();
    const setup = createTestApp(database);
    const rig = setup.rigRepo.createRig("add-rollback");
    const pod = await setup.rigExpansionService.expand({ rigId: rig.id, pod: {
      id: "dev", label: "Dev", members: [{ id: "first", runtime: "terminal", agentRef: "builtin:terminal", profile: "none", cwd: "/tmp" }], edges: [],
    } });
    expect(pod.ok).toBe(true);
    const before = database.prepare("SELECT count(*) AS n FROM nodes").get();
    database.exec("CREATE TRIGGER fail_node_record BEFORE UPDATE ON operation_correlations WHEN NEW.node_ids_json != OLD.node_ids_json BEGIN SELECT RAISE(ABORT, 'record failed'); END");
    const request = JSON.stringify({ member: { id: "second", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" }, rigRoot: "/tmp" });
    const response = await setup.app.request(`/api/rigs/${rig.id}/pods/dev/members`, {
      method: "POST", headers: { "X-OpenRig-Operation-Id": id() }, body: request,
    });
    expect(response.status).toBe(500);
    expect(database.prepare("SELECT count(*) AS n FROM nodes").get()).toEqual(before);
  });
});
