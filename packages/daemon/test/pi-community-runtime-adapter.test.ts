import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { PiCommunityRuntimeAdapter } from "../src/adapters/pi-community-runtime-adapter.js";
import { withCommunityHarnesses, seatAdapter, withCommunityHarnessResolver } from "../src/adapters/community-harness-runtime-adapter.js";
import { piSeatPaths, buildPendingRunnerState } from "../src/adapters/pi-runner-protocol.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { activityRoutes } from "../src/routes/activity.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { AgentActivityStore, isRunnerExit } from "../src/domain/agent-activity-store.js";
import { communityHarnessStopsRestore } from "../src/domain/community-harness-presets.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { RigEvent } from "../src/domain/types.js";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-community-test-"));
  const presetsDir = join(root, "community-harnesses");
  const stateRoot = join(root, "state", "pi");
  const files: Record<string, string> = {};

  const fsOps = {
    readFile: (p: string) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    writeFile: (p: string, c: string) => { files[p] = c; },
    exists: (p: string) => p in files,
    mkdirp: (_p: string) => {},
    listFiles: (_dir: string) => [] as string[],
    statMode: (_p: string) => 0o644,
    chmod: (_p: string, _m: number) => {},
  };

  const tmux = {
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "node"),
    sendShellCommand: vi.fn(async () => ({ ok: true as const, code: "ok" })),
    capturePaneContent: vi.fn(async () => "[pi-runner] READY"),
    listPanes: vi.fn(async () => [{ id: "%1" }]),
  };

  const piAdapter = new PiRuntimeAdapter({
    tmux: tmux as any,
    fsOps,
    stateRoot,
    runnerEntryPath: "/dist/adapters/pi-runner.js",
    trustPosture: "no-approve",
    sleep: async () => {},
    newLaunchId: () => "test-launch-id-1",
  });

  return {
    root,
    presetsDir,
    stateRoot,
    files,
    fsOps,
    tmux,
    piAdapter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("PiCommunityRuntimeAdapter", () => {
  it("resolves through withCommunityHarnesses when protocol: pi-rpc is declared", () => {
    const f = makeFixture();
    try {
      const dir = f.presetsDir;
      const omoYaml = "format: 1\nname: omo\ncommand: omo\nmaintainer: OmO Team\nlimits: []\nprotocol: pi-rpc\n";
      const { mkdirSync } = require("node:fs");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "omo.yaml"), omoYaml);

      const map = withCommunityHarnesses({ pi: f.piAdapter }, { tmux: f.tmux as any, presetsDir: () => dir, piAdapter: f.piAdapter });
      const adapter = map["omo"];
      expect(adapter).toBeInstanceOf(PiCommunityRuntimeAdapter);
      expect(adapter?.runtime).toBe("omo");
      expect((adapter as PiCommunityRuntimeAdapter).communityHarness).toBe("omo");
    } finally {
      f.cleanup();
    }
  });

  it("launches harness via pi-runner with --command and captures session token", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      expect(adapter.runtime).toBe("omo");

      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0197-test.jsonl");

      // Simulate pi-runner writing ready sidecar upon launch
      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile,
          updatedAt: new Date().toISOString(),
        });
        f.files[sessionFile] = '{"type":"session_start"}';
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
        model: "anthropic/claude-3-5-sonnet",
        effort: "high",
        launchGeneration: "gen-1",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resumeToken).toBe(sessionFile);
        expect(result.resumeType).toBe("community:omo");
      }

      // Verify the command typed into tmux pane
      expect(f.tmux.sendShellCommand).toHaveBeenCalled();
      const sentCmd = f.tmux.sendShellCommand.mock.calls[0]![1];
      expect(sentCmd).toContain("--command 'omo'");
      expect(sentCmd).toContain("--session-name 'omo-seat@rig'");
      expect(sentCmd).toContain("--no-approve");
      expect(sentCmd).toContain("--model 'anthropic/claude-3-5-sonnet'");
      expect(sentCmd).toContain("--thinking 'high'");
    } finally {
      f.cleanup();
    }
  });

  it("resumes an existing session via --session and returns community:<runtime>", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0197-test.jsonl");
      f.files[sessionFile] = '{"type":"session_start"}';

      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile,
          updatedAt: new Date().toISOString(),
        });
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
        launchGeneration: "gen-2",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName, resumeToken: sessionFile });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.resumeToken).toBe(sessionFile);
        expect(result.resumeType).toBe("community:omo");
      }

      const sentCmd = f.tmux.sendShellCommand.mock.calls[0]![1];
      expect(sentCmd).toContain(`--session '${sessionFile}'`);
    } finally {
      f.cleanup();
    }
  });

  it("fails resume honestly when the session file is missing (retry_fresh)", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const sessionFile = "/state/pi/omo-seat@rig/sessions/missing.jsonl";

      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName, resumeToken: sessionFile });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        recovery: "retry_fresh",
        missingConversation: true,
      });
      expect(f.tmux.sendShellCommand).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("checks readiness through runner sidecar and pane markers", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo",
        command: "omo",
        maintainer: "OmO Team",
        limits: [],
        protocol: "pi-rpc" as const,
        launchResult: false,
        namesConversation: false,
        resume: true,
        startupAssisted: false,
        firstInput: false,
        passesModel: false,
        runner: false,
        path: "/fake/omo.yaml",
      };

      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const binding: NodeBinding = {
        id: "b1",
        nodeId: "node-1",
        tmuxSession: sessionName,
        tmuxPane: "%1",
        cwd: "/workspace",
      };

      // Not ready when sidecar is missing
      f.tmux.capturePaneContent.mockResolvedValueOnce("");
      expect(await adapter.checkReady(binding)).toMatchObject({ ready: false });

      // Ready when sidecar is ready
      f.files[paths.runnerStatePath] = JSON.stringify({
        ready: true,
        updatedAt: new Date().toISOString(),
      });
      expect(await adapter.checkReady(binding)).toEqual({ ready: true });

      // Not ready when exited
      f.files[paths.runnerStatePath] = JSON.stringify({
        ready: false,
        updatedAt: new Date().toISOString(),
        exited: { code: 1, at: new Date().toISOString() },
      });
      expect(await adapter.checkReady(binding)).toMatchObject({ ready: false, code: "runner_exited" });
    } finally {
      f.cleanup();
    }
  });

  it("passes the Pi adapter's guidance-block records and state roots to the fork (#2461)", () => {
    const f = makeFixture();
    try {
      const records = { read: vi.fn(), write: vi.fn() };
      const stateRootForSession = (session: string) => join(f.stateRoot, "by-session", session);
      const pi = new PiRuntimeAdapter({ ...f.piAdapter.getCommunityDeps(), managedBlockRecords: records as never, stateRootForSession });
      const deps = pi.getCommunityDeps();
      expect(deps.managedBlockRecords).toBe(records);
      expect(deps.stateRootForSession?.("omo-seat@rig")).toBe(join(f.stateRoot, "by-session", "omo-seat@rig"));
    } finally {
      f.cleanup();
    }
  });

  it("declares runner() as true so launch records community_runner", () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo", command: "omo", maintainer: "OmO Team", limits: [],
        protocol: "pi-rpc" as const, launchResult: false, namesConversation: false,
        resume: true, startupAssisted: false, firstInput: false, runner: false, passesModel: false, path: "/fake/omo.yaml",
      };
      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      expect(adapter.runner()).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("refuses resume when reported session file mismatches requested (request A, report B)", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo", command: "omo", maintainer: "OmO Team", limits: [],
        protocol: "pi-rpc" as const, launchResult: false, namesConversation: false,
        resume: true, startupAssisted: false, firstInput: false, runner: false, passesModel: false, path: "/fake/omo.yaml",
      };
      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(f.piAdapter, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFileA = join(paths.sessionsDir, "0001-requested-a.jsonl");
      const sessionFileB = join(paths.sessionsDir, "0002-reported-b.jsonl");
      f.files[sessionFileA] = '{"type":"session_start"}';
      f.files[sessionFileB] = '{"type":"session_start"}';

      // Runner becomes ready, but reports sessionFileB instead of requested sessionFileA
      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile: sessionFileB,
          updatedAt: new Date().toISOString(),
        });
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1", nodeId: "node-1", tmuxSession: sessionName, tmuxPane: "%1", cwd: "/workspace",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName, resumeToken: sessionFileA });
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({
        ok: false,
        error: "omo resume: the runner is ready but does not report the requested session file",
      });
    } finally {
      f.cleanup();
    }
  });

  it("wraps the launch command with seatLaunchEnvironment for pi-rpc community harnesses", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo", command: "omo", maintainer: "OmO Team", limits: [],
        protocol: "pi-rpc" as const, launchResult: false, namesConversation: false,
        resume: true, startupAssisted: false, firstInput: false, runner: false, passesModel: false, path: "/fake/omo.yaml",
      };
      const envWrap = vi.fn(async (_session: string, cmd: string, _ctx: unknown) => `/usr/bin/wrapped ${cmd}`);
      const piAdapterWithEnv = new PiRuntimeAdapter({
        ...f.piAdapter.getCommunityDeps(),
        seatLaunchEnvironment: { command: envWrap, accountHome: () => undefined } as any,
      });
      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(piAdapterWithEnv, "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0001-test.jsonl");
      f.files[sessionFile] = '{"type":"session_start"}';

      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({
          ready: true,
          launchId: "test-launch-id-1",
          sessionFile,
          updatedAt: new Date().toISOString(),
        });
        return { ok: true, code: "ok" };
      });

      const binding: NodeBinding = {
        id: "b1", nodeId: "node-1", tmuxSession: sessionName, tmuxPane: "%1", cwd: "/workspace", launchGeneration: "gen-env",
      };

      const result = await adapter.launchHarness(binding, { name: sessionName });
      expect(result.ok).toBe(true);
      expect(envWrap).toHaveBeenCalledWith(sessionName, expect.any(String), {
        nodeId: "node-1",
        generation: "gen-env",
        runtime: "omo",
      });
      const sentCmd = f.tmux.sendShellCommand.mock.calls[0]![1];
      expect(sentCmd).toMatch(/^\/usr\/bin\/wrapped node/);
    } finally {
      f.cleanup();
    }
  });

  it("a pi-rpc fork launch whose binding carries accountHome: null builds no --account-home", async () => {
    const f = makeFixture();
    try {
      const preset = {
        name: "omo", command: "omo", maintainer: "OmO Team", limits: [],
        protocol: "pi-rpc" as const, launchResult: false, namesConversation: false,
        resume: true, startupAssisted: false, firstInput: false, runner: false, passesModel: false, launchWrapper: false, path: "/fake/omo.yaml",
      };
      const envWrap = vi.fn(async (_session: string, cmd: string, _ctx: unknown) => `/usr/bin/wrapped ${cmd}`);
      // As in production, asking again for a runtime other than pi can answer with another runtime's home.
      const accountHome = vi.fn((_nodeId: string, _runtime: string, ignoreAccountHome?: boolean) => ignoreAccountHome ? "/home/claude-config" : undefined);
      const adapter = PiCommunityRuntimeAdapter.fromPiAdapter(new PiRuntimeAdapter({
        ...f.piAdapter.getCommunityDeps(),
        seatLaunchEnvironment: { command: envWrap, accountHome } as any,
      }), "omo", preset);
      const sessionName = "omo-seat@rig";
      const paths = piSeatPaths(f.stateRoot, sessionName);
      const sessionFile = join(paths.sessionsDir, "0001-test.jsonl");
      f.files[sessionFile] = '{"type":"session_start"}';
      f.tmux.sendShellCommand.mockImplementation(async () => {
        f.files[paths.runnerStatePath] = JSON.stringify({ ready: true, launchId: "test-launch-id-1", sessionFile, updatedAt: new Date().toISOString() });
        return { ok: true, code: "ok" };
      });
      const binding: NodeBinding = {
        id: "b1", nodeId: "node-1", tmuxSession: sessionName, tmuxPane: "%1", cwd: "/workspace", launchGeneration: "gen-env", accountHome: null,
      } as NodeBinding;

      expect((await adapter.launchHarness(binding, { name: sessionName })).ok).toBe(true);
      expect(envWrap.mock.calls[0]![1]).not.toContain("--account-home");
      expect((f.tmux.sendShellCommand.mock.calls[0] as unknown[])[1]).not.toContain("--account-home");
      expect(accountHome).not.toHaveBeenCalled();
    } finally {
      f.cleanup();
    }
  });

  it("identity post stores community:<name>, restore plan resumes, quiet turn reads idle, exit reads exited", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, node_id TEXT, session_name TEXT, resume_type TEXT,
          resume_token TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT,
          resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_token TEXT,
          agent_app TEXT, agent_runner INTEGER);
        CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
        CREATE TABLE occupant_tenures (id TEXT, node_id TEXT, generation_ordinal INTEGER,
          generation_uuid TEXT, kind TEXT, native_session_id_at_boot TEXT, boot_at TEXT);
        INSERT INTO nodes VALUES ('omo-node', 'rig', 'omo');
        INSERT INTO sessions (id, node_id, session_name, agent_app, agent_runner) VALUES (1, 'omo-node', 'worker@omo-test', 'omo', 2);
        INSERT INTO occupant_tenures VALUES ('current', 'omo-node', 1, 'omo-gen-1', 'initial', NULL, '2026-10-31');
      `);

      const events: RigEvent[] = [];
      const insertEvent = db.prepare("INSERT INTO events (node_id, type, payload) VALUES (?, ?, ?)");
      const eventBus = {
        emit(e: RigEvent) {
          events.push(e);
          insertEvent.run((e as any).nodeId, e.type, JSON.stringify((e as any).activity ? { sessionName: (e as any).sessionName, activity: (e as any).activity } : e));
          return e;
        },
      } as EventBus;
      const registry = new SessionRegistry(db);
      const store = new AgentActivityStore({
        db,
        eventBus,
        resolveOccupantGeneration: (nodeId) => registry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
        isRegisteredOccupantGeneration: (nodeId, gen) => registry.isOccupantGenerationRegistered(nodeId, gen),
      });

      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("agentActivityStore" as never, store as never);
        c.set("sessionRegistry" as never, registry as never);
        c.set("eventBus" as never, eventBus as never);
        c.set("activityHookToken" as never, "fixture-token" as never);
        await next();
      });
      app.route("/api/activity", activityRoutes);

      const sessionFile = "/fixture/state/pi/worker@omo-test/sessions/001.jsonl";

      // 1. Runner posts session identity
      const res = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          eventFamily: "session_identity",
          runtime: "omo",
          nodeId: "omo-node",
          sessionName: "worker@omo-test",
          sessionId: "omo-sess-1",
          sessionFile,
          generation: "omo-gen-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, tokenPersisted: true, provenance: "rpc" });

      // Verifies community:omo is stored, NOT pi_session_file
      const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = 1").get() as any;
      expect(sessionRow.resume_type).toBe("community:omo");
      expect(sessionRow.resume_token).toBe(sessionFile);

      // 2. Restore plan resumes (communityHarnessStopsRestore is false)
      const presetsDir = mkdtempSync(join(tmpdir(), "omo-preset-"));
      try {
        writeFileSync(join(presetsDir, "omo.yaml"), "format: 1\nname: omo\ncommand: omo\nmaintainer: OmO\nprotocol: pi-rpc\nresume: true\nlimits: []\n");
        const stops = communityHarnessStopsRestore("omo", sessionRow.resume_type, sessionRow.resume_token, presetsDir);
        expect(stops).toBe(false); // Resumes!
      } finally {
        rmSync(presetsDir, { recursive: true, force: true });
      }

      // 3. A quiet turn reads idle
      const quietHook = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          runtime: "omo",
          nodeId: "omo-node",
          sessionName: "worker@omo-test",
          hookEvent: "Stop",
          subtype: null,
          generation: "omo-gen-1",
        }),
      });
      expect(quietHook.status).toBe(200);
      const latestQuiet = store.getLatestForNode({ nodeId: "omo-node", sessionName: "worker@omo-test" });
      expect(latestQuiet?.state).toBe("idle");

      // 4. An exit reads exited (isRunnerExit matches omo_exited on community_runner session)
      const exitHook = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          runtime: "omo",
          nodeId: "omo-node",
          sessionName: "worker@omo-test",
          hookEvent: "Stop",
          subtype: "omo_exited",
          generation: "omo-gen-1",
        }),
      });
      expect(exitHook.status).toBe(200);
      const latestExit = store.getLatestForNode({ nodeId: "omo-node", sessionName: "worker@omo-test" });
      expect(isRunnerExit("omo_exited", "omo", true)).toBe(true);
      expect(latestExit?.state).toBe("unknown"); // Clears prompt state on exit
    } finally {
      db.close();
    }
  });

  it("identity post arriving before launch result confirmation stores community:<name>", async () => {
    const db = new Database(":memory:");
    const originalOpenRigHome = process.env.OPENRIG_HOME;
    const openrigHome = mkdtempSync(join(tmpdir(), "openrig-home-"));
    try {
      process.env.OPENRIG_HOME = openrigHome;
      const harnessDir = join(openrigHome, "community-harnesses");
      mkdirSync(harnessDir, { recursive: true });
      writeFileSync(
        join(harnessDir, "omo.yaml"),
        "format: 1\nname: omo\ncommand: omo\nmaintainer: OmO\nprotocol: pi-rpc\nresume: true\nlimits: []\n",
      );

      db.exec(`
        CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, node_id TEXT, session_name TEXT, resume_type TEXT,
          resume_token TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT,
          resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_token TEXT,
          agent_app TEXT, agent_runner INTEGER);
        CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
        CREATE TABLE occupant_tenures (id TEXT, node_id TEXT, generation_ordinal INTEGER,
          generation_uuid TEXT, kind TEXT, native_session_id_at_boot TEXT, boot_at TEXT);
        INSERT INTO nodes VALUES ('omo-node', 'rig', 'omo');
        INSERT INTO sessions (id, node_id, session_name) VALUES (1, 'omo-node', 'worker@omo-test');
        INSERT INTO occupant_tenures VALUES ('current', 'omo-node', 1, 'omo-gen-1', 'initial', NULL, '2026-10-31');
      `);

      const events: RigEvent[] = [];
      const eventBus = { emit(e: RigEvent) { events.push(e); return e; } } as EventBus;
      const registry = new SessionRegistry(db);
      const store = new AgentActivityStore({ db, eventBus });

      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("agentActivityStore" as never, store as never);
        c.set("sessionRegistry" as never, registry as never);
        c.set("eventBus" as never, eventBus as never);
        c.set("activityHookToken" as never, "fixture-token" as never);
        await next();
      });
      app.route("/api/activity", activityRoutes);

      const sessionFile = "/fixture/state/pi/worker@omo-test/sessions/001.jsonl";

      // Identity post lands before recordCommunityHarnessSelection
      const res = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          eventFamily: "session_identity",
          runtime: "omo",
          nodeId: "omo-node",
          sessionName: "worker@omo-test",
          sessionId: "omo-sess-1",
          sessionFile,
          generation: "omo-gen-1",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ ok: true, tokenPersisted: true, provenance: "rpc" });

      // Then the launch records its protocol (agent_runner 2, OpenRig's hosted Pi-protocol runner)
      registry.recordCommunityHarnessSelection("1", "omo", "pi-rpc");

      const sessionRow = db.prepare("SELECT * FROM sessions WHERE id = 1").get() as any;
      expect(sessionRow.resume_type).toBe("community:omo");
      expect(sessionRow.resume_token).toBe(sessionFile);
      expect(sessionRow.agent_runner).toBe(2);
    } finally {
      if (originalOpenRigHome !== undefined) {
        process.env.OPENRIG_HOME = originalOpenRigHome;
      } else {
        delete process.env.OPENRIG_HOME;
      }
      rmSync(openrigHome, { recursive: true, force: true });
      db.close();
    }
  });

  it("a launch recorded as a plain preset (agent_runner 0) keeps off the Pi identity path after its preset is edited to pi-rpc", async () => {
    const db = new Database(":memory:");
    const originalOpenRigHome = process.env.OPENRIG_HOME;
    const openrigHome = mkdtempSync(join(tmpdir(), "openrig-home-"));
    try {
      process.env.OPENRIG_HOME = openrigHome;
      const harnessDir = join(openrigHome, "community-harnesses");
      mkdirSync(harnessDir, { recursive: true });
      // The installed preset now declares pi-rpc; the session's launch recorded a plain preset (0).
      writeFileSync(
        join(harnessDir, "omo.yaml"),
        "format: 1\nname: omo\ncommand: omo\nmaintainer: OmO\nprotocol: pi-rpc\nresume: true\nlimits: []\n",
      );
      db.exec(`
        CREATE TABLE nodes (id TEXT, rig_id TEXT, runtime TEXT);
        CREATE TABLE sessions (id INTEGER PRIMARY KEY, node_id TEXT, session_name TEXT, resume_type TEXT,
          resume_token TEXT, resume_provenance TEXT, resume_last_verified TEXT, resume_last_probe_status TEXT,
          resume_rotated_from TEXT, resume_rotated_process TEXT, resume_launch_token TEXT,
          agent_app TEXT, agent_runner INTEGER);
        CREATE TABLE events (seq INTEGER PRIMARY KEY, node_id TEXT, type TEXT, payload TEXT);
        CREATE TABLE occupant_tenures (id TEXT, node_id TEXT, generation_ordinal INTEGER,
          generation_uuid TEXT, kind TEXT, native_session_id_at_boot TEXT, boot_at TEXT);
        INSERT INTO nodes VALUES ('omo-node', 'rig', 'omo');
        INSERT INTO sessions (id, node_id, session_name, agent_app, agent_runner) VALUES (1, 'omo-node', 'worker@omo-test', 'omo', 0);
        INSERT INTO occupant_tenures VALUES ('current', 'omo-node', 1, 'omo-gen-1', 'initial', NULL, '2026-10-31');
      `);
      const eventBus = { emit(e: RigEvent) { return e; } } as EventBus;
      const registry = new SessionRegistry(db);
      const store = new AgentActivityStore({ db, eventBus });
      const app = new Hono();
      app.use("*", async (c, next) => {
        c.set("agentActivityStore" as never, store as never);
        c.set("sessionRegistry" as never, registry as never);
        c.set("eventBus" as never, eventBus as never);
        c.set("activityHookToken" as never, "fixture-token" as never);
        await next();
      });
      app.route("/api/activity", activityRoutes);

      const res = await app.request("/api/activity/hooks", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer fixture-token" },
        body: JSON.stringify({
          eventFamily: "session_identity", runtime: "omo", nodeId: "omo-node", sessionName: "worker@omo-test",
          sessionId: "omo-sess-1", sessionFile: "/fixture/state/pi/worker@omo-test/sessions/001.jsonl", generation: "omo-gen-1",
        }),
      });

      expect(await res.json()).not.toMatchObject({ provenance: "rpc" });
      expect(db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = 1").get()).toEqual({ resume_type: null, resume_token: null });
    } finally {
      if (originalOpenRigHome !== undefined) {
        process.env.OPENRIG_HOME = originalOpenRigHome;
      } else {
        delete process.env.OPENRIG_HOME;
      }
      rmSync(openrigHome, { recursive: true, force: true });
      db.close();
    }
  });
});
