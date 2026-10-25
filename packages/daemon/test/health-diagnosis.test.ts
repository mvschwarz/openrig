import { delegatedPostureFixture } from "./helpers/delegated-posture.js";
import { mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { HealthPolicyStore } from "../src/domain/health-policy.js";
import { HealthDiagnosisService } from "../src/domain/health-diagnosis.js";
import { HealthProjectionService, type HealthDetectorObservation } from "../src/domain/health-detectors.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { adaptQueueTransitionEvidence, boundHealthEvidence, deriveHealthSourceFreshness } from "../src/domain/health-projection.js";
import { HealthCheckpointSource, type HealthCheckpoint } from "../src/domain/health-checkpoints.js";
import { Hono } from "hono";
import { healthDiagnosisRoutes } from "../src/routes/health-diagnosis.js";
import { healthAuthority } from "../src/domain/health-context.js";
import { healthRoutes } from "../src/routes/health.js";

const cleanup: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach((f) => f()); });

function setup() {
  const home = mkdtempSync(join(tmpdir(), "health-diagnosis-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const db = createDb();
  // Receipt tests need migration 076; the shared "full" fixture intentionally omits it.
  migrate(db, ALL_MIGRATIONS);
  cleanup.push(() => db.close());
  const queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [
    { entityId: "operator", class: "human", displayName: "Fixture operator", address: "operator@external", connectorBindings: [{ kind: "slack", connectorRef: "fixture", secretsRef: "fixture", role: "primary" }], prefs: { deliveryClass: "A" } },
  ] }) });
  let now = "2026-09-05T21:00:00.000Z";
  const policy = new HealthPolicyStore(home, () => ({ warningPercent: 95, criticalPercent: 99 }));
  const evidence = [adaptQueueTransitionEvidence({ transitionId: 1, qitemId: "lineage", ts: now, state: "in-progress", actorSession: "owner@rig", identityProvenance: "transport:v1" }, 0)];
  const observation = {
    kind: "coordination-lineage" as const, scope: { type: "rig" as const, rigId: "rig" },
    episodeStartedAt: now, lastObservedAt: now, lineageId: "lineage",
    coordinationTransitions: 257, productStateChanges: 0, boundedAuthority: false,
    reviewReturns: 0, candidateChanges: 0, newRiskClasses: 0,
    source: boundHealthEvidence(evidence, { source: "mixed", startedAt: now, endedAt: now, limit: 200, retentionSeconds: 86400 }, deriveHealthSourceFreshness({ evaluatedAt: now, newestSourceAt: now, maxAgeSeconds: 600, available: true })),
  };
  const projection = new HealthProjectionService({ read: () => [observation] }, () => policy.read(), delegatedPostureFixture);
  const service = new HealthDiagnosisService({ queue, projection, policy, now: () => now, authority: () => [{ path: "project/SPEC.md", state: "unavailable" as const }] });
  return { home, db, queue, policy, projection, service, observation, tick: (value: string) => { now = value; } };
}

