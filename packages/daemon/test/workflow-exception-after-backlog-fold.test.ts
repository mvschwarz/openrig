// #2988: the stuck sweep folds an open per-row unclaimed finding into a delegation parent's standing notice and closes it.
// Every recovery lookup then skips that folded finding, as if the row never had one. A stuck workflow packet sitting
// unclaimed in such a row still gets its workflow exception item, under an id of its own: the folded finding holds the
// id recoveryId gives the packet's episode without owning it, so reusing that id would collide with it (a different
// destination or source is refused as id reuse; the same ones would hand back the folded, closed row as if just created).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { runWorkflowBootSweep } from "../src/domain/workflow-boot-sweep.js";
import { WatchdogJobsRepository } from "../src/domain/watchdog-jobs-repository.js";
import { makeEnsureStuckExceptionItem } from "../src/domain/workflow-exception-escalation.js";
import { WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS } from "../src/domain/workflow-deadline.js";
import { runStuckSweep, createStuckSweepStatus, STUCK_SWEEP_FINDING_TAG, findingDedupTag, BACKLOG_FOLDED_TAG } from "../src/domain/queue-stuck-sweep.js";
import { recoveryId, recoveryTag } from "../src/domain/queue-recovery.js";

const spec = (orch: string) => `workflow:
  id: wf-fold
  version: 1
  objective: fold
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - dev1@lane
    orch:
      preferred_targets:
        - ${orch}
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
        - waiting
  exception_routing:
    orchestrator_role: orch
`;

describe("workflow exception for a packet whose per-row finding was folded (#2988)", () => {
  let db: Database.Database;
  let rigs: RigRepository;
  let queue: QueueRepository;
  let tmp: string;
  let bus: EventBus;
  let seq = 0;
  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    rigs = new RigRepository(db);
    bus = new EventBus(db);
    queue = new QueueRepository(db, bus, { validateRig: () => true, loadHumanRegistry: () => ({ ok: true, entities: [] }) });
    queue.attachOutbox(new OutboxHandler(db));
    tmp = mkdtempSync(join(tmpdir(), "wf-exc-fold-"));
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });
  function seat(rigName: string, logicalId: string, session: string) {
    const rig = rigs.listRigs().find((r) => r.name === rigName) ?? rigs.createRig(rigName);
    const node = rigs.addNode(rig.id, logicalId, { runtime: "claude-code" });
    db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES (?,?,?,?)").run(`session-${++seq}`, node.id, session, "running");
    return { rig, node, session };
  }
  const sweep = () => runStuckSweep({ db, queueRepo: queue, status: createStuckSweepStatus(), unclaimedAgeMinutes: 60, log: () => {},
    isRegisteredHost: () => false, resolveRecoveryAgentSeat: () => null, resolveOperatorSeat: () => null });

  async function setup(orch: string, legacy: boolean) {
    const parent = seat("lane", "coord.owner", "owner@lane");
    const kid = seat("lane", "pool.dev1", "dev1@lane");
    rigs.addEdge(parent.rig.id, parent.node.id, kid.node.id, "delegates_to");
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo: queue });
    const specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, spec(orch));
    const inst = await runtime.instantiate({ specPath, rootObjective: "x", createdBySession: "ops@lane" });
    const packetId = inst.instance.currentFrontier[0]!;
    const past = new Date(Date.now() - (WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS + 3600) * 1000).toISOString();
    db.prepare("UPDATE queue_items SET ts_created = ? WHERE qitem_id = ?").run(past, packetId);
    db.prepare("UPDATE queue_transitions SET ts = ? WHERE qitem_id = ?").run(past, packetId);
    const packet = queue.getById(packetId)!;
    let perRowId: string;
    if (legacy) {
      perRowId = (await queue.create({ qitemId: recoveryId(db, packetId), sourceSession: packet.sourceSession, destinationSession: "owner@lane",
        body: "STUCK SWEEP FINDING (unclaimed-obligation)", summary: "x",
        tags: [STUCK_SWEEP_FINDING_TAG, findingDedupTag("unclaimed-obligation", packetId), recoveryTag(packetId)], nudge: false })).qitemId;
    } else {
      // The sweep's own finding per row: dev1 escalates to owner@lane before owner@lane delegates to it.
      db.prepare("DELETE FROM edges WHERE source_id = ? AND target_id = ? AND kind = 'delegates_to'").run(parent.node.id, kid.node.id);
      rigs.addEdge(kid.rig.id, kid.node.id, "owner@lane", "escalates_to");
      await sweep();
      const f = queue.list({ limit: 1000 }).find((i) => (i.tags ?? []).includes(findingDedupTag("unclaimed-obligation", packetId)));
      expect(f).toMatchObject({ destinationSession: "owner@lane", state: "pending" });
      perRowId = f!.qitemId;
      rigs.addEdge(parent.rig.id, parent.node.id, kid.node.id, "delegates_to");
    }
    await sweep();
    const folded = queue.getById(perRowId)!;
    const ensurer = makeEnsureStuckExceptionItem({ db, queueRepo: queue,
      resolveRoute: (n, v, c) => runtime.resolveExceptionRouteFor(n, v, c), humanFallbackSeat: "human@host" });
    return { packetId, packet, folded, ensurer, runtime, perRowId };
  }

  for (const legacy of [true, false]) for (const orch of ["lead@ops", "owner@lane"]) {
    it(`a stuck packet whose per-row finding was folded still gets an open exception item of its own (orchestrator ${orch}, ${legacy ? "finding filed before #2988" : "finding the sweep filed by escalates_to"})`, async () => {
      const s = await setup(orch, legacy);
      expect(s.folded).toMatchObject({ state: "done" });
      expect(s.folded.tags).toContain(BACKLOG_FOLDED_TAG);
      const results: unknown[] = [];
      const ensure = async (i: Parameters<typeof s.ensurer>[0]) => {
        try { const r = await s.ensurer(i); results.push(r); return r; } catch (e) { results.push(String(e)); throw e; }
      };
      for (let k = 0; k < 2; k++) await runWorkflowBootSweep({ instanceStore: s.runtime.instanceStore, queueRepo: queue,
        watchdogJobsRepo: new WatchdogJobsRepository(db), ensureStuckExceptionItem: ensure, log: () => {} });
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(typeof r).toBe("object");
      const items = db.prepare(`SELECT qitem_id AS id, state FROM queue_items WHERE json_valid(tags)
        AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'exception:stuck_overdue')`).all() as Array<{ id: string; state: string }>;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ state: "pending" });
      expect(items[0]!.id).not.toBe(s.perRowId);
      // Re-detection finds that item: no second one.
      expect(results.at(-1)).toMatchObject({ outcome: "deduped", qitemId: items[0]!.id });
      // The folded finding is left as it was.
      expect(queue.getById(s.perRowId)).toMatchObject({ state: "done" });
    });
  }
});
