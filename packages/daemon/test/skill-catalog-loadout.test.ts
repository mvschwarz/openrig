import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reconcileSkillLoadout, resolvePluginSkills, resolveSkillLoadout, type SkillLoadout } from "../src/domain/skill-catalog.js";

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
  it("uses an explicit System World selector instead of the legacy catalog selector", () => {
    const f = fixture(["legacy-system"]);
    for (const id of ["legacy-system", "world-system", "topology-skill"]) writeSkill(f.catalog, id);
    commit(f.root);

    const result = resolveSkillLoadout({
      catalogRoot: f.catalog,
      systemSkills: ["world-system"],
      topologySkills: ["topology-skill"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loadout.entries.map((entry) => [entry.id, entry.selectedBy])).toEqual([
      ["topology-skill", ["topology"]],
      ["world-system", ["system"]],
    ]);
  });

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
    expect(idempotent.receipts.every((receipt) => receipt.detail === "owned target matches selected source bytes")).toBe(true);

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

  it.each([
    ["claude-code", ".claude"],
    ["codex", ".agents"],
  ] as const)("keeps a successful %s projection clean in ordinary Git without hiding unrelated harness entries", (runtime, harnessDir) => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    const localSkill = join(f.project, harnessDir, "skills", "local-only", "SKILL.md");
    mkdirSync(join(localSkill, ".."), { recursive: true });
    writeFileSync(localSkill, "# tracked local skill\n");
    commit(f.root);

    const excludePath = join(f.root, ".git", "info", "exclude");
    const operatorExclude = `${readFileSync(excludePath, "utf8")}\n# operator-owned rule\n/private-cache/\n`;
    writeFileSync(excludePath, operatorExclude);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    const first = reconcileSkillLoadout({ loadout: selected.loadout, runtime, cwd: f.project, apply: true });
    expect(first.errors).toEqual([]);
    expect(first).toMatchObject({ ok: true, applied: true });
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(readFileSync(excludePath, "utf8")).toBe(operatorExclude);
    expect(git(f.root, "check-ignore", "-v", "--no-index", join(f.project, harnessDir, "skills", "managed", "SKILL.md")))
      .toContain(`${harnessDir}/skills/.gitignore`);
    expect(() => git(f.root, "check-ignore", "--no-index", localSkill)).toThrow();

    rmSync(join(f.project, harnessDir, "skills", ".gitignore"));
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).not.toBe("");
    const healed = reconcileSkillLoadout({ loadout: selected.loadout, runtime, cwd: f.project, apply: true });
    expect(healed).toMatchObject({ ok: true, applied: true, freshLaunchRequired: false });
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    const idempotent = reconcileSkillLoadout({ loadout: selected.loadout, runtime, cwd: f.project, apply: true });
    expect(idempotent).toMatchObject({ ok: true, applied: false, freshLaunchRequired: false });
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");

    const empty = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: [] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    expect(reconcileSkillLoadout({ loadout: empty.loadout, runtime, cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, removed: ["managed"] });
    expect(() => git(f.root, "check-ignore", "--no-index", join(f.project, harnessDir, "skills", "managed", "SKILL.md"))).toThrow();
    expect(readFileSync(excludePath, "utf8")).toBe(operatorExclude);
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("refuses before projecting when a foreign ignore covers only part of a multi-file skill", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    mkdirSync(join(f.catalog, "managed", "scripts"), { recursive: true });
    writeFileSync(join(f.catalog, "managed", "scripts", "helper.txt"), "managed helper\n");
    const ignorePath = join(f.project, ".agents", "skills", ".gitignore");
    mkdirSync(join(ignorePath, ".."), { recursive: true });
    writeFileSync(ignorePath, "/managed/SKILL.md\n");
    commit(f.root);

    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    const result = reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true });
    const repeated = reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true });

    expect(result).toMatchObject({ ok: false, applied: false, errors: [{ code: "git_exclusion_failed" }] });
    expect(repeated).toMatchObject({ ok: false, applied: false, errors: [{ code: "git_exclusion_failed" }] });
    expect(existsSync(join(f.project, ".agents", "skills", "managed"))).toBe(false);
    expect(existsSync(join(f.project, ".openrig", "skill-loadouts", "codex.json"))).toBe(false);
    expect(readFileSync(ignorePath, "utf8")).toBe("/managed/SKILL.md\n");
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("does not hide an unowned same-path skill in a sibling linked worktree", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    commit(f.root);
    const sibling = mkdtempSync(join(tmpdir(), "openrig-skill-loadout-linked-"));
    roots.push(sibling);
    rmSync(sibling, { recursive: true, force: true });
    git(f.root, "worktree", "add", "-q", "--detach", sibling, "HEAD");
    const foreignSkill = join(sibling, "project", ".agents", "skills", "managed", "SKILL.md");
    mkdirSync(join(foreignSkill, ".."), { recursive: true });
    writeFileSync(foreignSkill, "# unowned sibling skill\n");
    const visible = "?? project/.agents/skills/managed/SKILL.md";
    expect(git(sibling, "status", "--porcelain=v1", "--untracked-files=all")).toBe(visible);

    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, applied: true });

    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    expect(git(sibling, "status", "--porcelain=v1", "--untracked-files=all")).toBe(visible);
  });

  it("composes both runtime projections in one Git working tree", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    commit(f.root);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, applied: true });
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "claude-code", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, applied: true });
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true }))
      .toMatchObject({ ok: true, applied: false });

    const manifestIgnore = readFileSync(join(f.project, ".openrig", "skill-loadouts", ".gitignore"), "utf8");
    expect(manifestIgnore).toContain("# BEGIN OpenRig managed skill loadout codex");
    expect(manifestIgnore).toContain("# BEGIN OpenRig managed skill loadout claude-code");
    expect(git(f.root, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
  });

  it("projects safely when the working directory is outside Git", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    commit(f.root);
    const cwd = mkdtempSync(join(tmpdir(), "openrig-skill-loadout-no-git-"));
    roots.push(cwd);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;

    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd, apply: true }))
      .toMatchObject({ ok: true, applied: true });
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd, apply: true }))
      .toMatchObject({ ok: true, applied: false });
    expect(readFileSync(join(cwd, ".agents", "skills", "managed", "SKILL.md"), "utf8")).toContain("name: managed");
    expect(existsSync(join(cwd, ".git"))).toBe(false);
  });

  it.each([
    ["claude-code", ".claude"],
    ["codex", ".agents"],
  ] as const)("preserves a %s projection after a mode-only local edit", (runtime, harnessDir) => {
    const f = fixture([]);
    writeSkill(f.catalog, "executable");
    writeFileSync(join(f.catalog, "executable", "helper.sh"), "#!/bin/sh\necho executable\n");
    chmodSync(join(f.catalog, "executable", "helper.sh"), 0o755);
    commit(f.root);

    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: ["executable"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime, cwd: f.project, apply: true }).ok).toBe(true);

    const target = join(f.project, harnessDir, "skills", "executable");
    const helper = join(target, "helper.sh");
    chmodSync(helper, 0o644);
    const inspection = reconcileSkillLoadout({ loadout: selected.loadout, runtime, cwd: f.project });

    const empty = resolveSkillLoadout({ catalogRoot: f.catalog, projectSkills: [] });
    expect(empty.ok).toBe(true);
    if (!empty.ok) return;
    const deselected = reconcileSkillLoadout({ loadout: empty.loadout, runtime, cwd: f.project, apply: true });

    expect({
      inspectionStatus: inspection.receipts[0]?.status,
      deselectionOk: deselected.ok,
      deselectionApplied: deselected.applied,
      removed: deselected.removed,
      errorCodes: deselected.errors.map((error) => error.code),
      targetExists: existsSync(target),
      helperMode: existsSync(helper) ? lstatSync(helper).mode & 0o777 : null,
    }).toEqual({
      inspectionStatus: "conflicting",
      deselectionOk: false,
      deselectionApplied: false,
      removed: [],
      errorCodes: ["stale_target_modified"],
      targetExists: true,
      helperMode: 0o644,
    });
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

  it("refuses incompatible symlink targets and reports restored state after a projection rollback", () => {
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
    mkdirSync(join(f.project, ".agents", "skills"), { recursive: true });
    mkdirSync(join(f.project, ".openrig"), { recursive: true });
    writeFileSync(join(f.project, ".openrig", "skill-loadouts"), "not a directory\n");
    const failed = reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, apply: true });
    expect(failed).toMatchObject({ ok: false, applied: false, errors: [{ code: "projection_failed" }] });
    expect(failed.receipts).toMatchObject([{
      id: "selected",
      status: "missing",
      detail: "selected skill is not projected",
    }]);
    expect(existsSync(join(f.project, ".agents", "skills", "selected"))).toBe(false);
    expect(existsSync(join(f.project, ".openrig", "skill-loadouts", "codex.json"))).toBe(false);
    expect(readFileSync(join(f.project, ".openrig", "skill-loadouts"), "utf8")).toBe("not a directory\n");
    expect(existsSync(join(f.project, ".agents", "skills", ".gitignore"))).toBe(false);

    const prior = fixture([]);
    writeSkill(prior.catalog, "selected", "selected", "# prior bytes\n");
    commit(prior.root);
    const initial = resolveSkillLoadout({ catalogRoot: prior.catalog, projectSkills: ["selected"] });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(reconcileSkillLoadout({ loadout: initial.loadout, runtime: "codex", cwd: prior.project, apply: true }).ok).toBe(true);

    writeSkill(prior.catalog, "selected", "selected", "# replacement bytes\n");
    writeSkill(prior.catalog, "new-skill");
    commit(prior.root);
    const replacement = resolveSkillLoadout({ catalogRoot: prior.catalog, projectSkills: ["new-skill", "selected"] });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;

    const manifestDirectory = join(prior.project, ".openrig", "skill-loadouts");
    chmodSync(manifestDirectory, 0o555);
    let rolledBack;
    try {
      rolledBack = reconcileSkillLoadout({ loadout: replacement.loadout, runtime: "codex", cwd: prior.project, apply: true });
    } finally {
      chmodSync(manifestDirectory, 0o755);
    }
    expect(rolledBack).toMatchObject({ ok: false, applied: false, errors: [{ code: "projection_failed" }] });
    expect(rolledBack.receipts).toMatchObject([
      { id: "new-skill", status: "missing", detail: "selected skill is not projected" },
      { id: "selected", status: "stale", detail: "owned target still matches the prior projection and can be refreshed safely" },
    ]);
    expect(existsSync(join(prior.project, ".agents", "skills", "new-skill"))).toBe(false);
    expect(readFileSync(join(prior.project, ".agents", "skills", "selected", "SKILL.md"), "utf8")).toContain("prior bytes");
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

