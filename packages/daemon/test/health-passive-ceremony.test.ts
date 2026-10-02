import { delegatedPostureFixture } from "./helpers/delegated-posture.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthCheckpointSource } from "../src/domain/health-checkpoints.js";
import { PassiveCeremonySource } from "../src/domain/health-passive-ceremony.js";
import { HealthProjectionService } from "../src/domain/health-detectors.js";
import { HealthDiagnosisService } from "../src/domain/health-diagnosis.js";
import { healthAuthority, readHealthArtifact } from "../src/domain/health-context.js";
import type { CeremonyProgressAssessment } from "../src/domain/health-projection.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach((f) => f()); });
async function setup(count = 30) {
  const home = mkdtempSync(join(tmpdir(), "passive-ceremony-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace"); const slice = join(workspace, "missions", "mission", "slices", "work");
  mkdirSync(join(slice, "proof"), { recursive: true });
  writeFileSync(join(workspace, "project.yaml"), "kind: project\nmetadata: {id: project}\n");
  writeFileSync(join(workspace, "SPEC.md"), "# Product intent\nHuman judgment, durable work.");
  writeFileSync(join(workspace, "missions/mission/mission.yaml"), "kind: mission\ncomposition:\n  slices:\n    - {ref: slices/work/slice.yaml, order: 10, active: true}\nsdlc:\n  defaults:\n    components: [journey.probe, build.minimal-gap, qa.public-journey, integrate.one-outcome]\n");
  writeFileSync(join(workspace, "missions/mission/SPEC.md"), "# Mission\nOne meaningful product journey.");
  writeFileSync(join(slice, "SPEC.md"), "---\nid: slice-1\nmission: mission\n---\n# Build the product\nOne author-excluded whole-outcome evaluation.");
  writeFileSync(join(slice, "slice.yaml"), "kind: slice\ncomposition:\n  mission: ../../mission.yaml\n");
  const proof = join(slice, "proof", "outcome.md");
  writeFileSync(proof, "# Outcome proof\nThe public product journey works. Corrections belong to this same outcome.");
  const db = createDb(); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [
    { entityId: "operator", class: "human", displayName: "Fixture operator", address: "operator@external", connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "fixture", role: "primary" }], prefs: { deliveryClass: "A" } },
  ] }) });
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  let now = "2026-09-05T12:00:00.000Z";
  const tags = ["mission:mission", "slice:slice-1"];
  const row = await queue.create({ qitemId: "root", sourceSession: "builder@rig", destinationSession: "owner@rig", body: "Build product", tags, nudge: false });
  db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(now, row.qitemId);
  db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(now, row.qitemId);
  for (let i = 1; i < count; i++) db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES(?,?,?,?)").run(row.qitemId, new Date(Date.parse(now) + i * 1000).toISOString(), "in-progress", "builder@rig");
  now = new Date(Date.parse(now) + count * 1000).toISOString();
  const source = new PassiveCeremonySource(workspace, queue, policy, () => now);
  const projection = new HealthProjectionService(source, () => policy.read(), delegatedPostureFixture);
  const checkpoints = new HealthCheckpointSource(home, queue, policy, () => now, workspace);
  let ready = false;
  const readiness = vi.fn(async () => ({ ready, reason: "isolated fixture readiness" }));
  const service = new HealthDiagnosisService({ queue, projection, policy, now: () => now, humanReadiness: readiness,
    authority: (r) => healthAuthority(workspace, checkpoints, r), resolveEvidence: (path) => readHealthArtifact(workspace, path) });
  const send = vi.fn(async () => ({ ok: true, verified: true })); queue.attachTransport({ send });
  const p = policy.read().policy;
  policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", cooldownSeconds: 60 } }, "operator@rig");
  const assessment = (conclusion: CeremonyProgressAssessment["conclusion"] = "established"): CeremonyProgressAssessment => ({ basis: projection.list().records[0]!.ceremony!.basis,
    conclusion, outcomes: conclusion === "established" ? [{ id: "one-public-outcome", observedAt: "2026-09-05T12:00:20.000Z", evidenceRefs: [proof] }] : [],
    boundedAuthority: conclusion === "indeterminate" ? null : false, boundary: "One whole-outcome evaluation; all correction candidates belong to it", evidenceRefs: [proof, join(slice, "SPEC.md")], missingFacts: conclusion === "indeterminate" ? ["No complete product-outcome census for the exact interval"] : [] });
  const dispose = (id: string, progress: CeremonyProgressAssessment, actor = "owner@rig") => service.dispose(id, actor, { verdict: progress.conclusion === "indeterminate" ? "insufficient evidence" : progress.conclusion === "false-positive" ? "false positive" : "established pathology",
    causalStart: null, steering: "Follow the authored outcome boundary", uncertainty: "Check beyond this packet", evidenceRefs: [proof], progress }, "transport:v1");
  return { home, workspace, slice, proof, db, queue, source, projection, service, send, policy, assessment, dispose, readiness, setReady: (value: boolean) => { ready = value; }, time: (at: string) => { now = at; } };
}

