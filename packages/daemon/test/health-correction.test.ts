import { mkdtempSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { RigModeStore } from "../src/domain/rig-mode/rig-mode-store.js";
import { RECOMMENDED_MODE_DEFAULTS } from "../src/domain/rig-mode/rig-mode-defaults.js";
import { OperatingPostureService } from "../src/domain/rig-mode/operating-posture.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthCheckpointSource } from "../src/domain/health-checkpoints.js";
import { PassiveCeremonySource } from "../src/domain/health-passive-ceremony.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { HealthDiagnosisService } from "../src/domain/health-diagnosis.js";
import { healthAuthority, healthSelectedContext, readHealthArtifact } from "../src/domain/health-context.js";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(f => f()));
async function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "health-correction-")));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const write = (path: string, content: string) => writeFileSync(join(home, path), content);
  write("SPEC.md", "# Product authority\nPublication requires its separate decision.\n");
  write("project.yaml", "metadata: {id: demo}\ninstall:\n  context: [PREFLIGHT.md#current, trace.md, missing.md]\n");
  write("PREFLIGHT.md", "## Historical\nRetain reservations.\n## Current\nNormal interactive planning is not pathology.\n");
  write("trace.md", "# Retained causal testimony\nReservations outlived a corrected premise.\n");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  new RigRepository(db).createRig("rig");
  const queue = new QueueRepository(db, new EventBus(db));
  const sends: unknown[] = []; queue.attachTransport({ send: async (...args) => { sends.push(args); return { ok: true, verified: true }; } });
  await queue.create({ qitemId: "plan", sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Independent planning", tags: ["project:demo"], nudge: false });
  const now = new Date().toISOString(); db.prepare("UPDATE queue_transitions SET ts = ?").run(now);
  // Half the retained transitions are daemon bookkeeping (system:*), which the ceremony count leaves out:
  // `created` plus 20 owner transitions keep this family above the default threshold of 20.
  for (let i = 0; i < 40; i++) db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES('plan',?,'in-progress',?)").run(now, i % 2 ? "system:watchdog" : "owner@rig");
  const modes = new RigModeStore(db), posture = new OperatingPostureService(db, modes, () => home);
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const checkpoints = new HealthCheckpointSource(home, queue, policy, () => now, home);
  const passive = new PassiveCeremonySource(home, queue, policy, () => now, checkpoints, { reader: posture, instanceId: "fixture" });
  const projection = new HealthProjectionService(passive, () => policy.read(), r => posture.forHealth(r));
  const service = new HealthDiagnosisService({ queue, projection, policy, now: () => now,
    authority: r => healthAuthority(home, checkpoints, r), resolveEvidence: path => readHealthArtifact(home, path) });
  const admit = async () => {
    modes.setBinding("project", "demo", "delegated", { ...RECOMMENDED_MODE_DEFAULTS.delegated, scope: "project", expiry_or_stale_rule: "none", evidence_citation: "isolated explicit choice" });
    const p = policy.read().policy; policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "owner@rig");
    return (await service.evaluate("system:health", true)).actions.find(a => a.action === "create")!.qitemId;
  };
  return { home, write, db, queue, sends, modes, posture, policy, projection, service, admit };
}

