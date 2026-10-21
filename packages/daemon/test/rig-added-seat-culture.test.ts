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
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

// A seat added to a running rig (`rig expand`, or add-member under `rig grow`) launches from a synthetic
// spec that declares no rig-level layers. It must still get the rig's culture file and rig startup block,
// resolved against the root the rig was created from, as an original seat does. Real instantiator and
// Claude adapter, temporary folders; no live seats.

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

/** An agent folder (local:agents/impl) under `root`. */
function agentAt(root: string): void {
  fs.mkdirSync(nodePath.join(root, "agents", "impl"), { recursive: true });
  fs.writeFileSync(nodePath.join(root, "agents", "impl", "agent.yaml"),
    `name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
}

function fixture() {
  const base = fs.mkdtempSync(nodePath.join(os.tmpdir(), "or-added-seat-culture-"));
  tmpDirs.push(base);
  const rigRoot = nodePath.join(base, "rig");
  // Where a later expand or add-member is run from: it has the agent, but none of the rig's own files.
  const otherRoot = nodePath.join(base, "elsewhere");
  const home = nodePath.join(base, "home");
  for (const dir of [rigRoot, otherRoot, home]) fs.mkdirSync(dir, { recursive: true });
  agentAt(rigRoot);
  agentAt(otherRoot);
  fs.writeFileSync(nodePath.join(rigRoot, "CULTURE.md"), `# Culture\n\n${CULTURE_TEXT}\n`);
  fs.writeFileSync(nodePath.join(rigRoot, "RIG-NOTES.md"), `# Notes\n\n${NOTES_TEXT}\n`);
  const cwd = (name: string) => {
    const dir = nodePath.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const db = createDb(nodePath.join(base, "openrig.sqlite"));
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
  const expansion = new RigExpansionService({ db, rigRepo, eventBus, nodeLauncher, podInstantiator: inst, sessionRegistry });

  const yaml = [
    `version: "0.2"`,
    `name: culture-rig`,
    `culture_file: CULTURE.md`,
    `startup:`,
    `  files:`,
    `    - path: RIG-NOTES.md`,
    `      required: true`,
    `  actions:`,
    `    - type: send_text`,
    `      value: "rig hello"`,
    `      idempotent: true`,
    `pods:`,
    `  - id: dev`,
    `    label: Dev`,
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd("repo")}"`,
    `    edges: []`,
    `edges: []`,
  ].join("\n") + "\n";

  /** The stored startup context of a seat: what its launch delivered and what every restore replays. */
  const context = (logicalId: string) => {
    const row = db.prepare(`SELECT c.resolved_files_json, c.startup_actions_json FROM node_startup_context c
      JOIN nodes n ON n.id = c.node_id WHERE n.logical_id = ?`).get(logicalId) as { resolved_files_json: string; startup_actions_json: string } | undefined;
    expect(row, `startup context for ${logicalId}`).toBeDefined();
    return {
      files: JSON.parse(row!.resolved_files_json) as Array<{ path: string; absolutePath: string }>,
      actions: row!.startup_actions_json,
    };
  };
  const rigFile = (logicalId: string, path: string) => context(logicalId).files.find((f) => f.path === path);
  const claudeMd = (dir: string) => fs.readFileSync(nodePath.join(dir, "CLAUDE.md"), "utf-8");

  return { db, rigRepo, inst, expansion, yaml, rigRoot, otherRoot, cwd, context, rigFile, claudeMd };
}

async function launched(f: ReturnType<typeof fixture>): Promise<string> {
  const result = await f.inst.instantiate(f.yaml, f.rigRoot);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return (result as { ok: true; result: { rigId: string } }).result.rigId;
}

describe("a seat added to a running rig gets the rig's culture and startup layers", () => {
  it("an original seat has them (the baseline)", async () => {
    const f = fixture();
    await launched(f);
    expect(f.rigFile("dev.impl", "CULTURE.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "CULTURE.md"));
    expect(f.rigFile("dev.impl", "RIG-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "RIG-NOTES.md"));
    f.db.close();
  });

  it("rig expand: the new pod's seat gets the culture file and rig startup, resolved against the rig's own root", async () => {
    const f = fixture();
    const rigId = await launched(f);
    const seatCwd = f.cwd("ux-repo");
    const result = await f.expansion.expand({
      rigId,
      pod: { id: "ux", label: "UX", members: [{ id: "designer", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: seatCwd }], edges: [] },
      rigRoot: f.otherRoot,
    } as never);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    // Resolved against the root the rig was created from, not the expansion's own root.
    expect(f.rigFile("ux.designer", "CULTURE.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "CULTURE.md"));
    expect(f.rigFile("ux.designer", "RIG-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "RIG-NOTES.md"));
    expect(f.context("ux.designer").actions).toContain("rig hello");
    // What the person sees: the culture reaches the seat's own guidance file.
    expect(f.claudeMd(seatCwd)).toContain(CULTURE_TEXT);
    f.db.close();
  });

  it("add-member (rig grow into an existing pod): the added seat gets them too, and keeps them for restore", async () => {
    const f = fixture();
    const rigId = await launched(f);
    const seatCwd = f.cwd("helper-repo");
    const outcome = await f.inst.addMemberToPod(rigId, "dev",
      { id: "helper", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: seatCwd }, f.otherRoot);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    // Stored in the seat's startup context, which restore and relaunch replay.
    expect(f.rigFile("dev.helper", "CULTURE.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "CULTURE.md"));
    expect(f.rigFile("dev.helper", "RIG-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "RIG-NOTES.md"));
    expect(f.context("dev.helper").actions).toContain("rig hello");
    expect(f.claudeMd(seatCwd)).toContain(CULTURE_TEXT);
    f.db.close();
  });

  it("a rig with nothing stored (created before this, or declaring neither) keeps today's behaviour: no backfill", async () => {
    const f = fixture();
    const rigId = await launched(f);
    f.rigRepo.setRigStartupLayers(rigId, null);
    const outcome = await f.inst.addMemberToPod(rigId, "dev",
      { id: "late", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: f.cwd("late-repo") }, f.otherRoot);
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("dev.late", "CULTURE.md")).toBeUndefined();
    expect(f.rigFile("dev.late", "RIG-NOTES.md")).toBeUndefined();
    f.db.close();
  });
});
