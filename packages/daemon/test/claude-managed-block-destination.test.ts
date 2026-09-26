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
import { claudeConflictTargetPath } from "../src/domain/projection-planner.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #25 — a rig can send Claude Code's OpenRig-managed blocks to CLAUDE.local.md
// instead of the (often git-tracked) CLAUDE.md. These drive the real
// instantiate/restore/expand/teardown paths with the real Claude adapter
// writing into a temporary cwd.

const BEGIN = "<!-- BEGIN OpenRig MANAGED BLOCK:";
const LOCAL = "managed_blocks:\n  claude-code: CLAUDE.local.md";
// A tracked CLAUDE.md that already carries blocks from an earlier default-target run.
const OLD_BLOCKS_CLAUDE_MD = [
  "# Project rules",
  "",
  "Keep this file short.",
  "",
  "<!-- BEGIN OpenRig MANAGED BLOCK: openrig-start.md -->",
  "old managed text",
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

function rigYaml(managedBlocksYaml: string, cwd: string, name = "issue25-rig"): string {
  return [
    `version: "0.2"`,
    `name: ${name}`,
    managedBlocksYaml,
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

function fixture(managedBlocksYaml: string, opts?: { claudeMd?: string; claudeLocalMd?: string }) {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-"));
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
  if (opts?.claudeMd !== undefined) fs.writeFileSync(nodePath.join(cwd, "CLAUDE.md"), opts.claudeMd);
  if (opts?.claudeLocalMd !== undefined) fs.writeFileSync(nodePath.join(cwd, "CLAUDE.local.md"), opts.claudeLocalMd);

  const db = createDb(dbFile);
  migrate(db, migrationsForFullTestDb);
  const services = wire(db, home);
  const read = (name: string, dir = cwd) => {
    const p = nodePath.join(dir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  };
  return { ...services, db, dbFile, root, rigRoot, cwd, home, yaml: rigYaml(managedBlocksYaml, cwd), read };
}

function wire(db: ReturnType<typeof createDb>, home: string) {
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: realFs(home), sleep: async () => {} });
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

describe("#25 journey — rig YAML selects the Claude managed-block destination", () => {
  it("managed_blocks: { claude-code: CLAUDE.local.md } writes the blocks to CLAUDE.local.md and never touches CLAUDE.md", async () => {
    const tracked = "# Project rules\n\nKeep this file short.\n";
    const f = fixture(LOCAL, { claudeMd: tracked });
    await launched(f);
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(tracked);
    f.db.close();
  });

  it("absent managed_blocks keeps today's destination: CLAUDE.md", async () => {
    const f = fixture("");
    await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    f.db.close();
  });

  it("managed_blocks: { claude-code: CLAUDE.md } is the explicit default", async () => {
    const f = fixture("managed_blocks:\n  claude-code: CLAUDE.md");
    await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    f.db.close();
  });
});

describe("#25 schema — accepted keys and values, rejected before launch", () => {
  const base = (managedBlocks: unknown) => ({
    version: "0.2", name: "r",
    ...(managedBlocks === undefined ? {} : { managed_blocks: managedBlocks }),
    pods: [{ id: "dev", label: "Dev", members: [{ id: "impl", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
    edges: [],
  });

  it("accepts both supported destinations and absence", () => {
    expect(RigSpecSchema.validate(base(undefined)).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({ "claude-code": "CLAUDE.md" })).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({ "claude-code": "CLAUDE.local.md" })).errors).toEqual([]);
    expect(RigSpecSchema.validate(base({})).errors).toEqual([]);
  });

  it("rejects an unsupported value, naming both supported files", () => {
    for (const bad of ["AGENTS.md", "docs/CLAUDE.md", "../CLAUDE.local.md", "", 7, null]) {
      const errors = RigSpecSchema.validate(base({ "claude-code": bad })).errors;
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("managed_blocks.claude-code: must be one of CLAUDE.md, CLAUDE.local.md");
    }
  });

  it("rejects any other runtime key, naming the supported key (Codex stays on AGENTS.md)", () => {
    for (const key of ["codex", "pi", "terminal", "claude"]) {
      const errors = RigSpecSchema.validate(base({ [key]: "CLAUDE.local.md" })).errors;
      expect(errors).toEqual([`managed_blocks.${key}: unsupported runtime "${key}"; only "claude-code" is configurable`]);
    }
  });

  it("rejects a non-mapping value", () => {
    for (const bad of ["CLAUDE.local.md", ["CLAUDE.local.md"], null]) {
      expect(RigSpecSchema.validate(base(bad)).errors).toEqual(["managed_blocks: must be a mapping such as { claude-code: CLAUDE.local.md }"]);
    }
  });

  it("an invalid value is refused by instantiate before any seat launches or file is written", async () => {
    const f = fixture("managed_blocks:\n  claude-code: AGENTS.md");
    const result = await f.inst.instantiate(f.yaml, f.rigRoot);
    expect(result).toMatchObject({ ok: false, code: "validation_failed" });
    expect(f.tmux.createSession).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.cwd)).toEqual([]);
    f.db.close();
  });
});

describe("#25 selected-file semantics — preservation, idempotence, the other file", () => {
  it("keeps user text in CLAUDE.local.md and leaves a CLAUDE.md with old blocks byte-identical", async () => {
    const userLocal = "# My local notes\n\nprefer short answers\n";
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD, claudeLocalMd: userLocal });
    await launched(f);
    const local = f.read("CLAUDE.local.md")!;
    expect(local.startsWith(userLocal.trimEnd())).toBe(true);
    expect(local).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("repeated projection into CLAUDE.local.md is idempotent", async () => {
    const f = fixture(LOCAL, { claudeLocalMd: "user line\n" });
    const rigId = await launched(f);
    const first = f.read("CLAUDE.local.md");
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const ctx = f.db.prepare("SELECT projection_entries_json, resolved_files_json FROM node_startup_context WHERE node_id = ?")
      .get(node.id) as { projection_entries_json: string; resolved_files_json: string };
    const binding = { cwd: f.cwd } as NodeBinding; // no destination on the binding: the rig row decides
    const files = JSON.parse(ctx.resolved_files_json).filter((file: { deliveryHint: string }) => file.deliveryHint === "guidance_merge");
    await f.claude.deliverStartup(files, { ...binding, claudeManagedBlockFile: "CLAUDE.local.md" });
    await f.claude.deliverStartup(files, { ...binding, claudeManagedBlockFile: "CLAUDE.local.md" });
    const again = f.read("CLAUDE.local.md")!;
    // Blocks are replaced in place, never duplicated. mergeManagedBlock's trailing
    // blank-line growth on re-merge predates #25 and is file-independent (parity below).
    const count = (text: string) => text.split(BEGIN).length - 1;
    expect(count(again)).toBe(count(first!));
    expect(again.trimEnd()).toBe(first!.trimEnd());

    fs.writeFileSync(nodePath.join(f.cwd, "CLAUDE.md"), "user line\n");
    for (let i = 0; i < 3; i++) await f.claude.deliverStartup(files, binding);
    expect(f.read("CLAUDE.md")).toBe(again);
    f.db.close();
  });

  it("profile managed_block projection uses the selected file too", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-proj-"));
    tmpDirs.push(root);
    const src = nodePath.join(root, "guide.md");
    fs.writeFileSync(src, "profile guidance body");
    const claude = new ClaudeCodeAdapter({ tmux: mockTmux(), fsOps: realFs(root), sleep: async () => {} });
    const plan = {
      runtime: "claude-code", cwd: root, conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] },
      entries: [{ category: "guidance" as const, effectiveId: "guide.md", sourceSpec: "impl", sourcePath: root, resourcePath: "guide.md", absolutePath: src, classification: "safe_projection" as const, mergeStrategy: "managed_block" as const }],
    };
    const result = await claude.project(plan, { cwd: root, claudeManagedBlockFile: "CLAUDE.local.md" } as NodeBinding);
    expect(result.projected).toContain("guide.md");
    expect(fs.readFileSync(nodePath.join(root, "CLAUDE.local.md"), "utf-8")).toContain("profile guidance body");
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.md"))).toBe(false);
  });

  it("the conflict target follows the selection; the default is unchanged", () => {
    expect(claudeConflictTargetPath("guidance", "g", "/cwd")).toBe("/cwd/CLAUDE.md");
    expect(claudeConflictTargetPath("guidance", "g", "/cwd", undefined, "CLAUDE.local.md")).toBe("/cwd/CLAUDE.local.md");
    expect(claudeConflictTargetPath("skill", "s", "/cwd", undefined, "CLAUDE.local.md")).toBe("/cwd/.claude/skills/s/SKILL.md");
  });

  it("the Codex adapter ignores the Claude selection and stays on AGENTS.md", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-issue25-codex-"));
    tmpDirs.push(root);
    const src = nodePath.join(root, "culture.md");
    fs.writeFileSync(src, "codex guidance");
    const codex = new CodexRuntimeAdapter({ tmux: mockTmux(), fsOps: realFs(root) as never, sleep: async () => {} } as never);
    await codex.deliverStartup(
      [{ path: "culture.md", absolutePath: src, ownerRoot: root, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }],
      { cwd: root, claudeManagedBlockFile: "CLAUDE.local.md" } as NodeBinding,
    );
    expect(fs.readFileSync(nodePath.join(root, "AGENTS.md"), "utf-8")).toContain("codex guidance");
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.local.md"))).toBe(false);
    expect(fs.existsSync(nodePath.join(root, "CLAUDE.md"))).toBe(false);
  });
});