it("previews without writes, then persists one non-exhaustive occurrence across repeat/concurrent evaluation", async () => {
  const t = setup();
  const policy = t.policy.read().policy;
  t.policy.apply({ ...policy, diagnosis: { ...policy.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  const preview = await t.service.evaluate("actor@rig", false);
  expect(preview.actions[0]?.action).toBe("create");
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  await Promise.all([t.service.evaluate("actor@rig", true), t.service.evaluate("actor@rig", true)]);
  const rows = t.queue.list({ destinationSession: "owner@rig", limit: 1000 });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.body).toContain("not the whole story");
  expect(rows[0]!.body).toContain("your own contribution");
  expect(rows[0]!.body).toContain(t.projection.list().records[0]!.id);
  expect(t.service.show(rows[0]!.qitemId).disposition).toBeNull();
});

it("ignores a canceled topical Markdown receipt in the census and scheduled evaluation without changing it", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-05T21:00:00Z"));
  const t = setup(); const p = t.policy.read().policy;
  const foreignId = "qitem-xh-1d22fe73dfa8f0e1";
  await t.queue.create({ qitemId: foreignId, sourceSession: "peer@rig", destinationSession: "owner@rig", nudge: false,
    body: "# OpenRig 0.5.10 Slice 09 Founder-Visible Dogfood Receipt\n\nOrdinary cross-host receipt, not a typed occurrence.",
    tags: ["slice-09", "dogfood", "health-diagnosis", "cross-host"] });
  t.queue.update({ qitemId: foreignId, state: "canceled", actorSession: "peer@rig" });
  const foreign = t.queue.getById(foreignId); const transitions = t.queue.listTransitions(foreignId);
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  expect(t.service.list()).toEqual([]);
  expect(() => t.service.show(foreignId)).toThrow("health_diagnosis_not_found");
  const app = new Hono(); app.use("*", async (c, next) => { c.set("healthDiagnosis" as never, t.service); await next(); });
  app.route("/api/health-diagnosis", healthDiagnosisRoutes());
  expect(await (await app.request("/api/health-diagnosis")).json()).toEqual([]);
  const refusal = await app.request(`/api/health-diagnosis/${foreignId}`);
  expect(refusal.status).toBe(400);
  expect(await refusal.json()).toMatchObject({ message: "health_diagnosis_not_found" });
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);

  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  t.service.start();
  try { await vi.advanceTimersByTimeAsync(60000); } finally { await t.service.stop(); }
  expect(t.service.status().lastEvaluation?.error).toBeNull();
  const id = `qitem-health-diagnosis-${t.projection.list().records[0]!.id}`;
  expect(t.service.list().map((o) => o.row.qitemId)).toEqual([id]);
  await t.service.evaluate("actor@rig", true);
  expect(t.service.list().map((o) => o.row.qitemId)).toEqual([id]);
  expect(t.queue.getById(foreignId)).toEqual(foreign);
  expect(t.queue.listTransitions(foreignId)).toEqual(transitions);
});

