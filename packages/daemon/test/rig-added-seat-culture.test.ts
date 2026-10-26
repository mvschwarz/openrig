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
import { RigExpansionService } from "../src/domain/rig-expansion-service.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { communityHarnessesDir } from "../src/domain/community-harness-presets.js";
import { seatSkillPaths } from "../src/domain/seat-skill-storage.js";

// A seat added to a running rig (`rig expand`, or add-member under `rig grow`) launches from a synthetic
// spec that declares no rig-level layers. It must still get the rig's culture file and rig startup block,
// resolved against the root the rig was created from, as an original seat does. Real instantiator and
// Claude adapter, temporary folders; no live seats.

const CULTURE_TEXT = "Rig culture: say it once, then stop.";
const NOTES_TEXT = "Rig notes every seat reads.";
const DEV_POD_TEXT = "Dev pod notes: run the checks before you hand off.";
const OPS_POD_TEXT = "Ops pod notes: never touch production by hand.";

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

/** `podStartup`: the `dev` pod declares DEV-NOTES.md (required) and DEV-OPTIONAL.md (optional, never written), and a
 *  second pod `ops` declares OPS-NOTES.md (required), each beside the rig file. */
function fixture(opts: { podStartup?: boolean } = {}) {
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
  if (opts.podStartup) {
    fs.writeFileSync(nodePath.join(rigRoot, "DEV-NOTES.md"), `# Dev\n\n${DEV_POD_TEXT}\n`);
    fs.writeFileSync(nodePath.join(rigRoot, "OPS-NOTES.md"), `# Ops\n\n${OPS_POD_TEXT}\n`);
  }
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
  const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux, sleep: async () => {} });
  const claude = new ClaudeCodeAdapter({ tmux, fsOps: realFs(home), sleep: async () => {} });
  const resolverFs: AgentResolverFsOps = { readFile: (p) => fs.readFileSync(p, "utf-8"), exists: (p) => fs.existsSync(p) };
  const inst = new PodRigInstantiator({
    db, rigRepo, podRepo, sessionRegistry, eventBus, nodeLauncher, startupOrchestrator,
    fsOps: resolverFs, tmuxAdapter: tmux,
    adapters: { "claude-code": claude, codex: noopAdapter("codex"), terminal: noopAdapter("terminal"), "acme-harness": noopAdapter("acme-harness") },
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
    ...(opts.podStartup ? [
      `    startup:`,
      `      files:`,
      `        - path: DEV-NOTES.md`,
      `          required: true`,
      `        - path: DEV-OPTIONAL.md`,
      `          required: false`,
    ] : []),
    `    members:`,
    `      - id: impl`,
    `        agent_ref: "local:agents/impl"`,
    `        profile: default`,
    `        runtime: claude-code`,
    `        cwd: "${cwd("repo")}"`,
    `    edges: []`,
    ...(opts.podStartup ? [
      `  - id: ops`,
      `    label: Ops`,
      `    startup:`,
      `      files:`,
      `        - path: OPS-NOTES.md`,
      `          required: true`,
      `    members:`,
      `      - id: runner`,
      `        agent_ref: "local:agents/impl"`,
      `        profile: default`,
      `        runtime: claude-code`,
      `        cwd: "${cwd("ops-repo")}"`,
      `    edges: []`,
    ] : []),
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

  /** The files of a seat's stored startup context, in delivery order. */
  const order = (logicalId: string) => context(logicalId).files.map((file) => file.path);
  const nodeExists = (logicalId: string) => !!db.prepare("SELECT 1 FROM nodes WHERE logical_id = ?").get(logicalId);
  /** The member fragment a runtime takes: a terminal seat has no agent. */
  const memberAs = (id: string, runtime: string) => runtime === "terminal"
    ? { id, agent_ref: "builtin:terminal", profile: "none", runtime, cwd: cwd(`${id}-repo`) }
    : { id, agent_ref: "local:agents/impl", profile: "default", runtime, cwd: cwd(`${id}-repo`) };
  const addHelper = (podId: string, id: string, runtime = "claude-code") => inst.addMemberToPod(rigIdOf(), podId, memberAs(id, runtime), otherRoot);
  let currentRigId = "";
  const rigIdOf = () => currentRigId;
  const setRigId = (id: string) => { currentRigId = id; };

  return { db, rigRepo, inst, expansion, tmux, yaml, rigRoot, otherRoot, cwd, context, rigFile, claudeMd, order, nodeExists, addHelper, memberAs, setRigId };
}

/** The reason an add gave for stopping, as one string. */
function reason(outcome: unknown): string {
  const o = outcome as { ok: boolean; errors?: string[]; message?: string; error?: string };
  return [...(o.errors ?? []), o.message ?? "", o.error ?? ""].join(" ");
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

describe("a seat added to an existing pod also gets that pod's startup files, and the add stops when a required inherited file is gone", () => {
  async function podRig() {
    const f = fixture({ podStartup: true });
    const rigId = await launched(f);
    f.setRigId(rigId);
    return { f, rigId };
  }

  it("an original seat has its pod's files (the baseline)", async () => {
    const { f } = await podRig();
    expect(f.rigFile("dev.impl", "DEV-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    f.db.close();
  });

  it("exported pod startup files resolve from the exported spec's folder on re-import", async () => {
    const { f, rigId } = await podRig();
    try {
      const exporter = new RigSpecExporter({
        rigRepo: f.rigRepo, podRepo: new PodRepository(f.db), sessionRegistry: new SessionRegistry(f.db),
      });
      const spec = exporter.exportRig(rigId) as import("../src/domain/types.js").RigSpec;
      spec.name = "exported-culture-rig";
      for (const pod of spec.pods) {
        for (const member of pod.members) member.cwd = f.cwd(`exported-${pod.id}-${member.id}`);
      }
      for (const file of ["CULTURE.md", "RIG-NOTES.md", "DEV-NOTES.md", "OPS-NOTES.md"]) {
        fs.copyFileSync(nodePath.join(f.rigRoot, file), nodePath.join(f.otherRoot, file));
      }
      const output = nodePath.join(f.otherRoot, "rig.yaml");
      fs.writeFileSync(output, RigSpecCodec.serialize(spec));
      const imported = await f.inst.instantiate(fs.readFileSync(output, "utf-8"), nodePath.dirname(output));
      expect(imported.ok, JSON.stringify(imported)).toBe(true);
      if (!imported.ok) return;
      const recreated = f.rigRepo.getRig(imported.result.rigId)!;

      for (const [logicalId, file, expected, other] of [
        ["dev.impl", "DEV-NOTES.md", DEV_POD_TEXT, OPS_POD_TEXT],
        ["ops.runner", "OPS-NOTES.md", OPS_POD_TEXT, DEV_POD_TEXT],
      ] as const) {
        const node = recreated.nodes.find((node) => node.logicalId === logicalId)!;
        const row = f.db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id = ?")
          .get(node.id) as { resolved_files_json: string };
        const files = JSON.parse(row.resolved_files_json) as Array<{ path: string; absolutePath: string }>;
        const delivered = files.find((entry) => entry.path === file);
        expect(delivered?.absolutePath).toBe(nodePath.join(nodePath.dirname(output), file));
        expect(fs.readFileSync(delivered!.absolutePath, "utf-8")).toContain(expected);
        const guidance = f.claudeMd(node.cwd!);
        expect(guidance).toContain(expected);
        expect(guidance).not.toContain(other);
      }
    } finally {
      f.db.close();
    }
  });

  it("add-member into the pod: the added seat gets the pod's file, resolved against the rig's root, after the rig layers", async () => {
    const { f } = await podRig();
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("dev.helper", "DEV-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    const order = f.order("dev.helper");
    expect(order.indexOf("CULTURE.md")).toBeGreaterThan(-1);
    expect(order.indexOf("CULTURE.md")).toBeLessThan(order.indexOf("RIG-NOTES.md"));
    expect(order.indexOf("RIG-NOTES.md")).toBeLessThan(order.indexOf("DEV-NOTES.md"));
    // The same list, in the same order, as the declared seat in that pod.
    expect(order).toEqual(f.order("dev.impl"));
    f.db.close();
  });

  it("each file comes from its own pod: a seat added to ops gets OPS-NOTES.md and not the dev pod's files", async () => {
    const { f } = await podRig();
    const outcome = await f.addHelper("ops", "second");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("ops.second", "OPS-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "OPS-NOTES.md"));
    expect(f.rigFile("ops.second", "DEV-NOTES.md")).toBeUndefined();
    expect(f.rigFile("dev.impl", "OPS-NOTES.md")).toBeUndefined();
    f.db.close();
  });

  it("the record is the one taken at creation: editing the rig file's startup list afterwards changes nothing", async () => {
    const { f } = await podRig();
    fs.writeFileSync(nodePath.join(f.rigRoot, "rig.yaml"), f.yaml.replace("- path: DEV-NOTES.md", "- path: SOMETHING-ELSE.md"));
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("dev.helper", "DEV-NOTES.md")).toBeDefined();
    expect(f.rigFile("dev.helper", "SOMETHING-ELSE.md")).toBeUndefined();
    f.db.close();
  });

  it("the added seat's saved list carries the pod file, so launch and restore replay it with no re-resolution", async () => {
    const { f, rigId } = await podRig();
    expect((await f.addHelper("dev", "helper")).ok).toBe(true);
    // Drop the record: what a restore replays is the seat's own saved list, not the rig's record.
    f.rigRepo.setRigStartupLayers(rigId, null);
    expect(f.rigFile("dev.helper", "DEV-NOTES.md")?.absolutePath).toBe(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    f.db.close();
  });

  it("an optional pod file that is missing does not stop the add, and is listed as for the declared seat", async () => {
    const { f } = await podRig();
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("dev.helper", "DEV-OPTIONAL.md")).toBeDefined(); // listed, like the declared seat's
    expect(f.rigFile("dev.helper", "DEV-OPTIONAL.md")).toEqual(f.rigFile("dev.impl", "DEV-OPTIONAL.md"));
    f.db.close();
  });

  it("a rig created before this change (nothing recorded) is unchanged: no pod file, no failure", async () => {
    const { f, rigId } = await podRig();
    f.rigRepo.setRigStartupLayers(rigId, null);
    fs.rmSync(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    expect(f.rigFile("dev.helper", "DEV-NOTES.md")).toBeUndefined();
    f.db.close();
  });

  it("a rig created with #1632 (rig layers recorded, no pod files): no pod file is delivered or checked, but a gone culture file stops the add", async () => {
    const { f, rigId } = await podRig();
    // Rewrite the row to what #1632 stored: the rig's culture file and startup, and no podStartupFiles.
    const { podStartupFiles: _recordedAfterThat, ...rigLayersOnly } = f.rigRepo.getRigStartupLayers(rigId)!;
    f.rigRepo.setRigStartupLayers(rigId, rigLayersOnly);

    // Everything present: the add works, the rig layers arrive, and there is no pod layer since none was recorded.
    const first = await f.addHelper("dev", "helper");
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(f.rigFile("dev.helper", "CULTURE.md")).toBeDefined();
    expect(f.rigFile("dev.helper", "RIG-NOTES.md")).toBeDefined();
    expect(f.rigFile("dev.helper", "DEV-NOTES.md")).toBeUndefined();

    // A required pod file is not checked either: nothing pod-level was recorded.
    fs.rmSync(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    const second = await f.addHelper("dev", "second");
    expect(second.ok, JSON.stringify(second)).toBe(true);

    // The recorded culture file is gone: the add is refused with the reason and no seat exists.
    fs.rmSync(nodePath.join(f.rigRoot, "CULTURE.md"));
    const refused = await f.addHelper("dev", "late");
    expect(refused.ok).toBe(false);
    expect(reason(refused)).toContain("CULTURE.md");
    expect(reason(refused)).toContain('rig "culture-rig"');
    expect(f.nodeExists("dev.late")).toBe(false);
    f.db.close();
  });

  it("a required pod file that is gone stops the add before any seat exists, naming the file and the pod", async () => {
    const { f } = await podRig();
    fs.rmSync(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok).toBe(false);
    const text = reason(outcome);
    expect(text).toContain("DEV-NOTES.md");
    expect(text).toContain(nodePath.join(f.rigRoot, "DEV-NOTES.md"));
    expect(text).toContain('pod "dev"');
    expect(f.nodeExists("dev.helper")).toBe(false);
    f.db.close();
  });

  it("a required rig startup file that is gone stops the add, naming the file and the rig", async () => {
    const { f } = await podRig();
    fs.rmSync(nodePath.join(f.rigRoot, "RIG-NOTES.md"));
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok).toBe(false);
    const text = reason(outcome);
    expect(text).toContain("RIG-NOTES.md");
    expect(text).toContain('rig "culture-rig"');
    expect(f.nodeExists("dev.helper")).toBe(false);
    f.db.close();
  });

  it("a declared culture_file that is gone stops the add", async () => {
    const { f } = await podRig();
    fs.rmSync(nodePath.join(f.rigRoot, "CULTURE.md"));
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok).toBe(false);
    expect(reason(outcome)).toContain("CULTURE.md");
    expect(f.nodeExists("dev.helper")).toBe(false);
    f.db.close();
  });

  it("a required file that cannot be read stops the add the same way", async () => {
    const { f } = await podRig();
    const target = nodePath.join(f.rigRoot, "DEV-NOTES.md");
    fs.rmSync(target);
    fs.mkdirSync(target); // present, but not a readable file
    const outcome = await f.addHelper("dev", "helper");
    expect(outcome.ok).toBe(false);
    expect(reason(outcome)).toContain("DEV-NOTES.md");
    expect(f.nodeExists("dev.helper")).toBe(false);
    f.db.close();
  });

  it("rig expand (a new pod) stops on a missing required rig file and creates no pod", async () => {
    const { f, rigId } = await podRig();
    fs.rmSync(nodePath.join(f.rigRoot, "RIG-NOTES.md"));
    const result = await f.expansion.expand({
      rigId,
      pod: { id: "ux", label: "UX", members: [{ id: "designer", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: f.cwd("ux-repo") }], edges: [] },
      rigRoot: f.otherRoot,
    } as never);
    expect(result.ok).toBe(false);
    expect(reason(result)).toContain("RIG-NOTES.md");
    expect(f.nodeExists("ux.designer")).toBe(false);
    f.db.close();
  });
  describe("a member whose runtime takes no startup files is added as on main, even with inherited files gone", () => {
    /** A community harness preset for `acme-harness` in this test's own OpenRig home. */
    function installCommunityPreset(): void {
      const dir = communityHarnessesDir();
      // Only ever write into the throwaway OpenRig home the test setup made, never a real one.
      expect(nodePath.basename(nodePath.dirname(dir)), `preset dir ${dir}`).toMatch(/^\.openrig-test-fixture-home-/);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(nodePath.join(dir, "acme-harness.yaml"), "format: 1\nname: acme-harness\ncommand: node -e 0\nmaintainer: Example Maintainer\n");
      tmpDirs.push(nodePath.join(dir, "acme-harness.yaml"));
    }
    function goneFiles(f: ReturnType<typeof fixture>): void {
      for (const file of ["CULTURE.md", "RIG-NOTES.md", "DEV-NOTES.md"]) fs.rmSync(nodePath.join(f.rigRoot, file));
    }

    it("a terminal member is added when the culture file, a required rig file and a required pod file are all gone", async () => {
      const { f } = await podRig();
      goneFiles(f);
      const outcome = await f.addHelper("dev", "shell", "terminal");
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(f.nodeExists("dev.shell")).toBe(true);
      f.db.close();
    });

    it("a community-harness member is added the same way", async () => {
      installCommunityPreset();
      const { f } = await podRig();
      goneFiles(f);
      const outcome = await f.addHelper("dev", "guest", "acme-harness");
      expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
      expect(f.nodeExists("dev.guest")).toBe(true);
      f.db.close();
    });

    it("rig grow --new-pod with only such members is added with a rig file gone", async () => {
      installCommunityPreset();
      const { f, rigId } = await podRig();
      goneFiles(f);
      const result = await f.expansion.expand({
        rigId,
        pod: { id: "side", label: "Side", members: [f.memberAs("shell", "terminal"), f.memberAs("guest", "acme-harness")].map((m) => ({ id: m.id, agentRef: m.agent_ref, profile: m.profile, runtime: m.runtime, cwd: m.cwd })), edges: [] },
        rigRoot: f.otherRoot,
      } as never);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(f.nodeExists("side.shell")).toBe(true);
      expect(f.nodeExists("side.guest")).toBe(true);
      f.db.close();
    });

    it("rig grow --new-pod with one member that takes startup files still stops, and creates no seat", async () => {
      const { f, rigId } = await podRig();
      goneFiles(f);
      const members = [f.memberAs("shell", "terminal"), f.memberAs("coder", "claude-code")];
      const result = await f.expansion.expand({
        rigId,
        pod: { id: "side", label: "Side", members: members.map((m) => ({ id: m.id, agentRef: m.agent_ref, profile: m.profile, runtime: m.runtime, cwd: m.cwd })), edges: [] },
        rigRoot: f.otherRoot,
      } as never);
      expect(result.ok).toBe(false);
      expect(reason(result)).toContain("CULTURE.md");
      expect(f.nodeExists("side.shell")).toBe(false);
      expect(f.nodeExists("side.coder")).toBe(false);
      f.db.close();
    });
  });
});

// OPR.0.7.0.13 with the above: an added seat gets its own skill storage, its plugin on the launch and the saved seat-skills
// line exactly as an original seat does, beside the rig's culture and startup; neither feature replaces the other's input.
describe("an added seat's own skill storage composes with the rig's culture and startup layers", () => {
  it("original, expanded and added-member seats: the same storage, plugin dir and saved line, beside the rig layers", async () => {
    const f = fixture();
    const rigId = await launched(f);
    const expanded = await f.expansion.expand({
      rigId,
      pod: { id: "ux", label: "UX", members: [{ id: "designer", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: f.cwd("ux-repo") }], edges: [] },
      rigRoot: f.otherRoot,
    } as never);
    expect(expanded.ok, JSON.stringify(expanded)).toBe(true);
    const added = await f.inst.addMemberToPod(rigId, "dev",
      { id: "helper", agent_ref: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: f.cwd("helper-repo") }, f.otherRoot);
    expect(added.ok, JSON.stringify(added)).toBe(true);
    const launchEnvs = vi.mocked(f.tmux.createSession).mock.calls.map((call) => (call[2] ?? {}) as Record<string, string>);
    for (const logicalId of ["dev.impl", "ux.designer", "dev.helper"]) {
      const paths = seatSkillPaths({ rigId, logicalId, runtime: "claude-code" });
      expect(fs.existsSync(paths.pluginManifestPath), `${logicalId}: its own plugin manifest`).toBe(true);
      // This seat's own launch carries its own plugin dir (the list is ":"-joined).
      const { id: nodeId } = f.db.prepare("SELECT id FROM nodes WHERE rig_id = ? AND logical_id = ?").get(rigId, logicalId) as { id: string };
      const own = launchEnvs.filter((env) => env["OPENRIG_NODE_ID"] === nodeId);
      expect(own, `${logicalId}: one launch`).toHaveLength(1);
      expect((own[0]!["CLAUDE_CODE_PLUGIN_DIRS"] ?? "").split(":"), `${logicalId}: its plugin on its launch`).toContain(paths.pluginDir);
      const saved = f.context(logicalId).files.map((file) => file.path);
      expect(saved, logicalId).toEqual(expect.arrayContaining(["CULTURE.md", "RIG-NOTES.md", "openrig-seat-skills.md"]));
      expect(f.context(logicalId).actions).toContain("rig hello");
    }
    f.db.close();
  });
});
