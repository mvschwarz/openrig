import { expect, it } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HealthProjectionService, type HealthDetectorObservation, type HealthObservationSource } from "../src/domain/health-detectors.js";
import { readSliceReadiness, recordJudgment } from "../src/domain/proof/judgments.js";
import { attentionRoutes } from "../src/routes/attention.js";
import type { AttentionRead } from "../src/attention-surface.js";
import { WorkflowInstanceStore } from "../src/domain/workflow-instance-store.js";
import { WorkflowStepTrailLog } from "../src/domain/workflow-step-trail-log.js";

function fixture(extraHealth: (health: HealthDetectorObservation) => HealthObservationSource[] = () => []) {
  const root = mkdtempSync(join(tmpdir(), "attention-test-"));
  const write = (file: string, body: object | string) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof body === "string" ? body : YAML.stringify(body)); };
  write(join(root, "workspace.yaml"), { projects: ["a", "b"].map(id => ({ id, root: `./${id}` })) });
  for (const id of ["a", "b"]) {
    write(join(root, id, "project.yaml"), { metadata: { id }, proofPolicy: { judges: ["judge@fixture"] } });
    write(join(root, id, "SPEC.md"), `${id} project source`);
    write(join(root, id, "missions/release/mission.yaml"), { kind: "mission", metadata: { name: "release", status: "active" }, composition: { slices: [{ ref: "slices/01-story/slice.yaml", order: 1, active: true }] } });
    write(join(root, id, "missions/release/SPEC.md"), `${id} mission source`);
    write(join(root, id, "missions/release/slices/01-story/slice.yaml"), { kind: "slice", metadata: { id: "story", status: "active" } });
    write(join(root, id, "missions/release/slices/01-story/SPEC.md"), `# Story\n\n## Proof contract\n- [ ] <!-- proof-item: same-id --> ${id} readers can inspect their draft.\n`);
    write(join(root, id, "missions/release/slices/01-story/proof/evidence.md"), `${id} observed draft`);
  }
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  const queue = new QueueRepository(db, new EventBus(db));
  const at = new Date().toISOString();
  const health: HealthDetectorObservation = { kind: "context-pressure", scope: { type: "instance", instanceId: "fixture" }, episodeKey: "fixture-context", episodeStartedAt: at, lastObservedAt: at, sourceName: "labelled fixture", continuity: null, source: { query: { source: "context-usage", startedAt: at, endedAt: at, limit: 100, retentionSeconds: 600 }, freshness: { state: "fresh", evaluatedAt: at, newestSourceAt: at, maxAgeSeconds: 600, ageSeconds: 0 }, evidence: [{ type: "context-usage", sourceOrder: 1, observedAt: at, nodeId: "fixture", sessionId: "fixture", usedPercentage: 99, available: true, fresh: true }], omitted: { outOfWindow: 0, missingTimestamp: 0, sourceMismatch: 0, truncated: 0, retentionClipped: false } } };
  let healthAvailable = true;
  const service = new HealthProjectionService([{ read: () => { if (!healthAvailable) throw new Error("health fixture unavailable"); return [health, health]; } }, ...extraHealth(health)]);
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("queueRepo" as never, queue as never);
    c.set("healthProjection" as never, service as never);
    c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? root : join(root, "workspace.yaml") }) } as never);
    await next();
  });
  app.route("/api/attention", attentionRoutes());
  const read = async (item?: string): Promise<AttentionRead> => (await app.request(`/api/attention${item ? `?item=${encodeURIComponent(item)}` : ""}`)).json();
  const row = (id: string, destination = "human@kernel", state = "pending", blocked: string | null = null, tier: string | null = null) => {
    db.prepare("INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,priority,body,summary,blocked_on,tier,tags) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(id, at, at, "author@fixture", destination, state, "urgent", `Real request for ${id}`, `Choose ${id}`, blocked, tier, '["project:a"]');
    queue.transitionLog.append({ qitemId: id, state: state as "pending", actorSession: "author@fixture", transitionNote: "Labelled fixture" });
  };
  const judge = (id: string, verdict: "accept" | "withdraw") => {
    const dir = join(root, id, "missions/release/slices/01-story"), item = readSliceReadiness(dir).items[0]!;
    return recordJudgment(join(root, id, "missions"), { scope: "release/slices/01-story", item: item.id, verdict, reason: `${id} independent ${verdict}`, evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null }, "judge@fixture", "labelled fixture");
  };
  return { root, db, queue, read, row, judge, health, service, write, unavailable: () => { healthAvailable = false; } };
}

