import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { externalCliAttachmentSchema } from "../src/db/migrations/019_external_cli_attachment.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { transcriptRoutes } from "../src/routes/transcripts.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { vi } from "vitest";

function setupDb(): Database.Database {
  const db = createDb();
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, snapshotsSchema, checkpointsSchema, resumeMetadataSchema, nodeSpecFieldsSchema, agentspecRebootSchema, externalCliAttachmentSchema]);
  return db;
}

function createApp(opts: {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  transcriptStore: TranscriptStore;
  tmuxAdapter?: TmuxAdapter;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("rigRepo" as never, opts.rigRepo);
    c.set("sessionRegistry" as never, opts.sessionRegistry);
    c.set("transcriptStore" as never, opts.transcriptStore);
    c.set("db" as never, opts.db);
    c.set("tmuxAdapter" as never, opts.tmuxAdapter);
    await next();
  });
  app.route("/api/transcripts", transcriptRoutes());
  return app;
}

describe("transcript routes", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let tmpDir: string;

  beforeEach(() => {
    db = setupDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-routes-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRigWithTranscript(content: string) {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "dev.impl@my-rig");
    sessionRegistry.updateStatus(session.id, "running");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    store.ensureTranscriptDir("my-rig");
    const filePath = store.getTranscriptPath("my-rig", "dev.impl@my-rig");
    writeFileSync(filePath, content);

    return { rig, node, session, store };
  }

  it("GET /tail returns 200 with stripped content for existing transcript", async () => {
    const { store } = seedRigWithTranscript("line1\n\x1b[1mline2\x1b[0m\nline3\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail?lines=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe("dev.impl@my-rig");
    expect(body.content).toContain("line2"); // ANSI stripped
    expect(body.content).not.toContain("\x1b[");
  });

  it("GET /tail with unknown session returns 404 with guidance", async () => {
    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/nonexistent-session/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("not found");
    expect(body.error).toContain("rig ps");
  });

  it("GET /tail with known session but no transcript file returns 404 with guidance", async () => {
    // Create rig + session but NO transcript file
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev.impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("No transcript");
    expect(body.error).toContain("rig up");
  });

  it("GET /tail starts transcript capture for a tmux-bound session with no transcript file", async () => {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev.impl@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev.impl@my-rig" });

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    vi.spyOn(store, "ensureTranscriptDir").mockReturnValue(true);
    const startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    const app = createApp({
      db,
      rigRepo,
      sessionRegistry,
      transcriptStore: store,
      tmuxAdapter: { startPipePane: startPipePaneSpy } as unknown as TmuxAdapter,
    });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("started now");
    expect(startPipePaneSpy).toHaveBeenCalledWith(
      "dev.impl@my-rig",
      store.getTranscriptPath("my-rig", "dev.impl@my-rig"),
    );
  });

  it("GET /tail returns warmed content after lazy-start capture when output appears quickly", async () => {
    const rig = rigRepo.createRig("my-rig");
    const node = rigRepo.addNode(rig.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node.id, "dev.impl@my-rig");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev.impl@my-rig" });

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const readTailSpy = vi.spyOn(store, "readTail")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce("READY\n");
    vi.spyOn(store, "ensureTranscriptDir").mockReturnValue(true);
    const startPipePaneSpy = vi.fn(async () => ({ ok: true as const }));
    const app = createApp({
      db,
      rigRepo,
      sessionRegistry,
      transcriptStore: store,
      tmuxAdapter: { startPipePane: startPipePaneSpy } as unknown as TmuxAdapter,
    });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("READY\n");
    expect(startPipePaneSpy).toHaveBeenCalledOnce();
    expect(readTailSpy).toHaveBeenCalledTimes(2);
  });

  it("GET /tail with non-positive lines normalizes to default", async () => {
    const { store } = seedRigWithTranscript("line1\nline2\nline3\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail?lines=-5");
    expect(res.status).toBe(200);
    const body = await res.json();
    // Normalized to default 50, response includes the normalized value
    expect(body.lines).toBe(50);
  });

  it("GET /tail with transcripts disabled returns 404 with guidance", async () => {
    seedRigWithTranscript("content");
    const disabledStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: false });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: disabledStore });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("disabled");
  });

  it("GET /grep with matches returns 200 with matched lines", async () => {
    const { store } = seedRigWithTranscript("hello world\ndecision made\nfoo bar\ndecision final\n");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/grep?pattern=decision");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session).toBe("dev.impl@my-rig");
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0]).toBe("decision made");
    expect(body.matches[1]).toBe("decision final");
  });

  it("GET /grep without pattern returns 400", async () => {
    const { store } = seedRigWithTranscript("content");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/grep");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("pattern");
  });

  it("GET /tail with ambiguous session name across rigs returns 409", async () => {
    // Create two rigs with same name and same session name
    const rig1 = rigRepo.createRig("my-rig");
    const node1 = rigRepo.addNode(rig1.id, "dev-impl", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node1.id, "dev.impl@my-rig");

    const rig2 = rigRepo.createRig("other-rig");
    const node2 = rigRepo.addNode(rig2.id, "dev-impl2", { role: "worker", runtime: "claude-code" });
    sessionRegistry.registerSession(node2.id, "dev.impl@my-rig");

    const store = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/tail");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("ambiguous");
  });

  it("GET /grep with invalid regex returns 400", async () => {
    const { store } = seedRigWithTranscript("content");
    const app = createApp({ db, rigRepo, sessionRegistry, transcriptStore: store });

    const res = await app.request("/api/transcripts/dev.impl@my-rig/grep?pattern=[invalid");
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid grep pattern");
  });
});
