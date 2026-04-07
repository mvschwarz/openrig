import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { podNamespaceSchema } from "../src/db/migrations/017_pod_namespace.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { whoamiRoutes } from "../src/routes/whoami.js";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, podNamespaceSchema]);
  return db;
}

describe("whoami routes", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
  });

  afterEach(() => { db.close(); });

  function createApp() {
    const transcriptStore = new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true });
    const svc = new WhoamiService({ db, rigRepo, sessionRegistry, transcriptStore });
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("whoamiService" as never, svc);
      await next();
    });
    app.route("/api/whoami", whoamiRoutes());
    return app;
  }

  function seedRig() {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "dev-impl@my-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@my-rig" });
    return { rig, node, sess };
  }

  it("GET /api/whoami?nodeId=... returns 200 with WhoamiResult", async () => {
    const { node } = seedRig();
    const app = createApp();
    const res = await app.request(`/api/whoami?nodeId=${node.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedBy).toBe("node_id");
    expect(body.identity.logicalId).toBe("dev.impl");
    expect(body.identity.sessionName).toBe("dev-impl@my-rig");
    expect(body.transcript).toBeDefined();
    expect(body.commands).toBeDefined();
  });

  it("GET /api/whoami?sessionName=... returns 200", async () => {
    seedRig();
    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=dev-impl@my-rig");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolvedBy).toBe("session_name");
    expect(body.identity.logicalId).toBe("dev.impl");
  });

  it("GET /api/whoami with no params returns 400", async () => {
    seedRig();
    const app = createApp();
    const res = await app.request("/api/whoami");

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("nodeId");
  });

  it("GET /api/whoami?sessionName=unknown returns 404 with guidance", async () => {
    seedRig();
    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=nonexistent-session");

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
    expect(body.error).toContain("rig ps");
  });

  it("GET /api/whoami?sessionName=ambiguous returns 409", async () => {
    // Two rigs with same session name
    const rig1 = rigRepo.createRig("rig-a");
    const node1 = rigRepo.addNode(rig1.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev-impl@shared");

    const rig2 = rigRepo.createRig("rig-b");
    const node2 = rigRepo.addNode(rig2.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev-impl@shared");

    const app = createApp();
    const res = await app.request("/api/whoami?sessionName=dev-impl@shared");

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ambiguous");
  });
});
