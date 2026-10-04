import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import { OperatingPostureService, configuredCatalogPath } from "../src/domain/rig-mode/operating-posture.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { RECOMMENDED_MODE_DEFAULTS } from "../src/domain/rig-mode/rig-mode-defaults.js";
import type { OperatorContextScope } from "../src/domain/rig-mode/rig-mode-types.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthProjectionService, type HealthDetectorObservation } from "../src/domain/health-detectors.js";
import { HealthDiagnosisService } from "../src/domain/health-diagnosis.js";
import { PassiveCeremonySource } from "../src/domain/health-passive-ceremony.js";
import { HealthCheckpointSource } from "../src/domain/health-checkpoints.js";
import { healthAuthority } from "../src/domain/health-context.js";
import { adaptQueueTransitionEvidence, boundHealthEvidence, deriveHealthSourceFreshness } from "../src/domain/health-projection.js";
import { rigModeRoutes } from "../src/routes/rig-mode.js";
import { healthRoutes } from "../src/routes/health.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
const record = (mode: "human-led" | "delegated" | "focus", scope: OperatorContextScope) => ({
  ...RECOMMENDED_MODE_DEFAULTS[mode], scope, expiry_or_stale_rule: "none", evidence_citation: "explicit isolated operator choice",
});

async function setup() {
  const home = mkdtempSync(join(tmpdir(), "operating-posture-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const rigs = new RigRepository(db), rig = rigs.createRig("demo");
  const queue = new QueueRepository(db, new EventBus(db));
  const send = vi.fn(async () => ({ ok: true, verified: true })); queue.attachTransport({ send });
  const modes = new RigModeStore(db), service = new OperatingPostureService(db, modes, () => home);
  const write = (path: string, bytes: string) => { mkdirSync(join(home, path, ".."), { recursive: true }); writeFileSync(join(home, path), bytes); };
  write("workspace.yaml", "projects: [{id: alpha, root: alpha}, {id: beta, root: beta}]\n");
  for (const project of ["alpha", "beta"]) {
    write(project + "/project.yaml", "metadata: {id: " + project + "}\n");
    write(project + "/missions/release/SPEC.md", "---\nid: release\n---\n# Release\n");
    write(project + "/missions/release/mission.yaml", "kind: mission\nmetadata: {name: release, status: active}\nrelease: {phase: planning}\ncomposition:\n  slices: [{ref: slices/01-work/slice.yaml, order: 1, active: true}]\n");
    write(project + "/missions/release/slices/01-work/slice.yaml", "kind: slice\ncomposition: {mission: ../../mission.yaml}\n");
    write(project + "/missions/release/slices/01-work/SPEC.md", "---\nid: work-1\nmission: release\nstage: planning\n---\n# Plan\n");
    await queue.create({ qitemId: project, sourceSession: "author@demo", destinationSession: "owner@demo", body: "Scoped work", tags: ["project:" + project, "mission:release", "slice:work-1"], nudge: false });
  }
  await queue.create({ qitemId: "unlinked", sourceSession: "author@demo", destinationSession: "owner@demo", body: "No authored linkage", nudge: false });
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("rigModeStore" as never, modes); c.set("operatingPosture" as never, service); await next(); });
  app.route("/api/rig-mode", rigModeRoutes({ bearerToken: "isolated-operator" }));
  const put = (mode: "human-led" | "delegated", scope: OperatorContextScope, qualifier: string) => app.request("/api/rig-mode/bindings/" + scope + "/" + encodeURIComponent(qualifier), {
    method: "PUT", headers: { "content-type": "application/json", authorization: "Bearer isolated-operator" }, body: JSON.stringify({ mode, record: record(mode, scope) }),
  });
  return { home, db, rig, rigs, queue, send, modes, service, app, put, write };
}

it("defaults a resolved new rig to human-led; explicit public transitions retain source and do not grant authority", async () => {
  const t = await setup();
  const initial = await (await t.app.request("/api/rig-mode/effective?rig=demo")).json();
  expect(initial.operatingPosture).toMatchObject({ posture: "human-led", source: "product-default", binding: null, grantsAuthority: false, context: { rigId: t.rig.id } });
  expect((await t.put("delegated", "rig", "demo")).status).toBe(200);
  expect(t.service.resolve({ rigId: "demo" })).toMatchObject({ posture: "delegated", source: "binding", binding: { id: "rig:" + t.rig.id }, grantsAuthority: false });
  expect((await t.put("human-led", "rig", "demo")).status).toBe(200);
  expect(t.service.resolve({ rigId: t.rig.id }).posture).toBe("human-led");
  expect(t.modes.listBindings()).toHaveLength(1);
  expect(t.send).not.toHaveBeenCalled();
});

