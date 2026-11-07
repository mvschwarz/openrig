// A skill whose resource says `on_restore: follow_source` takes today's bytes and today's selection when a restore
// brings its seat back with its conversation; a seat's edit is still never overwritten.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanSeatSkills, ensureSeatSkillPlugin, followSeatSkills, recordSeatSkillFollowing, recordSeatSkillWrite, rehydrateSeatSkills, seatSkillPaths,
} from "../src/domain/seat-skill-storage.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

describe("a restore brings a following skill's copy up to its source, and keeps a seat's edit", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function seat() {
    const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime: "claude-code" }, home);
    ensureSeatSkillPlugin(paths);
    const sourceOf = (id: string) => join(home, "skills", id);
    const put = (file: string, text: string) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
    /** A skill as a launch leaves it: source and seat copy alike, every file recorded, following its source or not. */
    const launched = (id: string, files: Record<string, string>, follow = true) => {
      for (const [rel, text] of Object.entries(files)) {
        put(join(sourceOf(id), rel), text);
        put(join(paths.skillsRoot, id, rel), text);
        recordSeatSkillWrite(paths.skillsRoot, join(paths.skillsRoot, id, rel), join(sourceOf(id), rel), text);
      }
      if (follow) recordSeatSkillFollowing(paths.skillsRoot, id, sourceOf(id));
    };
    const copy = (id: string, rel: string) => readFileSync(join(paths.skillsRoot, id, rel), "utf8");
    return { paths, sourceOf, put, launched, copy };
  }

  it("refreshes an unchanged copy from its changed source, and records the new bytes", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1", "scripts/check.sh": "check v1" });
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    put(join(sourceOf("infra-review"), "references/aws.md"), "new reference");
    rmSync(join(sourceOf("infra-review"), "scripts"), { recursive: true });

    const out = followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] });

    expect(out).toEqual({ refreshed: ["infra-review"], added: [], removed: [], warnings: [] });
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(copy("infra-review", "references/aws.md")).toBe("new reference");
    expect(existsSync(join(paths.skillsRoot, "infra-review", "scripts"))).toBe(false);
    // The record now holds today's bytes, so the next rig down removes the copy and the next restore puts it back.
    expect(cleanSeatSkills(paths).kept).toEqual([]);
    expect(rehydrateSeatSkills(paths).restored.sort()).toEqual([
      join(paths.skillsRoot, "infra-review", "SKILL.md"), join(paths.skillsRoot, "infra-review", "references/aws.md")]);
  });
  it("refreshes a copy rig down removed for being unchanged, so the restore doesn't name it missing", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    cleanSeatSkills(paths);
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");

    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] }).refreshed)
      .toEqual(["infra-review"]);
    expect(copy("infra-review", "SKILL.md")).toBe("v2");
    expect(rehydrateSeatSkills(paths)).toEqual({ restored: [], kept: [], missing: [], refused: [] });
  });

  it("leaves an unchanged skill whose source hasn't moved to the usual rehydration, and reports nothing", () => {
    const { paths, sourceOf, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    cleanSeatSkills(paths);

    expect(followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] }))
      .toEqual({ refreshed: [], added: [], removed: [], warnings: [] });
    expect(rehydrateSeatSkills(paths).restored).toEqual([join(paths.skillsRoot, "infra-review", "SKILL.md")]);
    expect(copy("infra-review", "SKILL.md")).toBe("v1");
  });

  it("keeps a copy the seat edited, or added a file to, and names it", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    launched("aws", { "SKILL.md": "aws v1" });
    put(join(paths.skillsRoot, "infra-review", "SKILL.md"), "the seat's edit");
    put(join(paths.skillsRoot, "aws", "notes.md"), "the seat's notes");
    put(join(sourceOf("infra-review"), "SKILL.md"), "v2");
    put(join(sourceOf("aws"), "SKILL.md"), "aws v2");

    const out = followSeatSkills(paths, { selected: new Set(["infra-review", "aws"]),
      following: [{ id: "infra-review", source: sourceOf("infra-review") }, { id: "aws", source: sourceOf("aws") }] });

    expect(out.refreshed).toEqual([]);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "infra-review")}: ${join(paths.skillsRoot, "infra-review", "SKILL.md")} was edited; it follows its source (on_restore: follow_source), but an edit is never overwritten`,
      `Restore: kept ${join(paths.skillsRoot, "aws")}: ${join(paths.skillsRoot, "aws", "notes.md")} is not a file OpenRig wrote; it follows its source (on_restore: follow_source), but an edit is never overwritten`,
    ]);
    expect(copy("infra-review", "SKILL.md")).toBe("the seat's edit");
    expect(copy("aws", "SKILL.md")).toBe("aws v1");
  });

  it("copies in a following skill the profile newly selects, unless something not OpenRig's is already there", () => {
    const { paths, sourceOf, put, copy } = seat();
    put(join(sourceOf("aws"), "SKILL.md"), "aws");
    put(join(sourceOf("mine"), "SKILL.md"), "from the source");
    put(join(paths.skillsRoot, "mine", "SKILL.md"), "the person's own");

    const out = followSeatSkills(paths, { selected: new Set(["aws", "mine"]),
      following: [{ id: "aws", source: sourceOf("aws") }, { id: "mine", source: sourceOf("mine") }] });

    expect(out.added).toEqual(["aws"]);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "mine")}: ${join(paths.skillsRoot, "mine", "SKILL.md")} is not a file OpenRig wrote; it follows its source (on_restore: follow_source), but an edit is never overwritten`]);
    expect(copy("aws", "SKILL.md")).toBe("aws");
    expect(copy("mine", "SKILL.md")).toBe("the person's own");
    // Recorded as OpenRig's, so rig down removes it like any other.
    expect(cleanSeatSkills(paths).removed).toContain(join(paths.skillsRoot, "aws", "SKILL.md"));
  });

  it("removes a following skill the profile no longer selects while unchanged; an edited one is kept", () => {
    const { paths, put, launched } = seat();
    launched("aws-cdk", { "SKILL.md": "cdk", "scripts/synth.sh": "synth" });
    launched("github-oidc-aws", { "SKILL.md": "oidc" });
    put(join(paths.skillsRoot, "github-oidc-aws", "SKILL.md"), "the seat's edit");

    const out = followSeatSkills(paths, { selected: new Set(), following: [] });

    expect(out.removed).toEqual(["aws-cdk"]);
    expect(existsSync(join(paths.skillsRoot, "aws-cdk"))).toBe(false);
    expect(out.warnings).toEqual([
      `Restore: kept ${join(paths.skillsRoot, "github-oidc-aws")}: ${join(paths.skillsRoot, "github-oidc-aws", "SKILL.md")} was edited, and it is no longer selected; it follows its source (on_restore: follow_source), but an edit is never overwritten`]);
    // Nothing of the removed skill is left for a later restore to put back.
    cleanSeatSkills(paths);
    expect(rehydrateSeatSkills(paths).restored).toEqual([]);
  });

  it("leaves skills that keep their saved copy alone, selected or not, and stops following one switched to keep_saved", () => {
    const { paths, sourceOf, put, launched, copy } = seat();
    launched("tdd", { "SKILL.md": "tdd v1" }, false);
    launched("old-pinned", { "SKILL.md": "old" }, false);
    launched("repo-docs", { "SKILL.md": "docs v1" });
    put(join(sourceOf("tdd"), "SKILL.md"), "tdd v2");
    put(join(sourceOf("repo-docs"), "SKILL.md"), "docs v2");

    expect(followSeatSkills(paths, { selected: new Set(["tdd", "repo-docs"]), following: [] }))
      .toEqual({ refreshed: [], added: [], removed: [], warnings: [] });
    expect(copy("tdd", "SKILL.md")).toBe("tdd v1");
    expect(copy("old-pinned", "SKILL.md")).toBe("old");
    expect(copy("repo-docs", "SKILL.md")).toBe("docs v1");
    // repo-docs no longer follows: deselecting it later keeps it, like any saved copy.
    expect(followSeatSkills(paths, { selected: new Set(), following: [] }).removed).toEqual([]);
    expect(copy("repo-docs", "SKILL.md")).toBe("docs v1");
  });

  it("keeps the saved copy when the source can't be read as a skill, and names it", () => {
    const { paths, sourceOf, launched, copy } = seat();
    launched("infra-review", { "SKILL.md": "v1" });
    rmSync(sourceOf("infra-review"), { recursive: true });

    const out = followSeatSkills(paths, { selected: new Set(["infra-review"]), following: [{ id: "infra-review", source: sourceOf("infra-review") }] });

    expect(out.warnings).toEqual([`Restore: infra-review follows its source, but ${sourceOf("infra-review")} can't be read as a skill; its saved copy is kept`]);
    expect(copy("infra-review", "SKILL.md")).toBe("v1");
  });
});

