// OPR.0.7.0.13 — copies a Claude seat's earlier launches put in the project leave only when the project's own loadout
// record names this seat as their sole owner and they are unchanged. Real catalog, real reconciler.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileSkillLoadout, resolveSkillLoadout, type SkillLoadout } from "../src/domain/skill-catalog.js";
import { migrateLegacyProjectSkills } from "../src/domain/seat-skill-storage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function catalogWith(ids: string[]): { catalog: string; project: string; loadout: (topology: string[], projectSkills?: string[]) => SkillLoadout } {
  const root = mkdtempSync(join(tmpdir(), "seat-skill-migration-"));
  roots.push(root);
  const catalog = join(root, "skills");
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  for (const id of ids) {
    mkdirSync(join(catalog, id), { recursive: true });
    writeFileSync(join(catalog, id, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n# ${id}\n`);
  }
  writeFileSync(join(catalog, "catalog.yaml"), "schema: openrig.skill-catalog/v1\nsystem: []\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "t@openrig.invalid"); git("config", "user.name", "T"); git("add", "."); git("commit", "-qm", "f");
  const loadout = (topology: string[], projectSkills?: string[]) => {
    const resolved = resolveSkillLoadout({ catalogRoot: catalog, topologySkills: topology, ...(projectSkills ? { projectSkills } : {}) });
    if (!resolved.ok) throw new Error(JSON.stringify(resolved.errors));
    return resolved.loadout;
  };
  return { catalog, project, loadout };
}

// What a seat's launch in the project did before seat storage: copies in <project>/.claude/skills, recorded per owner.
function legacyLaunch(project: string, loadout: SkillLoadout, owner: string) {
  const result = reconcileSkillLoadout({ loadout, runtime: "claude-code", cwd: project, apply: true, topologyOwner: owner });
  expect(result.ok, JSON.stringify(result.errors)).toBe(true);
}

describe("moving a Claude seat's old project copies out", () => {
  it("removes the copies this seat alone owned, once it uses its own storage", () => {
    const { project, loadout } = catalogWith(["queue-handoff", "review-pr"]);
    const selected = loadout(["queue-handoff", "review-pr"]);
    legacyLaunch(project, selected, "dev-impl@team");
    expect(existsSync(join(project, ".claude/skills/queue-handoff/SKILL.md"))).toBe(true);
    const notes = migrateLegacyProjectSkills({ reconcile: reconcileSkillLoadout, loadout: selected, cwd: project, owner: "dev-impl@team" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^legacy_project_skills_removed: .*queue-handoff/);
    expect(existsSync(join(project, ".claude/skills/queue-handoff"))).toBe(false);
    expect(existsSync(join(project, ".claude/skills/review-pr"))).toBe(false);
  });

  it("keeps a skill the person installed for the project, and removes only the seat's own", () => {
    const { project, loadout } = catalogWith(["queue-handoff", "review-pr"]);
    legacyLaunch(project, loadout(["queue-handoff"], ["review-pr"]), "dev-impl@team");
    expect(existsSync(join(project, ".claude/skills/review-pr/SKILL.md"))).toBe(true);
    const notes = migrateLegacyProjectSkills({ reconcile: reconcileSkillLoadout, loadout: loadout(["queue-handoff"]), cwd: project, owner: "dev-impl@team" });
    expect(notes).toEqual([`legacy_project_skills_removed: queue-handoff (now in this seat's own storage)`]);
    expect(existsSync(join(project, ".claude/skills/queue-handoff"))).toBe(false);
    expect(existsSync(join(project, ".claude/skills/review-pr/SKILL.md"))).toBe(true);
  });

  it("keeps an edited copy and says why", () => {
    const { project, loadout } = catalogWith(["queue-handoff"]);
    const selected = loadout(["queue-handoff"]);
    legacyLaunch(project, selected, "dev-impl@team");
    writeFileSync(join(project, ".claude/skills/queue-handoff/SKILL.md"), "the person's edit\n");
    const notes = migrateLegacyProjectSkills({ reconcile: reconcileSkillLoadout, loadout: selected, cwd: project, owner: "dev-impl@team" });
    expect(notes[0]).toMatch(/^legacy_project_skills_kept: stale_target_modified/);
    expect(readFileSync(join(project, ".claude/skills/queue-handoff/SKILL.md"), "utf8")).toBe("the person's edit\n");
  });

  it("removes nothing while another seat still shares the copies", () => {
    const { project, loadout } = catalogWith(["queue-handoff"]);
    const selected = loadout(["queue-handoff"]);
    legacyLaunch(project, selected, "dev-impl@team");
    legacyLaunch(project, selected, "dev-qa@team");
    const notes = migrateLegacyProjectSkills({ reconcile: reconcileSkillLoadout, loadout: selected, cwd: project, owner: "dev-impl@team" });
    expect(notes).toEqual(["legacy_project_skills_kept: other seats still share the project's copies (dev-qa@team)"]);
    expect(existsSync(join(project, ".claude/skills/queue-handoff/SKILL.md"))).toBe(true);
  });

  it("does nothing in a project OpenRig never projected into", () => {
    const { project, loadout } = catalogWith(["queue-handoff"]);
    mkdirSync(join(project, ".claude/skills/mine"), { recursive: true });
    writeFileSync(join(project, ".claude/skills/mine/SKILL.md"), "mine\n");
    expect(migrateLegacyProjectSkills({ reconcile: reconcileSkillLoadout, loadout: loadout(["queue-handoff"]), cwd: project, owner: "dev-impl@team" })).toEqual([]);
    expect(readFileSync(join(project, ".claude/skills/mine/SKILL.md"), "utf8")).toBe("mine\n");
  });
});