it("joins project, mission, authored workstream and qitem; the most specific explicit choice wins without leaking across projects", async () => {
  const t = await setup();
  for (const [scope, qualifier] of [["project", "alpha"], ["mission", "beta/release"]] as const) expect((await t.put("delegated", scope, qualifier)).status).toBe(200);
  expect(t.service.resolve({ qitemId: "alpha" })).toMatchObject({ posture: "delegated", binding: { id: "project:alpha" }, context: { projectId: "alpha", missionId: "release", workstreamId: "alpha/release/work-1", phase: { value: "planning" } } });
  expect((await t.put("human-led", "workstream", "alpha/release/work-1")).status).toBe(200);
  expect(t.service.resolve({ qitemId: "alpha" }).posture).toBe("human-led");
  expect(t.service.resolve({ qitemId: "beta" })).toMatchObject({ posture: "delegated", binding: { id: "mission:beta/release" } });
  expect((await t.put("delegated", "qitem", "alpha")).status).toBe(200);
  expect(t.service.resolve({ qitemId: "alpha" }).binding?.scope).toBe("qitem");
  expect(t.service.resolve({ workstreamId: "alpha/release/work-1" }).posture).toBe("human-led");
  const manifest = join(t.home, "alpha/missions/release/mission.yaml"), before = readFileSync(manifest);
  t.service.resolve({ qitemId: "alpha" }); expect(readFileSync(manifest)).toEqual(before);
});

it("uses exact workflow packet phase and normalizes rig aliases; workflow existence does not delegate", async () => {
  const t = await setup();
  t.db.prepare("INSERT INTO workflow_instances(instance_id,workflow_name,workflow_version,created_by_session,created_at,bound_rig,lifecycle_binding_json) VALUES('workflow','fixture','1','owner@demo','2026-09-09',?,?)")
    .run("demo", JSON.stringify({ identity: { project: "alpha", mission: "release" } }));
  t.db.prepare("INSERT INTO workflow_frontier_bindings(instance_id,packet_id,step_id,created_at) VALUES('workflow','alpha','interactive-plan','2026-09-09')").run();
  expect(t.service.resolve({ rigId: t.rig.id, qitemId: "alpha" })).toMatchObject({ posture: "human-led", source: "product-default", context: { phase: { value: "interactive-plan", source: "workflow:workflow/frontier/alpha" } } });
  t.db.prepare("UPDATE workflow_instances SET lifecycle_binding_json = ?").run(JSON.stringify({ identity: { project: "beta", mission: "release" } }));
  expect(t.service.resolve({ qitemId: "alpha" })).toMatchObject({ posture: "unknown", source: "unknown", reason: expect.stringContaining("conflicting projectId") });
});

it("refuses missing, conflicting, ambiguous, unreadable and corrupt sources instead of using the default", async () => {
  const t = await setup();
  for (const ctx of [{}, { rigId: "missing" }, { rigId: " " }, { missionId: "release" }, { projectId: "missing" }, { projectId: "alpha", missionId: "missing" }, { qitemId: "unlinked" }, { qitemId: "missing" }, { qitemId: "alpha", projectId: "beta" }]) {
    expect(t.service.resolve(ctx)).toMatchObject({ posture: "unknown", source: "unknown", binding: null });
  }
  expect((await t.put("delegated", "qitem", "unlinked")).status).toBe(400);
  expect(t.modes.listBindings()).toHaveLength(0);
  t.write("alpha/missions/duplicate/SPEC.md", "---\nid: release\n---\n# Duplicate\n");
  expect(t.service.resolve({ qitemId: "alpha" }).posture).toBe("unknown");
  t.write("beta/missions/release/mission.yaml", "metadata: [invalid yaml\n");
  expect(t.service.resolve({ qitemId: "beta" }).posture).toBe("unknown");
  expect((await t.put("delegated", "rig", "demo")).status).toBe(200);
  t.db.prepare("UPDATE operator_context_mode_bindings SET record_json = '{'").run();
  expect(t.service.resolve({ rigId: "demo" })).toMatchObject({ posture: "unknown", source: "unknown" });
});

