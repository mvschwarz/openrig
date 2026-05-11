import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectAllowlistedProviderAuthEnv, createDaemon } from "../src/startup.js";
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
  // V0.3.1 slice 05 kernel-rig-as-default — startup tests construct
  // the daemon without booting the kernel rig. The kernel-boot path
  // is exercised separately in kernel-boot.test.ts (unit) +
  // kernel-rig-spec-validate.test.ts (variant gate); these tests
  // assert the surrounding daemon-composition contract, so the
  // OPENRIG_NO_KERNEL=1 escape hatch keeps them fast + deterministic
  // regardless of the host's runtime-auth state.
  beforeAll(() => {
    process.env.OPENRIG_NO_KERNEL = "1";
  });
  afterAll(() => {
    delete process.env.OPENRIG_NO_KERNEL;
  });

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

  it("createDaemon queue validation accepts first-class human seats without a materialized kernel rig", async () => {
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec: ExecFn = async () => "";

    const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });

    const canonical = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human-operator@kernel",
      body: "human gate smoke",
      tier: "human-gate",
      nudge: false,
    });
    const generic = await deps.queueRepo.create({
      sourceSession: "dev-qa@implementation-pair",
      destinationSession: "human@host",
      body: "human host smoke",
      tier: "human-gate",
      nudge: false,
    });

    expect(canonical.destinationSession).toBe("human-operator@kernel");
    expect(generic.destinationSession).toBe("human@host");
    await expect(
      deps.queueRepo.create({
        sourceSession: "dev-qa@implementation-pair",
        destinationSession: "driver@phantom-rig",
        body: "must still reject phantom rigs",
        nudge: false,
      }),
    ).rejects.toThrow(/unknown rig/);

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

  it("passes daemon CLI reachability env and PATH into launched tmux sessions", async () => {
    vi.stubEnv("PATH", "/proof/openrig/bin:/usr/bin:/bin");
    vi.stubEnv("OPENRIG_PORT", "17433");
    vi.stubEnv("OPENRIG_HOST", "127.0.0.1");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec = vi.fn<ExecFn>(async () => "");

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("path-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "codex" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = tmuxExec.mock.calls
        .map((call) => call[0])
        .find((cmd) => cmd.includes("tmux new-session"));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-e 'PATH=/proof/openrig/bin:/usr/bin:/bin'");
      expect(newSessionCmd).toContain("-e 'OPENRIG_PORT=17433'");
      expect(newSessionCmd).toContain("-e 'OPENRIG_HOST=127.0.0.1'");

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("passes only explicitly allowlisted provider auth env into launched tmux sessions", async () => {
    vi.stubEnv("OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,OPENAI_API_KEY,BOGUS_TOKEN");
    vi.stubEnv("ANTHROPIC_API_KEY", "anthropic-test-key");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-test-token");
    vi.stubEnv("OPENAI_API_KEY", "openai-test-key");
    vi.stubEnv("BOGUS_TOKEN", "must-not-leak");
    const cmuxFactory: CmuxTransportFactory = async () => {
      throw Object.assign(new Error(""), { code: "ENOENT" });
    };
    const tmuxExec = vi.fn<ExecFn>(async () => "");

    try {
      const { db, deps } = await createDaemon({ cmuxFactory, tmuxExec });
      const rig = deps.rigRepo.createRig("provider-auth-env-rig");
      deps.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code" });

      const result = await deps.nodeLauncher.launchNode(rig.id, "worker");

      expect(result.ok).toBe(true);
      const newSessionCmd = tmuxExec.mock.calls
        .map((call) => call[0])
        .find((cmd) => cmd.includes("tmux new-session"));
      expect(newSessionCmd).toBeDefined();
      expect(newSessionCmd).toContain("-e 'ANTHROPIC_API_KEY=anthropic-test-key'");
      expect(newSessionCmd).toContain("-e 'CLAUDE_CODE_OAUTH_TOKEN=claude-oauth-test-token'");
      expect(newSessionCmd).toContain("-e 'OPENAI_API_KEY=openai-test-key'");
      expect(newSessionCmd).not.toContain("BOGUS_TOKEN");

      db.close();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("collectAllowlistedProviderAuthEnv ignores empty, invalid, and unknown names", () => {
    expect(collectAllowlistedProviderAuthEnv(
      "ANTHROPIC_API_KEY, nope, ../BAD, OPENAI_API_KEY, BOGUS_TOKEN, CLAUDE_CODE_OAUTH_TOKEN",
      {
        ANTHROPIC_API_KEY: "anthropic-test-key",
        OPENAI_API_KEY: "",
        BOGUS_TOKEN: "must-not-leak",
        CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
      },
    )).toEqual({
      ANTHROPIC_API_KEY: "anthropic-test-key",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-test-token",
    });
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

  it("createDaemon accepts cmuxExec, connect() probes the live cmux surface through it", async () => {
    const cmuxExec = vi.fn<ExecFn>().mockRejectedValue(
      Object.assign(new Error("command not found"), { code: "ENOENT" })
    );
    const tmuxExec: ExecFn = async () => "";

    const { db } = await createDaemon({ cmuxExec, tmuxExec });

    // The injected cmuxExec was called during startup connect().
    // The transport now probes the live command surface via `cmux --help`
    // before issuing version-adaptive requests.
    expect(cmuxExec).toHaveBeenCalled();
    const helpCall = cmuxExec.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("cmux --help")
    );
    expect(helpCall).toBeDefined();

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

    // tmux reports no sessions (session is gone):
    // list-sessions returns empty; has-session throws (session not found)
    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
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

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
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

  // L1 cold-start tmux truth repair: startup must surface a compact reconcile
  // summary so silent reconciliation drift is visible in daemon output.
  it("startup logs compact reconcile summary line", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const dbPath = path.join(tmpDir, "test.sqlite");

    seedDbWithStaleSessions(dbPath, [
      { rigName: "r01", logicalId: "dev1-impl", sessionName: "r01-dev1-impl" },
    ]);

    const tmuxExec: ExecFn = async (cmd: string) => {
      if (cmd.includes("has-session")) throw new Error("session not found");
      return "";
    };
    const cmuxExec: ExecFn = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { db } = await createDaemon({ dbPath, tmuxExec, cmuxExec });

      const calls = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
      const summary = calls.find((line) => line.startsWith("startup reconcile:"));
      expect(summary).toBeDefined();
      expect(summary).toMatch(/rigs=1\b/);
      expect(summary).toMatch(/checked=1\b/);
      expect(summary).toMatch(/detached=1\b/);
      expect(summary).toMatch(/errors=0\b/);

      db.close();
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
