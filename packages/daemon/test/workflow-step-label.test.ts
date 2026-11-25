// An authored, optional short label on a workflow step: a person sees it in place of the step's id. The id stays the
// step's identity (and its display without a label), and the objective stays its instruction.
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
import { WorkflowSpecError, parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { workflowRoutes } from "../src/routes/workflow.js";

const spec = (produceLabel: string | null) => `workflow:
  id: labelled
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
${produceLabel === null ? "" : `      label: ${produceLabel}\n`}      actor_role: producer
      objective: Build the change.
      allowed_exits:
        - handoff
    - id: review
      actor_role: reviewer
      allowed_exits:
        - done
`;

describe("a workflow step's label", () => {
  it("parses and is kept on the step, beside its id and objective; a step without one has none", () => {
    const parsed = parseWorkflowSpec(spec("QA pass"), "/specs/labelled.yaml");
    expect(parsed.steps[0]).toMatchObject({ id: "produce", label: "QA pass", objective: "Build the change." });
    expect(parsed.steps[1]).not.toHaveProperty("label");
  });

  it("leaves an unlabelled spec exactly as before", () => {
    const parsed = parseWorkflowSpec(spec(null), "/specs/labelled.yaml");
    expect(parsed.steps.map((step) => Object.keys(step).includes("label"))).toEqual([false, false]);
  });

  it.each([['""', ""], ["3", 3], ["[a]", ["a"]]])("refuses a label that isn't a non-empty string (%s), naming its path", (yaml, value) => {
    let error: unknown;
    try { parseWorkflowSpec(spec(yaml), "/specs/labelled.yaml"); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(WorkflowSpecError);
    expect(error).toMatchObject({ code: "spec_field_invalid", details: { path: "workflow.steps[0].label" } });
    expect((error as Error).message).toContain(JSON.stringify(value));
  });

  describe("on the instance read", () => {
    let db: Database.Database;
    let app: Hono;
    let tmp: string;

    beforeEach(() => {
      db = createDb();
      migrate(db, ALL_MIGRATIONS);
      db.prepare("INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')").run();
      const bus = new EventBus(db);
      const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
      queueRepo.attachOutbox(new OutboxHandler(db));
      const runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });
      app = new Hono();
      app.use("*", async (c, next) => {
        c.set("eventBus" as never, bus);
        c.set("workflowRuntime" as never, runtime);
        await next();
      });
      app.route("/api/workflow", workflowRoutes());
      tmp = mkdtempSync(join(tmpdir(), "wf-step-label-"));
    });

    afterEach(() => {
      db.close();
      rmSync(tmp, { recursive: true, force: true });
    });

    it("GET /api/workflow/<id> returns the started spec's labels, matched to the current step by id", async () => {
      const specPath = join(tmp, "labelled.yaml");
      writeFileSync(specPath, spec("QA pass"));
      const created = await app.request("/api/workflow/instantiate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ specPath, rootObjective: "ship it", createdBySession: "ops@rig" }),
      });
      expect(created.status).toBe(201);
      const { instance } = (await created.json()) as { instance: { instanceId: string } };

      const shown = (await (await app.request(`/api/workflow/${instance.instanceId}`)).json()) as {
        currentStepId: string;
        frontierPackets: Array<{ stepId: string | null }>;
        startedSpec: { spec: { steps: Array<{ id: string; label?: string; objective?: string }> } };
      };
      const steps = shown.startedSpec.spec.steps;
      expect(steps.map((step) => [step.id, step.label ?? null])).toEqual([["produce", "QA pass"], ["review", null]]);
      // A client shows the current step's label, and the id where a step has none.
      expect(shown.currentStepId).toBe("produce");
      expect(shown.frontierPackets.map((packet) => packet.stepId)).toEqual(["produce"]);
      const current = steps.find((step) => step.id === shown.currentStepId)!;
      expect(current.label ?? current.id).toBe("QA pass");
      expect(current.objective).toBe("Build the change.");
    });
  });
});