it("automatically admits suspicion without a checkpoint or denominator; owner judgment confirms the same canonical episode", async () => {
  const t = await setup();
  const before = t.db.prepare("SELECT total_changes() AS n").get(); const bytes = readFileSync(t.proof);
  const first = t.projection.list().records[0]!;
  expect(first).toMatchObject({ status: "indeterminate", severity: "info", ceremony: { stage: "needs-diagnosis", transitionIds: expect.any(Array) } });
  expect(first.explanation).toContain("no ratio is computed"); expect(first.explanation).not.toContain("30.0:1");
  expect(first.ceremony!.context.some((r) => r.path.endsWith("mission.yaml") && r.state === "available")).toBe(true);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  await Promise.all([t.service.evaluate("system:health", true), t.service.evaluate("system:health", true)]);
  const occurrence = t.service.list()[0]!;
  expect(t.service.list()).toHaveLength(1); expect(t.send).toHaveBeenCalledTimes(1);
  expect(occurrence.packet.instructions).toContain("not the whole story");
  expect(occurrence.packet.instructions).toContain("No separate checkpoint");
  expect(occurrence.authority).toContainEqual(expect.objectContaining({ level: "slice", state: "available" }));
  t.dispose(occurrence.row.qitemId, t.assessment());
  const confirmed = t.projection.get(first.id)!;
  expect(confirmed).toMatchObject({ status: "active", severity: "warning", ceremony: { stage: "confirmed", assessment: { actor: "owner@rig", identityProvenance: "transport:v1" } } });
  expect(confirmed.explanation).toContain("30.0:1");
  expect(t.service.show(occurrence.row.qitemId).finding).toEqual(confirmed);
  expect(t.service.list()[0]!.finding).toEqual(confirmed);
  for (let i = 0; i < 5; i++) await t.service.evaluate("system:health", true);
  expect(t.service.list()).toHaveLength(1); expect(t.send).toHaveBeenCalledTimes(1);
  expect(readFileSync(t.proof)).toEqual(bytes); expect(t.queue.getById("root")!.state).toBe("pending");
});

it("keeps proportionate/high-consequence assessment quiet and unknown progress honestly indeterminate", async () => {
  const t = await setup(); const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  t.dispose(id, t.assessment("indeterminate"));
  expect(t.projection.list().records[0]).toMatchObject({ status: "indeterminate", ceremony: { stage: "indeterminate" } });
  expect(t.projection.list().records[0]!.explanation).not.toContain("30.0:1");
  t.dispose(id, { ...t.assessment(), boundedAuthority: true, boundary: "One consequence-bound operation with a bounded effect and explicit stop conditions" });
  expect(t.projection.list().records).toEqual([]);
  expect(t.projection.list({ status: "cleared" }).records[0]?.ceremony?.stage).toBe("cleared");
  await t.service.evaluate("system:health", true); expect(t.send).toHaveBeenCalledTimes(1);
});