describe("plugin skills in the managed loadout", () => {
  function writePlugin(root: string, manifests: string[], skills: string[]): string {
    const plugin = join(root, "plugins", "core");
    for (const manifest of manifests) {
      mkdirSync(join(plugin, manifest), { recursive: true });
      writeFileSync(join(plugin, manifest, "plugin.json"), JSON.stringify({ name: "core", version: "1.2.3", skills: "./skills" }));
    }
    for (const id of skills) writeSkill(join(plugin, "skills"), id);
    return plugin;
  }

  function loadoutOf(entries: SkillLoadout["entries"], root: string): SkillLoadout {
    return { catalogRoot: join(root, "no-catalog"), catalogRevision: null, catalogDigest: null, projectSelectionDeclared: false, projectSelection: [], entries };
  }

  it("selects a plugin's skills only for the runtimes its manifests or plugin type name", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff", "delegating-work"]);

    const claude = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" });
    expect(claude.warnings).toEqual([]);
    expect(claude.entries.map((entry) => [entry.id, entry.selectedBy, entry.revision, entry.pluginId, entry.sourceDir])).toEqual([
      ["delegating-work", ["topology"], "plugin:core@1.2.3", "core", join(plugin, "skills", "delegating-work")],
      ["queue-handoff", ["topology"], "plugin:core@1.2.3", "core", join(plugin, "skills", "queue-handoff")],
    ]);
    expect(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "codex" }).entries).toEqual([]);
    expect(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "codex", pluginType: "codex" }).entries.map((entry) => entry.id))
      .toEqual(["delegating-work", "queue-handoff"]);
    expect(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code", pluginType: "codex" }).entries).toEqual([]);
  });

  it("skips a plugin skill it cannot copy exactly and says why", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["good", "linked"]);
    symlinkSync(join(plugin, "skills", "good", "SKILL.md"), join(plugin, "skills", "linked", "extra.md"));

    const result = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" });
    expect(result.entries.map((entry) => entry.id)).toEqual(["good"]);
    expect(result.warnings).toEqual([expect.stringMatching(/^plugin_skill_skipped: .*linked.*symlink/)]);
  });

  it.each([
    ["claude-code", ".claude"],
    ["codex", ".agents"],
  ] as const)("projects a plugin's skills into the %s project skill folder and owns them", (runtime, harnessDir) => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin", ".codex-plugin"], ["queue-handoff", "delegating-work"]);
    const loadout = loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime }).entries, f.root);

    expect(reconcileSkillLoadout({ loadout, runtime, cwd: f.project, topologyOwner: "seat-a", apply: true }))
      .toMatchObject({ ok: true, applied: true });
    for (const id of ["queue-handoff", "delegating-work"]) {
      expect(readFileSync(join(f.project, harnessDir, "skills", id, "SKILL.md"), "utf8"))
        .toBe(readFileSync(join(plugin, "skills", id, "SKILL.md"), "utf8"));
    }
    const manifest = JSON.parse(readFileSync(join(f.project, ".openrig", "skill-loadouts", `${runtime}.json`), "utf8")) as {
      skills: Array<{ id: string; revision: string }>;
    };
    expect(manifest.skills.map((skill) => [skill.id, skill.revision])).toEqual([
      ["delegating-work", "plugin:core@1.2.3"],
      ["queue-handoff", "plugin:core@1.2.3"],
    ]);
    expect(reconcileSkillLoadout({ loadout, runtime, cwd: f.project, topologyOwner: "seat-a", apply: true }))
      .toMatchObject({ ok: true, applied: false });
  });

  it("keeps a same-name skill OpenRig does not own and records no ownership or selection for it", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".codex-plugin"], ["queue-handoff", "delegating-work"]);
    const own = join(f.project, ".agents", "skills", "queue-handoff");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: queue-handoff\ndescription: The repository's own copy.\n---\n");
    commit(f.root);
    const loadout = loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "codex" }).entries, f.root);

    const result = reconcileSkillLoadout({ loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-a", apply: true });
    expect(result).toMatchObject({ ok: true, applied: true, errors: [] });
    expect(readFileSync(join(own, "SKILL.md"), "utf8")).toContain("The repository's own copy.");
    expect(git(f.root, "status", "--porcelain", "--untracked-files=no")).toBe("");
    expect(result.receipts.find((receipt) => receipt.id === "queue-handoff")).toMatchObject({
      status: "shadowed",
      detail: expect.stringMatching(/^kept: .*does not own/),
    });
    expect(existsSync(join(f.project, ".agents", "skills", "delegating-work", "SKILL.md"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(f.project, ".openrig", "skill-loadouts", "codex.json"), "utf8")) as {
      skills: Array<{ id: string }>;
      topologySelections: Record<string, string[]>;
    };
    expect(manifest.skills.map((skill) => skill.id)).toEqual(["delegating-work"]);
    expect(manifest.topologySelections).toEqual({ "seat-a": ["delegating-work"] });

    // A seat that shares this folder without the plugin is not blocked by the kept skill.
    expect(reconcileSkillLoadout({ loadout: loadoutOf([], f.root), runtime: "codex", cwd: f.project, topologyOwner: "seat-b", apply: true }))
      .toMatchObject({ ok: true, errors: [] });
  });

  it("refreshes its own copy when the plugin's skill changes", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff"]);
    const resolve = () => loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries, f.root);
    expect(reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, apply: true }).ok).toBe(true);

    writeSkill(join(plugin, "skills"), "queue-handoff", "queue-handoff", "# newer plugin bytes\n");
    const refreshed = reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, apply: true });
    expect(refreshed).toMatchObject({ ok: true, applied: true });
    expect(refreshed.receipts.find((receipt) => receipt.id === "queue-handoff")?.status).toBe("current");
    expect(readFileSync(join(f.project, ".claude", "skills", "queue-handoff", "SKILL.md"), "utf8")).toContain("newer plugin bytes");
  });

  it("keeps an edit to its own plugin copy under the same ownership record", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff"]);
    const resolve = () => loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries, f.root);
    expect(reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, apply: true }).ok).toBe(true);
    const manifestPath = join(f.project, ".openrig", "skill-loadouts", "claude-code.json");
    const ownedBefore = readFileSync(manifestPath, "utf8");
    const target = join(f.project, ".claude", "skills", "queue-handoff", "SKILL.md");
    writeFileSync(target, "operator edit\n");

    writeSkill(join(plugin, "skills"), "queue-handoff", "queue-handoff", "# newer plugin bytes\n");
    const kept = reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, apply: true });
    expect(kept).toMatchObject({ ok: true, errors: [] });
    expect(kept.receipts[0]).toMatchObject({ id: "queue-handoff", status: "shadowed", detail: expect.stringMatching(/^kept: .*changed after OpenRig projected it/) });
    expect(readFileSync(target, "utf8")).toBe("operator edit\n");
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).skills).toEqual(JSON.parse(ownedBefore).skills);
  });

  it("keeps an edited plugin copy that another seat sharing the folder still selects", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".codex-plugin"], ["queue-handoff"]);
    const loadout = loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "codex" }).entries, f.root);
    expect(reconcileSkillLoadout({ loadout, runtime: "codex", cwd: f.project, topologyOwner: "seat-a", apply: true }).ok).toBe(true);
    const target = join(f.project, ".agents", "skills", "queue-handoff", "SKILL.md");
    writeFileSync(target, "operator edit\n");

    const other = reconcileSkillLoadout({ loadout: loadoutOf([], f.root), runtime: "codex", cwd: f.project, topologyOwner: "seat-b", apply: true });
    expect(other).toMatchObject({ ok: true, errors: [] });
    expect(other.receipts[0]).toMatchObject({ id: "queue-handoff", status: "shadowed", detail: expect.stringMatching(/^kept: /) });
    expect(readFileSync(target, "utf8")).toBe("operator edit\n");
  });

  it("leaves an edited plugin copy in place, no longer owned, when the plugin is deselected", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff", "delegating-work"]);
    const loadout = loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries, f.root);
    expect(reconcileSkillLoadout({ loadout, runtime: "claude-code", cwd: f.project, apply: true }).ok).toBe(true);
    const edited = join(f.project, ".claude", "skills", "queue-handoff", "SKILL.md");
    writeFileSync(edited, "operator edit\n");

    const deselected = reconcileSkillLoadout({ loadout: loadoutOf([], f.root), runtime: "claude-code", cwd: f.project, apply: true });
    expect(deselected).toMatchObject({ ok: true, applied: true, removed: ["delegating-work"], errors: [] });
    expect(deselected.receipts.find((receipt) => receipt.id === "queue-handoff")).toMatchObject({ status: "shadowed", detail: expect.stringMatching(/^kept: /) });
    expect(readFileSync(edited, "utf8")).toBe("operator edit\n");
    expect(existsSync(join(f.project, ".claude", "skills", "delegating-work"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(f.project, ".openrig", "skill-loadouts", "claude-code.json"), "utf8")) as { skills: unknown[] };
    expect(manifest.skills).toEqual([]);
  });

  it("lets every seat sharing the folder keep launching after an edit to a plugin copy (review replay)", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff", "delegating-work"]);
    const full = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries;
    const reconcile = (entries: SkillLoadout["entries"], owner: string) =>
      reconcileSkillLoadout({ loadout: loadoutOf(entries, f.root), runtime: "claude-code", cwd: f.project, topologyOwner: owner, apply: true });
    const edited = join(f.project, ".claude", "skills", "queue-handoff", "SKILL.md");

    expect(reconcile(full, "dev-a")).toMatchObject({ ok: true, applied: true });
    writeFileSync(edited, "operator edit\n");
    // Seat B shares the folder and does not select the plugin.
    expect(reconcile([], "dev-b")).toMatchObject({ ok: true, errors: [] });
    // A plugin release drops the edited skill while seat A still selects the plugin.
    expect(reconcile(full.filter((entry) => entry.id !== "queue-handoff"), "dev-a")).toMatchObject({ ok: true, errors: [] });
    // Seat A deselects the plugin altogether.
    expect(reconcile([], "dev-a")).toMatchObject({ ok: true, errors: [] });
    expect(readFileSync(edited, "utf8")).toBe("operator edit\n");
  });

  it("treats a same-name skill in another letter case as the user's and adds no ignore entry for it", () => {
    const f = fixture([]);
    git(f.root, "config", "core.ignorecase", "true");
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff"]);
    const own = join(f.project, ".claude", "skills", "Queue-Handoff");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), "---\nname: Queue-Handoff\ndescription: The user's own.\n---\n");
    const loadout = loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries, f.root);

    const result = reconcileSkillLoadout({ loadout, runtime: "claude-code", cwd: f.project, apply: true });
    expect(result).toMatchObject({ ok: true, errors: [] });
    expect(result.receipts).toEqual([expect.objectContaining({ id: "queue-handoff", status: "shadowed", target: own, detail: expect.stringMatching(/^kept: /) })]);
    expect(readdirSync(join(f.project, ".claude", "skills"))).toEqual(["Queue-Handoff"]);
    expect(git(f.root, "status", "--porcelain", "--untracked-files=all")).toContain("project/.claude/skills/Queue-Handoff/SKILL.md");
  });

  it("keeps a deleted plugin copy whose source changed for another seat, and lets the owner refresh it (review replay)", () => {
    const f = fixture([]);
    const plugin = writePlugin(f.root, [".claude-plugin"], ["queue-handoff"]);
    const resolve = () => loadoutOf(resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" }).entries, f.root);
    expect(reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, topologyOwner: "dev-a", apply: true }).ok).toBe(true);
    const manifestPath = join(f.project, ".openrig", "skill-loadouts", "claude-code.json");
    const ownedBefore = JSON.parse(readFileSync(manifestPath, "utf8")).skills;
    // An upgrade changes the plugin's bytes, and the ignored copy is cleaned away.
    writeSkill(join(plugin, "skills"), "queue-handoff", "queue-handoff", "# newer plugin bytes\n");
    const copy = join(f.project, ".claude", "skills", "queue-handoff");
    mkdirSync(join(f.root, "cleaned"));
    renameSync(copy, join(f.root, "cleaned", "queue-handoff"));

    // Seat B shares the folder and does not select the plugin.
    const other = reconcileSkillLoadout({ loadout: loadoutOf([], f.root), runtime: "claude-code", cwd: f.project, topologyOwner: "dev-b", apply: true });
    expect(other).toMatchObject({ ok: true, errors: [] });
    expect(other.receipts).toEqual([expect.objectContaining({ id: "queue-handoff", status: "shadowed", detail: expect.stringMatching(/^kept: /) })]);
    expect(existsSync(copy)).toBe(false);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).skills).toEqual(ownedBefore);

    // Seat A's next launch projects the new bytes and refreshes the record.
    const owner = reconcileSkillLoadout({ loadout: resolve(), runtime: "claude-code", cwd: f.project, topologyOwner: "dev-a", apply: true });
    expect(owner).toMatchObject({ ok: true, applied: true, errors: [] });
    expect(readFileSync(join(copy, "SKILL.md"), "utf8")).toContain("newer plugin bytes");
  });

  it("still refuses a deleted catalog copy whose source changed, as before", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "managed");
    commit(f.root);
    const selected = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["managed"] });
    expect(selected.ok).toBe(true);
    if (!selected.ok) return;
    expect(reconcileSkillLoadout({ loadout: selected.loadout, runtime: "codex", cwd: f.project, topologyOwner: "dev-a", apply: true }).ok).toBe(true);
    writeFileSync(join(f.catalog, "managed", "SKILL.md"), "---\nname: managed\ndescription: Use when testing managed.\n---\n\n# changed\n");
    mkdirSync(join(f.root, "cleaned"));
    renameSync(join(f.project, ".agents", "skills", "managed"), join(f.root, "cleaned", "managed"));

    const other = reconcileSkillLoadout({ loadout: loadoutOf([], f.root), runtime: "codex", cwd: f.project, topologyOwner: "dev-b", apply: true });
    expect(other).toMatchObject({ ok: false, errors: [{ code: "target_conflict" }] });
  });

  it("does not keep a same-name catalog record when a plugin's source changes under it", () => {
    const f = fixture([]);
    writeSkill(f.catalog, "queue-handoff");
    commit(f.root);
    const catalog = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["queue-handoff"] });
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(reconcileSkillLoadout({ loadout: catalog.loadout, runtime: "codex", cwd: f.project, topologyOwner: "dev-a", apply: true }).ok).toBe(true);
    const target = join(f.project, ".agents", "skills", "queue-handoff", "SKILL.md");
    const catalogBytes = readFileSync(target, "utf8");

    // Another seat's plugin supplies its own queue-handoff, and its source changes before the reconcile applies.
    const plugin = writePlugin(f.root, [".codex-plugin"], ["queue-handoff"]);
    writeSkill(join(plugin, "skills"), "queue-handoff", "queue-handoff", "# the plugin's own bytes\n");
    const entries = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "codex" }).entries;
    writeSkill(join(plugin, "skills"), "queue-handoff", "queue-handoff", "# changed after resolve\n");
    const other = reconcileSkillLoadout({ loadout: loadoutOf(entries, f.root), runtime: "codex", cwd: f.project, topologyOwner: "dev-b", apply: true });
    expect(other).toMatchObject({ ok: false, errors: [{ code: "target_conflict" }] });
    expect(readFileSync(target, "utf8")).toBe(catalogBytes);
  });

  it("returns no plugin skills, with a warning, when the plugin's skills path is not a readable folder", () => {
    const f = fixture([]);
    const plugin = join(f.root, "plugins", "core");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "core", skills: "./skills.md" }));
    writeFileSync(join(plugin, "skills.md"), "not a folder\n");

    const result = resolvePluginSkills({ pluginId: "core", pluginRoot: plugin, runtime: "claude-code" });
    expect(result.entries).toEqual([]);
    expect(result.warnings).toEqual([expect.stringMatching(/^plugin_skill_skipped: plugin core skills at .*skills\.md/)]);
  });
});

