// Slice 16: what a seat's successor is planned to launch with on the other runtime, from the seat's own agent spec.
// The spec here declares a Claude model on its profile and Codex defaults, so each direction shows which applies and
// which is dropped (P5: a default declared for the source runtime doesn't reach the target).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
});