describe("a launch records which of a seat's skills follow their source", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-launch-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  const realFs = {
    readFile: (p: string) => readFileSync(p, "utf8"), writeFile: (p: string, c: string) => writeFileSync(p, c),
    exists: (p: string) => existsSync(p), mkdirp: (p: string) => { mkdirSync(p, { recursive: true }); },
    copyFile: (a: string, b: string) => writeFileSync(b, readFileSync(a)),
    listFiles: (p: string) => {
      const out: string[] = [];
      const walk = (dir: string, rel: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(dir, e.name), join(rel, e.name)); else out.push(join(rel, e.name));
        }
      };
      walk(p, "");
      return out;
    },
  };

  for (const runtime of ["claude-code", "codex"] as const) {
    it(`${runtime}: marks a follow_source skill as following, and unmarks it when it is launched as keep_saved`, async () => {
      const paths = seatSkillPaths({ rigId: "rig-1", logicalId: "dev.impl", runtime }, home);
      if (runtime === "claude-code") ensureSeatSkillPlugin(paths);
      const project = join(home, "project");
      mkdirSync(project, { recursive: true });
      const source = (id: string) => {
        const dir = join(home, "skills", id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\nbody\n`);
        return dir;
      };
      const adapter = runtime === "codex"
        ? new CodexRuntimeAdapter({ tmux: {} as never, fsOps: realFs as never })
        : new ClaudeCodeAdapter({ tmux: {} as never, fsOps: realFs });
      const binding = { id: "b", nodeId: "n", tmuxSession: null, tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null,
        updatedAt: "", cwd: project, seatSkillsRoot: paths.skillsRoot } as NodeBinding;
      const launch = (entries: Array<{ id: string; onRestore?: "follow_source" }>) => adapter.project({ runtime, cwd: project,
        entries: entries.map(({ id, onRestore }) => ({ effectiveId: id, category: "skill", absolutePath: source(id), classification: "safe_projection", ...(onRestore ? { onRestore } : {}) })),
        startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] } as never, binding);
      const following = () => (JSON.parse(readFileSync(paths.projectionsPath, "utf8")) as { following?: Record<string, { source: string }> }).following;

      expect((await launch([{ id: "infra-review", onRestore: "follow_source" }, { id: "tdd" }])).failed).toEqual([]);
      expect(following()).toEqual({ "infra-review": { source: join(home, "skills", "infra-review") } });

      await launch([{ id: "infra-review" }, { id: "tdd" }]);
      expect(following()).toBeUndefined();
    });
  }
});

describe("a restore reads a seat's skill selection from its spec as it is now, through its launch recipe", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "seat-skills-follow-select-")); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  function seatWithRecipe(agentYaml: string | undefined, opts: { recipe?: boolean } = {}) {
    const db = createFullTestDb();
    const rigRoot = mkdtempSync(join(home, "rig-"));
    if (agentYaml !== undefined) { mkdirSync(join(rigRoot, "agents", "impl"), { recursive: true }); writeFileSync(join(rigRoot, "agents", "impl", "agent.yaml"), agentYaml); }
    const setup = createTestApp(db, { podInstantiatorFsOps: { exists: (p) => existsSync(p), readFile: (p) => readFileSync(p, "utf8") } });
    const rig = setup.rigRepo.createRig("follow-rig");
    db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)").run("pod-follow", rig.id, "dev", "Development");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-follow", cwd: rigRoot,
      ...(opts.recipe === false ? {} : { launchRecipe: { version: 1 as const, rigRoot, rigSpec: { version: "0.2", name: "follow-rig",
        pods: [{ id: "dev", label: "Development", members: [{ id: "impl", agentRef: "local:agents/impl", profile: "default", runtime: "claude-code", cwd: "." }], edges: [] }],
        edges: [] } } }) });
    return { db, setup, rigId: rig.id, nodeId: node.id, rigRoot };
  }

  it("lists every skill the profile selects today, and which follow their source, with the source's full path", async () => {
    const { db, setup, rigId, nodeId, rigRoot } = seatWithRecipe(`name: impl
version: "1.0"
resources:
  skills:
    - id: infra-review
      path: skills/infra-review
      on_restore: follow_source
    - id: tdd
      path: skills/tdd
    - id: unused
      path: skills/unused
      on_restore: follow_source
profiles:
  default:
    uses:
      skills: [infra-review, tdd]
`);
    for (const id of ["infra-review", "tdd", "unused"]) {
      mkdirSync(join(rigRoot, "agents", "impl", "skills", id), { recursive: true });
      writeFileSync(join(rigRoot, "agents", "impl", "skills", id, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\n`);
    }
    try {
      const out = await setup.podInstantiator.seatSkillSelection(rigId, nodeId);
      expect(out.ok).toBe(true);
      if (!out.ok) return;
      expect([...out.selection.selected].sort()).toEqual(["infra-review", "tdd"]);
      expect(out.selection.following).toEqual([{ id: "infra-review", source: join(rigRoot, "agents", "impl", "skills", "infra-review") }]);
    } finally { db.close(); }
  });

  it("finds a following skill declared in an imported spec and selected by its qualified name", async () => {
    const { db, setup, rigId, nodeId, rigRoot } = seatWithRecipe(`name: impl
version: "1.0"
imports:
  - ref: local:../../shared
profiles:
  default:
    uses:
      skills: [team-skills:infra-review, team-skills:tdd]
`);
    const shared = join(rigRoot, "shared");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "agent.yaml"), `name: team-skills
version: "1.0"
resources:
  skills:
    - id: infra-review
      path: vendor/infra-review
      on_restore: follow_source
    - id: tdd
      path: vendor/tdd
`);
    for (const id of ["infra-review", "tdd"]) {
      mkdirSync(join(shared, "vendor", id), { recursive: true });
      writeFileSync(join(shared, "vendor", id, "SKILL.md"), `---\nname: ${id}\ndescription: d\n---\n`);
    }
    try {
      const out = await setup.podInstantiator.seatSkillSelection(rigId, nodeId);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      if (!out.ok) return;
      // An imported skill keeps its qualified name, which is also its folder in the seat's storage.
      expect([...out.selection.selected].sort()).toEqual(["team-skills:infra-review", "team-skills:tdd"]);
      expect(out.selection.following).toEqual([{ id: "team-skills:infra-review", source: join(shared, "vendor", "infra-review") }]);
    } finally { db.close(); }
  });

  it("says why when it can't: no launch recipe, or an agent spec that is gone or invalid", async () => {
    const cases = [
      seatWithRecipe(undefined, { recipe: false }),
      seatWithRecipe(undefined),
      seatWithRecipe(`name: impl\nversion: "1.0"\nresources:\n  skills:\n    - id: x\n      path: skills/x\n      on_restore: sometimes\nprofiles:\n  default: {}\n`),
    ];
    try {
      const reasons = [];
      for (const c of cases) {
        const out = await c.setup.podInstantiator.seatSkillSelection(c.rigId, c.nodeId);
        expect(out.ok).toBe(false);
        if (!out.ok) reasons.push(out.reason);
      }
      expect(reasons[0]).toContain("no launch recipe");
      expect(reasons[1]).toContain("agent.yaml");
      expect(reasons[2]).toContain("on_restore");
    } finally { for (const c of cases) c.db.close(); }
  });
});
