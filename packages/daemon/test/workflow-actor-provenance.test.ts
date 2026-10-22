// #1710: a workflow record names the agent that projected the step, derived from the caller, not a copied owner.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";
import { setSelfHostId } from "../src/domain/hosts/fanout-contract.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

const SPEC = `workflow:
  id: actor-fixture
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
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
  invariants:
    allowed_exits:
      - handoff
      - done
`;

describe("a workflow record names the agent that projected the step", () => {
  let db: Database.Database;
  let app: Hono;
  let tmp: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = new Hono();
    app.use("*", async (c, next) => { c.set("eventBus" as never, bus); c.set("workflowRuntime" as never, runtime); await next(); });
    app.route("/api/workflow", workflowRoutes());
    tmp = mkdtempSync(join(tmpdir(), "wf-actor-"));
    writeFileSync(join(tmp, "spec.yaml"), SPEC);
  });
  afterEach(() => { setSelfHostId(null); db.close(); rmSync(tmp, { recursive: true, force: true }); });

  async function entry() {
    const res = await app.request("/api/workflow/instantiate", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: join(tmp, "spec.yaml"), rootObjective: "x", createdBySession: "ops@rig" }) });
    return (await res.json()) as { instance: { instanceId: string }; entryQitemId: string };
  }
  async function project(packet: { instance: { instanceId: string }; entryQitemId: string }, headers: Record<string, string>, actorSession?: string) {
    const res = await app.request("/api/workflow/project", { method: "POST", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ instanceId: packet.instance.instanceId, currentPacketId: packet.entryQitemId, exit: "handoff", actorSession }) });
    return { status: res.status, body: (await res.json()) as { advisories?: string[]; nextOwnerSession?: string } };
  }
  /** Who the records say projected the packet: its trail and its closing queue transition. */
  function recorded(packetId: string) {
    const trail = db.prepare("SELECT actor_session FROM workflow_step_trails WHERE prior_qitem_id = ?").get(packetId) as { actor_session: string };
    const close = db.prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? AND state = 'handed-off' ORDER BY transition_id DESC LIMIT 1")
      .get(packetId) as { actor_session: string; identity_provenance: string | null };
    return { trail: trail.actor_session, close: close.actor_session, provenance: close.identity_provenance };
  }

  it("records the caller, not the owner its request named, and tells it once that it moved another seat's packet", async () => {
    const packet = await entry();
    const { status, body } = await project(packet, { "x-openrig-session": "orch-lead@rig" }, "producer@rig");
    expect(status).toBe(200);
    expect(recorded(packet.entryQitemId)).toEqual({ trail: "orch-lead@rig", close: "orch-lead@rig", provenance: "transport:v1" });
    expect(body.advisories).toEqual([`recorded orch-lead@rig as the agent that projected packet ${packet.entryQitemId}, which is owned by producer@rig`]);
    // Delegated work moved in one call, and nothing extra went to the owner.
    expect(body.nextOwnerSession).toBe("reviewer@rig");
    expect(db.prepare("SELECT COUNT(*) AS n FROM queue_items WHERE destination_session = 'producer@rig'").get()).toEqual({ n: 1 });
  });

  it("reads this host's own qualifier as the local seat, so the owner projecting its packet gets no advisory", async () => {
    setSelfHostId("host-a");
    const packet = await entry();
    const { body } = await project(packet, { "x-openrig-session": "producer@rig@host-a" });
    expect(recorded(packet.entryQitemId)).toEqual({ trail: "producer@rig", close: "producer@rig", provenance: "transport:v1" });
    expect(body.advisories).toBeUndefined();
  });

  it("records a declared actor as claimed when the caller has no identity, and doesn't call it a mismatch", async () => {
    const packet = await entry();
    const { body } = await project(packet, {}, "orch-lead@rig");
    expect(recorded(packet.entryQitemId)).toEqual({ trail: "orch-lead@rig", close: "orch-lead@rig", provenance: "claimed:v1" });
    expect(body.advisories).toBeUndefined();
  });

  it("records a relayed caller no stronger than the relay carried it", async () => {
    const packet = await entry();
    const { body } = await project(packet, { "x-openrig-session": "orch-lead@rig@host-b", "x-openrig-relay": "1" });
    expect(recorded(packet.entryQitemId)).toEqual({ trail: "orch-lead@rig@host-b", close: "orch-lead@rig@host-b", provenance: "claimed:v1" });
    expect(body.advisories).toBeUndefined();
  });

  it("route and abort record their caller the same way", async () => {
    const packet = await entry();
    const id = packet.instance.instanceId;
    const routed = await app.request(`/api/workflow/${id}/route`, { method: "POST", headers: { "Content-Type": "application/json", "x-openrig-session": "orch-lead@rig" },
      body: JSON.stringify({ toSession: "producer-2@rig", actorSession: "producer@rig" }) });
    expect(routed.status).toBe(200);
    expect(db.prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1").get(packet.entryQitemId))
      .toEqual({ actor_session: "orch-lead@rig", identity_provenance: "transport:v1" });
    const { newPacketId } = (await routed.json()) as { newPacketId: string };
    const aborted = await app.request(`/api/workflow/${id}/abort`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "stop", actorSession: "ops@rig" }) });
    expect(aborted.status).toBe(200);
    expect(db.prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1").get(newPacketId))
      .toEqual({ actor_session: "ops@rig", identity_provenance: "claimed:v1" });
  });
});
