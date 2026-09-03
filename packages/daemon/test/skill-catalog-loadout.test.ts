import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeSkill(catalog: string, dir: string, id = dir, body = `# ${id}\n`): void {
  const root = join(catalog, dir);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), `---\nname: ${id}\ndescription: Use when testing ${id}.\n---\n\n${body}`);
}

function fixture(system: string[] = []): { root: string; catalog: string; project: string } {
  const root = mkdtempSync(join(tmpdir(), "openrig-skill-catalog-"));
  roots.push(root);
  const catalog = join(root, "skills");
  const project = join(root, "project");
  mkdirSync(catalog, { recursive: true });
  mkdirSync(project, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@openrig.invalid");
  git(root, "config", "user.name", "OpenRig Test");
  writeFileSync(join(catalog, "catalog.yaml"), `schema: openrig.skill-catalog/v1\nsystem:\n${system.map((id) => `  - ${id}`).join("\n")}${system.length ? "\n" : "  []\n"}`);
  return { root, catalog, project };
}

function commit(root: string): string {
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return git(root, "rev-parse", "HEAD");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed skill catalog and composable loadouts", () => {
  it("composes system, topology, and project selectors deterministically with exact deduplication and provenance", () => {
    const f = fixture(["system-skill", "shared"]);
    writeSkill(f.catalog, "system-skill");
    writeSkill(f.catalog, "topology-skill");
    writeSkill(f.catalog, "project-skill");
    writeSkill(f.catalog, "shared");
    writeFileSync(join(f.project, "project.yaml"), "install:\n  skills: [project-skill, shared]\n");
    const revision = commit(f.root);

    const result = resolveSkillLoadout({
      catalogRoot: f.catalog,
      topologySkills: ["topology-skill", "shared"],
      projectRoot: f.project,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loadout.entries.map((entry) => entry.id)).toEqual([
      "project-skill",
      "shared",
      "system-skill",
      "topology-skill",
    ]);
    expect(result.loadout.entries.find((entry) => entry.id === "shared")!.selectedBy)
      .toEqual(["system", "topology", "project"]);
    expect(result.loadout.catalogRevision).toBe(revision);
    expect(result.loadout.catalogDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.loadout.entries.every((entry) => entry.sourceRoot === f.catalog)).toBe(true);
  });

  it("refuses a dirty catalog revision and a missing selected identity without projecting", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "known");
    commit(f.root);
    writeFileSync(join(f.catalog, "known", "SKILL.md"), "dirty\n");
    const dirty = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["known"] });
    expect(dirty).toMatchObject({ ok: false, errors: [{ code: "catalog_unavailable" }] });
    if (!dirty.ok) expect(dirty.errors[0]!.message).toMatch(/uncommitted/);

    git(f.root, "restore", "skills/known/SKILL.md");
    const missing = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["absent"] });
    expect(missing).toMatchObject({ ok: false, errors: [{ code: "selected_skill_missing" }] });
  });

  it("reports duplicate catalog identities explicitly", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "first", "same-id");
    writeSkill(f.catalog, "second", "same-id");
    commit(f.root);
    const result = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["same-id"] });
    expect(result).toMatchObject({ ok: false, errors: [{ code: "catalog_unavailable" }] });
    if (!result.ok) expect(result.errors[0]!.message).toMatch(/duplicate managed skill identity/);
  });

  it.each([
    ["claude-code", ".claude"],
    ["codex", ".agents"],
  ] as const)("projects exact bytes idempotently for %s and removes only stale owned unchanged skills", (runtime, harnessDir) => {
    const f = fixture([]);
    writeSkill(f.catalog, "one");
    writeSkill(f.catalog, "two");
    writeFileSync(join(f.catalog, "two", "helper.sh"), "#!/bin/sh\necho two\n");
    chmodSync(join(f.catalog, "two", "helper.sh"), 0o755);
    commit(f.root);

    const first = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["one", "two"] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const planned = reconcileSkillLoadout({ loadout: first.loadout, runtime, cwd: f.project });
    expect(planned.receipts.map((receipt) => receipt.status)).toEqual(["missing", "missing"]);
    expect(readFileSync(join(f.catalog, "two", "SKILL.md"), "utf8")).not.toBe("");

    const applied = reconcileSkillLoadout({ loadout: first.loadout, runtime, cwd: f.project, apply: true });
    expect(applied.ok).toBe(true);
    expect(applied.freshLaunchRequired).toBe(true);
    expect(applied.receipts.every((receipt) => receipt.status === "current")).toBe(true);
    expect(readFileSync(join(f.project, harnessDir, "skills", "two", "helper.sh"), "utf8")).toBe("#!/bin/sh\necho two\n");

    const idempotent = reconcileSkillLoadout({ loadout: first.loadout, runtime, cwd: f.project, apply: true });
    expect(idempotent.ok).toBe(true);
    expect(idempotent.applied).toBe(false);
    expect(idempotent.freshLaunchRequired).toBe(false);
    expect(idempotent.receipts.every((receipt) => receipt.detail === "owned target matches catalog bytes")).toBe(true);

    writeSkill(join(f.project, harnessDir, "skills"), "unrelated", "unrelated", "# user-owned\n");
    const switched = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["two"] });
    expect(switched.ok).toBe(true);
    if (!switched.ok) return;
    const switchedApply = reconcileSkillLoadout({ loadout: switched.loadout, runtime, cwd: f.project, apply: true });
    expect(switchedApply.ok).toBe(true);
    expect(switchedApply.removed).toEqual(["one"]);
    expect(() => readFileSync(join(f.project, harnessDir, "skills", "one", "SKILL.md"), "utf8")).toThrow();
    expect(readFileSync(join(f.project, harnessDir, "skills", "unrelated", "SKILL.md"), "utf8")).toContain("user-owned");
  });

  it("protects modified owned targets and leaves an equal unowned shadow untouched", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "owned");
    writeSkill(f.catalog, "shadow");
    commit(f.root);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["owned"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true }).ok).toBe(true);
    writeFileSync(join(f.project, ".agents", "skills", "owned", "SKILL.md"), "operator edit\n");

    const empty = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: [] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const refused = reconcileSkillLoadout({ loadout: empty.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(refused).toMatchObject({ ok: false, applied: false, errors: [{ code: "stale_target_modified" }] });
    expect(readFileSync(join(f.project, ".agents", "skills", "owned", "SKILL.md"), "utf8")).toBe("operator edit\n");

    rmSync(join(f.project, ".agents", "skills", "owned"), { recursive: true, force: true });
    mkdirSync(join(f.project, ".agents", "skills", "shadow"), { recursive: true });
    writeFileSync(
      join(f.project, ".agents", "skills", "shadow", "SKILL.md"),
      readFileSync(join(f.catalog, "shadow", "SKILL.md")),
    );
    const shadow = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["shadow"] });
    expect(shadow.ok).toBe(true);
    if (!shadow.ok) return;
    const observed = reconcileSkillLoadout({ loadout: shadow.loadout, runtime: "codex", cwd: f.project });
    expect(observed.receipts[0]!.status).toBe("shadowed");
  });

  it("adds and switches project selections in place while system, topology, and unrelated entries stay byte-stable", () => {
    const f = fixture(["system-skill"]);
    for (const id of ["system-skill", "topology-skill", "project-a", "project-b"]) writeSkill(f.catalog, id);
    commit(f.root);
    const unrelated = join(f.project, ".agents", "skills", "local-only");
    mkdirSync(unrelated, { recursive: true });
    writeFileSync(join(unrelated, "SKILL.md"), "local bytes\n");

    const noProject = resolveSkillLoadout({
      catalogRoot: f.catalog,
      topologySkills: ["topology-skill"],
      projectSkills: [],
    });
    expect(noProject.ok).toBe(true);
    if (!noProject.ok) return;
    expect(reconcileSkillLoadout({ loadout: noProject.loadout, runtime: "codex", cwd: f.project, apply: true }).ok).toBe(true);
    const systemBefore = readFileSync(join(f.project, ".agents", "skills", "system-skill", "SKILL.md"));
    const topologyBefore = readFileSync(join(f.project, ".agents", "skills", "topology-skill", "SKILL.md"));

    const projectA = resolveSkillLoadout({
      catalogRoot: f.catalog,
      topologySkills: ["topology-skill"],
      projectSkills: ["project-a"],
    });
    expect(projectA.ok).toBe(true);
    if (!projectA.ok) return;
    expect(reconcileSkillLoadout({ loadout: projectA.loadout, runtime: "codex", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, removed: [] });

    const projectB = resolveSkillLoadout({
      catalogRoot: f.catalog,
      topologySkills: ["topology-skill"],
      projectSkills: ["project-b"],
    });
    expect(projectB.ok).toBe(true);
    if (!projectB.ok) return;
    expect(reconcileSkillLoadout({ loadout: projectB.loadout, runtime: "codex", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, removed: ["project-a"] });

    expect(readFileSync(join(f.project, ".agents", "skills", "system-skill", "SKILL.md"))).toEqual(systemBefore);
    expect(readFileSync(join(f.project, ".agents", "skills", "topology-skill", "SKILL.md"))).toEqual(topologyBefore);
    expect(readFileSync(join(unrelated, "SKILL.md"), "utf8")).toBe("local bytes\n");
    expect(() => readFileSync(join(f.project, ".agents", "skills", "project-a", "SKILL.md"))).toThrow();
    expect(readFileSync(join(f.project, ".agents", "skills", "project-b", "SKILL.md"), "utf8")).toContain("project-b");
  });

  it("retains an installed project selection when seat startup has no project input and clears it only on explicit empty install", () => {
    const f = fixture(["system-skill"]);
    writeSkill(f.catalog, "system-skill");
    writeSkill(f.catalog, "project-skill");
    commit(f.root);

    const installed = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["project-skill"] });
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    expect(reconcileSkillLoadout({ loadout: installed.loadout, runtime: "codex", cwd: f.project, apply: true }).ok).toBe(true);

    const startupWithoutProject = resolveSkillLoadout({
      catalogRoot: f.catalog,
      topologySkills: [],
      projectRoot: join(f.root, "cwd-with-no-project-manifest"),
    });
    expect(startupWithoutProject.ok).toBe(true);
    if (!startupWithoutProject.ok) return;
    expect(startupWithoutProject.loadout.projectSelectionDeclared).toBe(false);
    const preserved = reconcileSkillLoadout({
      loadout: startupWithoutProject.loadout,
      runtime: "codex",
      cwd: f.project,
      topologyOwner: "seat-a",
      apply: true,
    });
    expect(preserved).toMatchObject({ ok: true, applied: false, removed: [] });
    expect(preserved.receipts.find((receipt) => receipt.id === "project-skill")?.selectedBy).toEqual(["project"]);
    expect(existsSync(join(f.project, ".agents", "skills", "project-skill", "SKILL.md"))).toBe(true);

    const explicitEmpty = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: [] });
    expect(explicitEmpty.ok).toBe(true);
    if (!explicitEmpty.ok) return;
    expect(explicitEmpty.loadout.projectSelectionDeclared).toBe(true);
    const cleared = reconcileSkillLoadout({ loadout: explicitEmpty.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(cleared).toMatchObject({ ok: true, removed: ["project-skill"] });
    expect(existsSync(join(f.project, ".agents", "skills", "project-skill", "SKILL.md"))).toBe(false);
  });

  it("refuses incompatible symlink targets and rolls back a projection filesystem failure", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "selected");
    commit(f.root);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["selected"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    const external = join(f.root, "external");
    writeSkill(external, "selected");
    mkdirSync(join(f.project, ".agents", "skills"), { recursive: true });
    symlinkSync(join(external, "selected"), join(f.project, ".agents", "skills", "selected"));
    const linked = reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(linked).toMatchObject({ ok: false, applied: false, errors: [{ code: "target_conflict" }] });

    rmSync(join(f.project, ".agents"), { recursive: true, force: true });
    writeFileSync(join(f.project, ".agents"), "not a directory\n");
    const failed = reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(failed).toMatchObject({ ok: false, applied: false, errors: [{ code: "projection_failed" }] });
    expect(existsSync(join(f.project, ".openrig", "skill-loadouts", "codex.json"))).toBe(false);
    expect(readFileSync(join(f.project, ".agents"), "utf8")).toBe("not a directory\n");
  });

  it("unions topology selections from seats that share one runtime working directory", () => {
    const f = fixture(["system-skill"]);
    for (const id of ["system-skill", "role-a", "role-b"]) writeSkill(f.catalog, id);
    commit(f.root);

    const loadoutA = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["role-a"] });
    const loadoutB = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["role-b"] });
    expect(loadoutA.ok).toBe(true);
    expect(loadoutB.ok).toBe(true);
    if (!loadoutA.ok || !loadoutB.ok) return;
    expect(reconcileSkillLoadout({ loadout: loadoutA.loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-a", apply: true }).ok).toBe(true);
    expect(reconcileSkillLoadout({ loadout: loadoutB.loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-b", apply: true }).ok).toBe(true);
    expect(existsSync(join(f.project, ".agents", "skills", "role-a", "SKILL.md"))).toBe(true);
    expect(existsSync(join(f.project, ".agents", "skills", "role-b", "SKILL.md"))).toBe(true);

    const systemOnly = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: [] });
    expect(systemOnly.ok).toBe(true);
    if (!systemOnly.ok) return;
    const clearedA = reconcileSkillLoadout({ loadout: systemOnly.loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-a", apply: true });
    expect(clearedA).toMatchObject({ ok: true, removed: ["role-a"] });
    expect(existsSync(join(f.project, ".agents", "skills", "role-a", "SKILL.md"))).toBe(false);
    expect(existsSync(join(f.project, ".agents", "skills", "role-b", "SKILL.md"))).toBe(true);

    const clearedB = reconcileSkillLoadout({ loadout: systemOnly.loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-b", apply: true });
    expect(clearedB).toMatchObject({ ok: true, removed: ["role-b"] });
    expect(existsSync(join(f.project, ".agents", "skills", "role-b", "SKILL.md"))).toBe(false);
    expect(existsSync(join(f.project, ".agents", "skills", "system-skill", "SKILL.md"))).toBe(true);
  });

  it("refuses an unsafe topology owner and a manifest that redirects ownership outside the harness root", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "owned");
    commit(f.root);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["owned"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    const unsafeOwner = reconcileSkillLoadout({
      loadout: selected.loadout,
      runtime: "codex",
      cwd: f.project,
      topologyOwner: "__proto__",
      apply: true,
    });
    expect(unsafeOwner).toMatchObject({ ok: false, errors: [{ code: "topology_owner_invalid" }] });

    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true }).ok).toBe(true);
    const manifestPath = join(f.project, ".openrig", "skill-loadouts", "codex.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { skills: Array<{ target: string }> };
    const external = join(f.root, "must-survive");
    mkdirSync(external);
    writeFileSync(join(external, "marker"), "preserved\n");
    manifest.skills[0]!.target = external;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const empty = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: [] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const refused = reconcileSkillLoadout({ loadout: empty.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(refused).toMatchObject({ ok: false, errors: [{ code: "ownership_manifest_invalid" }] });
    expect(readFileSync(join(external, "marker"), "utf8")).toBe("preserved\n");
  });
});
