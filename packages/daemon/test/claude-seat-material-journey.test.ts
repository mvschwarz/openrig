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
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { claudeSeatMaterialPaths } from "../src/domain/claude-seat-material.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #875 — `seat_material: { claude-code: seat }` keeps a Claude seat's projected material out of
// its cwd. These drive the real instantiate/restore/export/teardown paths with the real Claude
// adapter, writing into a temporary repository and a temporary OpenRig home.

const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";
const SEAT = "seat_material:\n  claude-code: seat";
const SESSION = "dev-impl@issue875-rig";
const TRACKED_CLAUDE_MD = [
  "# Project rules",
  "",
  "<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->",
  "old managed text from an earlier cwd-mode run",
  "<!-- END OpenRig MANAGED BLOCK: openrig-start.md -->",
  "",
].join("\n");

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => "Claude Code\n>"),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
  } as unknown as TmuxAdapter;
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

function rigYaml(seatMaterialYaml: string, cwd: string): string {
  return [
    `version: "0.2"`,
    `name: issue875-rig`,
    seatMaterialYaml,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd}"`,
    `    edges: []`,
    `edges: []`,
  ].filter(Boolean).join("\n") + "\n";
}

function fixture(seatMaterialYaml: string, opts?: { claudeMd?: string }) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue875-"));
  tmpDirs.push(root);
  const rigRoot = nodePath.join(root, "rig");
  const cwd = nodePath.join(root, "repo");
  const home = nodePath.join(root, "home");
  const openrigHome = nodePath.join(root, "openrig-home");
  const dbFile = nodePath.join(root, "openrig.sqlite");
  fs.mkdirSync(nodePath.join(rigRoot, "agents", "impl"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(nodePath.join(rigRoot, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
  if (opts?.claudeMd !== undefined) fs.writeFileSync(nodePath.join(cwd, "CLAUDE.md"), opts.claudeMd);

  const db = createDb(dbFile);
  migrate(db, migrationsForFullTestDb);
  const services = wire(db, home, openrigHome);
  const seat = claudeSeatMaterialPaths(openrigHome, SESSION);
  const read = (path: string) => fs.existsSync(path) ? fs.readFileSync(path, "utf-8") : null;
  return { ...services, db, dbFile, root, rigRoot, cwd, home, openrigHome, seat, yaml: rigYaml(seatMaterialYaml, cwd), read };
}

function wire(db: ReturnType<typeof createDb>, home: string, openrigHome: string) {
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const claude = new ClaudeCodeAdapter({
    tmux, fsOps: realFs(home), sleep: async () => {}, stateDir: openrigHome,
    resolveSeatMaterial: (seat) => rigRepo.getClaudeSeatMaterialForSeat(seat),
  });
  const resolverFs: AgentResolverFsOps = {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
  };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  return { rigRepo, podRepo, sessionRegistry, eventBus, tmux, nodeLauncher, startupOrchestrator, claude, inst };
}

async function launched(f: ReturnType<typeof fixture>): Promise<string> {
  const result = await f.inst.instantiate(f.yaml, f.rigRoot);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; result: { rigId: string } }).result.rigId;
}

function launchCommands(tmux: TmuxAdapter): string[] {
  const calls = (tmux.sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  return calls.map((call) => String(call[1])).filter((text) => /\bclaude\b.*--(?:session-id|resume)/.test(text));
}

function snapshotOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = nodePath.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[nodePath.relative(dir, p)] = fs.readFileSync(p, "utf-8");
    }
  };
  walk(dir);
  return out;
}

describe("#875 journey — rig YAML keeps a Claude seat's material out of its cwd", () => {
  it("seat_material: seat writes guidance into the seat directory, launches with it, and leaves the repository untouched", async () => {
    const f = fixture(SEAT, { claudeMd: TRACKED_CLAUDE_MD });
    const before = snapshotOf(f.cwd);
    await launched(f);

    expect(snapshotOf(f.cwd)).toEqual(before);
    expect(f.read(f.seat.guidancePath)).toContain(BEGIN);
    const [cmd] = launchCommands(f.tmux);
    expect(cmd).toContain(`'--append-system-prompt-file' '${f.seat.guidancePath}'`);
    expect(cmd).toContain(`'--plugin-dir' '${f.seat.pluginDir}'`);
    expect(cmd).toContain(`'--settings' '${f.seat.launchSettingsPath}'`);
    expect(f.read(f.seat.pluginManifestPath)).toContain('"name": "openrig"');
    f.db.close();
  });

  it("absent seat_material keeps today's cwd projection and launch command", async () => {
    const f = fixture("");
    await launched(f);
    expect(f.read(nodePath.join(f.cwd, "CLAUDE.md"))).toContain(BEGIN);
    expect(fs.existsSync(f.seat.root)).toBe(false);
    expect(launchCommands(f.tmux).join("\n")).not.toContain("--plugin-dir");
    f.db.close();
  });

  it("resolves the mode by node id and by session name, the handles launch and the context monitor use", async () => {
    const f = fixture(SEAT);
    const rigId = await launched(f);
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    expect(f.rigRepo.getClaudeSeatMaterialForSeat({ nodeId: node.id })).toBe("seat");
    expect(f.rigRepo.getClaudeSeatMaterialForSeat({ sessionName: SESSION })).toBe("seat");
    expect(f.rigRepo.getClaudeSeatMaterialForSeat({ sessionName: "unknown@nowhere" })).toBe("cwd");
    f.db.close();
  });
});

