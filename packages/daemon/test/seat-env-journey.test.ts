import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A rig that declares env: at rig and member level, driven through the real instantiate and the real
// restore, with tmux faked so the environment each seat's session is created with can be read back.

function mockTmux() {
  return {
    createSession: vi.fn(async (_name: string, _cwd?: string, _env?: Record<string, string>) => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    setSessionEnv: vi.fn(async (_session: string, _key: string, _value: string) => {}),
    unsetSessionEnv: vi.fn(async (_session: string, _key: string) => {}),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  };
}

function realFs(home: string): ClaudeAdapterFsOps {
  return {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    copyFile: (s, d) => fs.copyFileSync(s, d),
    listFiles: (dir) => (fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? fs.readdirSync(dir) : []),
    homedir: home,
  };
}

function noopAdapter(runtime: string): RuntimeAdapter {
  return {
    runtime,
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function wire(db: ReturnType<typeof createDb>, home: string) {
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const tmuxAdapter = tmux as unknown as TmuxAdapter;
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter, sleep: async () => {} });
  const claude = new ClaudeCodeAdapter({ tmux: tmuxAdapter, fsOps: realFs(home), sleep: async () => {} });
  const resolverFs: AgentResolverFsOps = { readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p) };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  return { rigRepo, sessionRegistry, eventBus, tmux, nodeLauncher, claude, inst };
}

function fixture() {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-seat-env-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "repo");
  const home = nodePath.join(root, "home");
  const dbFile = nodePath.join(root, "openrig.sqlite");
  fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  const db = createDb(dbFile);
  migrate(db, migrationsForFullTestDb);
  const yaml = [
    `version: "0.2"`,
    `name: env-journey`,
    `env:`,
    `  SHARED: from-rig`,
    `  RIG_ONLY: rig`,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd}"`,
    `        env:`,
    `          SHARED: from-member`,
    `          MEMBER_ONLY: member`,
    `      - id: plain`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd}"`,
    `    edges: []`,
    `edges: []`,
  ].join("\n") + "\n";
  return { ...wire(db, home), db, dbFile, root, rigRoot, cwd, home, yaml };
}

type Fixture = ReturnType<typeof fixture>;

const envOf = (f: { tmux: ReturnType<typeof mockTmux> }, sessionPart: string) => {
  const call = f.tmux.createSession.mock.calls.find(([name]) => name.includes(sessionPart));
  expect(call, `no session created for ${sessionPart}`).toBeDefined();
  return call![2] ?? {};
};

async function launch(f: Fixture, opts?: { env?: Record<string, string> }): Promise<string> {
  const result = await f.inst.instantiate(f.yaml, f.rigRoot, opts as never);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; result: { rigId: string } }).result.rigId;
}

