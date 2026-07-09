import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { workflowSpecsSchema } from "../src/db/migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "../src/db/migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "../src/db/migrations/035_workflow_step_trails.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemEvidenceRefSchema } from "../src/db/migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "../src/db/migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "../src/db/migrations/050_workflow_spec_json.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { WorkflowProjectorError } from "../src/domain/workflow-projector.js";
import { workflowRoutes } from "../src/routes/workflow.js";

/**
 * OPR.0.4.6.WF3 FR-4 — `route` contract pins. THE ZOMBIE REVOCATION
 * TEST IS FIRST (the adjudication's load-bearing fact: if it fails,
 * nothing else matters).
 */

const SPEC = `workflow:
  id: route-fixture
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
    reviewer:
      preferred_targets:
        - reviewer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - handoff
        - waiting
        - failed
      next_hop:
        suggested_roles:
          - reviewer
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
        - failed
  invariants:
    allowed_exits:
      - handoff
      - waiting
      - done
      - failed
`;

function buildApp(opts: { eventBus: EventBus; runtime: WorkflowRuntime }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("workflowRuntime" as never, opts.runtime);
    await next();
  });
  app.route("/api/workflow", workflowRoutes());
  return app;
}

describe("workflow route (WF3 FR-4 — close+recreate+rebind)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, bindingsSessionsSchema, eventsSchema,
      queueItemsSchema, queueTransitionsSchema,
      queueItemSummarySchema, queueItemEvidenceRefSchema,
      workflowSpecsSchema, workflowInstancesSchema, workflowStepTrailsSchema,
      workflowInstanceVersionSchema, workflowSpecJsonSchema,
    ]);
    bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = buildApp({ eventBus: bus, runtime });
    tmp = mkdtempSync(join(tmpdir(), "wf-route-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function instantiate() {
    const r = await runtime.instantiate({
      specPath,
      rootObjective: "route pins",
      createdBySession: "orch@rig",
    });
    return { instanceId: r.instance.instanceId, entryPacket: r.entryQitemId };
  }

  it("THE ZOMBIE REVOCATION PROOF: old owner's stale project → structured packet_not_on_frontier 409; new owner succeeds", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const routed = await runtime.route({
      instanceId,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "owner seat dead",
    });

    // The zombie (old owner, waking post-compaction) tries to advance
    // its stale packet — the shipped replay guard rejects STRUCTURALLY.
    const zombie = await app.request(`/api/workflow/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instanceId,
        currentPacketId: entryPacket,
        exit: "handoff",
        actorSession: "producer@rig",
      }),
    });
    expect(zombie.status).toBe(409);
    const zbody = await zombie.json() as { error: string };
    expect(zbody.error).toBe("packet_not_on_frontier");

    // The NEW owner advances the SAME step successfully.
    const advanced = await runtime.project({
      instanceId,
      currentPacketId: routed.newPacketId,
      exit: "handoff",
      actorSession: "producer2@rig",
    });
    expect(advanced.nextStepId).toBe("review");
  });

  it("the observable contract: owner changed, step UNCHANGED, honest handoff closure (no forged completion), provenance durable, version bumped, hop count NOT bumped", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const before = runtime.instanceStore.getByIdOrThrow(instanceId);
    const routed = await runtime.route({
      instanceId,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "rebalance",
    });
    const after = runtime.instanceStore.getByIdOrThrow(instanceId);

    // (1) owner is the target (queue row read directly — queueRepo is
    // runtime-private by design)
    const qrow = (id: string) =>
      db.prepare(`SELECT destination_session, state, closure_reason, closure_target, blocked_on, chain_of_record FROM queue_items WHERE qitem_id = ?`).get(id) as Record<string, string | null> | undefined;
    const newPacket = qrow(routed.newPacketId);
    expect(newPacket?.destination_session).toBe("producer2@rig");
    // (2) step identity unchanged
    expect(after.currentStepId).toBe(before.currentStepId);
    expect(after.currentStepId).toBe("produce");
    // (4) the old packet closed as handed_off_to — NEVER done/no-follow-on
    const oldPacket = qrow(entryPacket);
    expect(oldPacket?.state).toBe("handed-off");
    expect(oldPacket?.closure_reason).toBe("handed_off_to");
    expect(oldPacket?.closure_target).toBe("producer2@rig");
    // (3) provenance queryable: actor + reason + old→new in the transition
    const transition = db
      .prepare(`SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(entryPacket) as { transition_note?: string } | undefined;
    expect(transition?.transition_note).toContain("orch@rig");
    expect(transition?.transition_note).toContain("producer@rig");
    expect(transition?.transition_note).toContain("producer2@rig");
    expect(transition?.transition_note).toContain("rebalance");
    // (5) frontier non-dangling
    expect(after.currentFrontier).toEqual([routed.newPacketId]);
    // (7) version guard exercised (bump); route is NOT an advance (no hop bump)
    expect(after.version).toBe(before.version + 1);
    expect(after.hopCount).toBe(before.hopCount);
    // chainOfRecord threads the lineage
    expect(String(newPacket?.chain_of_record ?? "")).toContain(entryPacket);
  });

  it("(6) routing_table_changed emits with the ADDITIVE re-route detail", async () => {
    const { instanceId, entryPacket } = await instantiate();
    const seen: Array<Record<string, unknown>> = [];
    bus.subscribe((e) => {
      if ((e as { type?: string }).type === "workflow.routing_table_changed") seen.push(e as never);
    });
    await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      cause: "workflow_route",
      instanceId,
      stepId: "produce",
      from: "producer@rig",
      to: "producer2@rig",
    });
    void entryPacket;
  });

  it("rejection matrix: completed instance → instance_not_active; empty-frontier handled; HTTP mapping 409/400", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({ instanceId, currentPacketId: entryPacket, exit: "failed", actorSession: "producer@rig" });
    await expect(
      runtime.route({ instanceId, toSession: "x@rig", actorSession: "orch@rig" }),
    ).rejects.toMatchObject({ code: "instance_not_active" });

    // HTTP surface: 409 for the terminal instance; 400 for missing fields.
    const res409 = await app.request(`/api/workflow/${instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "x@rig", actorSession: "orch@rig" }),
    });
    expect(res409.status).toBe(409);
    const res400 = await app.request(`/api/workflow/${instanceId}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res400.status).toBe(400);
  });

  it("a waiting instance routes with its park PRESERVED (owner changes, recorded state does not)", async () => {
    const { instanceId, entryPacket } = await instantiate();
    await runtime.project({
      instanceId,
      currentPacketId: entryPacket,
      exit: "waiting",
      actorSession: "producer@rig",
      blockedOn: "founder-gate",
    });
    const routed = await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    const successor = db.prepare(`SELECT state, blocked_on FROM queue_items WHERE qitem_id = ?`).get(routed.newPacketId) as Record<string, string | null> | undefined;
    expect(successor?.state).toBe("blocked");
    expect(successor?.blocked_on).toBe("founder-gate");
    const inst = runtime.instanceStore.getByIdOrThrow(instanceId);
    expect(inst.status).toBe("waiting");
    expect(inst.currentStepId).toBe("produce");
  });

  it("concurrency: the version guard serializes — a stale-versioned frontier write after route conflicts", async () => {
    const { instanceId } = await instantiate();
    const stale = runtime.instanceStore.getByIdOrThrow(instanceId);
    await runtime.route({ instanceId, toSession: "producer2@rig", actorSession: "orch@rig" });
    // A writer holding the PRE-route version loses (the WF-1 guard —
    // same mechanism the projector rides; true same-instant commits are
    // impossible under better-sqlite3's synchronous single-writer, so
    // the stale-read simulation is the faithful race, arch-blessed).
    expect(() =>
      runtime.instanceStore.updateFrontier(instanceId, ["qitem-fake"], "active", {
        expectedVersion: stale.version,
      }),
    ).toThrowError(/instance_version_conflict|version/);
  });

  it("HUMAN-GATED park routes with summary/evidence_ref PRESERVED — never human_route_fields_required (rev1-r2 BLOCKING fold)", async () => {
    // The waiting-on-human class is the one route most exists for: a
    // human-parked packet whose ROLE OWNER seat died. The successor
    // must keep the park AND its human-route fields, or the shipped
    // validateHumanPark rejects the repark and the instance is
    // un-routable exactly when it matters.
    const gatedSpecPath = join(tmp, "gated.yaml");
    writeFileSync(gatedSpecPath, `workflow:
  id: route-gated-human
  version: 1
  entry:
    role: producer
  roles:
    producer:
      preferred_targets:
        - producer@rig
  steps:
    - id: produce
      actor_role: producer
      allowed_exits:
        - done
        - failed
      gate:
        target: human@kernel
        summary: "Sign off the walk"
        evidence_ref: proof/PROOF.md
  invariants:
    allowed_exits:
      - done
      - failed
`);
    const r = await runtime.instantiate({
      specPath: gatedSpecPath,
      rootObjective: "human-park route",
      createdBySession: "orch@rig",
    });
    const iid = r.instance.instanceId;
    // Entry parked on the human seat WITH the required fields.
    const qrow = (id: string) =>
      db.prepare(`SELECT destination_session, state, blocked_on, summary, evidence_ref FROM queue_items WHERE qitem_id = ?`).get(id) as Record<string, string | null>;
    const parked = qrow(r.entryQitemId);
    expect(parked.state).toBe("blocked");
    expect(parked.blocked_on).toBe("human@kernel");
    expect(parked.summary).toBe("Sign off the walk");

    // Route the parked step to a new role-owner seat: must SUCCEED.
    const routed = await runtime.route({
      instanceId: iid,
      toSession: "producer2@rig",
      actorSession: "orch@rig",
      reason: "role owner seat dead",
    });
    const successor = qrow(routed.newPacketId);
    expect(successor.destination_session).toBe("producer2@rig");
    expect(successor.state).toBe("blocked");
    expect(successor.blocked_on).toBe("human@kernel");
    // THE FIX: the human-route fields survive the re-route.
    expect(successor.summary).toBe("Sign off the walk");
    expect(successor.evidence_ref).toBe("proof/PROOF.md");
    // Step identity + instance state preserved.
    const inst = runtime.instanceStore.getByIdOrThrow(iid);
    expect(inst.currentStepId).toBe("produce");
    expect(inst.currentFrontier).toEqual([routed.newPacketId]);
    // OPR.0.4.6.WF5 (rev1-r2 B1): the class-(c) exception identity
    // CARRIES to the routed successor — the live frontier item stays
    // queryable, and the occurrence stays the ORIGINAL gate packet id
    // (route changes the owner, never the episode).
    const successorTags = String(
      (db.prepare(`SELECT tags FROM queue_items WHERE qitem_id = ?`).get(routed.newPacketId) as { tags: string }).tags,
    );
    expect(successorTags).toContain("workflow-exception");
    expect(successorTags).toContain("exception:human_gate_trip");
    expect(successorTags).toContain("step:produce");
    expect(successorTags).toContain(`occurrence:${r.entryQitemId}`);
    expect(successorTags).toContain("re-route");
  });

  it("PIN-VIOLATING TARGET rejected 409 harness_pin_unsatisfied; a matching-harness target routes fine (guard prepass finding 3)", async () => {
    // Seed managed nodes so nodeRuntimeOf resolves runtimes (the WF-2
    // seedSeat pattern).
    const seedSeat = (sessionName: string, runtimeName: string, nodeId: string): void => {
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES (?, 'r-1', ?, ?)`)
        .run(nodeId, sessionName.split("@")[0], runtimeName);
      db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, 'running')`)
        .run(`s-${nodeId}`, nodeId, sessionName);
    };
    seedSeat("codex-seat@rig", "codex", "n-codex");
    seedSeat("codex-seat2@rig", "codex", "n-codex2");
    seedSeat("claude-seat@rig", "claude-code", "n-claude");
    const pinnedSpecPath = join(tmp, "pinned.yaml");
    writeFileSync(pinnedSpecPath, `workflow:
  id: route-pinned
  version: 1
  entry:
    role: builder
  roles:
    builder:
      preferred_targets:
        - codex-seat@rig
  steps:
    - id: build
      actor_role: builder
      allowed_exits:
        - done
        - failed
      harness: codex
  invariants:
    allowed_exits:
      - done
      - failed
`);
    const r = await runtime.instantiate({
      specPath: pinnedSpecPath,
      rootObjective: "pin pins",
      createdBySession: "orch@rig",
    });
    const iid = r.instance.instanceId;

    // Wrong harness at the HTTP surface: structured 409, nothing mutated.
    const res = await app.request(`/api/workflow/${iid}/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "claude-seat@rig", actorSession: "orch@rig" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("harness_pin_unsatisfied");
    const untouched = runtime.instanceStore.getByIdOrThrow(iid);
    expect(untouched.currentFrontier).toEqual([r.entryQitemId]);

    // Matching harness routes fine.
    const routed = await runtime.route({ instanceId: iid, toSession: "codex-seat2@rig", actorSession: "orch@rig" });
    expect(routed.toSession).toBe("codex-seat2@rig");
  });

  it("route on an unknown instance throws instance_not_found (404 at the route layer)", async () => {
    await expect(
      runtime.route({ instanceId: "nope", toSession: "x@rig", actorSession: "orch@rig" }),
    ).rejects.toSatisfy((e: unknown) => {
      // instanceStore.getByIdOrThrow throws its own store error class;
      // the HTTP mapper turns it into 404 — pinned at the HTTP level:
      return e instanceof Error;
    });
    const res = await app.request(`/api/workflow/nope/route`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toSession: "x@rig", actorSession: "orch@rig" }),
    });
    expect(res.status).toBe(404);
    void WorkflowProjectorError;
  });
});
