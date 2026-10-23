import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { DaemonClient } from "../src/client.js";
import { DecisionRun } from "../src/decisions/decisions.js";
import { applyPending, runDecideWake } from "../src/decisions/stream-consumer.js";
import { JEV_MODEL } from "../src/commands/project-jev.js";
// The real daemon stores and routes, from source, on a migrated in-memory database.
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { EventBus } from "../../daemon/src/domain/event-bus.js";
import { StreamStore } from "../../daemon/src/domain/stream-store.js";
import { ClassifierLeaseManager } from "../../daemon/src/domain/classifier-lease-manager.js";
import { ClassificationAttemptLedger } from "../../daemon/src/domain/classification-attempts.js";
import { ProjectClassifier } from "../../daemon/src/domain/project-classifier.js";
import { classifierOccupant, routingCandidates, sourceHash } from "../../daemon/src/domain/classification-sources.js";
import { projectsRoutes } from "../../daemon/src/routes/projects.js";
import { queueRoutes } from "../../daemon/src/routes/queue.js";
import { QueueRepository } from "../../daemon/src/domain/queue-repository.js";

const TAXONOMY = `version: v1\nfields:\n${["kind", "urgency", "maturity", "area"].map(k => `  ${k}:\n    question: "Which ${k}?"\n    values: { chosen: meaning }`).join("\n")}\n`;
const OPTS = { project: "FIX", taxonomy: "taxonomy.yaml", classifierVersion: "intake-v1", evidenceEpoch: "e1", limit: "5" };
const ON = { enabled: true, consumers: "stream", templateDir: "" };

/** A provider that answers every question __unknown__ (a decline), or fails with an HTTP status. */
function provider(status = 200) {
  return vi.fn(async (_u: unknown, init?: RequestInit) => {
    if (status !== 200) return new Response("down", { status });
    const questions = JSON.parse(String(init!.body)).questions as Record<string, { criteria: Record<string, string> }>;
    return Response.json({ id: "gen-1", model: JEV_MODEL + "-20260917", provider: "TypeSafe", answers: Object.fromEntries(Object.entries(questions).map(([id, q]) =>
      [id, { type: "choice", choice: "__unknown__", confidence: 0.2, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === "__unknown__" ? 1 : 0])) }])) });
  });
}