it("preserves legacy binding bytes through migration and never infers delegation from an ergonomic mode", async () => {
  const db = createDb(); cleanup.push(() => db.close()); migrate(db, ALL_MIGRATIONS.slice(0, -1));
  const store = new RigModeStore(db); store.setBinding("global_host", null, "focus", record("focus", "global_host"));
  const before = db.prepare("SELECT * FROM operator_context_mode_bindings").all();
  migrate(db, ALL_MIGRATIONS); expect(db.prepare("SELECT * FROM operator_context_mode_bindings").all()).toEqual(before);
  const rig = new RigRepository(db).createRig("legacy");
  const result = new OperatingPostureService(db, store, () => "unreadable").resolve({ rigId: rig.id });
  expect(result).toMatchObject({ posture: "human-led", source: "product-default" });
});

it("keeps legacy ergonomic bindings addressed by rig name readable alongside canonical posture", async () => {
  const t = await setup(); t.modes.setBinding("rig", "demo", "focus", record("focus", "rig"));
  const result = await (await t.app.request("/api/rig-mode/effective?rig=demo")).json();
  expect(result.effective.binding.mode).toBe("focus");
  expect(result.operatingPosture).toMatchObject({ posture: "human-led", source: "product-default" });
  await t.put("delegated", "project", "alpha");
  const scoped = await (await t.app.request("/api/rig-mode/effective?rig=demo&project=alpha")).json();
  expect(scoped.effective.binding.id).toBe("project:alpha");
  expect(scoped.operatingPosture.posture).toBe("delegated");
});

