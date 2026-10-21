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
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import type { RigSpec } from "../src/domain/types.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// #1631: `rig export` writes back the culture file and rig startup block the rig was created with, so a rig
// re-created from the exported spec, read from the exported spec's folder, resolves the same startup files.
// Real instantiator, exporter and Claude adapter, temporary folders; no live seats.
const CULTURE_TEXT = "Rig culture: say it once, then stop.";
const NOTES_TEXT = "Rig notes every seat reads.";

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

function agentAt(root: string): void {
  fs.mkdirSync(nodePath.join(root, "agents", "impl"), { recursive: true });
  fs.writeFileSync(nodePath.join(root, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
}

/** A daemon's worth of state over its own database. */
function daemon(base: string, name: string) {
  const home = nodePath.join(base, `${name}-home`);
  fs.mkdirSync(home, { recursive: true });
  const db = createDb(nodePath.join(base, `${name}.sqlite`));
  migrate(db, migrationsForFullTestDb);
  const rigRepo = new RigRepository(db);
  const podRepo = new PodRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);
  const tmux = mockTmux();
  const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: realFs(home), sleep: async () => {} });
  const resolverFs: AgentResolverFsOps = { readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p) };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal") },
  } as never);
  const exporter = new RigSpecExporter({ rigRepo, sessionRegistry, podRepo });

  const instantiate = async (yaml: string, root: string): Promise<string> => {
    const result = await inst.instantiate(yaml, root);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    return (result as { ok: true; result: { rigId: string } }).result.rigId;
  };
  const exportYaml = (rigId: string) => RigSpecCodec.serialize(exporter.exportRig(rigId) as RigSpec);
  /** The resolved startup files and actions stored for a seat. */
  const context = (logicalId: string) => {
    const row = db.prepare(`SELECT c.resolved_files_json, c.startup_actions_json FROM node_startup_context c
      JOIN nodes n ON n.id = c.node_id WHERE n.logical_id = ?`).get(logicalId) as { resolved_files_json: string; startup_actions_json: string } | undefined;
    expect(row, `startup context for ${logicalId}`).toBeDefined();
    return {
      files: (JSON.parse(row!.resolved_files_json) as Array<{ path: string; absolutePath: string }>)
        .map((f) => ({ path: f.path, absolutePath: f.absolutePath })),
      actions: JSON.parse(row!.startup_actions_json) as unknown,
    };
  };
  return { db, instantiate, exportYaml, context };
}

function fixture(rigLevel: string[]) {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-export-startup-layers-"));
  tmpDirs.push(base);
  const specDir = nodePath.join(base, "rig");
  const seatCwd = nodePath.join(base, "repo");
  for (const dir of [specDir, seatCwd]) fs.mkdirSync(dir, { recursive: true });
  agentAt(specDir);
  fs.writeFileSync(nodePath.join(specDir, "CULTURE.md"), `# Culture\n\n${CULTURE_TEXT}\n`);
  fs.writeFileSync(nodePath.join(specDir, "RIG-NOTES.md"), `# Notes\n\n${NOTES_TEXT}\n`);
  const yaml = [
    `version: "0.2"`,
    `name: culture-rig`,
    ...rigLevel,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${seatCwd}"`,
    `    edges: []`,
    `edges: []`,
  ].join("\n") + "\n";
  return { base, specDir, seatCwd, yaml };
}

const LAYERS = [
  `culture_file: CULTURE.md`,
  `startup:`,
  `  files:`,
  `    - path: RIG-NOTES.md`,
  `      required: true`,
  `  actions:`,
  `    - type: send_text`,
  `      value: "rig hello"`,
  `      idempotent: true`,
];

describe("rig export keeps the rig's culture file and rig startup block (#1631)", () => {
  it("a rig re-created from its export, read from the exported spec's folder, resolves the same startup files", async () => {
    const f = fixture(LAYERS);
    const original = daemon(f.base, "original");
    const rigId = await original.instantiate(f.yaml, f.specDir);
    const before = original.context("dev.impl");
    expect(before.files).toContainEqual({ path: "CULTURE.md", absolutePath: nodePath.join(f.specDir, "CULTURE.md") });
    expect(before.files).toContainEqual({ path: "RIG-NOTES.md", absolutePath: nodePath.join(f.specDir, "RIG-NOTES.md") });

    const exported = original.exportYaml(rigId);
    expect(exported).toContain("culture_file: CULTURE.md");
    expect(exported).toContain("RIG-NOTES.md");
    // Save the export where `rig export` writes it by default: beside the spec the rig came from.
    const exportedPath = nodePath.join(f.specDir, "rig.yaml");
    fs.writeFileSync(exportedPath, exported);
    original.db.close();

    const recreated = daemon(f.base, "recreated");
    await recreated.instantiate(fs.readFileSync(exportedPath, "utf-8"), nodePath.dirname(exportedPath));
    const after = recreated.context("dev.impl");
    expect(after.files).toEqual(before.files);
    expect(after.actions).toEqual(before.actions);
    expect(JSON.stringify(after.actions)).toContain("rig hello");
    expect(fs.readFileSync(nodePath.join(f.seatCwd, "CLAUDE.md"), "utf-8")).toContain(CULTURE_TEXT);
    recreated.db.close();
  });

  it("a rig that declares neither exports without them, and re-creates with the same startup files", async () => {
    const f = fixture([]);
    const original = daemon(f.base, "original");
    const rigId = await original.instantiate(f.yaml, f.specDir);
    const before = original.context("dev.impl");
    const exported = original.exportYaml(rigId);
    expect(exported).not.toMatch(/^culture_file:/m);
    expect(exported).not.toMatch(/^startup:/m);
    original.db.close();

    const recreated = daemon(f.base, "recreated");
    await recreated.instantiate(exported, f.specDir);
    expect(recreated.context("dev.impl").files).toEqual(before.files);
    recreated.db.close();
  });
});