it("reads selected project planning without inventing a mission or interrupting human-led work", async () => {
  const t = await setup();
  const before = t.db.prepare("SELECT total_changes() n").get();
  expect(t.posture.resolve({ qitemId: "plan" })).toMatchObject({ posture: "human-led", grantsAuthority: false, context: { projectId: "demo", phase: { value: null, source: null } } });
  expect(t.posture.resolve({ qitemId: "plan" }).context?.missionId).toBeUndefined();
  const finding = t.projection.records()[0]!;
  expect(finding.ceremony?.context).toContainEqual(expect.objectContaining({ path: join(t.home, "PREFLIGHT.md") + "#current", state: "available", selectedBy: join(t.home, "project.yaml") + "#install.context" }));
  expect(healthAuthority(t.home, new HealthCheckpointSource(t.home, t.queue, t.policy), finding)).toContainEqual(expect.objectContaining({ content: "## Current\nNormal interactive planning is not pathology.\n" }));
  expect((await t.service.evaluate("owner@rig", false)).actions).toEqual([]);
  expect(t.sends).toEqual([]); expect(t.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  t.db.prepare("INSERT INTO workflow_instances(instance_id,workflow_name,workflow_version,created_by_session,created_at,bound_rig,lifecycle_binding_json) VALUES('planning','fixture','1','owner@rig',?,'rig',?)")
    .run(new Date().toISOString(), JSON.stringify({ identity: { project: "demo" } }));
  t.db.prepare("INSERT INTO workflow_frontier_bindings(instance_id,packet_id,step_id,created_at) VALUES('planning','plan','interactive-plan',?)").run(new Date().toISOString());
  expect(t.posture.resolve({ qitemId: "plan" }).context).toMatchObject({ phase: { value: "interactive-plan", source: "workflow:planning/frontier/plan" } });
  expect(t.posture.resolve({ qitemId: "plan" }).context?.missionId).toBeUndefined();
});

it("refreshes current selected sources while preserving the original diagnosis, including list reads", async () => {
  const t = await setup(), id = await t.admit();
  const original = t.queue.getById(id)!.body;
  t.write("PREFLIGHT.md", "## Current\nRetire disproved reservations; publication remains separately authorized.\n");
  const before = t.db.prepare("SELECT total_changes() n").get();
  for (const view of [t.service.show(id), t.service.list()[0]!]) {
    expect(view.authority).toContainEqual(expect.objectContaining({ content: expect.stringContaining("Retire disproved") }));
    expect(view.packet.authority).toContainEqual(expect.objectContaining({ content: expect.stringContaining("Normal interactive") }));
    expect(view.authority).toContainEqual(expect.objectContaining({ path: "missing.md", state: "unavailable" }));
    expect(view.behavioralEffect).toBe("unobserved");
  }
  expect(t.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  expect(t.queue.getById(id)!.body).toBe(original);
  await t.queue.create({ qitemId: "unlinked", sourceSession: "owner@rig", destinationSession: "owner@rig", body: "Unlinked", nudge: false });
  expect(t.posture.resolve({ qitemId: "unlinked" }).posture).toBe("unknown");
  t.write("project.yaml", "metadata: {id: conflicting}\n");
  expect(t.service.show(id).authority).toEqual([expect.objectContaining({ path: "operatingPosture", state: "unavailable", reason: expect.stringContaining("conflicting") })]);
});

it("keeps correction, attribution and later effect separate without requiring a global outcome census", async () => {
  const t = await setup(), id = await t.admit();
  const d = { verdict: "insufficient evidence", causalStart: null, steering: "Continue useful planning within the corrected authority", uncertainty: "Global outcome census incomplete; half the retained transitions are automatic bookkeeping, not owner actions. Interruption cost not measured.", evidenceRefs: ["trace.md"],
    correction: { applicability: "Emergency origin no longer establishes current need; publication boundary still applies", causalJudgment: "Retained trace attributes persistence of the disproved premise to the process owner", action: { state: "proposed", summary: "Retire reservations", evidenceRefs: [] as string[] }, effect: { state: "unobserved", summary: "No natural later opportunity", evidenceRefs: [] as string[] } } };
  expect(t.service.dispose(id, "owner@rig", d).disposition?.correction?.action.state).toBe("proposed");
  const missing = { ...d, correction: { ...d.correction, action: { state: "taken", summary: "Retired", evidenceRefs: ["absent.md"] } } };
  const before = t.db.prepare("SELECT total_changes() n").get();
  expect(() => t.service.dispose(id, "owner@rig", missing)).toThrow("health_correction_evidence_unavailable");
  expect(t.db.prepare("SELECT total_changes() n").get()).toEqual(before);
  t.write("action.md", "# Retained fixture action\nReservations removed within authorized scope.\n");
  const taken = { ...d, correction: { ...d.correction, action: { state: "taken", summary: "Retained-case action recorded", evidenceRefs: ["action.md"] } } };
  const view = t.service.dispose(id, "owner@rig", taken);
  expect(view.assessment).toMatchObject({ actor: "owner@rig", transitionId: expect.any(Number) });
  expect(view.correctionEvidence).toContainEqual(expect.objectContaining({ path: "action.md", sha256: expect.any(String) }));
  expect(view.behavioralEffect).toBe("unobserved");
  expect(view.finding.ceremony?.assessment).toBeUndefined();
  expect(t.queue.getById(id)!.state).toBe("pending");
  expect(t.queue.getById("plan")!.body).toBe("Independent planning");
  expect((await t.service.evaluate("system:health", true)).actions[0]!.action).toBe("retained");
  expect(t.sends).toHaveLength(1);
  expect(() => t.service.dispose(id, "foreign@rig", taken)).toThrow("health_diagnosis_owner_required");
  expect(() => t.service.dispose(id, "owner@rig", { ...taken, correction: { ...taken.correction, effect: { state: "observed", summary: "Unsupported improvement", evidenceRefs: [] } } })).toThrow("require evidence");
});

it("refuses selected context escapes, aliases, ambiguous spans and oversized selections", async () => {
  const t = await setup(); symlinkSync(join(t.home, "trace.md"), join(t.home, "alias.md"));
  t.write("PREFLIGHT.md", "## Same\nOne\n## Same\nTwo\n");
  t.write("project.yaml", "metadata: {id: demo}\ninstall:\n  context: [../outside.md, alias.md, PREFLIGHT.md#same, 'https://example.com/context']\n");
  expect(healthSelectedContext(t.home).every(r => r.state === "unavailable")).toBe(true);
  t.write("project.yaml", "metadata: {id: demo}\ninstall:\n  context: " + JSON.stringify(Array(33).fill("trace.md")) + "\n");
  expect(healthSelectedContext(t.home)).toEqual([expect.objectContaining({ state: "unavailable", reason: expect.stringContaining("32") })]);
});

it("reads only the selected profile and mission context refs, with manifest-relative provenance", async () => {
  const t = await setup();
  t.write("project.yaml", "metadata: {id: demo}\nlifecycle:\n  profile: chosen\n  profiles:\n    chosen:\n      workflow:\n        context_refs: [trace.md]\n    other:\n      workflow:\n        context_refs: [not-selected.md]\n");
  // Same root is sufficient for this reference-reader check; work-node identity is tested above.
  t.write("mission.yaml", "lifecycle:\n  workflow:\n    context_refs: [PREFLIGHT.md#current]\n");
  const refs = healthSelectedContext(t.home, t.home);
  expect(refs).toHaveLength(2);
  expect(refs.map(r => r.selectedBy)).toEqual([join(t.home, "project.yaml") + "#lifecycle.profiles.chosen.workflow.context_refs", join(t.home, "mission.yaml") + "#lifecycle.workflow.context_refs"]);
  expect(refs.every(r => r.state === "available")).toBe(true);
});