async function diagnosisSetup() {
  const t = await setup(); let now = "2026-09-09T22:00:00Z";
  const observation = (id: string): HealthDetectorObservation => ({ kind: "coordination-lineage", scope: { type: "rig", rigId: t.rig.id }, lineageId: id, episodeKey: id,
    episodeStartedAt: now, lastObservedAt: now, coordinationTransitions: 257, productStateChanges: 0, boundedAuthority: false, reviewReturns: 0, candidateChanges: 0, newRiskClasses: 0,
    source: boundHealthEvidence([adaptQueueTransitionEvidence({ transitionId: id === "alpha" ? 1 : 2, qitemId: id, ts: now, state: "in-progress", actorSession: "owner@demo" }, 0)], { source: "mixed", startedAt: now, endedAt: now, limit: 200, retentionSeconds: 86400 }, deriveHealthSourceFreshness({ evaluatedAt: now, newestSourceAt: now, maxAgeSeconds: 600, available: true })),
  });
  const observations = [observation("alpha"), observation("beta"), observation("unlinked")];
  const policy = new HealthPolicyStore(t.home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const p = policy.read().policy; policy.apply({ ...p, freshnessSeconds: 86400, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@demo", cooldownSeconds: 60 } }, "isolated-operator");
  const projection = new HealthProjectionService({ read: () => observations }, () => policy.read(), r => t.service.forHealth(r));
  const diagnosis = new HealthDiagnosisService({ queue: t.queue, projection, policy, now: () => now, authority: () => [] });
  t.app.use("/api/health/*", async (c, next) => { c.set("healthProjection" as never, projection); await next(); });
  t.app.route("/api/health", healthRoutes());
  return { ...t, observations, policy, projection, diagnosis, tick: () => { now = "2026-09-09T22:02:00Z"; } };
}

it("does not select one project's authority for a mixed finding even when both postures match", async () => {
  const t = await diagnosisSetup();
  const records = t.projection.records();
  const alpha = records.find(r => r.evidence.some(e => e.type === "queue-transition" && e.qitemId === "alpha"))!;
  const beta = records.find(r => r.evidence.some(e => e.type === "queue-transition" && e.qitemId === "beta"))!;
  const mixed = t.service.forHealth({ ...alpha, evidence: [...alpha.evidence, ...beta.evidence] });
  expect(mixed).toMatchObject({ posture: "unknown", context: null, reason: expect.stringContaining("different work contexts") });
  expect(mixed.members?.map(m => m.posture)).toEqual(["human-led", "human-led"]);
});

it("presents only unrelated delegated planning, keeps human-led and unknown findings inspectable, then quiets an existing occurrence without canceling it", async () => {
  const t = await diagnosisSetup();
  await t.put("delegated", "mission", "beta/release");
  const list = await (await t.app.request("/api/health")).json(); expect(list.records).toHaveLength(3);
  expect(list.records.map((r: any) => r.operatingPosture.posture).sort()).toEqual(["delegated", "human-led", "unknown"]);
  const workBefore = [t.queue.getById("alpha"), t.queue.getById("beta")];
  const preview = await t.diagnosis.evaluate("system:health", false);
  expect(preview.actions.filter(a => a.action === "create")).toHaveLength(1); expect(t.send).not.toHaveBeenCalled();
  const applied = await t.diagnosis.evaluate("system:health", true), id = applied.actions.find(a => a.action === "create")!.qitemId;
  expect(t.send).toHaveBeenCalledTimes(1);
  expect(t.diagnosis.show(id).finding.operatingPosture).toMatchObject({ posture: "delegated", context: { phase: { value: "planning" } } });
  await t.put("human-led", "mission", "beta/release"); t.tick();
  expect((await t.diagnosis.evaluate("system:health", true)).actions.every(a => a.action === "deferred")).toBe(true);
  expect(t.send).toHaveBeenCalledTimes(1); expect(t.queue.getById(id)!.state).toBe("pending");
  expect([t.queue.getById("alpha"), t.queue.getById("beta")]).toEqual(workBefore);
  expect(t.diagnosis.show(id).finding.operatingPosture?.posture).toBe("human-led");
  await expect(t.diagnosis.notify(id, "owner@demo")).rejects.toThrow("posture_does_not_admit");
  t.observations.length = 0;
  expect(t.diagnosis.show(id).finding.operatingPosture?.posture).toBe("unknown");
  expect(t.diagnosis.list()[0]!.finding.operatingPosture?.posture).toBe("unknown");
});

it("does not treat a finding spanning different postures as one delegated scope", async () => {
  const t = await diagnosisSetup(); await t.put("delegated", "project", "beta");
  const records = t.projection.records().filter(r => r.operatingPosture?.posture !== "unknown");
  const combined = { ...records[0]!, evidence: records.flatMap(r => r.evidence) };
  expect(t.service.forHealth(combined).posture).toBe("unknown");
});

it("discovers simultaneous catalog projects through the automatic source and supplies the selected authority", async () => {
  const t = await diagnosisSetup(), now = "2026-09-09T22:00:00.000Z";
  await t.put("delegated", "project", "beta");
  t.db.prepare("UPDATE queue_transitions SET ts = ?").run(now);
  for (const id of ["alpha", "beta", "unlinked"]) for (let n = 0; n < 22; n++) {
    t.db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES(?,?,'in-progress','owner@demo')").run(id, now);
  }
  const source = new PassiveCeremonySource(t.home, t.queue, t.policy, () => now, undefined, { reader: t.service, instanceId: t.home });
  const projection = new HealthProjectionService(source, () => t.policy.read(), r => t.service.forHealth(r));
  const checkpoints = new HealthCheckpointSource(t.home, t.queue, t.policy);
  const diagnosis = new HealthDiagnosisService({ queue: t.queue, projection, policy: t.policy, now: () => now, authority: r => healthAuthority(t.home, checkpoints, r) });
  expect(projection.list().records.map(r => r.operatingPosture?.posture).sort()).toEqual(["delegated", "human-led", "unknown"]);
  const result = await diagnosis.evaluate("system:health", true);
  expect(result.actions.filter(a => a.action === "create")).toHaveLength(1);
  const occurrence = diagnosis.list()[0]!;
  expect(occurrence.finding.ceremony?.stage).toBe("needs-diagnosis");
  expect(occurrence.authority).toContainEqual(expect.objectContaining({ level: "mission", state: "available", path: realpathSync(join(t.home, "beta/missions/release/mission.yaml")) }));
});

it("keeps ordinary context/continuity health and queue reminders effective under human-led posture", async () => {
  const t = await diagnosisSetup(), now = "2026-09-09T22:00:00.000Z";
  const source = t.observations[0]!.source;
  t.observations.push({ kind: "context-pressure", scope: { type: "seat", rigId: t.rig.id, seatId: "seat" }, episodeStartedAt: now, lastObservedAt: now,
    sourceName: "fixture", continuity: "known", source: { ...source, evidence: [{ type: "context-usage", sourceOrder: 0, observedAt: now, nodeId: "seat", sessionId: "session", usedPercentage: 99, available: true, fresh: true }] } });
  const p = t.policy.read().policy; t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, detectors: [...p.diagnosis.detectors, "context.pressure"] } }, "operator");
  const operational = t.projection.records().find(r => r.category === "context")!;
  expect(operational).toMatchObject({ status: "active", severity: "critical", operatingPosture: { posture: "human-led" } });
  expect((await t.diagnosis.evaluate("system:health", true)).actions).toContainEqual(expect.objectContaining({ action: "create", findingId: operational.id }));
  // Same queue delivery port used by workflow reminders remains independent of diagnosis eligibility.
  await t.queue.maybeNudge("alpha", "owner@demo", true, "workflow");
  expect(t.send).toHaveBeenCalledTimes(2);
});