it("uses real human obligations, source summaries and dependents; excludes agent-only and terminal queue rows", async () => {
  const f = fixture();
  try {
    f.row("decision", "human-founder@external"); f.row("blocker", "agent@fixture", "blocked", "human-reader@external");
    f.row("dependent", "agent@fixture", "blocked", "decision"); f.row("agent-gate", "agent@fixture", "pending", null, "human-gate");
    f.row("ordinary", "agent@fixture", "blocked", "agent@fixture"); f.row("done", "human@kernel", "done");
    f.db.prepare("UPDATE queue_items SET evidence_ref = ? WHERE qitem_id = ?").run(join(f.root, "a/SPEC.md") + "#decision", "decision");
    f.db.prepare("UPDATE queue_items SET human_detail = ? WHERE qitem_id = ?").run("Full supplemental human detail", "decision");
    const before = f.db.serialize();
    const read = await f.read("queue:decision");
    expect(read.items.filter(i => i.kind === "action").map(i => i.id).sort()).toEqual(["queue:blocker", "queue:decision"]);
    expect(read.detail?.item).toMatchObject({ recipient: "human-founder@external", summary: "Choose decision", unblocks: "Choose dependent", project: { id: "a" } });
    expect(read.detail?.lines.join("\n")).toContain("Real request for decision");
    expect(read.detail?.lines.join("\n")).toContain("Full supplemental human detail");
    expect(read.detail?.lines.join("\n")).toContain("Decision route:");
    expect(read.items.find(i => i.id === "queue:blocker")?.recipient).toBe("human-reader@external");
    expect(read.detail?.files[0]?.path).toBe(realpathSync(join(f.root, "a/SPEC.md")) + "#decision");
    expect(read.items.filter(i => i.id.startsWith("health:"))).toHaveLength(1);
    expect(read.items.some(i => i.summary.includes("done"))).toBe(false);
    expect(f.db.serialize()).toEqual(before);
    f.db.prepare("UPDATE queue_items SET state='done' WHERE qitem_id='decision'").run();
    expect((await f.read("queue:decision")).detail?.lines).toContain("State: done");
    expect((await f.read()).items.some(i => i.id === "queue:decision")).toBe(false);
  } finally { f.db.close(); }
});

it("keeps current proof corrections and exact project sources, retained health clears and unavailable states", async () => {
  const f = fixture();
  try {
    f.judge("a", "accept"); f.judge("b", "accept");
    const first = (await f.read()).items.filter(i => i.urgency === "outcome");
    expect(first.map(i => i.project?.id).sort()).toEqual(["a", "b"]);
    const id = first.find(i => i.project?.id === "a")!.id;
    f.judge("a", "withdraw");
    const next = await f.read(id);
    expect(next.items.filter(i => i.id === id)).toHaveLength(1);
    expect(next.detail?.item.summary).toContain("withdrawn");
    const files = next.detail!.files;
    expect(files).toHaveLength(3);
    expect(files.map(f => readFileSync(f.path, "utf8")).join("\n")).toContain("independent withdraw");
    expect(files.every(x => x.path.startsWith(realpathSync(join(f.root, "a"))))).toBe(true);
    const episode = next.items.find(i => i.id.startsWith("health:"))!;
    f.health.source.evidence.push({ type: "context-usage", sourceOrder: 2, observedAt: new Date(Date.parse(f.health.lastObservedAt) + 1000).toISOString(), nodeId: "fixture", sessionId: "fixture", usedPercentage: 20, available: true, fresh: true });
    const cleared = (await f.read()).items.find(i => i.id === episode.id);
    expect(cleared?.summary).toContain("cleared");
    f.unavailable(); f.write(join(f.root, "workspace.yaml"), "projects: [invalid");
    const unavailable = await f.read();
    expect(unavailable.sources.filter(s => s.state === "unavailable").map(s => s.source)).toEqual(expect.arrayContaining(["health", "project catalog"]));
    expect(unavailable.items.some(i => i.id.startsWith("proof:"))).toBe(false);
  } finally { f.db.close(); }
});

it("reports a saturated source query instead of claiming an empty complete feed", async () => {
  const f = fixture();
  try {
    f.row("agent-gate", "agent@fixture", "pending", null, "human-gate");
    const row = f.queue.getById("agent-gate")!;
    f.queue.listAttention = () => Array(1001).fill(row);
    const read = await f.read();
    expect(read.items.filter(i => i.kind === "action")).toEqual([]);
    expect(read.sources.find(s => s.source === "queue")?.state).toBe("partial");
  } finally { f.db.close(); }
});