it("small activity never mints a diagnosis; false positive does not invent a denominator", async () => {
  const small = await setup(12); expect(small.projection.list().records).toEqual([]);
  expect((await small.service.evaluate("system:health", true)).actions).toEqual([]);
  const t = await setup(); const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  t.dispose(id, t.assessment("false-positive"));
  const clear = t.projection.list({ status: "cleared" }).records[0]!;
  expect(clear.ceremony?.stage).toBe("cleared"); expect(clear.explanation).toContain("no ratio is computed");
});

it("rejects stale basis, wrong custody, missing refs, duplicate outcomes and invented timestamps", async () => {
  const t = await setup(); const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  const a = t.assessment();
  expect(() => t.dispose(id, a, "peer@rig")).toThrow("owner_required");
  expect(() => t.dispose(id, { ...a, evidenceRefs: ["missing.md"] })).toThrow("evidence_unavailable");
  expect(() => t.dispose(id, { ...a, outcomes: [...a.outcomes, ...a.outcomes] })).toThrow("unique");
  expect(() => t.dispose(id, { ...a, outcomes: [{ ...a.outcomes[0]!, observedAt: "2026-01-01T00:00:00Z" }] })).toThrow("inside");
  writeFileSync(t.proof, "Changed accepted outcome evidence");
  expect(() => t.dispose(id, a)).toThrow("basis_changed");
  t.dispose(id, t.assessment());
  writeFileSync(t.proof, "Evidence changed again");
  expect(t.projection.list().records[0]?.ceremony?.stage).toBe("indeterminate");
  expect(t.projection.list().records[0]!.explanation).not.toContain("30.0:1");
});

it("retains uncertainty and the episode boundary when a false-positive assessment names missing facts", async () => {
  const t = await setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, human: { address: "operator@external", conditions: ["confirmed ceremony"] } }, "operator@rig");
  t.setReady(true);
  const first = t.projection.list().records[0]!;
  const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  const missingFacts = ["A complete product-outcome census for the observed interval"];
  t.dispose(id, { ...t.assessment("false-positive"), missingFacts });
  expect(t.projection.get(first.id)).toMatchObject({ status: "indeterminate", ceremony: { stage: "indeterminate", assessment: { result: { missingFacts } } } });
  expect(t.service.show(id).receipts.filter((r) => r.action === "disposition").at(-1)?.episodeCleared).toBe(false);
  await expect(t.service.notify(id, "owner@rig")).rejects.toThrow("confirmed_active");
  expect(t.readiness).not.toHaveBeenCalled();

  for (let i = 0; i < 20; i++) t.db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES(?,?,?,?)").run("root", `2026-09-05T12:02:${String(i).padStart(2, "0")}.000Z`, "pending", "builder@rig");
  t.time("2026-09-05T12:02:30.000Z");
  expect(t.projection.list().records).toHaveLength(1);
  expect(t.projection.list().records[0]).toMatchObject({ id: first.id, status: "indeterminate" });
  expect(t.projection.get(first.id)?.ceremony?.transitionIds).toHaveLength(50);
  await t.service.evaluate("system:health", true);
  expect(t.service.list()).toHaveLength(1); expect(t.send).toHaveBeenCalledTimes(1);
  expect(t.queue.list({ tag: "health-human" })).toHaveLength(0);

  t.dispose(id, t.assessment("false-positive"));
  expect(t.projection.get(first.id)).toMatchObject({ status: "cleared", ceremony: { stage: "cleared" } });
});

