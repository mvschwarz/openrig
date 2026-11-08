import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { WorkflowRuntime } from "../src/domain/workflow-runtime.js";
import { workflowRoutes } from "../src/routes/workflow.js";

// #2730: `rig workflow instantiate` and `run` require --root-objective, which lived only in the entry packet's body.
// Once that packet closed, nothing on the instance said what the run was for.

const SPEC = `workflow:
  id: root-objective-fixture
  version: 1
  entry:
    role: worker
  roles:
    worker:
      preferred_targets:
        - worker@rig
  steps:
    - id: act
      actor_role: worker
      allowed_exits:
        - handoff
        - done
`;

describe("#2730 a workflow instance keeps its root objective", () => {
  let db: Database.Database;
  let queueRepo: QueueRepository;
  let runtime: WorkflowRuntime;
  let app: Hono;
  let tmp: string;
  let specPath: string;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("workflowRuntime" as never, runtime);
      await next();
    });
    app.route("/api/workflow", workflowRoutes());
    tmp = mkdtempSync(join(tmpdir(), "wf-root-objective-"));
    specPath = join(tmp, "spec.yaml");
    writeFileSync(specPath, SPEC);
  });

  afterEach(() => {
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  /** What list, show and trace say the instance is for. */
  async function readBack(instanceId: string) {
    const list = await (await app.request("/api/workflow/list")).json() as Array<{ instanceId: string; rootObjective?: unknown }>;
    const show = await (await app.request(`/api/workflow/${instanceId}`)).json() as { rootObjective?: unknown };
    const trace = await (await app.request(`/api/workflow/${instanceId}/trace`)).json() as { instance: { rootObjective?: unknown } };
    return {
      list: list.find((row) => row.instanceId === instanceId)?.rootObjective,
      show: show.rootObjective,
      trace: trace.instance.rootObjective,
    };
  }

  it("list, show and trace return the objective after the entry packet is closed", async () => {
    const started = await runtime.instantiate({ specPath, rootObjective: "TICKET-123 ship the thing", createdBySession: "lead@rig" });
    expect(queueRepo.getById(started.entryQitemId)?.body).toContain("Root objective: TICKET-123 ship the thing");

    queueRepo.claim({ qitemId: started.entryQitemId, destinationSession: "worker@rig" });
    queueRepo.update({ qitemId: started.entryQitemId, actorSession: "worker@rig", state: "done", closureReason: "no-follow-on", transitionNote: "closed" });
    expect(queueRepo.getById(started.entryQitemId)?.state).toBe("done");

    expect(await readBack(started.instance.instanceId)).toEqual({
      list: "TICKET-123 ship the thing",
      show: "TICKET-123 ship the thing",
      trace: "TICKET-123 ship the thing",
    });
  });

  it("an instance from before the objective was kept reads it as not recorded, never as empty", async () => {
    const started = await runtime.instantiate({ specPath, rootObjective: "older run", createdBySession: "lead@rig" });
    db.prepare("UPDATE workflow_instances SET root_objective = NULL WHERE instance_id = ?").run(started.instance.instanceId);

    expect(await readBack(started.instance.instanceId)).toEqual({ list: null, show: null, trace: null });
  });
});
