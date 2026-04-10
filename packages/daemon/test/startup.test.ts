import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";
import type { ExecFn } from "../src/adapters/tmux.js";

function seedDbWithStaleSessions(dbPath: string, rigs: { rigName: string; logicalId: string; sessionName: string }[]) {
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema, nodeSpecFieldsSchema, checkpointsSchema, agentspecRebootSchema]);
  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);

  for (const r of rigs) {
    const rig = rigRepo.createRig(r.rigName);
    const node = rigRepo.addNode(rig.id, r.logicalId);
    const session = sessionRegistry.registerSession(node.id, r.sessionName);
    sessionRegistry.updateStatus(session.id, "running");
  }

  db.close();
}

describe("createDaemon startup composition", () => {
  it("calls cmuxAdapter.connect() during startup", async () => {
    const connectCalled = vi.fn();
    const cmuxFactory: CmuxTransportFactory = async () => {
      connectCalled();
      const err = new Error("no socket") as Error & { code?: string };
      err.code = "ENOENT";
      throw err;
    };
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxFactory, tmuxExec });

    // Factory was called during startup (connect() invoked)
    expect(connectCalled).toHaveBeenCalled();

    db.close();
  });

  it("createDaemon app: GET /api/rigs/:rigId/sessions returns 200 (session routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    // Seed a rig so the sessions endpoint has something to query
    const rig = deps.rigRepo.createRig("r01");

    const res = await app.request(`/api/rigs/${rig.id}/sessions`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);

    db.close();
  });

  it("createDaemon app: GET /api/adapters/cmux/status returns 200 (adapter routes mounted)", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxFactory, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("available");

    db.close();
  });

  it("createDaemon wires node cmux service for POST /api/rigs/:rigId/nodes/:logicalId/open-cmux", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => ({
      request: async (method: string) => {
        if (method === "capabilities") return { capabilities: ["workspace.current", "surface.create", "surface.focus"] };
        if (method === "workspace.current") return { workspace_id: "workspace:1" };
        if (method === "surface.create") return { created_surface_ref: "surface:99" };
        return {};
      },
      close: () => {},
    });
    const tmuxExec: ExecFn = async () => "";

    const { app, db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
    const rig = deps.rigRepo.createRig("r01");
    const node = deps.rigRepo.addNode(rig.id, "dev1-impl");
    deps.sessionRegistry.registerSession(node.id, "r01-dev1-impl");
    deps.sessionRegistry.updateBinding(node.id, {
      attachmentType: "tmux",
      tmuxSession: "r01-dev1-impl",
    });

    const res = await app.request(`/api/rigs/${rig.id}/nodes/dev1-impl/open-cmux`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["action"]).toBe("created_new");

    const binding = deps.sessionRegistry.getBindingForNode(node.id);
    expect(binding?.cmuxWorkspace).toBe("workspace:1");
    expect(binding?.cmuxSurface).toBe("surface:99");

    db.close();
  });

  it("createDaemon accepts cmuxExec, connect() issues 'cmux capabilities --json' through it", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxExec, tmuxExec });

    // The injected cmuxExec was called during startup connect()
    // It should have been called with 'cmux capabilities --json' (via the transport factory)
    expect(cmuxExec).toHaveBeenCalled();
    const capCall = cmuxExec.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("cmux capabilities --json")
    );
    expect(capCall).toBeDefined();

    db.close();
  });

  it("createDaemon with cmuxExec that throws -> still degrades cleanly", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { app, db } = await createDaemon({ cmuxExec, tmuxExec });

    const res = await app.request("/api/adapters/cmux/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(false);

    db.close();
  });

  it("startup reconciles stale session: status=detached + event row in DB", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    // tmux reports no sessions (session is gone)
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // After createDaemon returns, session should be detached
    const sessions = db.prepare("SELECT status FROM sessions").all() as { status: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.status).toBe("detached");

    // Event row should exist
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(1);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("startup reconciles multiple rigs: all stale sessions detached", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
      { rigName: "r02", logicalId: "dev2-impl", sessionName: "r02-dev2-impl" },
    ]);

    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

    // Both sessions should be detached
    const sessions = db.prepare("SELECT status FROM sessions ORDER BY session_name").all() as { status: string }[];
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.status).toBe("detached");
    expect(sessions[1]!.status).toBe("detached");

    // Both events should exist
    const events = db.prepare("SELECT type FROM events WHERE type = 'session.detached'").all();
    expect(events).toHaveLength(2);

    db.close();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("startup reconcile with empty DB runs without error", async () => {
    const tmuxExec: ExecFn = async () => "";
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const { db } = await createDaemon({ tmuxExec, cmuxExec });

    // No sessions, no events, no errors
    const sessions = db.prepare("SELECT * FROM sessions").all();
    expect(sessions).toHaveLength(0);

    db.close();
  });
});