it("maps attributed mission outcomes to their exact bound project and keeps current workflow state", async () => {
  const f = fixture();
  try {
    const p = realpathSync(join(f.root, "a"));
    const instances = new WorkflowInstanceStore(f.db);
    const instance = instances.create({ workflowName: "mission-release", workflowVersion: "1", createdBySession: "judge@fixture", lifecycle: { operationKey: "fixture", compiledInputDigest: "fixture", binding: { identity: { project: "a", mission: "release" }, sources: [{ kind: "project", path: join(p, "project.yaml") }, { kind: "mission", path: join(p, "missions/release/mission.yaml") }] } } });
    f.row("judgment", "judge@fixture", "done");
    const trail = new WorkflowStepTrailLog(f.db);
    trail.record({ instanceId: instance.instanceId, stepId: "accept-outcome", stepRole: "judge", closureReason: "done", closedAt: new Date().toISOString(), actorSession: "judge@fixture", priorQitemId: "judgment", closureEvidence: { summary: "Edition accepted" } });
    const id = `workflow:${instance.instanceId}`;
    const first = await f.read(id);
    expect(first.detail?.item).toMatchObject({ project: { id: "a", root: p }, kind: "update" });
    expect(first.detail?.item.summary).toContain("workflow active");
    expect(first.detail?.lines.join("\n")).toContain("Edition accepted");
    expect(first.detail?.files[0]?.path).toBe(join(p, "missions/release/mission.yaml"));
    f.db.prepare("UPDATE workflow_instances SET status = 'completed' WHERE instance_id = ?").run(instance.instanceId);
    const completed = await f.read();
    expect(completed.items.filter(i => i.id === id)).toHaveLength(1);
    expect(completed.items.find(i => i.id === id)?.summary).toContain("workflow completed");
  } finally { f.db.close(); }
});


it("carries failed-reader coverage through Attention and retains only missing health items in the TUI", async () => {
  let failed = false;
  const f = fixture(health => [{ name: "passive-reader", read: () => {
    if (failed) throw new Error("fixture_window_unavailable");
    return [{ ...health, episodeKey: "other-episode", scope: { type: "instance", instanceId: "other" } }];
  } }]);
  try {
    const { retainAttentionSources } = await import("../../tui/src/attention/source-continuity.js");
    const { attentionLines } = await import("../../tui/src/attention/attention-model.js");
    const { createViewState, emptySnapshot } = await import("../../tui/src/state.js");
    const first = await f.read();
    expect(first.items.filter(i => i.id.startsWith("health:"))).toHaveLength(2);
    failed = true;
    f.health.lastObservedAt = new Date(Date.parse(f.health.lastObservedAt) + 1000).toISOString();
    f.health.source.evidence.push({ type: "context-usage", sourceOrder: 2, observedAt: f.health.lastObservedAt, nodeId: "fixture", sessionId: "fixture", usedPercentage: 99, available: true, fresh: true });
    const current = await f.read();
    const fresh = current.items.filter(i => i.id.startsWith("health:"));
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.at).toBe(f.health.lastObservedAt);
    expect(current.sources.find(s => s.source === "health")).toMatchObject({ state: "unavailable", detail: expect.stringContaining("passive-reader: unavailable — fixture_window_unavailable") });
    const merged = retainAttentionSources(current, first);
    expect(merged.retained).toBe(true);
    expect(merged.read.items.filter(i => i.id.startsWith("health:"))).toHaveLength(2);
    expect(merged.read.items.find(i => i.id === fresh[0]!.id)).toEqual(fresh[0]);
    const view = createViewState({ instanceId: "fixture" }).get();
    const text = attentionLines(view, { ...emptySnapshot(), attentionRead: merged.read }, 120).map(l => l.text).join(" ");
    expect(text).toContain("feed is incomplete");
    expect(text).toContain("passive-reader: unavailable");
    expect(text).toContain("fixture_window_unavailable");
    const oldDetail = await f.read(fresh[0]!.id);
    const newDetail = { ...oldDetail, detail: { ...oldDetail.detail!, lines: ["New detail from working reader"] } };
    expect(retainAttentionSources(newDetail, oldDetail).read.detail!.lines).toEqual(["New detail from working reader"]);
    failed = false;
    expect((await f.read()).sources.find(s => s.source === "health")?.state).toBe("available");
  } finally { f.db.close(); }
});

it("shows bounded health coverage as partial without reviving items outside a successful window", async () => {
  const f = fixture(() => [{ read: () => [], coverage: () => [{ source: "bounded-reader", evaluatedAt: "fixture", unit: "families", limit: 200, total: 206, evaluated: 200, omitted: 6, partial: true, order: "busiest first" }] }]);
  try {
    const { retainAttentionSources } = await import("../../tui/src/attention/source-continuity.js");
    const { attentionLines } = await import("../../tui/src/attention/attention-model.js");
    const { createViewState, emptySnapshot } = await import("../../tui/src/state.js");
    const current = await f.read();
    expect(current.sources.find(s => s.source === "health")).toMatchObject({ state: "partial", detail: expect.stringContaining("bounded-reader: partial — evaluated 200 of 206 families; 6 omitted") });
    const empty = { ...current, items: [] };
    const merged = retainAttentionSources(empty, current);
    expect(merged.retained).toBe(false);
    expect(merged.read.items).toEqual([]);
    const text = attentionLines(createViewState({ instanceId: "fixture" }).get(), { ...emptySnapshot(), attentionRead: merged.read }, 120).map(l => l.text).join(" ");
    expect(text).toContain("feed is incomplete");
    expect(text).toContain("bounded-reader: partial");
    expect(text).toContain("Unknown: a required source is unavailable or partial.");
  } finally { f.db.close(); }
});