it("rechecks posture after notification readiness I/O and refuses an intervening human-led transition", async () => {
  const t = await diagnosisSetup(); await t.put("delegated", "project", "beta");
  const p = t.policy.read().policy;
  t.policy.apply({ ...p, human: { address: "operator@external", conditions: ["established pathology"] } }, "operator");
  const id = (await t.diagnosis.evaluate("system:health", true)).actions.find(a => a.action === "create")!.qitemId;
  t.diagnosis.dispose(id, "owner@demo", { verdict: "established pathology", causalStart: null, steering: "Inspect the scoped work", uncertainty: "Isolated fixture only", evidenceRefs: ["fixture"] });
  const readiness = vi.fn(async () => { await t.put("human-led", "project", "beta"); return { ready: true, reason: "isolated fixture" }; });
  const service = new HealthDiagnosisService({ queue: t.queue, projection: t.projection, policy: t.policy, authority: () => [], humanReadiness: readiness });
  await expect(service.notify(id, "owner@demo")).rejects.toThrow("posture_changed_or_unknown");
  expect(readiness).toHaveBeenCalledOnce();
  expect(t.queue.list({ tag: "health-human", limit: 100 })).toEqual([]);
});

it("reads the project catalog from the configured workspace.catalog_path, not only <workspace>/workspace.yaml", () => {
  const home = mkdtempSync(join(tmpdir(), "operating-posture-catalog-")); cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const workspace = join(home, "workspace"), catalog = join(home, "catalogs", "projects.yaml");
  mkdirSync(join(workspace, "gamma"), { recursive: true }); mkdirSync(join(home, "catalogs"), { recursive: true });
  writeFileSync(join(workspace, "gamma", "project.yaml"), "metadata: {id: gamma}\n");
  // Only the configured catalog declares gamma; its root is relative to the catalog's folder,
  // and the entry carries the optional rigs key other catalog readers accept.
  writeFileSync(catalog, "projects: [{id: gamma, root: ../workspace/gamma, rigs: [openrig-dev]}]\n");
  const service = new OperatingPostureService(db, new RigModeStore(db), () => workspace, () => catalog);
  expect(service.resolve({ projectId: "gamma" })).toMatchObject({
    posture: "human-led",
    source: "product-default",
    context: { projectId: "gamma", paths: { project: realpathSync(join(workspace, "gamma")) } },
  });
});

it("keeps the default catalog beside the real workspace when workspace.root is a symlink, and honours an explicit catalog", () => {
  vi.stubEnv("OPENRIG_WORKSPACE_ROOT", undefined); vi.stubEnv("OPENRIG_WORKSPACE_CATALOG_PATH", undefined); cleanup.push(() => vi.unstubAllEnvs());
  const root = realpathSync(mkdtempSync(join(tmpdir(), "operating-posture-link-"))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "physical", "workspace"), gamma = join(root, "physical", "gamma"), alias = join(root, "logical", "workspace");
  mkdirSync(workspace, { recursive: true }); mkdirSync(gamma); mkdirSync(join(root, "logical")); mkdirSync(join(root, "catalogs"));
  symlinkSync(workspace, alias, "dir");
  writeFileSync(join(workspace, "workspace.yaml"), "projects: [{id: gamma, root: ../gamma}]\n");
  writeFileSync(join(gamma, "project.yaml"), "metadata: {id: gamma}\n");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const configPath = join(root, "config.json");
  const resolveWith = (workspaceConfig: Record<string, string>, projectId: string) => {
    writeFileSync(configPath, JSON.stringify({ workspace: workspaceConfig }));
    const settings = new SettingsStore(configPath);
    const service = new OperatingPostureService(db, new RigModeStore(db), () => settings.resolveOne("workspace.root").value as string, configuredCatalogPath(settings));
    return service.resolve({ projectId });
  };

  // Default catalog through the symlink: ../gamma resolves beside the real workspace, as before.
  expect(resolveWith({ root: alias }, "gamma")).toMatchObject({ posture: "human-led", context: { projectId: "gamma", paths: { project: gamma } } });

  // An explicitly configured catalog still wins; only it declares delta.
  const delta = join(root, "physical", "delta");
  mkdirSync(delta); writeFileSync(join(delta, "project.yaml"), "metadata: {id: delta}\n");
  writeFileSync(join(root, "catalogs", "projects.yaml"), "projects: [{id: delta, root: ../physical/delta}]\n");
  expect(resolveWith({ root: alias, catalogPath: join(root, "catalogs", "projects.yaml") }, "delta"))
    .toMatchObject({ posture: "human-led", context: { projectId: "delta", paths: { project: delta } } });
});
