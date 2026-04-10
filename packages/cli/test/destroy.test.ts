import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  DESTROY_CONFIRM_TOKEN,
  buildBackupPath,
  buildDestroyPlan,
  executeDestroy,
  listManagedTmuxSessionsFromDb,
  type DestroyDeps,
} from "../src/destroy-helpers.js";
import { destroyCommand } from "../src/commands/destroy.js";

function captureLogs(fn: () => Promise<void>): Promise<{ logs: string[]; exitCode: number | undefined }> {
  return new Promise(async (resolve) => {
    const logs: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origExitCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const exitCode = process.exitCode;
    process.exitCode = origExitCode;
    resolve({ logs, exitCode });
  });
}

function makeDestroyDeps(overrides?: Partial<DestroyDeps>): DestroyDeps {
  return {
    stopDaemon: vi.fn(async () => {}),
    inspectListener: vi.fn(async () => ({ kind: "unreachable" as const })),
    findListeningPid: vi.fn(() => null),
    killProcess: vi.fn(),
    exists: vi.fn(() => false),
    renamePath: vi.fn(),
    removePath: vi.fn(),
    mkdirp: vi.fn(),
    listManagedTmuxSessions: vi.fn(() => []),
    killTmuxSession: vi.fn(() => true),
    sleep: vi.fn(async () => {}),
    now: vi.fn(() => new Date("2026-04-10T08:10:11Z")),
    ...overrides,
  };
}

