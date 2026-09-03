import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { OutboxHandler } from "../../daemon/src/domain/outbox-handler.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";
import { WorkflowRuntime } from "../../daemon/src/domain/workflow-runtime.js";
import { workflowRoutes } from "../../daemon/src/routes/workflow.js";
import { DaemonClient } from "../src/client.js";
import { realDeps } from "../src/commands/daemon.js";
import { workflowCommand, type WorkflowDeps } from "../src/commands/workflow.js";

const ACCEPTANCE_SPEC = `workflow:
  id: cli-acceptance
  version: 1
  entry: { role: producer }
  roles:
    producer: { preferred_targets: [producer@rig] }
    gate: { preferred_targets: [gate@rig] }
  steps:
    - id: produce
      actor_role: producer
      allowed_exits: [handoff]
    - id: accept
      actor_role: gate
      acceptance:
        candidate: abc123
        verdicts: [CLEAR]
        evidence_ref: proof/review.md
      allowed_exits: [done]
`;

describe("workflow project typed acceptance — real CLI to HTTP boundary", () => {
  let db: Database.Database;
  let runtime: WorkflowRuntime;
  let server: ReturnType<typeof serve>;
  let url: string;
  let dir: string;

  beforeEach(async () => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const bus = new EventBus(db);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    const queueRepo = new QueueRepository(db, bus, {
      validateRig: () => true,
      transport: { send: async () => ({ ok: true, verified: true }) },
    });
    queueRepo.attachOutbox(new OutboxHandler(db));
    runtime = new WorkflowRuntime({ db, eventBus: bus, queueRepo });

    const app = new Hono();
    app.get("/healthz", (c) => c.json({ status: "ok" }));
    app.use("*", async (c, next) => {
      c.set("eventBus" as never, bus);
      c.set("workflowRuntime" as never, runtime);
      await next();
    });
    app.route("/api/workflow", workflowRoutes());
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (info) => {
        url = `http://127.0.0.1:${info.port}`;
        resolve();
      });
    });
    vi.stubEnv("OPENRIG_URL", url);
    vi.stubEnv("OPENRIG_SESSION_NAME", "gate@rig");
    dir = mkdtempSync(join(tmpdir(), "workflow-acceptance-cli-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(): WorkflowDeps {
    return {
      lifecycleDeps: realDeps(),
      clientFactory: (candidateUrl: string) => {
        if (candidateUrl !== url) throw new Error(`test isolation: ${candidateUrl} !== ${url}`);
        return new DaemonClient(candidateUrl);
      },
    };
  }

  async function runProject(instanceId: string, packetId: string, acceptance: { candidate: string; verdict: string; evidence: string }) {
    const output: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
    console.error = (...args: unknown[]) => { output.push(args.join(" ")); };
    process.exitCode = undefined;
    try {
      const command = workflowCommand(deps());
      command.exitOverride();
      await command.parseAsync([
        "node", "rig", "project",
        "--instance", instanceId,
        "--current-packet", packetId,
        "--exit", "done",
        "--actor-session", "gate@rig",
        "--acceptance-candidate", acceptance.candidate,
        "--acceptance-verdict", acceptance.verdict,
        "--acceptance-evidence-ref", acceptance.evidence,
        "--json",
      ]);
      return { output: output.join("\n"), exitCode: process.exitCode };
    } finally {
      console.log = log;
      console.error = error;
    }
  }

  function mutationSnapshot(): unknown {
    return {
      instances: db.prepare("SELECT instance_id, status, current_frontier_json, version FROM workflow_instances ORDER BY instance_id").all(),
      items: db.prepare("SELECT qitem_id, state, handed_off_to, blocked_on FROM queue_items ORDER BY qitem_id").all(),
      trail: db.prepare("SELECT count(*) AS n FROM workflow_step_trails").get(),
      transitions: db.prepare("SELECT count(*) AS n FROM queue_transitions").get(),
      events: db.prepare("SELECT count(*) AS n FROM events").get(),
    };
  }

  it("advances the matching acceptance and rejects each mismatching field without mutation", async () => {
    const specPath = join(dir, "workflow.yaml");
    writeFileSync(specPath, ACCEPTANCE_SPEC);
    const created = await runtime.instantiate({ specPath, rootObjective: "accept", createdBySession: "orch@rig" });
    const projected = await runtime.project({
      instanceId: created.instance.instanceId,
      currentPacketId: created.entryQitemId,
      exit: "handoff",
      actorSession: "producer@rig",
    });
    const packetId = projected.nextQitemId!;

    for (const acceptance of [
      { candidate: "wrong", verdict: "CLEAR", evidence: "proof/review.md" },
      { candidate: "abc123", verdict: "BLOCKING", evidence: "proof/review.md" },
      { candidate: "abc123", verdict: "CLEAR", evidence: "proof/other.md" },
    ]) {
      const before = mutationSnapshot();
      const result = await runProject(created.instance.instanceId, packetId, acceptance);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("acceptance_payload_mismatch");
      expect(mutationSnapshot()).toEqual(before);
    }

    const accepted = await runProject(created.instance.instanceId, packetId, { candidate: "abc123", verdict: "CLEAR", evidence: "proof/review.md" });
    expect(accepted.exitCode).toBeUndefined();
    expect(runtime.inspect(created.instance.instanceId).instance.status).toBe("completed");
  });
});
