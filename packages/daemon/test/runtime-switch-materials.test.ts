// Slice 16: what a seat's successor is planned to launch with on the other runtime, from the seat's own agent spec.
// The spec here declares a Claude model on its profile and Codex defaults, so each direction shows which applies and
// which is dropped (P5: a default declared for the source runtime doesn't reach the target).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { planRuntimeSwitchMaterials, type SwitchRuntime } from "../src/domain/runtime-switch-materials.js";
import { seatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { seatSkillsPointerStartupFile } from "../src/domain/rigspec-instantiator.js";
import type { ParsedStartupContext } from "../src/domain/seat-lifecycle-service.js";
import type { Node } from "../src/domain/types.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import { piAccountSwitchStateRoot } from "../src/domain/pi-account-state.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { managedBlockText } from "../src/domain/managed-blocks.js";
import { managedBlockRecords } from "../src/domain/managed-block-records.js";

const AGENT_YAML = `name: impl
version: "1.0.0"
defaults:
  runtime: codex
  model: gpt-5.5
  effort: high
startup:
  files: []
  actions: []
resources:
  skills:
    - id: review
      path: skills/review
profiles:
  default:
    preferences:
      runtime: claude-code
      model: claude-opus-5-5
    uses:
      skills: [review]
`;

describe("a runtime switch plans the successor from the seat's own agent spec", () => {
  let tmp: string;
  let agentDir: string;
  let home: string;
  let db: Database.Database;
  let rigRepo: RigRepository;
  let rigId: string;

  beforeEach(() => {
    tmp = mkdtempSync(nodePath.join(tmpdir(), "s16-materials-"));
    agentDir = nodePath.join(tmp, "rig", "agents", "impl");
    home = nodePath.join(tmp, "openrig-home");
    mkdirSync(nodePath.join(agentDir, "skills", "review"), { recursive: true });
    mkdirSync(nodePath.join(agentDir, "startup"), { recursive: true });
    mkdirSync(nodePath.join(tmp, "project"), { recursive: true });
    writeFileSync(nodePath.join(agentDir, "agent.yaml"), AGENT_YAML);
    writeFileSync(nodePath.join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Use when reviewing.\n---\n# Review\n");
    writeFileSync(nodePath.join(agentDir, "startup", "role.md"), "# The implementer's role\n");
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    rigId = rigRepo.createRig("seat-rig").id;
  });
  afterEach(() => { db.close(); rmSync(tmp, { recursive: true, force: true }); });

  const seat = (runtime: SwitchRuntime, extra: { model?: string; codexConfigProfile?: string } = {}): Node =>
    rigRepo.addNode(rigId, "dev.impl", { runtime, cwd: nodePath.join(tmp, "project"), agentRef: "local:agents/impl", profile: "default",
      resolvedSpecName: "impl", ...extra });

  /** What the seat's last launch saved: its role file from the agent folder, the seat-skills pointer, a Codex seat's catalog
   *  and its identity, a startup text and a slash command. */
  const savedContext = (node: Node, from: SwitchRuntime): ParsedStartupContext => ({
    runtime: from, hash: "saved",
    plan: { runtime: from, cwd: node.cwd!, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
    resolvedStartupFiles: [
      { path: "startup/role.md", absolutePath: nodePath.join(agentDir, "startup", "role.md"), ownerRoot: agentDir, deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] },
      seatSkillsPointerStartupFile(),
      ...(from === "codex" ? [{ path: "openrig-seat-skills.md", absolutePath: seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "codex" }, home).catalogPath,
        ownerRoot: home, deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const, "restore" as const] }] : []),
    ],
    startupActions: [
      { type: "send_text", value: `Identity:\n- rig: seat-rig\n- runtime: ${from}\n- session: dev-impl@seat-rig`, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, builtin: "session_identity" },
      { type: "send_text", value: "Read your queue first.", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
      { type: "slash_command", value: "/rename impl", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true },
    ],
  });

  const plan = (node: Node, from: SwitchRuntime, to: SwitchRuntime, explicit: { model?: string; effort?: string } = {}) =>
    planRuntimeSwitchMaterials({ db, node, rigName: "seat-rig", canonicalSession: "dev-impl@seat-rig", runtime: to, explicit,
      saved: savedContext(node, from), openrigHome: home, resolution: { homedir: tmp, skillsRoot: nodePath.join(tmp, "no-catalog") } });

  it("Codex to Claude Code: the spec's Claude model applies; its Codex effort and the seat's Codex settings are dropped, and the plan says so", () => {
    const materials = plan(seat("codex", { model: "gpt-5.5", codexConfigProfile: "fast" }), "codex", "claude-code");
    expect(materials.settings.model).toEqual({ value: "claude-opus-5-5", source: "agent_spec" });
    expect(materials.settings.effort).toEqual({ value: null, source: "native_default" });
    expect(materials.settings.codexConfigProfile).toEqual({ value: null, source: "native_default" });
    expect(materials.dropped).toEqual(expect.arrayContaining([
      { setting: "model", value: "gpt-5.5" },
      { setting: "codex config profile", value: "fast" },
      { setting: "effort (agent spec, spec defaults, declared for codex)", value: "high" },
    ]));
    expect(materials.resolvedSpec?.name).toBe("impl");
  });

  it("Claude Code to Codex: the spec's Codex defaults apply, and its Claude model is dropped and named", () => {
    const materials = plan(seat("claude-code"), "claude-code", "codex");
    expect(materials.settings.model).toEqual({ value: "gpt-5.5", source: "agent_spec" });
    expect(materials.settings.effort).toEqual({ value: "high", source: "agent_spec" });
    expect(materials.settings.advisor).toEqual({ value: null, source: "native_default" });
    expect(materials.dropped).toContainEqual({ setting: "model (agent spec, profile default, declared for claude-code)", value: "claude-opus-5-5" });
  });

  it.each(["codex", "claude-code"] as const)("prepares %s → Pi in isolated successor storage with target settings", async from => {
    const node = seat(from, { model: "source-model" });
    const materials = plan(node, from, "pi");
    expect(materials.settings.model).toEqual({ value: null, source: "native_default" });
    expect(materials.settings.effort).toEqual({ value: null, source: "native_default" });
    expect(materials.firstTurn).toContain("- runtime: pi");
    expect(materials.files.map(file => file.absolutePath)).not.toContain(seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: from }, home).catalogPath);
    const explicit = plan(node, from, "pi", { model: "provider/pi-model", effort: "medium" });
    expect(explicit.settings.model).toEqual({ value: "provider/pi-model", source: "explicit" });
    expect(explicit.settings.effort).toEqual({ value: "medium", source: "explicit" });
    const base = nodePath.join(home, "state", "pi");
    const canonical = "dev-impl@seat-rig";
    const adapter = new PiRuntimeAdapter({ stateRoot: base, runnerEntryPath: "/unused-runner.js", tmux: {},
      fsOps: { exists: existsSync, readFile: (p: string) => readFileSync(p, "utf8"), writeFile: writeFileSync,
        mkdirp: (p: string) => mkdirSync(p, { recursive: true }), listFiles: readdirSync } } as never);
    await materials.prepare({ nodeId: node.id, cwd: node.cwd, tmuxSession: "openrig-switch-staged", launchGeneration: "next",
      runtimeSwitchFrom: { runtime: from, session: canonical, pane: "%0", generation: "old" }, ...materials.bindingAdditions() } as NodeBinding, adapter);
    const target = piSeatPaths(piAccountSwitchStateRoot(base, "next"), canonical);
    expect(readFileSync(nodePath.join(target.agentDir, "skills", "review", "SKILL.md"), "utf8")).toContain("# Review");
    expect(existsSync(piSeatPaths(base, canonical).agentDir)).toBe(false);
    expect(existsSync(nodePath.join(node.cwd!, ".claude"))).toBe(false);
    expect(materials.notRun).toEqual(["/rename impl"]);
  });

  it.each(["codex", "claude-code"] as const)("Pi → %s resolves that runtime's spec and materials", to => {
    const materials = plan(seat("pi", { model: "provider/pi-model" }), "pi", to);
    expect(materials.settings.model).toEqual({ value: to === "codex" ? "gpt-5.5" : "claude-opus-5-5", source: "agent_spec" });
    expect(materials.settings.effort.value).toBe(to === "codex" ? "high" : null);
    expect(materials.firstTurn).toContain(`- runtime: ${to}`);
    expect(materials.bindingAdditions().seatSkillsRoot).toBe(seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: to }, home).skillsRoot);
    expect(materials.dropped).toContainEqual({ setting: "model", value: "provider/pi-model" });
  });

  it("an explicit option wins over the spec", () => {
    const materials = plan(seat("codex"), "codex", "claude-code", { model: "claude-sonnet-5", effort: "max" });
    expect(materials.settings.model).toEqual({ value: "claude-sonnet-5", source: "explicit" });
    expect(materials.settings.effort).toEqual({ value: "max", source: "explicit" });
  });

  it("the successor gets the target's own materials: its skills in its own seat storage, its pointer, no Codex catalog, and an identity naming the new runtime", () => {
    const materials = plan(seat("codex"), "codex", "claude-code");
    const target = seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "claude-code" }, home);
    const source = seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "codex" }, home);
    // The plan carries the skill from the agent's folder; the binding sends it to the Claude seat's own storage.
    expect(materials.plan.entries.find((entry) => entry.category === "skill"))
      .toMatchObject({ absolutePath: nodePath.join(agentDir, "skills", "review"), classification: "safe_projection" });
    expect(materials.bindingAdditions().seatSkillsRoot).toBe(target.skillsRoot);
    expect(target.skillsRoot).not.toBe(source.skillsRoot);
    const paths = materials.files.map((file) => file.absolutePath);
    expect(paths).toContain(seatSkillsPointerStartupFile().absolutePath);
    expect(paths).not.toContain(source.catalogPath);
    expect(materials.firstTurn).toMatch(/- runtime: claude-code/);
    expect(materials.firstTurn).not.toMatch(/- runtime: codex/);
    expect(materials.firstTurn).toMatch(/Read your queue first\./);
    expect(materials.firstTurn).toMatch(/The implementer's role/);
    // A switch doesn't run startup slash commands; the preview names them.
    expect(materials.notRun).toEqual(["/rename impl"]);
  });

  it("to Codex, the successor reads the Codex seat's own skill catalog", () => {
    const materials = plan(seat("claude-code"), "claude-code", "codex");
    const target = seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "codex" }, home);
    expect(materials.files.map((file) => file.absolutePath)).toContain(target.catalogPath);
    expect(materials.bindingAdditions().seatSkillsRoot).toBe(target.skillsRoot);
  });

  it("the target's skills are checked against the target runtime's own seat storage, never the predecessor's", () => {
    const node = seat("codex");
    const edited = (root: string) => {
      mkdirSync(nodePath.join(root, "review"), { recursive: true });
      writeFileSync(nodePath.join(root, "review", "SKILL.md"), "---\nname: review\ndescription: Edited by hand.\n---\n");
    };
    const skillClass = () => plan(node, "codex", "claude-code").plan.entries.find((entry) => entry.category === "skill")?.classification;
    // An edited copy in the Codex predecessor's storage has nothing to do with the Claude successor.
    edited(seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "codex" }, home).skillsRoot);
    expect(skillClass()).toBe("safe_projection");
    // One in the Claude seat's own storage is a conflict the preview reports, not something overwritten silently.
    edited(seatSkillPaths({ rigId, logicalId: "dev.impl", runtime: "claude-code" }, home).skillsRoot);
    expect(skillClass()).toBe("hash_conflict");
  });

  it("a spec that isn't where the seat's last launch read it is reported before anything stops", () => {
    rmSync(nodePath.join(agentDir, "agent.yaml"));
    expect(() => plan(seat("codex"), "codex", "claude-code")).toThrow(/agent spec \(impl\) wasn't found where its last launch read it/);
  });

  // #2456: the switch's preparation writes the successor's guidance through the target adapter, as a start does. A block
  // OpenRig wrote is refreshed from its changed source, and one a person edited since is kept.
  describe("the preparation and a managed guidance block OpenRig wrote (#2456)", () => {
    const tmux = { sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), hasSession: vi.fn(async () => true) };
    async function switchToClaude(edit: boolean): Promise<{ after: string; notes: string[] }> {
      const node = seat("codex");
      const culture = nodePath.join(agentDir, "culture.md");
      writeFileSync(culture, "Team culture, revised.\n");
      const saved = savedContext(node, "codex");
      saved.resolvedStartupFiles.push({ path: "culture.md", absolutePath: culture, ownerRoot: agentDir, deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] });
      const materials = planRuntimeSwitchMaterials({ db, node, rigName: "seat-rig", canonicalSession: "dev-impl@seat-rig", runtime: "claude-code",
        explicit: {}, saved, openrigHome: home, resolution: { homedir: tmp, skillsRoot: nodePath.join(tmp, "no-catalog") } });
      const project = nodePath.join(tmp, "project");
      const guidance = nodePath.join(project, "CLAUDE.md");
      // An earlier OpenRig write left the block and its record.
      writeFileSync(guidance, `# Project notes\n\n${managedBlockText("culture.md", "Team culture.\n")}\n`);
      managedBlockRecords(db).set(guidance, "culture.md", "Team culture.\n");
      if (edit) writeFileSync(guidance, readFileSync(guidance, "utf8").replace("Team culture.", "Team culture. My own note."));
      const fsOps = { readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
        exists: (p: string) => existsSync(p), mkdirp: (p: string) => mkdirSync(p, { recursive: true }), copyFile: (a: string, b: string) => copyFileSync(a, b),
        listFiles: (dir: string) => (existsSync(dir) ? readdirSync(dir) : []), homedir: tmp };
      const adapter = new ClaudeCodeAdapter({ tmux, fsOps, sleep: async () => {}, managedBlockRecords: managedBlockRecords(db) } as never);
      const notes = await materials.prepare({ cwd: project, tmuxSession: "dev-impl@seat-rig", ...materials.bindingAdditions() } as NodeBinding, adapter);
      return { after: readFileSync(guidance, "utf8"), notes };
    }

    it("control: a block OpenRig wrote is refreshed from its changed source", async () => {
      const { after, notes } = await switchToClaude(false);
      expect(after).toContain("Team culture, revised.");
      expect(notes.some((note) => note.startsWith("guidance_block_edited:")), JSON.stringify(notes)).toBe(false);
    });

    it("a block a person edited since OpenRig wrote it is kept", async () => {
      const { after, notes } = await switchToClaude(true);
      expect(after).toContain("Team culture. My own note.");
      expect(after).not.toContain("Team culture, revised.");
      // Round 2: the switch's notes name the kept block, so its result and the successor's first turn say so.
      expect(notes.some((note) => note.startsWith("guidance_block_edited:") && note.includes("culture.md")), JSON.stringify(notes)).toBe(true);
    });
  });
});