describe("destroy helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "openrig-destroy-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildBackupPath appends timestamp and resolves collisions", () => {
    const target = join(tmpDir, ".openrig");
    const first = buildBackupPath(target, existsSync, new Date("2026-04-10T08:10:11Z"));
    expect(basename(first)).toMatch(/^\.openrig\.backup-20260410-\d{6}$/);

    mkdirSync(first, { recursive: true });
    const second = buildBackupPath(target, existsSync, new Date("2026-04-10T08:10:11Z"));
    expect(second).toBe(`${first}-2`);
  });

  it("listManagedTmuxSessionsFromDb returns distinct tmux-backed sessions", () => {
    const dbPath = join(tmpDir, "openrig.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE bindings (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        tmux_session TEXT,
        tmux_window TEXT,
        tmux_pane TEXT,
        cmux_workspace TEXT,
        cmux_surface TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        attachment_type TEXT NOT NULL DEFAULT 'tmux',
        external_session_name TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n1");
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n2");
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n3");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, attachment_type) VALUES (?, ?, ?, ?)")
      .run("b1", "n1", "orch1-lead@demo", "tmux");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, attachment_type) VALUES (?, ?, ?, ?)")
      .run("b2", "n2", "orch1-lead@demo", "tmux");
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)")
      .run("s3", "n3", "dev1-impl@demo");
    db.prepare("INSERT INTO bindings (id, node_id, attachment_type, external_session_name) VALUES (?, ?, ?, ?)")
      .run("b3", "n3", "external_cli", "ext-cli");
    db.close();

    expect(listManagedTmuxSessionsFromDb(dbPath)).toEqual(["orch1-lead@demo"]);
  });

  it("listManagedTmuxSessionsFromDb prefers the current session for a node over historical names", () => {
    const dbPath = join(tmpDir, "openrig-current.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE bindings (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        tmux_session TEXT,
        tmux_window TEXT,
        tmux_pane TEXT,
        cmux_workspace TEXT,
        cmux_surface TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        attachment_type TEXT NOT NULL DEFAULT 'tmux',
        external_session_name TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n1");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, created_at) VALUES (?, ?, ?, ?)")
      .run("s1", "n1", "old-name@demo", "2026-04-10T08:00:00Z");
    db.prepare("INSERT INTO sessions (id, node_id, session_name, created_at) VALUES (?, ?, ?, ?)")
      .run("s2", "n1", "current-name@demo", "2026-04-10T08:05:00Z");
    db.close();

    expect(listManagedTmuxSessionsFromDb(dbPath)).toEqual(["current-name@demo"]);
  });

  it("buildDestroyPlan includes external db/transcript targets outside state root", () => {
    const stateRoot = join(tmpDir, ".openrig");
    const externalDb = join(tmpDir, "custom", "openrig.sqlite");
    const externalTx = join(tmpDir, "custom", "transcripts");
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(join(tmpDir, "custom"), { recursive: true });
    writeFileSync(externalDb, "");
    mkdirSync(externalTx, { recursive: true });

    const deps = makeDestroyDeps({
      exists: (path: string) => existsSync(path),
      listManagedTmuxSessions: () => [],
    });

    const plan = buildDestroyPlan("state", true, {
      stateRoot,
      dbPath: externalDb,
      transcriptsPath: externalTx,
      daemonHost: "127.0.0.1",
      daemonPort: 7433,
    }, deps);

    expect(plan.targets.map((target) => target.kind)).toEqual(["state_root", "db_file", "transcripts_dir"]);
    expect(plan.warnings.length).toBe(2);
  });

  it("executeDestroy stops daemon, kills managed tmux sessions, backs up state root, and recreates it", async () => {
    const stateRoot = join(tmpDir, ".openrig");
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "daemon.json"), "{}");
    const dbPath = join(stateRoot, "openrig.sqlite");
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (id TEXT PRIMARY KEY);
      CREATE TABLE bindings (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        tmux_session TEXT,
        tmux_window TEXT,
        tmux_pane TEXT,
        cmux_workspace TEXT,
        cmux_surface TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        attachment_type TEXT NOT NULL DEFAULT 'tmux',
        external_session_name TEXT
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unknown',
        last_seen_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n1");
    db.prepare("INSERT INTO nodes (id) VALUES (?)").run("n2");
    db.prepare("INSERT INTO bindings (id, node_id, tmux_session, attachment_type) VALUES (?, ?, ?, ?)")
      .run("b1", "n1", "orch1-lead@demo", "tmux");
    db.prepare("INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)")
      .run("s2", "n2", "dev1-impl@demo");
    db.close();

    const deps = makeDestroyDeps({
      exists: (path: string) => existsSync(path),
      renamePath: (from: string, to: string) => renameSync(from, to),
      mkdirp: (path: string) => mkdirSync(path, { recursive: true }),
      listManagedTmuxSessions: listManagedTmuxSessionsFromDb,
      killTmuxSession: (sessionName: string) => sessionName !== "dev1-impl@demo",
      inspectListener: vi.fn()
        .mockResolvedValueOnce({ kind: "openrig" })
        .mockResolvedValueOnce({ kind: "unreachable" })
        .mockResolvedValueOnce({ kind: "unreachable" }),
      findListeningPid: () => 1234,
    });

    const plan = buildDestroyPlan("all", true, {
      stateRoot,
      dbPath,
      transcriptsPath: join(stateRoot, "transcripts"),
      daemonHost: "127.0.0.1",
      daemonPort: 7433,
    }, deps);

    const result = await executeDestroy(plan, deps);
    expect(result.daemonStopped).toBe(true);
    expect(result.portCleared).toBe(true);
    expect(result.stateRecreated).toBe(true);
    expect(result.tmuxKilled).toBe(1);
    expect(result.tmuxMissing).toBe(1);
    expect(result.backupPaths).toHaveLength(1);
    expect(existsSync(stateRoot)).toBe(true);
    expect(deps.killProcess).toHaveBeenCalledWith(1234);
  });

  it("executeDestroy leaves state untouched when a local listener is still live but cannot be safely cleared", async () => {
    const stateRoot = join(tmpDir, ".openrig-live");
    mkdirSync(stateRoot, { recursive: true });
    const removePath = vi.fn();
    const mkdirp = vi.fn();
    const deps = makeDestroyDeps({
      exists: () => true,
      removePath,
      mkdirp,
      inspectListener: vi.fn(async () => ({ kind: "openrig" })),
      findListeningPid: () => null,
    });

    const result = await executeDestroy({
      scope: "state",
      backup: false,
      stateRoot,
      daemonHost: "127.0.0.1",
      daemonPort: 7433,
      managedTmuxSessions: [],
      targets: [{ path: stateRoot, kind: "state_root" }],
      warnings: [],
    }, deps);

    expect(result.portCleared).toBe(false);
    expect(result.stateRecreated).toBe(false);
    expect(removePath).not.toHaveBeenCalled();
    expect(mkdirp).not.toHaveBeenCalled();
  });

  it("executeDestroy does not kill a live non-OpenRig HTTP listener", async () => {
    const killProcess = vi.fn();
    const deps = makeDestroyDeps({
      exists: () => true,
      removePath: vi.fn(),
      mkdirp: vi.fn(),
      inspectListener: vi.fn(async () => ({ kind: "other_http", detail: "HTTP 200" })),
      findListeningPid: () => 7777,
      killProcess,
    });

    const result = await executeDestroy({
      scope: "state",
      backup: false,
      stateRoot: join(tmpDir, ".openrig-http"),
      daemonHost: "127.0.0.1",
      daemonPort: 7433,
      managedTmuxSessions: [],
      targets: [{ path: join(tmpDir, ".openrig-http"), kind: "state_root" }],
      warnings: [],
    }, deps);

    expect(result.portCleared).toBe(false);
    expect(killProcess).not.toHaveBeenCalled();
  });

  it("executeDestroy does not enumerate or kill tmux sessions for --state", async () => {
    const stateRoot = join(tmpDir, ".openrig-state-only");
    mkdirSync(stateRoot, { recursive: true });
    const listManagedTmuxSessions = vi.fn(() => ["orchestrator@demo"]);
    const killTmuxSession = vi.fn(() => true);
    const deps = makeDestroyDeps({
      exists: () => true,
      removePath: vi.fn(),
      mkdirp: vi.fn(),
      listManagedTmuxSessions,
      killTmuxSession,
    });

    const plan = buildDestroyPlan("state", false, {
      stateRoot,
      dbPath: join(stateRoot, "openrig.sqlite"),
      transcriptsPath: join(stateRoot, "transcripts"),
      daemonHost: "127.0.0.1",
      daemonPort: 7433,
    }, deps);
    await executeDestroy(plan, deps);

    expect(listManagedTmuxSessions).not.toHaveBeenCalled();
    expect(killTmuxSession).not.toHaveBeenCalled();
  });

  it("executeDestroy does not report remote daemon targets as cleared", async () => {
    const deps = makeDestroyDeps({
      exists: () => false,
      mkdirp: vi.fn(),
    });

    const result = await executeDestroy({
      scope: "state",
      backup: false,
      stateRoot: join(tmpDir, ".openrig-remote"),
      daemonHost: "10.0.0.5",
      daemonPort: 7433,
      managedTmuxSessions: [],
      targets: [],
      warnings: [],
    }, deps);

    expect(result.daemonStopped).toBe(false);
    expect(result.portCleared).toBe(false);
    expect(result.stateRecreated).toBe(false);
  });
});