describe("env: reaches the seats from a rig spec", () => {
  it("gives each seat its rig env with the member's own env over it", async () => {
    const f = fixture();
    await launch(f);
    expect(envOf(f, "dev-impl")).toMatchObject({ SHARED: "from-member", RIG_ONLY: "rig", MEMBER_ONLY: "member" });
    expect(envOf(f, "dev-plain")).toMatchObject({ SHARED: "from-rig", RIG_ONLY: "rig" });
    expect(envOf(f, "dev-plain")).not.toHaveProperty("MEMBER_ONLY");
    f.db.close();
  });

  it("records the declared names on the session so the managed Claude launch can forward them", async () => {
    const f = fixture();
    await launch(f);
    // A Claude seat also carries its own skill plugin (OPR.0.7.0.13), so the managed launch forwards that name too.
    expect(envOf(f, "dev-impl").OPENRIG_SEAT_ENV_KEYS?.split(",").sort()).toEqual(["CLAUDE_CODE_PLUGIN_DIRS", "MEMBER_ONLY", "RIG_ONLY", "SHARED"]);
    expect(envOf(f, "dev-plain").OPENRIG_SEAT_ENV_KEYS?.split(",").sort()).toEqual(["CLAUDE_CODE_PLUGIN_DIRS", "RIG_ONLY", "SHARED"]);
    f.db.close();
  });

  it("rig up --env wins over the spec for this launch", async () => {
    const f = fixture();
    await launch(f, { env: { SHARED: "from-flag", EXTRA: "1" } });
    expect(envOf(f, "dev-impl")).toMatchObject({ SHARED: "from-flag", MEMBER_ONLY: "member", EXTRA: "1" });
    expect(envOf(f, "dev-plain")).toMatchObject({ SHARED: "from-flag", EXTRA: "1" });
    // The session environment is put back as soon as each first pane exists, so a later pane starts from the spec.
    expect(f.tmux.setSessionEnv.mock.calls.map(([s, k, v]) => [s, k, v]).sort()).toEqual([
      ["dev-impl@env-journey", "SHARED", "from-member"],
      ["dev-plain@env-journey", "SHARED", "from-rig"],
    ]);
    expect(f.tmux.unsetSessionEnv.mock.calls.map(([s, k]) => [s, k]).sort()).toEqual([
      ["dev-impl@env-journey", "EXTRA"],
      ["dev-plain@env-journey", "EXTRA"],
    ]);
    f.db.close();
  });

  it("a seat that declares nothing is launched with nothing of its own but its skill plugin", async () => {
    const f = fixture();
    const noEnv = f.yaml.replace(/env:\n {2}SHARED: from-rig\n {2}RIG_ONLY: rig\n/, "").replace(/ {8}env:\n {10}SHARED: from-member\n {10}MEMBER_ONLY: member\n/, "");
    expect(noEnv).not.toContain("SHARED");
    const result = await f.inst.instantiate(noEnv, f.rigRoot);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const env = envOf(f, "dev-impl");
    // OPR.0.7.0.13: a Claude seat's own skill plugin is the only name it carries; nothing the spec didn't declare.
    expect(env.OPENRIG_SEAT_ENV_KEYS).toBe("CLAUDE_CODE_PLUGIN_DIRS");
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toMatch(/\/state\/seats\/[^/]+\/dev\.impl\/claude-code\/plugin$/);
    expect(env).not.toHaveProperty("SHARED");
    f.db.close();
  });
});

describe("env: survives restore", () => {
  it("a restored seat gets the spec's env again and not the one-off --env", async () => {
    const f = fixture();
    const rigId = await launch(f, { env: { SHARED: "from-flag", EXTRA: "1" } });
    for (const node of f.rigRepo.getRig(rigId)!.nodes) {
      const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
      f.sessionRegistry.updateStatus(session.id, "running");
      f.db.prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL WHERE node_id = ?").run(node.id);
    }
    const snapshotRepo = new SnapshotRepository(f.db);
    const checkpointStore = new CheckpointStore(f.db);
    const snap = new SnapshotCapture({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, snapshotRepo, checkpointStore })
      .captureSnapshot(rigId, "manual");
    for (const session of f.sessionRegistry.getSessionsForRig(rigId)) f.sessionRegistry.updateStatus(session.id, "exited");
    f.db.close();

    // A daemon restart: a reopened database and a fresh tmux, so only persisted state can supply env.
    const db2 = createDb(f.dbFile);
    const s2 = wire(db2, f.home);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus,
      snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2,
      snapshotCapture: new SnapshotCapture({ db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 }),
      nodeLauncher: s2.nodeLauncher, tmuxAdapter: s2.tmux as unknown as TmuxAdapter,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const restored = await orch.restore(snap.id, { adapters: { "claude-code": s2.claude }, freshLogicalIds: ["dev.impl", "dev.plain"] } as never);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });

    expect(envOf(s2, "dev-impl")).toMatchObject({ SHARED: "from-member", RIG_ONLY: "rig", MEMBER_ONLY: "member" });
    expect(envOf(s2, "dev-impl")).not.toHaveProperty("EXTRA");
    expect(envOf(s2, "dev-plain")).toMatchObject({ SHARED: "from-rig", RIG_ONLY: "rig" });
    db2.close();
  });
});