it("reads the census without projecting non-owned topical rows, and still refuses a full census before ownership", async () => {
  const t = setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  const id = (await t.service.evaluate("actor@rig", true)).actions[0]!.qitemId;
  // A topical row (not an occurrence) whose unrelated structured field is malformed: only a full row projection reads it.
  const foreign = await t.queue.create({ sourceSession: "peer@rig", destinationSession: "owner@rig", nudge: false,
    body: "topical note", tags: ["health-diagnosis"] });
  t.db.prepare("UPDATE queue_items SET chain_of_record = ? WHERE qitem_id = ?").run("{not json", foreign.qitemId);
  expect(t.service.list().map((o) => o.row.qitemId)).toEqual([id]);

  // Exactly 10000 tagged rows refuses the census even though none of the extra rows is owned.
  const insert = t.db.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, tags)
    VALUES (?, ?, ?, 'peer@rig', 'owner@rig', 'done', 'x', '["health-diagnosis"]')`);
  t.db.transaction(() => { for (let i = 0; i < 9998; i++) insert.run(`qitem-topical-${i}`, "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z"); })();
  expect(() => t.service.list()).toThrow("health_diagnosis_census_truncated");
});

it.each(["markdown", "null", "schema", "finding-id", "authority", "presentedAt"])("refuses corrupt owned occurrence state (%s) instead of hiding or certifying it", async (defect) => {
  const t = setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  const id = (await t.service.evaluate("actor@rig", true)).actions[0]!.qitemId;
  const packet = JSON.parse(t.queue.getById(id)!.body);
  if (defect === "schema") packet.schema = "unrelated/v1";
  if (defect === "finding-id") packet.finding.id = "health-other";
  if (defect === "authority") delete packet.authority;
  if (defect === "presentedAt") packet.presentedAt = "unknown";
  const body = defect === "markdown" ? "# Broken owned packet" : defect === "null" ? "null" : JSON.stringify(packet);
  t.db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run(body, id);
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  expect(() => t.service.show(id)).toThrow(`health_diagnosis_invalid_packet: ${id}`);
  expect(() => t.service.list()).toThrow(`health_diagnosis_invalid_packet: ${id}`);
  await expect(t.service.evaluate("actor@rig", true)).rejects.toThrow(`health_diagnosis_invalid_packet: ${id}`);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
});

it("preserves honest dispositions and never edits the source work or manufactures a resolution", async () => {
  const t = setup();
  const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  const result = await t.service.evaluate("actor@rig", true);
  const id = result.actions[0]!.qitemId;
  const before = t.queue.getById(id)!;
  t.service.dispose(id, "owner@rig", { verdict: "insufficient evidence", causalStart: null, steering: "Inspect product checkpoints", uncertainty: "Admission authority unavailable", evidenceRefs: ["project/SPEC.md"] });
  expect(t.service.show(id).disposition?.verdict).toBe("insufficient evidence");
  expect(t.queue.getById(id)!.state).toBe(before.state);
  t.observation.boundedAuthority = true;
  expect((await t.service.evaluate("actor@rig", true)).actions).toHaveLength(0);
  expect(t.service.show(id).disposition?.verdict).toBe("insufficient evidence");
});

it("re-presents the same occurrence once after cooldown, survives service restart, and stops after disposition", async () => {
  const t = setup(); const p = t.policy.read().policy;
  const send = vi.fn(async () => ({ ok: true, verified: false }));
  t.queue.attachTransport({ send });
  t.policy.apply({ ...p, freshnessSeconds: 86400, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", cooldownSeconds: 60 } }, "actor@rig");
  const first = await t.service.evaluate("actor@rig", true);
  t.tick("2026-09-05T21:01:01Z");
  const service = new HealthDiagnosisService({ queue: t.queue, projection: t.projection, policy: t.policy, now: () => "2026-09-05T21:01:01Z", authority: () => [] });
  const again = await service.evaluate("actor@rig", true);
  expect(again.actions[0]).toMatchObject({ action: "represent", qitemId: first.actions[0]!.qitemId });
  t.tick("2026-09-05T22:00:00Z");
  expect((await t.service.evaluate("actor@rig", true)).actions[0]!.action).toBe("retained");
  expect(t.queue.list({ limit: 100 })).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(2);
  expect(t.queue.getById(first.actions[0]!.qitemId)!.lastNudgeResult).toBe("delivered-ack-pending");
});

it("policy changes are versioned and audited, invalid or replayed changes write nothing", () => {
  const t = setup(); const original = t.policy.read();
  const next = { ...original.policy, thresholds: { ...original.policy.thresholds, ceremonyRatio: 1000 } };
  const changed = t.policy.apply(next, "editor@rig");
  expect(changed.version).not.toBe(original.version);
  expect(t.projection.list().records).toHaveLength(0);
  const files = readdirSync(join(t.home, "health", "policy-history"));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(t.home, "health", "policy-history", files[0]!), "utf8")).toContain("editor@rig");
  t.policy.apply(next, "editor@rig");
  expect(() => t.policy.apply({ ...next, diagnosis: { ...next.diagnosis, cooldownSeconds: 0 } }, "editor@rig")).toThrow();
  expect(readdirSync(join(t.home, "health", "policy-history"))).toEqual(files);
});

async function checkpointSetup() {
  const t = setup(); let now = "2026-09-04T04:51:31.138Z";
  // Synthetic lifecycle mechanics, not a historical product-outcome calibration.
  const subject = { lineage: "synthetic-reminder-lineage", scope: { type: "rig" as const, rigId: "fixture" },
    window: { startedAt: "2026-09-04T04:00:00.000Z" },
    autoUnparks: Array.from({ length: 52 }, (_, i) => ({ transitionId: 100000 + i, observedAt: new Date(Date.parse("2026-09-04T04:00:00.000Z") + i * 60000).toISOString() })) };
  const row = await t.queue.create({ qitemId: subject.lineage, sourceSession: "actor@rig", destinationSession: "owner@rig", body: "synthetic replay lineage", nudge: false });
  // Each transition is explicit; the source must verify the complete census.
  const insert = t.db.prepare("INSERT INTO queue_transitions(transition_id,qitem_id,ts,state,actor_session) VALUES(?,?,?,?,?)");
  for (const event of subject.autoUnparks) insert.run(event.transitionId, row.qitemId, event.observedAt, "pending", "watchdog");
  const workspace = join(t.home, "workspace"); mkdirSync(workspace);
  const evidencePath = join(workspace, "synthetic-census.json");
  writeFileSync(evidencePath, JSON.stringify({ synthetic: true, outcomes: ["closure"], expectation: "One bounded outcome check", boundedAuthority: false }));
  const cp: HealthCheckpoint = { schema: "openrig.health-checkpoint/v0alpha1", lineageQitemId: row.qitemId, scope: subject.scope,
    startedAt: subject.window.startedAt, observedAt: now, transitionIds: subject.autoUnparks.map((x: { transitionId: number }) => x.transitionId),
    productOutcomes: [{ id: "closure", observedAt: now, evidenceRef: evidencePath }],
    productCensusRef: evidencePath, sdlc: { expectation: "Keep the graph moving; wait on named live boundaries", evidenceRef: evidencePath }, boundedAuthority: { applies: false, evidenceRef: evidencePath },
    authorityPaths: { project: [], mission: [], slice: [] } };
  const source = new HealthCheckpointSource(t.home, t.queue, t.policy, () => now);
  const projection = new HealthProjectionService(source, () => t.policy.read(), delegatedPostureFixture);
  const service = new HealthDiagnosisService({ queue: t.queue, projection, policy: t.policy, now: () => now, authority: () => [] });
  return { ...t, source, projection, service, cp, time: (value: string) => { now = value; } };
}

it("drives synthetic checkpoint ingestion, clear and recurrence without a wake storm", async () => {
  const t = await checkpointSetup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", cooldownSeconds: 60 } }, "actor@rig");
  t.source.submit(t.cp, "author@rig");
  const first = t.projection.list().records[0]!;
  expect(first.status).toBe("active");
  expect(first.explanation).toContain("52 coordination transitions for 1 product-state change");
  const changes = t.db.prepare("SELECT total_changes() AS n").get();
  t.projection.list(); t.projection.get(first.id);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(changes);
  await t.service.evaluate("actor@rig", true); await t.service.evaluate("actor@rig", true);
  expect(t.service.list()).toHaveLength(1);
  t.time("2026-09-04T04:52:00Z");
  t.source.submit({ ...t.cp, observedAt: "2026-09-04T04:52:00Z" }, "author@rig");
  expect(t.projection.list().records[0]!.id).toBe(first.id);
  t.time("2026-09-04T04:53:00Z");
  t.source.submit({ ...t.cp, observedAt: "2026-09-04T04:53:00Z", boundedAuthority: { applies: true, evidenceRef: t.cp.boundedAuthority.evidenceRef } }, "author@rig");
  expect(t.projection.get(first.id)?.status).toBe("cleared");
  await t.service.evaluate("actor@rig", true);
  const transitions = t.queue.listTransitions(`qitem-health-diagnosis-${first.id}`).length;
  await t.service.evaluate("actor@rig", true);
  expect(t.queue.listTransitions(`qitem-health-diagnosis-${first.id}`)).toHaveLength(transitions);
  t.time("2026-09-04T04:54:00Z");
  t.source.submit({ ...t.cp, observedAt: "2026-09-04T04:54:00Z" }, "author@rig");
  expect(t.projection.list().records[0]!.id).not.toBe(first.id);
  await t.service.evaluate("actor@rig", true);
  expect(t.service.list()).toHaveLength(2);
});

it("rejects partial/mixed-lineage censuses; unknown authority and stale evidence cannot admit diagnosis", async () => {
  const t = await checkpointSetup();
  expect(() => t.source.submit({ ...t.cp, transitionIds: t.cp.transitionIds.slice(1) }, "author@rig")).toThrow("census");
  expect(t.source.entries()).toHaveLength(0);
  t.source.submit({ ...t.cp, boundedAuthority: { applies: null, evidenceRef: "unavailable" } }, "author@rig");
  expect(t.projection.list().records[0]!.status).toBe("indeterminate");
  t.time("2026-09-04T06:00:00Z");
  expect(t.projection.list().records[0]!.status).toBe("indeterminate");
  expect((await t.service.evaluate("actor@rig", true)).actions).toHaveLength(0);
});

it("serves the real routes with no GET writes and rejects incomplete dispositions", async () => {
  const t = await checkpointSetup();
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("healthProjection" as never, t.projection); c.set("healthDiagnosis" as never, t.service);
    c.set("healthPolicy" as never, t.policy); c.set("healthCheckpoints" as never, t.source); await next();
  });
  app.route("/api/health", healthRoutes()); app.route("/api/health-diagnosis", healthDiagnosisRoutes());
  const post = (path: string, body: unknown) => app.request(`/api/health-diagnosis/${path}`, { method: "POST", headers: { "x-openrig-session": "actor@rig", "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("checkpoints", { value: t.cp })).status).toBe(200);
  const p = t.policy.read().policy;
  expect((await post("policy", { value: { ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } } })).status).toBe(200);
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  for (const path of ["/api/health", "/api/health-diagnosis/policy", "/api/health-diagnosis/checkpoints", "/api/health-diagnosis"]) expect((await app.request(path)).status).toBe(200);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  const result = await (await post("evaluate", { apply: true })).json();
  const id = result.actions[0].qitemId;
  expect((await post(`${id}/disposition`, { value: { verdict: "resolved" } })).status).toBe(400);
  expect((await post(`${id}/notify`, {})).status).toBe(400);
  expect(t.service.list()).toHaveLength(1);
});

it("a hundred context episodes remain low-priority and opt-in admission is still bounded per owner", async () => {
  const t = setup(); let cleared = false; const at = "2026-09-05T21:00:00.000Z";
  const source = { read: (): HealthDetectorObservation[] => Array.from({ length: 100 }, (_, i) => {
    const sample = { type: "context-usage" as const, nodeId: `seat-${i}`, sessionId: `occupant-${i}`, observedAt: at, sourceOrder: 0, usedPercentage: 96, available: true, fresh: true };
    return { kind: "context-pressure", sourceName: "native", continuity: "same-occupant", scope: { type: "seat", rigId: "rig", seatId: `seat-${i}` }, episodeStartedAt: at, lastObservedAt: at,
      source: boundHealthEvidence(cleared ? [sample, { ...sample, sourceOrder: 1, usedPercentage: 30 }] : [sample], { source: "context-usage", startedAt: at, endedAt: at, limit: 3, retentionSeconds: 86400 }, deriveHealthSourceFreshness({ evaluatedAt: at, newestSourceAt: at, maxAgeSeconds: 600, available: true })) };
  }) };
  const projection = new HealthProjectionService(source, () => t.policy.read(), delegatedPostureFixture);
  const service = new HealthDiagnosisService({ queue: t.queue, projection, policy: t.policy, now: () => at, authority: () => [] });
  const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  expect(projection.list().total).toBe(100);
  expect((await service.evaluate("actor@rig", true)).actions).toHaveLength(0);
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", detectors: ["context.pressure"] } }, "actor@rig");
  await Promise.all([service.evaluate("actor@rig", true), service.evaluate("actor@rig", true)]);
  expect(service.list()).toHaveLength(1);
  cleared = true;
  expect(projection.list().total).toBe(0);
  expect(projection.list({ status: "cleared" }).total).toBe(100);
  await service.evaluate("actor@rig", true);
  expect(service.list()).toHaveLength(1);
  expect(service.list()[0]!.finding.status).toBe("cleared");
});

it("human escalation requires both an admitted agent disposition and ready delivery, with one durable request", async () => {
  const t = setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" }, human: { address: "operator@external", conditions: ["established pathology"] } }, "actor@rig");
  const id = (await t.service.evaluate("actor@rig", true)).actions[0]!.qitemId;
  let ready = false;
  const readiness = vi.fn(async () => ({ ready, reason: "fixture readiness" }));
  const service = new HealthDiagnosisService({ queue: t.queue, projection: t.projection, policy: t.policy, authority: () => [], humanReadiness: readiness });
  await expect(service.notify(id, "owner@rig")).rejects.toThrow("policy");
  expect(readiness).not.toHaveBeenCalled();
  service.dispose(id, "owner@rig", { verdict: "established pathology", causalStart: "fixture:initial-reminder", steering: "Retire stale directive at next boundary", uncertainty: "Fixture evidence only", evidenceRefs: ["fixture:stale-conductor"] });
  await expect(service.notify(id, "owner@rig")).rejects.toThrow("readiness");
  expect(t.queue.list({ limit: 100 })).toHaveLength(1);
  ready = true;
  const first = await service.notify(id, "owner@rig");
  const second = await service.notify(id, "owner@rig");
  expect(second.qitemId).toBe(first.qitemId);
  // Selected for the person by the health policy: an alert, not only a place on Steering.
  expect(t.queue.transitionLog.latestOwnerNotificationForQitem(first.qitemId)).toMatchObject({ ownerNotificationKind: "human-required", ownerNotificationLevel: "ALERT" });
  expect(first.deliveryOutcome).not.toBe("posted");
  expect(t.queue.list({ limit: 100 })).toHaveLength(2);
  const key = `${first.qitemId}:${t.queue.transitionLog.latestOwnerNotificationForQitem(first.qitemId)!.transitionId}`;
  t.queue.update({ qitemId: first.qitemId, actorSession: "connector@fixture", transitionNote: `slack-owner-notification-transport-failed notification_key=${key} error=fixture-offline` });
  expect(service.show(id).humanDelivery?.outcome).toBe("transport-failed");
  t.queue.update({ qitemId: first.qitemId, actorSession: "connector@fixture", transitionNote: `slack-owner-notification-posted notification_key=${key} message_ts=fixture-1` });
  expect(service.show(id).humanDelivery?.outcome).toBe("posted");
});

it("automatically evaluates enabled policy, never sends a human notification, and stops cleanly", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-05T21:00:00Z"));
  const t = setup(); const p = t.policy.read().policy;
  t.service.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.queue.list()).toHaveLength(0);
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.queue.list()).toHaveLength(1);
  expect(t.service.status().lastEvaluation?.error).toBeNull();
  await t.service.stop();
  expect(t.service.status().scheduled).toBe(false);
  await vi.advanceTimersByTimeAsync(60000);
  expect(t.queue.list()).toHaveLength(1);
});

it("policy threshold changes immediately reevaluate the structured source with the displayed version", async () => {
  const t = await checkpointSetup(); const p = t.policy.read().policy;
  t.source.submit(t.cp, "author@rig");
  const id = t.projection.list().records[0]!.id;
  t.policy.apply({ ...p, thresholds: { ...p.thresholds, ceremonyRatio: 100 } }, "actor@rig");
  expect(t.projection.list().records).toHaveLength(0);
  expect(t.projection.get(id)?.status).toBe("cleared");
  t.policy.apply(p, "actor@rig");
  expect(t.projection.list().records[0]!.policyVersion).toBe(t.policy.read().version);
});


it("requires occurrence custody before disposition or human effects and retains route identity provenance", async () => {
  const t = setup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, freshnessSeconds: 86400, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig", cooldownSeconds: 60 }, human: { address: "operator@external", conditions: ["established pathology"] } }, "actor@rig");
  const readiness = vi.fn(async () => ({ ready: true, reason: "fixture" }));
  const service = new HealthDiagnosisService({ queue: t.queue, projection: t.projection, policy: t.policy, now: () => "2026-09-05T21:01:01Z", authority: () => [], humanReadiness: readiness });
  const id = (await t.service.evaluate("actor@rig", true)).actions[0]!.qitemId;
  const app = new Hono(); app.use("*", async (c, next) => { c.set("healthDiagnosis" as never, service); await next(); });
  app.route("/api/health-diagnosis", healthDiagnosisRoutes());
  const disposition = { verdict: "established pathology", causalStart: null, steering: "Inspect", uncertainty: "Fixture", evidenceRefs: ["fixture"] };
  const post = (action: string, actor: string) => app.request(`/api/health-diagnosis/${id}/${action}`, { method: "POST", headers: { "x-openrig-session": actor, "content-type": "application/json" }, body: JSON.stringify({ actor: "owner@rig", value: disposition }) });
  const before = t.db.prepare("SELECT total_changes() AS n").get();
  expect((await post("disposition", "peer@rig")).status).toBe(400);
  expect((await post("notify", "peer@rig")).status).toBe(400);
  expect(readiness).not.toHaveBeenCalled();
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
  expect(service.show(id).disposition).toBeNull();
  expect((await service.evaluate("system:health", true)).actions[0]!.action).toBe("represent");
  expect((await post("disposition", "owner@rig")).status).toBe(200);
  expect(t.queue.listTransitions(id).at(-1)).toMatchObject({ actorSession: "owner@rig", identityProvenance: "transport:v1" });
  const unchanged = t.db.prepare("SELECT total_changes() AS n").get();
  expect((await post("disposition", "peer@rig")).status).toBe(400); // identical replay is still an owner action
  expect((await post("notify", "peer@rig")).status).toBe(400);
  expect(t.db.prepare("SELECT total_changes() AS n").get()).toEqual(unchanged);
  expect((await post("notify", "owner@rig")).status).toBe(200);
  expect(readiness).toHaveBeenCalledTimes(1);
  const human = t.queue.list({ tag: "health-human" })[0]!;
  expect(t.queue.listTransitions(human.qitemId)[0]).toMatchObject({ actorSession: "owner@rig", identityProvenance: "transport:v1" });
});

it("keeps unresolved checkpoint evidence indeterminate and never admits a diagnostic row", async () => {
  for (const field of ["census", "authority", "outcome"]) {
    const t = await checkpointSetup(); const cp = structuredClone(t.cp);
    const p = t.policy.read().policy;
    t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
    if (field === "census") cp.productCensusRef = "missing-census.md";
    if (field === "authority") cp.boundedAuthority.evidenceRef = "missing-authority.md";
    if (field === "outcome") cp.productOutcomes[0]!.evidenceRef = "missing-outcome.md";
    t.source.submit(cp, "author@rig");
    expect(t.source.entries()[0]!.checkpoint).toEqual(cp);
    expect(t.projection.list().records[0]!.status).toBe("indeterminate");
    expect((await t.service.evaluate("actor@rig", true)).actions).toHaveLength(0);
    expect(t.service.list()).toHaveLength(0);
  }
});

it("embeds only canonical authority files with contained real paths", async () => {
  const t = await checkpointSetup(); const workspace = join(t.home, "workspace");
  mkdirSync(workspace, { recursive: true });
  const outside = join(t.home, "outside.yaml"); writeFileSync(outside, "outside-marker");
  const arbitrary = join(workspace, "other.yaml"); writeFileSync(arbitrary, "arbitrary-marker");
  const spec = join(workspace, "SPEC.md"); writeFileSync(spec, "# Project authority");
  symlinkSync(outside, join(workspace, "project.yaml"));
  const mission = join(workspace, "missions", "release-0.5.9"); mkdirSync(mission, { recursive: true });
  symlinkSync(outside, join(mission, "SPEC.md"));
  t.source.submit({ ...t.cp, authorityPaths: { project: [outside, arbitrary, spec], mission: [join(mission, "SPEC.md")], slice: [] } }, "author@rig");
  const record = t.projection.list().records[0]!;
  const authority = healthAuthority(workspace, t.source, record);
  expect(authority.find((a) => a.path === spec)).toMatchObject({ state: "available", content: "# Project authority" });
  for (const path of [outside, arbitrary, join(workspace, "project.yaml"), join(mission, "SPEC.md")]) {
    expect(authority.find((a) => a.path === path)).toMatchObject({ state: "unavailable" });
  }
  expect(JSON.stringify(authority)).not.toContain("outside-marker");
  expect(JSON.stringify(authority)).not.toContain("arbitrary-marker");
});


it("rechecks evidence availability after submission and refuses empty, non-file and escaped evidence", async () => {
  const t = await checkpointSetup(); const p = t.policy.read().policy;
  t.policy.apply({ ...p, diagnosis: { ...p.diagnosis, enabled: true, owner: "owner@rig" } }, "actor@rig");
  t.source.submit(t.cp, "author@rig");
  expect(t.projection.list().records[0]!.status).toBe("active");
  const evidence = t.cp.productCensusRef;
  for (const state of ["empty", "directory", "symlink", "missing"]) {
    rmSync(evidence, { force: true, recursive: true });
    if (state === "empty") writeFileSync(evidence, "");
    if (state === "directory") mkdirSync(evidence);
    if (state === "symlink") { const outside = join(t.home, "outside-evidence.md"); writeFileSync(outside, "Unapproved evidence"); symlinkSync(outside, evidence); }
    expect(t.projection.list().records[0]!.status).toBe("indeterminate");
    expect((await t.service.evaluate("actor@rig", true)).actions).toHaveLength(0);
    expect(t.service.list()).toHaveLength(0);
  }
});


it("binds authority categories and slice IDs to the finding scope", async () => {
  const t = await checkpointSetup(); const workspace = join(t.home, "workspace");
  const write = (path: string, content: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); return path; };
  const project = write(join(workspace, "SPEC.md"), "# Current project");
  const mission = write(join(workspace, "missions/current/SPEC.md"), "# Current mission");
  const missionYaml = write(join(workspace, "missions/current/mission.yaml"), "metadata: {name: current}");
  const spec = write(join(workspace, "missions/current/slices/09-current/SPEC.md"), "---\nid: OPR.9\nmission: current\n---\n# Current slice");
  const yaml = write(join(workspace, "missions/current/slices/09-current/slice.yaml"), "schema: openrig.slice/v0alpha1");
  const otherMission = write(join(workspace, "missions/other/SPEC.md"), "# Unrelated mission marker");
  const sibling = write(join(workspace, "missions/current/slices/08-sibling/SPEC.md"), "---\nid: OPR.8\n---\n# Sibling marker");
  const missingId = write(join(workspace, "missions/current/slices/OPR.9/SPEC.md"), "# Directory name is not a declared ID marker");
  const malformed = write(join(workspace, "missions/current/slices/malformed/SPEC.md"), "---\nid: [broken\n---\n# Malformed marker");
  const cp = { ...t.cp, scope: { type: "slice" as const, projectId: "project", missionId: "current", sliceId: "OPR.9" },
    authorityPaths: { project: [project, mission], mission: [mission, otherMission, spec], slice: [spec, yaml, mission, otherMission, sibling, missingId, malformed] } };
  t.source.submit(cp, "author@rig");
  const finding = t.projection.list().records[0]!;
  const results = healthAuthority(workspace, t.source, finding);
  expect(results.find((a) => a.path === otherMission)).toMatchObject({ state: "unavailable" });
  // Scope category stays observable when a path is submitted at two different levels.
  const entry = (level: string, path: string) => results.find((a) => (a as { level?: string }).level === level && a.path === path);
  for (const [level, path] of [["project", project], ["mission", mission], ["mission", missionYaml], ["slice", spec], ["slice", yaml]]) expect(entry(level!, path!)).toMatchObject({ state: "available" });
  for (const [level, path] of [["project", mission], ["mission", spec], ["mission", otherMission], ["slice", mission], ["slice", otherMission], ["slice", sibling], ["slice", missingId], ["slice", malformed]]) expect(entry(level!, path!)).toMatchObject({ state: "unavailable" });
  for (const marker of ["Unrelated mission marker", "Sibling marker", "declared ID marker", "Malformed marker"]) expect(JSON.stringify(results)).not.toContain(marker);
  write(spec, "---\nid: OPR.8\nmission: current\n---\n# Changed identity marker");
  const changed = healthAuthority(workspace, t.source, finding);
  expect(changed.find((a) => a.path === yaml)).toMatchObject({ state: "unavailable" });
  expect(JSON.stringify(changed)).not.toContain("Changed identity marker");
  const unscoped = healthAuthority(workspace, t.source, { ...finding, scope: { type: "rig", rigId: "rig" } });
  expect(unscoped.filter((a) => (a as { level?: string }).level !== "project").every((a) => a.state === "unavailable")).toBe(true);
});