describe("destroy command", () => {
  it("requires exactly one destroy scope", async () => {
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/db" }, transcripts: { enabled: true, path: "/tmp/tx" } }) },
      destroyDeps: makeDestroyDeps(),
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "destroy", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Specify exactly one destroy scope");
  });

  it("requires explicit confirmation token", async () => {
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/db" }, transcripts: { enabled: true, path: "/tmp/tx" } }) },
      destroyDeps: makeDestroyDeps(),
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "destroy", "--state", "--yes", "--confirm", "wrong"]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain(`Destroy requires: --confirm ${DESTROY_CONFIRM_TOKEN}`);
  });

  it("requires --yes", async () => {
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/db" }, transcripts: { enabled: true, path: "/tmp/tx" } }) },
      destroyDeps: makeDestroyDeps(),
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "destroy", "--state", "--confirm", DESTROY_CONFIRM_TOKEN]);
    });

    expect(exitCode).toBe(1);
    expect(logs.join("\n")).toContain("Destroy requires --yes");
  });

  it("runs destroy with backup mode and prints plan/result", async () => {
    const destroyDeps = makeDestroyDeps({
      exists: vi.fn(() => false),
      mkdirp: vi.fn(),
    });
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({
      configStore: { resolve: () => ({ daemon: { port: 7433, host: "127.0.0.1" }, db: { path: "/tmp/db" }, transcripts: { enabled: true, path: "/tmp/tx" } }) },
      destroyDeps,
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "destroy", "--state", "--backup", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);
    });

    expect(exitCode).toBeUndefined();
    const output = logs.join("\n");
    expect(output).toContain("DESTROY PLAN");
    expect(output).toContain("scope: state");
    expect(output).toContain("DESTROY RESULT");
    expect(output).toContain("fresh state root:");
  });

  it("falls back to compatibility defaults when config resolution is malformed", async () => {
    const destroyDeps = makeDestroyDeps({
      exists: vi.fn(() => false),
      mkdirp: vi.fn(),
    });
    const program = new Command();
    program.exitOverride();
    program.addCommand(destroyCommand({
      configStore: { resolve: () => { throw new Error("bad config json"); } },
      destroyDeps,
    }));

    const { logs, exitCode } = await captureLogs(async () => {
      await program.parseAsync(["node", "rig", "destroy", "--state", "--yes", "--confirm", DESTROY_CONFIRM_TOKEN]);
    });

    expect(exitCode).toBeUndefined();
    expect(logs.join("\n")).toContain("DESTROY PLAN");
    expect(logs.join("\n")).toContain("bad config json");
  });
});