// #875 — a seat_material: seat Claude seat keeps its loadout in its OpenRig seat directory.
describe("skill loadout kept outside the cwd", () => {
  it("projects into the given location, records plugin-qualified names and leaves the checkout clean", () => {
    const f = fixture();
    writeSkill(f.catalog, "review");
    writeSkill(f.catalog, "kickoff");
    commit(f.root);
    const seatRoot = join(f.root, "openrig-home", "state", "claude-seats", "dev-impl@rig");
    const location = {
      targetRoot: join(seatRoot, "plugin", "skills"),
      manifestPath: join(seatRoot, "skill-loadout.json"),
      qualifiedName: (id: string) => `openrig:${id}`,
    };
    const resolved = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["review", "kickoff"] });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    const applied = reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "claude-code", cwd: f.project, apply: true, topologyOwner: "dev-impl@rig", location });
    expect(applied.ok).toBe(true);
    expect(applied.targetRoot).toBe(location.targetRoot);
    expect(readFileSync(join(location.targetRoot, "review", "SKILL.md"), "utf8")).toContain("name: review");
    const manifest = JSON.parse(readFileSync(location.manifestPath, "utf8")) as { skills: Array<{ id: string; qualifiedName?: string }> };
    expect(manifest.skills.map((skill) => [skill.id, skill.qualifiedName])).toEqual([
      ["kickoff", "openrig:kickoff"],
      ["review", "openrig:review"],
    ]);
    expect(readdirSync(f.project)).toEqual([]);
    expect(git(f.root, "status", "--porcelain", "--", "project")).toBe("");

    const again = reconcileSkillLoadout({ loadout: resolved.loadout, runtime: "claude-code", cwd: f.project, apply: true, topologyOwner: "dev-impl@rig", location });
    expect(again).toMatchObject({ ok: true, applied: false });

    const narrowed = resolveSkillLoadout({ catalogRoot: f.catalog, topologySkills: ["review"] });
    if (!narrowed.ok) throw new Error("narrowed loadout did not resolve");
    const removed = reconcileSkillLoadout({ loadout: narrowed.loadout, runtime: "claude-code", cwd: f.project, apply: true, topologyOwner: "dev-impl@rig", location });
    expect(removed.removed).toEqual(["kickoff"]);
    expect(existsSync(join(location.targetRoot, "kickoff"))).toBe(false);
  });
});