it("neither recursive diagnosis traffic nor prose closures become product progress; old source cannot wake", async () => {
  const t = await setup(); await t.service.evaluate("system:health", true);
  const id = t.service.list()[0]!.row.qitemId;
  for (let i = 0; i < 25; i++) t.queue.update({ qitemId: id, actorSession: "owner@rig", transitionNote: "progress claimed, product shipped" });
  expect(t.projection.list().records).toHaveLength(1);
  expect(t.projection.list().records[0]!.ceremony!.transitionIds).toHaveLength(30);
  t.time("2026-09-05T13:00:00Z");
  expect(t.projection.list().records[0]!.freshness.state).toBe("stale");
  expect((await t.service.evaluate("system:health", true)).actions.every((a) => a.action !== "create" && a.action !== "represent")).toBe(true);
});


it("a later qualifying interval after a cleared assessment gets a new episode; repeated reads keep both identities", async () => {
  const t = await setup(); const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  const first = t.projection.list().records[0]!;
  t.dispose(id, t.assessment("false-positive"));
  for (let i = 0; i < 20; i++) t.db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES(?,?,?,?)").run("root", `2026-09-05T12:02:${String(i).padStart(2, "0")}.000Z`, "pending", "builder@rig");
  t.time("2026-09-05T12:02:30.000Z");
  const next = t.projection.list().records[0]!;
  expect(next.id).not.toBe(first.id); expect(next.ceremony?.transitionIds).toHaveLength(20);
  expect(t.projection.get(first.id)?.status).toBe("cleared");
  expect(t.projection.get(next.id)).toEqual(next);
  await t.service.evaluate("system:health", true); await t.service.evaluate("system:health", true);
  expect(t.service.list()).toHaveLength(2); expect(t.send).toHaveBeenCalledTimes(2);
});

it("confirmed policy sends one human request; suspicion, uncertainty, unavailable readiness and repeated evaluations cannot post", async () => {
  const t = await setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, human: { address: "operator@external", conditions: ["confirmed ceremony"] } }, "operator@rig");
  await t.service.evaluate("system:health", true);
  const id = t.service.list()[0]!.row.qitemId;
  await expect(t.service.notify(id, "owner@rig")).rejects.toThrow("confirmed_active");
  expect(t.readiness).not.toHaveBeenCalled(); expect(t.queue.list({ tag: "health-human" })).toHaveLength(0);
  t.dispose(id, t.assessment("indeterminate"));
  await t.service.evaluate("system:health", true); expect(t.readiness).not.toHaveBeenCalled();
  t.dispose(id, t.assessment());
  const preview = await t.service.evaluate("system:health", false);
  expect(preview.actions.some((a) => a.action === "notify")).toBe(true); expect(t.readiness).not.toHaveBeenCalled();
  await t.service.evaluate("system:health", true);
  expect(t.service.show(id).notificationReadiness?.ready).toBe(false);
  expect(t.queue.list({ tag: "health-human" })).toHaveLength(0);
  const failedCount = t.queue.listTransitions(id).length;
  await t.service.evaluate("system:health", true); expect(t.queue.listTransitions(id)).toHaveLength(failedCount);
  t.setReady(true);
  await Promise.all([t.service.evaluate("system:health", true), t.service.evaluate("system:health", true)]);
  const humans = t.queue.list({ tag: "health-human" }); expect(humans).toHaveLength(1);
  expect(t.service.show(id).humanDelivery?.outcome).not.toBe("posted");
  const checks = t.readiness.mock.calls.length;
  await t.service.evaluate("system:health", true); expect(t.readiness).toHaveBeenCalledTimes(checks);
  const key = `${humans[0]!.qitemId}:${t.queue.transitionLog.latestOwnerNotificationForQitem(humans[0]!.qitemId)!.transitionId}`;
  t.queue.update({ qitemId: humans[0]!.qitemId, actorSession: "connector@fixture", transitionNote: `slack-owner-notification-transport-failed notification_key=${key} error=fixture-offline` });
  expect(t.service.show(id).humanDelivery?.outcome).toBe("transport-failed");
  expect(t.projection.list().records[0]!.ceremony!.transitionIds).toHaveLength(30);
});