describe("a declined item stays decidable by the intake agent in the same turn (real attempt ledger)", () => {
  let db: Database.Database, ledger: ClassificationAttemptLedger, client: DaemonClient;
  let leases: ClassifierLeaseManager, queue: QueueRepository, beforeQueue: (() => void) | undefined;
  const run = (send: ReturnType<typeof provider>) => new DecisionRun({ consumer: "stream", settings: () => ON, env: { OPENROUTER_API_KEY: "synthetic" }, send });
  const agentEligible = () => ledger.eligible({ classifierVersion: "intake-v1", taxonomyVersion: "v1", evidenceEpoch: "e1" }).items.map(i => i.streamItemId);

  beforeEach(() => {
    vi.stubEnv("OPENRIG_SESSION_NAME", "intake@rig"); vi.stubEnv("OPENRIG_URL", ""); vi.stubEnv("RIGGED_URL", "");
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig', 'rig')`).run();
    for (const [id, session, role] of [["intake", "intake@rig", "Intake"], ["lead", "dev-lead@rig", "Owns the build pod's work"]]) {
      db.prepare(`INSERT INTO nodes (id, rig_id, logical_id, role) VALUES (?, 'rig', ?, ?)`).run(id, id, role);
      db.prepare(`INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)`).run(`b-${id}`, id, session);
    }
    // Only the intake seat is a running occupant; the owner isn't running.
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES ('s-intake', 'intake', 'intake@rig', 'running')`).run();
    db.prepare(`INSERT INTO occupant_tenures (id, node_id, generation_ordinal, generation_uuid, kind) VALUES ('t1', 'intake', 1, 'g1', 'initial')`).run();
    const bus = new EventBus(db), stream = new StreamStore(db, bus);
    leases = new ClassifierLeaseManager(db, bus); queue = new QueueRepository(db, bus); beforeQueue = undefined;
    ledger = new ClassificationAttemptLedger(db, leases);
    stream.emit({ streamItemId: "S1", sourceSession: "poster@rig", body: "Something odd happened, not sure where it belongs" });
    const app = new Hono();
    app.use("*", async (c, next) => {
      for (const [k, v] of Object.entries({ db, eventBus: bus, streamStore: stream, classifierLeaseManager: leases, classificationAttemptLedger: ledger,
        projectClassifier: new ProjectClassifier(db, bus, leases), queueRepo: queue })) c.set(k as never, v);
      await next();
    });
    // The project-scope part of worker-sources needs a workspace tree; this stub serves the same snapshot shape with
    // the real occupant and the real routing candidates. Everything else is the real route.
    app.get("/api/projects/worker-sources", c => {
      const routing = routingCandidates(db, "rig");
      return c.json({ occupant: classifierOccupant(db, "intake@rig"), observedAt: "t", version: "v", unavailable: [],
        sources: { project: {}, scopes: [], roster: [], recent: [] }, routing, routingVersion: sourceHash(JSON.stringify(routing)) });
    });
    app.route("/api/projects", projectsRoutes());
    app.route("/api/queue", queueRoutes());
    app.get("/api/stream/:id", c => c.json(stream.getById(c.req.param("id"))));
    client = new DaemonClient("http://offline.invalid", { fetchImpl: async (url, init) => {
      if (init?.method === "POST" && String(url).includes("/api/queue/")) beforeQueue?.();
      return app.request(String(url), init);
    } });
  });
  afterEach(() => { db.close(); vi.unstubAllEnvs(); });

  it("ordinary queue writes still work without a classifier binding or lease", async () => {
    const created = await client.post("/api/queue/create", { qitemId: "ordinary", destinationSession: "dev-lead@rig", body: "ordinary work", nudge: false });
    expect(created.status).toBe(201);
    expect((await client.post("/api/queue/ordinary/update", { transitionNote: "ordinary note" })).status).toBe(200);
  });

  it("classifier-bound creation stays on its accepting daemon", async () => {
    const lease = leases.acquire("intake@rig");
    const result = await client.post("/api/queue/create", { qitemId: "remote", destinationSession: "dev-lead@rig", body: "work", hostId: "other-host",
      classificationBinding: { leaseId: lease.leaseId, expectedOccupant: "g1" } });
    expect(result).toMatchObject({ status: 400, data: { error: "invalid_classification_binding" } });
    expect(queue.getById("remote")).toBeNull();
  });

  it.each(["create", "join"].flatMap(kind => ["lease", "occupant"].map(lost => ({ kind, lost }))))("a replaced $lost after preflight cannot commit a $kind effect", async ({ kind, lost }) => {
    const lease = leases.acquire("intake@rig");
    await queue.create({ qitemId: "work", sourceSession: "intake@rig", destinationSession: "dev-lead@rig", body: "existing work", nudge: false });
    new ProjectClassifier(db, new EventBus(db), leases).classify({ streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease.leaseId,
      classificationDestination: "dev-lead@rig", disposition: { disposition: kind, ownerSession: "dev-lead@rig", workQitemId: kind === "join" ? "work" : null,
        effect: kind === "join" ? { operation: "note", qitemId: "work", destination: null } : { operation: "create", qitemId: "qitem-stream-S1", destination: "dev-lead@rig" },
        templateDigest: "sha256:"+"a".repeat(64), templateText: "stream template", request: "{}", provenance: {} } });
    const before = queue.listTransitions("work").length;
    beforeQueue = () => { beforeQueue = undefined;
      if (lost === "lease") { leases.reclaim("intake@rig", { reason: "test replacement" }); leases.acquire("intake@rig"); }
      else db.exec("UPDATE occupant_tenures SET generation_uuid='g2' WHERE node_id='intake'"); };
    const out = await applyPending(client, { intake: "intake@rig", generation: "g1", leaseId: lease.leaseId });
    expect(queue.getById("qitem-stream-S1")).toBeNull();
    expect(queue.listTransitions("work")).toHaveLength(before);
    expect(out).toMatchObject([{ outcome: "stopped" }]);
  });

  it("a decline is deferred to intake with its structured result: the agent decides it now, and the model isn't asked again", async () => {
    const send = provider(), first = await runDecideWake(client, OPTS, run(send), () => TAXONOMY);
    expect(send).toHaveBeenCalledTimes(1);
    expect(first.decisions.forIntake).toMatchObject([{ streamItemId: "S1", status: "abstained", reason: expect.stringContaining("unknown: disposition") }]);
    // The deferral is stored with the abstention: the exact request, the template binding and the returned provenance.
    const deferral = (await client.get<Record<string, any>>("/api/projects/dispositions/S1")).data;
    expect(deferral).toMatchObject({ disposition: "deferred", projectId: null, acceptedBy: "intake@rig", request: String(send.mock.calls[0]![1]!.body),
      templateDigest: expect.stringMatching(/^sha256:/), provenance: { generationId: "gen-1" }, result: { status: "abstained" }, applied: { outcome: "deferred_to_intake" } });
    // The agent's own identity still sees the item: no backoff, nothing exhausted.
    expect(agentEligible()).toEqual(["S1"]);
    // A second automatic wake before the agent acts doesn't ask the model again.
    const again = provider();
    await runDecideWake(client, OPTS, run(again), () => TAXONOMY);
    expect(again).not.toHaveBeenCalled();
    // The agent decides in the same turn (rig project classify under the active lease), and the item leaves every queue.
    const lease = (await client.get<{ leaseId: string }>("/api/projects/lease")).data;
    const classified = await client.post("/api/projects/project", { streamItemId: "S1", classifierSession: "intake@rig", leaseId: lease.leaseId, classificationDestination: "dev-lead@rig", action: "create" });
    expect(classified.status).toBe(201);
    expect(agentEligible()).toEqual([]);
  });

  it("a provider error is deferred to intake too, with no backoff for the agent and no automatic retry", async () => {
    const send = provider(503), out = await runDecideWake(client, OPTS, run(send), () => TAXONOMY);
    expect(out.decisions.forIntake).toMatchObject([{ streamItemId: "S1", status: "abstained", reason: expect.stringContaining("HTTP 503") }]);
    expect((await client.get<Record<string, any>>("/api/projects/dispositions/S1")).data).toMatchObject({ disposition: "deferred", result: { status: "failed", httpStatus: 503 } });
    expect(agentEligible()).toEqual(["S1"]);
    const again = provider();
    await runDecideWake(client, OPTS, run(again), () => TAXONOMY);
    expect(again).not.toHaveBeenCalled();
  });
});
