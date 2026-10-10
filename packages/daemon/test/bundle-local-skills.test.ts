// Real create/unpack/materialization and runtime projection; no native provider.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createTestApp } from "./helpers/test-app.js";
import { PodBundleSourceResolver, materializePodBundle } from "../src/domain/bundle-source-resolver.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { discoverSkillsForRuntime, discoverSkillsWithProvenance } from "../src/domain/skill-discovery.js";
import { inspectSkillDirectory, reconcileSkillLoadout, resolveSkillLoadout } from "../src/domain/skill-catalog.js";
import { planProjection } from "../src/domain/projection-planner.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import { piSeatPaths } from "../src/adapters/pi-runner-protocol.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";

const skill = (id: string) => `---\nname: ${id}\ndescription: A portable test skill\n---\n\nRead references/example.md and run scripts/helper.sh.\n`;
const rigYaml = `version: "0.2"
name: portable
pods:
  - id: dev
    label: Dev
    members:
      - id: worker
        agent_ref: local:agents/worker
        profile: default
        runtime: pi
        cwd: .
    edges: []
edges: []
`;

function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? walk(path.join(root, e.name)).map(p => path.join(e.name, p)) : [e.name]);
}
const fsOps = {
  readFile: (p: string) => fs.readFileSync(p, "utf8"),
  writeFile: (p: string, text: string) => fs.writeFileSync(p, text),
  exists: fs.existsSync,
  mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); },
  copyFile: fs.copyFileSync,
  listFiles: walk,
  statMode: (p: string) => fs.statSync(p).mode,
  chmod: fs.chmodSync,
};