describe("#25 carriage — the selection holds across the lifecycle", () => {
  // Restore after a daemon restart: reopened DB, real pod-aware RestoreOrchestrator.
  // `withResumeToken: false` forces a fresh-primed relaunch, which replays startup;
  // an exact native resume replays nothing by design (D6a containment).
  async function restoreAfterRestart(withResumeToken: boolean) {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
    f.sessionRegistry.updateStatus(session.id, "running");
    if (!withResumeToken) f.db.prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL WHERE node_id = ?").run(node.id);
    const snapshotRepo = new SnapshotRepository(f.db);
    const checkpointStore = new CheckpointStore(f.db);
    const snap = new SnapshotCapture({ db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, eventBus: f.eventBus, snapshotRepo, checkpointStore })
      .captureSnapshot(rigId, "manual");
    f.sessionRegistry.updateStatus(session.id, "exited"); // the rig is down before restore
    f.db.close();
    fs.rmSync(nodePath.join(f.cwd, "CLAUDE.local.md"));

    const db2 = createDb(f.dbFile);
    const s2 = wire(db2, f.home);
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
    const restored = await orch.restore(snap.id, { adapters: { "claude-code": s2.claude }, ...(withResumeToken ? {} : { freshLogicalIds: ["dev.impl"] }) } as never);
    expect(restored, JSON.stringify(restored)).toMatchObject({ ok: true });
    db2.close();
    return { f, restored: restored as { ok: true; result: { nodes: Array<{ status: string }> } } };
  }

  it("restore with a fresh-primed relaunch replays the blocks into CLAUDE.local.md only", { timeout: 30000 }, async () => {
    const { f, restored } = await restoreAfterRestart(false);
    expect(restored.result.nodes[0]!.status, JSON.stringify(restored)).not.toBe("failed");
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
  });

  it("restore by exact native resume writes neither file (containment unchanged)", { timeout: 30000 }, async () => {
    const { f } = await restoreAfterRestart(true);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
  });

  it("relaunch/continue replay of the persisted startup context binds the rig's selection even when the caller's binding omits it", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    fs.rmSync(nodePath.join(f.cwd, "CLAUDE.local.md"));
    const node = f.rigRepo.getRig(rigId)!.nodes[0]!;
    const session = f.sessionRegistry.getSessionsForRig(rigId).find((s) => s.nodeId === node.id)!;
    const ctx = f.db.prepare("SELECT projection_entries_json, resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?")
      .get(node.id) as { projection_entries_json: string; resolved_files_json: string; startup_actions_json: string };
    // Same startNode inputs seat-lifecycle-service builds for launchFresh/continueFreshStartup.
    const result = await f.startupOrchestrator.startNode({
      rigId, nodeId: node.id, sessionId: session.id,
      binding: { cwd: f.cwd, tmuxSession: session.sessionName } as NodeBinding,
      adapter: f.claude,
      plan: { runtime: "claude-code", cwd: f.cwd, entries: JSON.parse(ctx.projection_entries_json), startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: JSON.parse(ctx.resolved_files_json),
      startupActions: JSON.parse(ctx.startup_actions_json),
      isRestore: false, sessionName: session.sessionName, skipHarnessLaunch: true,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(f.read("CLAUDE.local.md")).toContain(BEGIN);
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("expand/add: a member added to the running rig receives CLAUDE.local.md", async () => {
    const f = fixture(LOCAL);
    const rigId = await launched(f);
    const cwd2 = nodePath.join(f.root, "repo2");
    fs.mkdirSync(cwd2);
    fs.writeFileSync(nodePath.join(cwd2, "CLAUDE.md"), OLD_BLOCKS_CLAUDE_MD);
    const outcome = await f.inst.addMemberToPod(rigId, "dev",
      { id: "helper", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: cwd2 }, f.rigRoot);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.read("CLAUDE.local.md", cwd2)).toContain(BEGIN);
    expect(f.read("CLAUDE.md", cwd2)).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("export → YAML → import round trip keeps the selection (and the default exports nothing)", async () => {
    const f = fixture(LOCAL);
    const rigId = await launched(f);
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, podRepo: f.podRepo }).exportRig(rigId);
    const yaml = RigSpecCodec.serialize(exported as never);
    expect(yaml).toContain("managed_blocks:\n  claude-code: CLAUDE.local.md");
    const reparsed = RigSpecSchema.normalize(RigSpecCodec.parse(yaml) as Record<string, unknown>);
    expect(reparsed.managedBlocks).toEqual({ "claude-code": "CLAUDE.local.md" });

    const g = fixture("");
    const defaultRig = await launched(g);
    const defaultYaml = RigSpecCodec.serialize(new RigSpecExporter({ rigRepo: g.rigRepo, sessionRegistry: g.sessionRegistry, podRepo: g.podRepo }).exportRig(defaultRig) as never);
    expect(defaultYaml).not.toContain("managed_blocks");
    f.db.close();
    g.db.close();
  });

  it("bundle rig.yaml rewrite (normalize → serialize) keeps the selection", () => {
    const f = fixture(LOCAL);
    const raw = RigSpecCodec.parse(f.yaml) as Record<string, unknown>;
    const rewritten = RigSpecCodec.serialize(RigSpecSchema.normalize(raw));
    expect(RigSpecCodec.parse(rewritten)).toMatchObject({ managed_blocks: { "claude-code": "CLAUDE.local.md" } });
    f.db.close();
  });
});

describe("#25 teardown — cleans the selected file only", () => {
  function teardown(f: ReturnType<typeof fixture>) {
    return new RigTeardownOrchestrator({
      db: f.db, rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, tmuxAdapter: f.tmux, eventBus: f.eventBus,
      snapshotCapture: { db: f.db, captureSnapshot: vi.fn(() => ({ id: "snap" })) } as never,
    });
  }

  it("strips blocks from CLAUDE.local.md, keeps its user text, and leaves CLAUDE.md with old blocks byte-identical", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD, claudeLocalMd: "my local line\n" });
    const rigId = await launched(f);
    for (const s of f.sessionRegistry.getSessionsForRig(rigId)) f.sessionRegistry.updateStatus(s.id, "running");
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.local.md")).toBe("my local line\n");
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("removes a CLAUDE.local.md that held only managed blocks", async () => {
    const f = fixture(LOCAL, { claudeMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.local.md")).toBeNull();
    expect(f.read("CLAUDE.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });

  it("default rig teardown still cleans CLAUDE.md and never creates or touches CLAUDE.local.md", async () => {
    const f = fixture("", { claudeLocalMd: OLD_BLOCKS_CLAUDE_MD });
    const rigId = await launched(f);
    expect(f.read("CLAUDE.md")).toContain(BEGIN);
    await teardown(f).teardown(rigId);
    expect(f.read("CLAUDE.md")).toBeNull();
    expect(f.read("CLAUDE.local.md")).toBe(OLD_BLOCKS_CLAUDE_MD);
    f.db.close();
  });
});