describe("#875 schema — accepted keys and values, rejected before launch", () => {
  const base = (seatMaterial: unknown) => ({
    version: "0.2", name: "r", seat_material: seatMaterial,
    pods: [{ id: "p", label: "P", members: [{ id: "m", agent_ref: "local:a", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
  });
  it("accepts cwd and seat", () => {
    expect(RigSpecSchema.validate(base({ "claude-code": "cwd" })).valid).toBe(true);
    expect(RigSpecSchema.validate(base({ "claude-code": "seat" })).valid).toBe(true);
  });
  it("rejects other values, other runtimes and non-mappings", () => {
    expect(RigSpecSchema.validate(base({ "claude-code": "home" })).errors.join("\n")).toMatch(/must be one of cwd, seat/);
    expect(RigSpecSchema.validate(base({ codex: "seat" })).errors.join("\n")).toMatch(/only "claude-code" is configurable/);
    expect(RigSpecSchema.validate(base("seat")).errors.join("\n")).toMatch(/must be a mapping/);
  });
});

describe("#875 carriage — the mode holds across the lifecycle", () => {
  it("restore after a daemon restart relaunches fresh from the seat directory, still leaving the repository alone", { timeout: 30000 }, async () => {
    const f = fixture(SEAT, { claudeMd: TRACKED_CLAUDE_MD });
    const rigId = await launched(f);
    const before = snapshotOf(f.cwd);
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
    f.sessionRegistry.updateStatus(session.id, "running");
    f.db.prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL WHERE node_id = ?").run(node.id);
    const snapshotRepo = new SnapshotRepository(f.db);
    const checkpointStore = new CheckpointStore(f.db);
    const snap = new SnapshotCapture({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, snapshotRepo, checkpointStore })
      .captureSnapshot(rigId, "manual");
    f.sessionRegistry.updateStatus(session.id, "exited");
    f.db.close();
    fs.rmSync(f.seat.guidancePath);

    const db2 = createDb(f.dbFile);
    const s2 = wire(db2, f.home, f.openrigHome);
    const snapshotRepo2 = new SnapshotRepository(db2);
    const checkpointStore2 = new CheckpointStore(db2);
    const orch = new RestoreOrchestrator({
      db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus,
      snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2,
      snapshotCapture: new SnapshotCapture({ db: db2, rigRepo: s2.rigRepo, sessionRegistry: s2.sessionRegistry, eventBus: s2.eventBus, snapshotRepo: snapshotRepo2, checkpointStore: checkpointStore2 }),
      nodeLauncher: s2.nodeLauncher, tmuxAdapter: s2.tmux,
      claudeResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });
    const restored = await orch.restore(snap.id, { adapters: { "claude-code": s2.claude }, freshLogicalIds: ["dev.impl"] } as never);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    db2.close();

    expect(f.read(f.seat.guidancePath)).toContain(BEGIN);
    expect(snapshotOf(f.cwd)).toEqual(before);
    expect(launchCommands(s2.tmux).at(-1)).toContain(`'--append-system-prompt-file' '${f.seat.guidancePath}'`);
  });

  it("export → YAML → import round trip keeps the mode (and the default exports nothing)", async () => {
    const f = fixture(SEAT);
    const rigId = await launched(f);
    const yaml = RigSpecCodec.serialize(new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, podRepo: f.podRepo }).exportRig(rigId) as never);
    expect(yaml).toContain("seat_material:\n  claude-code: seat");
    expect(RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>).seatMaterial).toEqual({ "claude-code": "seat" });

    const g = fixture("");
    const defaultRig = await launched(g);
    const defaultYaml = RigSpecCodec.serialize(new RigSpecExporter({ rigRepo: g.rigRepo, sessionRegistry: g.sessionRegistry, podRepo: g.podRepo }).exportRig(defaultRig) as never);
    expect(defaultYaml).not.toContain("seat_material");
    f.db.close();
    g.db.close();
  });

  it("teardown leaves the repository byte-identical, including blocks an earlier cwd-mode run left behind", async () => {
    const f = fixture(SEAT, { claudeMd: TRACKED_CLAUDE_MD });
    const rigId = await launched(f);
    for (const s of f.sessionRegistry.getSessionsForRig(rigId)) f.sessionRegistry.updateStatus(s.id, "running");
    await new RigTeardownOrchestrator({
      db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, tmuxAdapter: f.tmux, eventBus: f.eventBus,
      snapshotCapture: { db: f.db, captureSnapshot: vi.fn(() => ({ id: "snap" })) } as never,
    }).teardown(rigId);
    expect(f.read(nodePath.join(f.cwd, "CLAUDE.md"))).toBe(TRACKED_CLAUDE_MD);
    f.db.close();
  });
});