describe("bundle-local skills", () => {
  let root: string;
  let db: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createTestApp>["app"];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-local-skills-"));
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    app = createTestApp(db).app;
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function write(relative: string, text: string) {
    const dest = path.join(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
    return dest;
  }
  function commitCatalog(catalog: string) {
    execFileSync("git", ["init", "-q", catalog]);
    execFileSync("git", ["-C", catalog, "add", "."]);
    execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
  }
  async function create() {
    const outputPath = path.join(root, "portable.rigbundle");
    const response = await app.request("/api/bundles/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specPath: path.join(root, "source/rig.yaml"), bundleName: "portable", bundleVersion: "1.0", outputPath }),
    });
    return { response, outputPath };
  }
  function seed() {
    write("source/rig.yaml", rigYaml);
    write("source/agents/worker/agent.yaml", `name: worker\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: [portable]\n`);
    write("source/bundle.yaml", "skills:\n  - skills/portable/SKILL.md\n  - skills/unselected/SKILL.md\n  - packages/legacy.txt\n");
    write("source/skills/portable/SKILL.md", skill("portable"));
    write("source/skills/portable/references/example.md", "Portable reference\n");
    fs.chmodSync(write("source/skills/portable/scripts/helper.sh", "#!/bin/sh\nprintf 'portable\\n'\n"), 0o755);
    write("source/skills/unselected/SKILL.md", skill("unselected"));
    write("source/skills/undeclared/SKILL.md", skill("undeclared"));
    write("source/packages/legacy.txt", "Legacy single-file payload\n");
  }

  it("carries the full declared skill directory and legacy file, without an undeclared sibling", async () => {
    seed();
    const { response, outputPath } = await create();
    expect(response.status, await response.text()).toBe(201);
    const resolver = new PodBundleSourceResolver();
    const extracted = await resolver.resolve(outputPath); // verifies archive integrity
    try {
      for (const rel of ["SKILL.md", "references/example.md", "scripts/helper.sh"]) {
        expect(fs.readFileSync(path.join(extracted.tempDir, "skills/portable", rel)))
          .toEqual(fs.readFileSync(path.join(root, "source/skills/portable", rel)));
      }
      expect(fs.statSync(path.join(extracted.tempDir, "skills/portable/scripts/helper.sh")).mode & 0o777).toBe(0o755);
      expect(fs.existsSync(path.join(extracted.tempDir, "skills/undeclared"))).toBe(false);
      expect(fs.readFileSync(path.join(extracted.tempDir, "packages/legacy.txt"), "utf8")).toBe("Legacy single-file payload\n");
    } finally { resolver.cleanup(extracted.tempDir); }
  });

  it("projects a selected installed skill into all three runtime targets with a separate shared cwd", async () => {
    seed();
    const { response, outputPath } = await create();
    expect(response.status, await response.text()).toBe(201);
    const resolver = new PodBundleSourceResolver();
    const extracted = await resolver.resolve(outputPath);
    const installed = path.join(root, "installed");
    expect(materializePodBundle(extracted.tempDir, installed)).toEqual({ ok: true });
    expect(materializePodBundle(extracted.tempDir, installed)).toEqual({ ok: true });
    resolver.cleanup(extracted.tempDir);
    fs.rmSync(path.join(root, "source"), { recursive: true });
    const cwd = path.join(root, "work");
    write("work/owned.txt", "User project stays intact\n");
    const catalog = path.join(root, "catalog");
    write("catalog/catalog.yaml", "schema: openrig.skill-catalog/v1\nsystem: []\n");
    execFileSync("git", ["init", "-q", catalog]);
    execFileSync("git", ["-C", catalog, "add", "."]);
    execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
    const catalogBefore = fs.readFileSync(path.join(catalog, "catalog.yaml"));
    const rig = RigSpecSchema.normalize(RigSpecCodec.parse(fs.readFileSync(path.join(installed, "rig.yaml"), "utf8")) as Record<string, unknown>);
    const resolved = resolveAgentRef("local:agents/worker", installed, fsOps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const tmux = {} as TmuxAdapter; // project() must not launch or contact a provider
    const pi = new PiRuntimeAdapter({ tmux, fsOps, stateRoot: path.join(root, "pi"), runnerEntryPath: "unused" });
    const adapters: RuntimeAdapter[] = [new ClaudeCodeAdapter({ tmux, fsOps }), new CodexRuntimeAdapter({ tmux, fsOps }), pi];
    for (const adapter of adapters) {
      const member = { ...rig.pods[0]!.members[0]!, runtime: adapter.runtime, cwd };
      const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
        profileName: "default", member, pod: rig.pods[0]!, rig, specRoot: installed, homedir: path.join(root, "home"), skillsRoot: catalog });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errors.join("; "));
      expect(result.config.selectedResources.skills.map(s => s.effectiveId)).toEqual(["portable"]);
      const session = `${adapter.runtime}@portable`;
      const target = adapter.runtime === "pi" ? path.dirname(pi.skillTargetPath(session, "portable")!)
        : path.join(cwd, adapter.runtime === "codex" ? ".agents" : ".claude", "skills/portable");
      const makePlan = () => planProjection({ config: result.config, collisions: resolved.collisions, fsOps,
        resolveTargetPath: () => path.join(target, "SKILL.md") });
      const binding = { tmuxSession: session, cwd } as NodeBinding;
      for (let repeat = 0; repeat < 2; repeat++) {
        const planned = makePlan();
        expect(planned.ok).toBe(true);
        if (!planned.ok) throw new Error(planned.errors.join("; "));
        if (repeat === 0) expect(planned.plan.entries[0]!.classification).toBe("safe_projection");
        expect((await adapter.project(planned.plan, binding)).failed).toEqual([]);
        for (const rel of ["SKILL.md", "references/example.md", "scripts/helper.sh"]) {
          expect(fs.readFileSync(path.join(target, rel))).toEqual(fs.readFileSync(path.join(installed, "skills/portable", rel)));
        }
        expect(fs.statSync(path.join(target, "scripts/helper.sh")).mode & 0o777).toBe(0o755);
        expect(fs.existsSync(path.join(target, "../unselected"))).toBe(false);
      }
    }
    expect(fs.readFileSync(path.join(cwd, "owned.txt"), "utf8")).toBe("User project stays intact\n");
    expect(fs.readFileSync(path.join(catalog, "catalog.yaml"))).toEqual(catalogBefore);
    expect(execFileSync("git", ["-C", catalog, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
  });

  it.each(["different-bytes", "different-mode", "same-bytes", "no-catalog"] as const)(
    "keeps selected bundle bytes through managed reconciliation and all adapters: %s", async (kind) => {
      seed();
      write("source/agents/worker/agent.yaml", `name: worker\nversion: "1.0"\nresources:\n  skills:\n    - id: portable\n      path: skills/portable\nprofiles:\n  default:\n    uses:\n      skills: [portable]\n`);
      fs.cpSync(path.join(root, "source/skills/portable"), path.join(root, "source/agents/worker/skills/portable"), { recursive: true });
      const { response, outputPath } = await create();
      expect(response.status, await response.text()).toBe(201);
      const resolver = new PodBundleSourceResolver();
      const extracted = await resolver.resolve(outputPath);
      const installed = path.join(root, "installed");
      expect(materializePodBundle(extracted.tempDir, installed)).toEqual({ ok: true });
      resolver.cleanup(extracted.tempDir);
      fs.rmSync(path.join(root, "source"), { recursive: true });
      const catalog = path.join(root, "catalog");
      if (kind !== "no-catalog") {
        fs.cpSync(path.join(installed, "agents/worker/skills/portable"), path.join(catalog, "portable"), { recursive: true });
        if (kind === "different-bytes") write("catalog/portable/references/example.md", "Catalog reference\n");
        if (kind === "different-mode") fs.chmodSync(path.join(catalog, "portable/scripts/helper.sh"), 0o644);
        write("catalog/catalog.yaml", "schema: openrig.skill-catalog/v1\nsystem: [system-only]\n");
        write("catalog/system-only/SKILL.md", skill("system-only"));
        write("catalog/project-only/SKILL.md", skill("project-only"));
        execFileSync("git", ["init", "-q", catalog]);
        execFileSync("git", ["-C", catalog, "add", "."]);
        execFileSync("git", ["-C", catalog, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "catalog"]);
      }
      const catalogBefore = kind === "no-catalog" ? null : inspectSkillDirectory(path.join(catalog, "portable"));
      const rig = RigSpecSchema.normalize(RigSpecCodec.parse(fs.readFileSync(path.join(installed, "rig.yaml"), "utf8")) as Record<string, unknown>);
      const resolved = resolveAgentRef("local:agents/worker", installed, fsOps);
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
      const tmux = {} as TmuxAdapter;
      const pi = new PiRuntimeAdapter({ tmux, fsOps, stateRoot: path.join(root, "pi"), runnerEntryPath: "unused" });
      for (const adapter of [new ClaudeCodeAdapter({ tmux, fsOps }), new CodexRuntimeAdapter({ tmux, fsOps }), pi]) {
        const cwd = path.join(root, `work-${adapter.runtime}`);
        fs.mkdirSync(cwd);
        if (kind !== "no-catalog") fs.writeFileSync(path.join(cwd, "project.yaml"), "install:\n  skills: [project-only]\n");
        const session = `${adapter.runtime}@portable`;
        const targetPath = (id: string) => adapter.runtime === "pi" ? pi.skillTargetPath(session, id)!
          : path.join(cwd, adapter.runtime === "codex" ? ".agents" : ".claude", "skills", id, "SKILL.md");
        // Exercise an already-owned catalog projection, not just an empty workspace.
        if (kind !== "no-catalog" && adapter.runtime !== "pi") {
          const old = resolveSkillLoadout({ catalogRoot: catalog, topologySkills: ["portable"], projectRoot: cwd });
          if (!old.ok) throw new Error(JSON.stringify(old));
          expect(reconcileSkillLoadout({ loadout: old.loadout, cwd, runtime: adapter.runtime, topologyOwner: session, apply: true }).ok).toBe(true);
        }
        for (let repeat = 0; repeat < 2; repeat++) {
          const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
            profileName: "default", member: { ...rig.pods[0]!.members[0]!, runtime: adapter.runtime, cwd }, pod: rig.pods[0]!, rig,
            specRoot: installed, homedir: path.join(root, "home"), skillsRoot: catalog });
          expect(result.ok, JSON.stringify(result)).toBe(true);
          if (!result.ok) throw new Error(result.errors.join(";"));
          expect(result.config.skillWarnings?.length ?? 0).toBe(kind.startsWith("different") ? 1 : 0);
          if (adapter.runtime !== "pi") {
            const receipt = reconcileSkillLoadout({ loadout: result.config.skillLoadout!, cwd, runtime: adapter.runtime, topologyOwner: session, apply: true });
            expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
            if (kind !== "no-catalog") expect(receipt.receipts.find(r => r.id === "portable")?.sourceRoot).toBe(installed);
          }
          const plan = planProjection({ config: result.config, collisions: resolved.collisions, fsOps,
            resolveTargetPath: (_cat, id) => targetPath(id) });
          if (!plan.ok) throw new Error(plan.errors.join(";"));
          expect((await adapter.project(plan.plan, { tmuxSession: session, cwd } as NodeBinding)).failed).toEqual([]);
          expect(inspectSkillDirectory(path.dirname(targetPath("portable"))))
            .toEqual(inspectSkillDirectory(path.join(installed, "agents/worker/skills/portable")));
          if (kind !== "no-catalog") for (const id of ["system-only", "project-only"]) {
            expect(fs.readFileSync(targetPath(id), "utf8")).toBe(skill(id));
          }
          if (repeat === 1 && kind !== "no-catalog" && adapter.runtime !== "pi") {
            fs.writeFileSync(targetPath("portable"), "Operator edit\n");
            const protectedResult = reconcileSkillLoadout({ loadout: result.config.skillLoadout!, cwd, runtime: adapter.runtime, topologyOwner: session, apply: true });
            expect(protectedResult.ok).toBe(false);
            expect(protectedResult.errors[0]?.code).toBe("target_conflict");
            expect(fs.readFileSync(targetPath("portable"), "utf8")).toBe("Operator edit\n");
          }
        }
      }
      if (catalogBefore) {
        expect(inspectSkillDirectory(path.join(catalog, "portable"))).toEqual(catalogBefore);
        expect(execFileSync("git", ["-C", catalog, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
      } else expect(fs.existsSync(catalog)).toBe(false);
    },
  );

  it.each(["changed", "missing", "added", "mode-only"] as const)(
    "reapplies a Pi skill with an unchanged SKILL.md and a %s helper",
    async (change) => {
      seed();
      const specRoot = path.join(root, "source");
      const resolved = resolveAgentRef("local:agents/worker", specRoot, fsOps);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
      const rig = RigSpecSchema.normalize(RigSpecCodec.parse(rigYaml) as Record<string, unknown>);
      const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
        profileName: "default", member: rig.pods[0]!.members[0]!, pod: rig.pods[0]!, rig, specRoot, homedir: path.join(root, "home") });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errors.join("; "));
      const pi = new PiRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateRoot: path.join(root, "pi"), runnerEntryPath: "unused" });
      const binding = { tmuxSession: "worker@portable", cwd: path.join(root, "work") } as NodeBinding;
      const target = path.dirname(pi.skillTargetPath(binding.tmuxSession, "portable")!);
      const project = async (classification: string) => {
        const planned = planProjection({ config: result.config, collisions: resolved.collisions, fsOps,
          resolveTargetPath: (_category, id) => pi.skillTargetPath(binding.tmuxSession, id) });
        expect(planned.ok).toBe(true);
        if (!planned.ok) throw new Error(planned.errors.join("; "));
        expect(planned.plan.entries.map(e => e.classification)).toEqual([classification]);
        expect((await pi.project(planned.plan, binding)).failed).toEqual([]);
      };
      await project("safe_projection");
      const sourceHelper = path.join(specRoot, "skills/portable/scripts/helper.sh");
      const targetHelper = path.join(target, "scripts/helper.sh");
      if (change === "changed") fs.writeFileSync(sourceHelper, "#!/bin/sh\nprintf 'updated\\n'\n");
      if (change === "missing") fs.unlinkSync(targetHelper);
      if (change === "added") write("source/skills/portable/references/added.md", "New helper reference\n");
      if (change === "mode-only") fs.chmodSync(sourceHelper, 0o700);

      await project("no_op"); // unchanged Markdown must not hide helper changes
      for (const rel of walk(path.join(specRoot, "skills/portable"))) {
        const source = path.join(specRoot, "skills/portable", rel);
        const delivered = path.join(target, rel);
        expect(fs.readFileSync(delivered)).toEqual(fs.readFileSync(source));
        expect(fs.statSync(delivered).mode & 0o777).toBe(fs.statSync(source).mode & 0o777);
      }
    },
  );

  it("delivers no working-tree bytes of a catalog skill with uncommitted content on any runtime", async () => {
    const specRoot = path.join(root, "source");
    write("source/agents/worker/agent.yaml", `name: worker\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: [edited]\n`);
    write("source/agents/plain/agent.yaml", `name: plain\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: []\n`);
    const catalog = path.join(root, "catalog");
    write("catalog/catalog.yaml", "schema: openrig.skill-catalog/v1\nsystem: []\n");
    write("catalog/edited/SKILL.md", skill("edited"));
    write("catalog/clean/SKILL.md", skill("clean"));
    commitCatalog(catalog);
    write("catalog/edited/SKILL.md", `${skill("edited")}\nUncommitted draft.\n`);
    const rig = RigSpecSchema.normalize(RigSpecCodec.parse(rigYaml) as Record<string, unknown>);
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const tmux = {} as TmuxAdapter;
    const pi = new PiRuntimeAdapter({ tmux, fsOps, stateRoot: path.join(root, "pi"), runnerEntryPath: "unused" });
    for (const adapter of [new ClaudeCodeAdapter({ tmux, fsOps }), new CodexRuntimeAdapter({ tmux, fsOps }), pi] as RuntimeAdapter[]) {
      // Claude and Codex discovery scans the catalog, so the profile selects the dirty skill by name. Pi discovers
      // only its bundle, so there the System World selects it.
      const viaProfile = adapter.runtime !== "pi";
      const resolved = resolveAgentRef(viaProfile ? "local:agents/worker" : "local:agents/plain", specRoot, fsOps);
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
      const member = { ...rig.pods[0]!.members[0]!, runtime: adapter.runtime, cwd };
      const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
        profileName: "default", member, pod: rig.pods[0]!, rig, specRoot, homedir: path.join(root, "home"), skillsRoot: catalog,
        systemSkills: viaProfile ? ["clean"] : ["clean", "edited"] });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error(result.errors.join("; "));
      expect(result.config.selectedResources.skills.map(s => s.effectiveId)).toEqual(["clean"]);
      expect(result.config.skillWarnings).toEqual([expect.stringMatching(/^selected_skill_skipped: 'edited' \(selected by (topology|system)\) /)]);
      const session = `${adapter.runtime}@portable`;
      const targetOf = (id: string) => adapter.runtime === "pi" ? pi.skillTargetPath(session, id)!
        : path.join(cwd, adapter.runtime === "codex" ? ".agents" : ".claude", "skills", id, "SKILL.md");
      const planned = planProjection({ config: result.config, collisions: resolved.collisions, fsOps, resolveTargetPath: (_category, id) => targetOf(id) });
      expect(planned.ok).toBe(true);
      if (!planned.ok) throw new Error(planned.errors.join("; "));
      expect((await adapter.project(planned.plan, { tmuxSession: session, cwd } as NodeBinding)).failed).toEqual([]);
      expect(fs.readFileSync(targetOf("clean"), "utf8")).toBe(skill("clean"));
      expect(fs.existsSync(targetOf("edited"))).toBe(false);
    }
  });

  it.each(["folder", "SKILL.md", "frontmatter name"] as const)(
    "resolves a fresh seat whose profile selects a dirty catalog skill after its %s is deleted or renamed",
    (change) => {
      const specRoot = path.join(root, "source");
      write("source/agents/worker/agent.yaml", `name: worker\nversion: "1.0"\nprofiles:\n  default:\n    uses:\n      skills: [edited]\n`);
      const catalog = path.join(root, "catalog");
      write("catalog/catalog.yaml", "schema: openrig.skill-catalog/v1\nsystem: []\n");
      write("catalog/folder alias/SKILL.md", skill("edited"));
      write("catalog/clean/SKILL.md", skill("clean"));
      commitCatalog(catalog);
      // Discovery can't see the committed name `edited` after any of these, so only the catalog recognizes it.
      const dir = path.join(catalog, "folder alias");
      if (change === "folder") fs.rmSync(dir, { recursive: true });
      else if (change === "SKILL.md") fs.rmSync(path.join(dir, "SKILL.md"));
      else write("catalog/folder alias/SKILL.md", skill("renamed"));
      const cwd = path.join(root, "work");
      fs.mkdirSync(cwd, { recursive: true });
      const resolved = resolveAgentRef("local:agents/worker", specRoot, fsOps);
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
      const rig = RigSpecSchema.normalize(RigSpecCodec.parse(rigYaml) as Record<string, unknown>);
      const member = { ...rig.pods[0]!.members[0]!, runtime: "codex", cwd };
      const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
        profileName: "default", member, pod: rig.pods[0]!, rig, specRoot, homedir: path.join(root, "home"), skillsRoot: catalog,
        systemSkills: ["clean"] });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) return;
      expect(result.config.selectedResources.skills.map(s => s.effectiveId)).toEqual(["clean"]);
      expect(result.config.skillWarnings).toEqual([expect.stringMatching(/^selected_skill_skipped: 'edited' \(selected by topology\) /)]);
    },
  );

  it("delivers nothing from inside a dirty catalog skill, and still delivers a sibling that only shares its name prefix", async () => {
    const specRoot = path.join(root, "source");
    // The catalog sits in the agent's folder, so the agent can declare a source inside one of its skills.
    write("source/agents/nested/agent.yaml", `name: nested\nversion: "1.0"\nresources:\n  skills:\n    - id: inner\n      path: skills/edited/inner\nprofiles:\n  default:\n    uses:\n      skills: [inner, edited-clean]\n`);
    const catalog = path.join(specRoot, "agents", "nested", "skills");
    write("source/agents/nested/skills/catalog.yaml", "schema: openrig.skill-catalog/v1\nsystem: []\n");
    write("source/agents/nested/skills/edited/SKILL.md", skill("edited"));
    write("source/agents/nested/skills/edited/inner/SKILL.md", skill("inner"));
    write("source/agents/nested/skills/edited-clean/SKILL.md", skill("edited-clean"));
    commitCatalog(catalog);
    write("source/agents/nested/skills/edited/inner/SKILL.md", `${skill("inner")}\nUncommitted draft.\n`);
    const cwd = path.join(root, "work");
    fs.mkdirSync(cwd, { recursive: true });
    const resolved = resolveAgentRef("local:agents/nested", specRoot, fsOps);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const rig = RigSpecSchema.normalize(RigSpecCodec.parse(rigYaml) as Record<string, unknown>);
    const member = { ...rig.pods[0]!.members[0]!, runtime: "codex", cwd };
    const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
      profileName: "default", member, pod: rig.pods[0]!, rig, specRoot, homedir: path.join(root, "home"), skillsRoot: catalog,
      systemSkills: [] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.errors.join("; "));
    expect(result.config.selectedResources.skills.map(s => s.effectiveId)).toEqual(["edited-clean"]);
    expect(result.config.skillWarnings).toEqual([
      expect.stringMatching(/^catalog_skill_skipped: 'edited' /),
      expect.stringMatching(/^selected_skill_skipped: 'inner' \(selected by topology\) is inside .*edited, which has uncommitted content/),
    ]);
    const targetOf = (id: string) => path.join(cwd, ".agents", "skills", id, "SKILL.md");
    const planned = planProjection({ config: result.config, collisions: resolved.collisions, fsOps, resolveTargetPath: (_category, id) => targetOf(id) });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.errors.join("; "));
    const adapter = new CodexRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps });
    expect((await adapter.project(planned.plan, { tmuxSession: "codex@portable", cwd } as NodeBinding)).failed).toEqual([]);
    expect(fs.existsSync(targetOf("inner"))).toBe(false);
    expect(fs.readFileSync(targetOf("edited-clean"), "utf8")).toBe(skill("edited-clean"));
  });

  it("discovers Pi bundle skills without importing Claude/Codex home or workspace pools", () => {
    for (const prefix of ["home/.agents", "home/.claude", "work/.agents", "work/.claude"]) {
      write(`${prefix}/skills/sibling/SKILL.md`, skill("sibling"));
    }
    write("installed/skills/portable/SKILL.md", skill("portable"));
    const paths = { runtime: "pi" as const, homedir: path.join(root, "home"), cwd: path.join(root, "work"), specInstallDir: path.join(root, "installed") };
    expect(discoverSkillsForRuntime(paths).skills.map(s => s.id)).toEqual(["portable"]);
    expect(discoverSkillsWithProvenance(paths).skills.map(s => [s.id, s.sourceKind])).toEqual([["portable", "spec_install"]]);
    expect(discoverSkillsForRuntime({ ...paths, specInstallDir: undefined }).skills).toEqual([]);
  });

  it("names the Pi seat target even when a Claude copy already exists", () => {
    const pi = new PiRuntimeAdapter({ tmux: {} as TmuxAdapter, fsOps, stateRoot: path.join(root, "pi"), runnerEntryPath: "unused" });
    write("work/.claude/skills/portable/SKILL.md", skill("portable"));
    expect(pi.skillTargetPath(null, "portable")).toBeNull();
    expect(pi.skillTargetPath("worker@portable", "portable"))
      .toBe(path.join(piSeatPaths(path.join(root, "pi"), "worker@portable").agentDir, "skills/portable/SKILL.md"));
  });

  it("still refuses a selected skill that discovery cannot resolve", () => {
    seed();
    write("source/skills/portable/SKILL.md", skill("different-id"));
    const specRoot = path.join(root, "source");
    const resolved = resolveAgentRef("local:agents/worker", specRoot, fsOps);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const rig = RigSpecSchema.normalize(RigSpecCodec.parse(rigYaml) as Record<string, unknown>);
    const result = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions,
      profileName: "default", member: rig.pods[0]!.members[0]!, pod: rig.pods[0]!, rig, specRoot, homedir: path.join(root, "home") });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("missing skill was accepted");
    expect(result.errors.join("; ")).toMatch(/portable.*not found/);
  });

  it("still rejects a missing declared entry and a helper symlink that escapes the source root", async () => {
    seed();
    fs.unlinkSync(path.join(root, "source/skills/portable/SKILL.md"));
    expect((await create()).response.status).toBe(500);
    write("source/skills/portable/SKILL.md", skill("portable"));
    write("outside.txt", "Must not enter the archive\n");
    fs.symlinkSync(path.join(root, "outside.txt"), path.join(root, "source/skills/portable/references/outside.txt"));
    const { response } = await create();
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("escaping bundle source root");
  });
});