it("keeps distinct same-time family identities and refuses a changed transition basis", async () => {
  const t = await setup();
  const first = t.projection.list().records[0]!;
  const id = (await t.service.evaluate("system:health", true)).actions[0]!.qitemId;
  const assessment = t.assessment();
  t.db.prepare("UPDATE queue_transitions SET actor_session = 'corrected@rig' WHERE transition_id = ?").run(first.ceremony!.transitionIds[0]);
  expect(() => t.dispose(id, assessment)).toThrow("basis_changed");
  t.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body) VALUES('independent','2026-09-05T12:00:00.000Z','2026-09-05T12:00:00.000Z','a@rig','b@rig','pending',?, 'same scope, distinct outcome')").run(JSON.stringify(["mission:mission", "slice:slice-1"]));
  for (let i = 0; i < 20; i++) t.db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES('independent',?,'pending','a@rig')").run(`2026-09-05T12:00:${String(i).padStart(2, "0")}.000Z`);
  const records = t.projection.list().records;
  expect(records).toHaveLength(2); expect(new Set(records.map((r) => r.id)).size).toBe(2);
  expect(records.every((r) => r.startedAt === first.startedAt)).toBe(true);
});

it("cannot turn a clipped interval into a complete census or confirmation", async () => {
  const t = await setup();
  t.db.prepare("UPDATE queue_transitions SET ts = '2026-09-01T00:00:00.000Z' WHERE transition_id = 1").run();
  const record = t.projection.list().records[0]!;
  expect(record.status).toBe("indeterminate"); expect(record.ceremony?.stage).toBe("indeterminate");
  expect(record.explanation).toContain("before retained observation window");
  expect((await t.service.evaluate("system:health", true)).actions).toEqual([]);
});


it("includes the typed workflow acceptance join after the queue closure without treating it as an outcome count", async () => {
  const t = await setup();
  t.db.prepare("INSERT INTO workflow_instances(instance_id,workflow_name,workflow_version,created_by_session,created_at) VALUES('run','journey','1','owner@rig','2026-09-05T12:00:00Z')").run();
  const acceptance = { acceptance: { candidate: "exact-candidate", verdict: "CLEAR", evidence_ref: t.proof } };
  t.db.prepare("INSERT INTO workflow_step_trails(trail_id,instance_id,step_id,step_role,closed_at,closure_reason,closure_evidence_json,actor_session,prior_qitem_id) VALUES('trail','run','accept','evaluator','2026-09-05T12:00:29.500Z','done',?,'owner@rig','root')").run(JSON.stringify(acceptance));
  const finding = t.projection.list().records[0]!;
  expect(finding.ceremony?.workflowReceipts).toEqual([{ trailId: "trail", instanceId: "run", stepId: "accept", qitemId: "root", closureReason: "done", actor: "owner@rig", at: "2026-09-05T12:00:29.500Z", evidence: acceptance }]);
  expect(finding.ceremony?.stage).toBe("needs-diagnosis"); expect(finding.explanation).toContain("no ratio is computed");
  expect(finding.lastObservedAt).toBe("2026-09-05T12:00:29.500Z");
});

// Each family is one undelegated row with `n` in-window transitions, in the fixture's slice.
function addFamilies(t: Awaited<ReturnType<typeof setup>>, counts: number[], prefix = "family") {
  const item = t.db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,tags,body) VALUES(?,?,?,'a@rig','b@rig','pending',?,'family')");
  const transition = t.db.prepare("INSERT INTO queue_transitions(qitem_id,ts,state,actor_session) VALUES(?,?,'pending','a@rig')");
  counts.forEach((n, i) => {
    const id = `${prefix}-${String(i).padStart(3, "0")}`;
    item.run(id, "2026-09-05T11:59:00.000Z", "2026-09-05T11:59:00.000Z", JSON.stringify(["mission:mission", "slice:slice-1"]));
    for (let k = 0; k < n; k++) transition.run(id, new Date(Date.parse("2026-09-05T11:59:00.000Z") + k * 1000).toISOString());
  });
}

