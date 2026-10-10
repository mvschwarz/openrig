// A rig brought up again under the same name archives the stopped one, and both rows keep the name.
// Lookups by rig name must answer for the active rig, not the archived one: rig ask, the queue's
// target_repo check, the workflow role and member probes, and rig whoami --session. An archived
// rig still answers when it is the only one with that name.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { workspacePrimitiveSchema } from "../src/db/migrations/038_workspace_primitive.js";
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { AskService } from "../src/domain/ask-service.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { TranscriptStore } from "../src/domain/transcript-store.js";
import { WhoamiService } from "../src/domain/whoami-service.js";
import { queueRoutes } from "../src/routes/queue.js";
import {
  rigMemberExists,
  roleResolutionContext,
  tryResolveRoleByCapability,
} from "../src/domain/workflow-role-context.js";

const RIG = "acme";

describe("archived rig sharing a name with the active rig", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let podRepo: PodRepository;
  let sessionSeq = 0;

  function seat(rigId: string, member: string, status: string, role = "builder"): void {
    const pod = podRepo.getPodByNamespace(rigId, "dev") ?? podRepo.createPod(rigId, "dev", "dev");
    const node = rigRepo.addNode(rigId, `dev.${member}`, {
      role,
      runtime: "claude-code",
      cwd: "/tmp",
      podId: pod.id,
      agentRef: "local:agents/x",
      profile: "default",
    });
    sessionSeq += 1;
    db.prepare(`INSERT INTO sessions (id, node_id, session_name, status) VALUES (?, ?, ?, ?)`)
      .run(`s-${sessionSeq}`, node.id, `dev-${member}@${RIG}`, status);
  }

  let archivedId: string;
  let activeId: string;

  beforeEach(() => {
    db = createFullTestDb();
    migrate(db, [workspacePrimitiveSchema, queueTargetRepoSchema]);
    rigRepo = new RigRepository(db);
    podRepo = new PodRepository(db);
    // The earlier generation: one member, one repo; stopped, then archived by the relaunch.
    archivedId = rigRepo.createRig(RIG).id;
    seat(archivedId, "builder1", "exited");
    rigRepo.setRigWorkspace(archivedId, { workspaceRoot: "/w", repos: [{ name: "alpha", path: "/w/a", kind: "project" }] });
    rigRepo.archiveRig(archivedId);
    // The relaunched rig: a second member and a second repo.
    activeId = rigRepo.createRig(RIG).id;
    seat(activeId, "builder1", "running");
    seat(activeId, "builder2", "running");
    rigRepo.setRigWorkspace(activeId, {
      workspaceRoot: "/w",
      repos: [{ name: "alpha", path: "/w/a", kind: "project" }, { name: "beta", path: "/w/b", kind: "project" }],
    });
  });
  afterEach(() => db.close());

  it("rig ask answers for the active rig instead of calling the name ambiguous", async () => {
    const searchChat = vi.fn(() => []);
    const ask = new AskService({
      psProjectionService: { getEntries: () => [] },
      rigRepo,
      historyQuery: {
        search: vi.fn(async () => ({ backend: "rg" as const, excerpts: [], insufficient: true })),
        searchChat,
        searchSeat: vi.fn(),
        searchSession: vi.fn(),
      },
      transcriptsEnabled: true,
    });

    const result = await ask.ask(RIG, "what changed in the build");

    expect(result.guidance ?? "").not.toContain("ambiguous");
    expect(searchChat).toHaveBeenCalledWith(activeId, "what changed in the build");
  });

  it("queue create checks target_repo against the active rig's workspace", async () => {
    const bus = new EventBus(db);
    const queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
    const app = new Hono();
    app.use("*", async (c, next) => {
      const set = c.set.bind(c) as (k: string, v: unknown) => void;
      set("eventBus", bus);
      set("queueRepo", queueRepo);
      set("rigRepo", rigRepo);
      await next();
    });
    app.route("/api/queue", queueRoutes());

    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": `dev-builder1@${RIG}` },
      body: JSON.stringify({
        sourceSession: `dev-builder1@${RIG}`,
        destinationSession: `dev-builder2@${RIG}`,
        body: "x",
        targetRepo: "beta",
        nudge: false,
      }),
    });

    expect(res.status).toBe(201);
  });

  it("workflow probes see the active rig's members and live seats", () => {
    expect(rigMemberExists(db, RIG, `dev-builder2@${RIG}`)).toBe(true);
    expect(tryResolveRoleByCapability(roleResolutionContext(db, RIG), "builder")).toBe(`dev-builder1@${RIG}`);
  });

  it("rig whoami --session resolves to the active rig instead of calling the session ambiguous", () => {
    const whoami = new WhoamiService({
      db,
      rigRepo,
      sessionRegistry: new SessionRegistry(db),
      transcriptStore: new TranscriptStore({ transcriptsRoot: "/tmp/transcripts", enabled: true }),
    });

    const result = whoami.resolve({ sessionName: `dev-builder1@${RIG}`, compact: true });

    expect(result?.identity.rigId).toBe(activeId);
  });

  it("an archived rig still answers when no active rig has the name", () => {
    db.prepare("DELETE FROM sessions WHERE node_id IN (SELECT id FROM nodes WHERE rig_id = ?)").run(activeId);
    rigRepo.deleteRig(activeId);

    expect(rigMemberExists(db, RIG, `dev-builder1@${RIG}`)).toBe(true);
    expect(rigMemberExists(db, RIG, `dev-builder2@${RIG}`)).toBe(false);
  });
});