it("past the family limit evaluates exactly the busiest families and reports the rest as omitted, not healthy", async () => {
  const t = await setup();
  // root has 30 transitions; 198 families have 22; three tie at 21. The limit keeps root,
  // the 198 and the lowest-ID tie, and omits the other two ties.
  addFamilies(t, [...Array<number>(198).fill(22), 21, 21, 21]);
  const read = vi.spyOn(t.queue.transitionLog, "listForQitemWindow");
  const lineages = t.projection.records().map((r) => r.ceremony!.lineageId).sort();
  expect(lineages).toHaveLength(200);
  expect(lineages).toContain("root"); expect(lineages).toContain("family-198");
  expect(lineages).not.toContain("family-199"); expect(lineages).not.toContain("family-200");
  // Omitted families are never read, so nothing about them can be concluded.
  expect(new Set(read.mock.calls.map((c) => c[0]))).toEqual(new Set(lineages));
  expect(t.projection.list({ limit: 200 })).toMatchObject({ total: 200, coverage: [{ source: "passive-ceremony", unit: "handoff families",
    limit: 200, total: 202, evaluated: 200, omitted: 2, partial: true, order: "most queue transitions in the observation window, then lineage ID" }] });
  expect(t.projection.records().map((r) => r.ceremony!.lineageId).sort()).toEqual(lineages);
});

it("at the family limit evaluates every family as before and reports complete coverage", async () => {
  const t = await setup();
  addFamilies(t, [...Array<number>(197).fill(22), 3, 2]);
  expect(t.projection.records().map((r) => r.ceremony!.lineageId)).toHaveLength(198);
  expect(t.projection.list({ limit: 200 }).coverage).toEqual([expect.objectContaining({ total: 200, evaluated: 200, omitted: 0, partial: false })]);
});

it("the scheduled evaluation records partial coverage instead of failing past the family limit", async () => {
  const t = await setup();
  addFamilies(t, Array<number>(201).fill(1));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  t.service.start();
  await vi.advanceTimersByTimeAsync(60000);
  await t.service.stop();
  expect(t.service.status().lastEvaluation).toMatchObject({ error: null,
    coverage: [{ source: "passive-ceremony", total: 202, evaluated: 200, omitted: 2, partial: true }] });
  expect(t.service.list()).toHaveLength(1);
});

it("the scheduled evaluation keeps its own coverage when another health read runs during delivery", async () => {
  const t = await setup();
  addFamilies(t, Array<number>(201).fill(1));
  // A health-list request served while the evaluation awaits delivery replaces the source's latest coverage.
  t.send.mockImplementation(async () => { addFamilies(t, [1, 1, 1], "late"); t.projection.list(); return { ok: true, verified: true }; });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  t.service.start();
  await vi.advanceTimersByTimeAsync(60000);
  await t.service.stop();
  expect(t.send).toHaveBeenCalledTimes(1);
  expect(t.projection.coverage()).toMatchObject([{ total: 205, omitted: 5 }]);
  expect(t.service.status().lastEvaluation).toMatchObject({ error: null, coverage: [{ total: 202, evaluated: 200, omitted: 2, partial: true }] });
});

it("a skipped evaluation reports no coverage, never coverage left by an earlier read", async () => {
  const t = await setup();
  const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: false } }, "operator@rig");
  t.projection.list();
  expect(t.projection.coverage()).toHaveLength(1);
  expect((await t.service.evaluate("system:health", true)).coverage).toBeNull();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  t.service.start();
  await vi.advanceTimersByTimeAsync(60000);
  await t.service.stop();
  expect(t.service.status().lastEvaluation).toMatchObject({ error: null, coverage: null });
});
