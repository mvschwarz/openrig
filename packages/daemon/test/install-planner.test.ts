import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import { InstallPlanner } from "../src/domain/install-planner.js";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";
import { parseManifest, normalizeManifest } from "../src/domain/package-manifest.js";

const BASIC_MANIFEST = `
schema_version: 1
name: test-pkg
version: 1.0.0
summary: Test package
compatibility:
  runtimes: [claude-code, codex]
exports:
  skills:
    - source: skills/foo
      name: foo
  guidance:
    - source: guidance/AGENTS.md
      name: review-guide
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
`;

/** Standard source files that match BASIC_MANIFEST */
const BASIC_SOURCE_FILES: Record<string, string | true> = {
  "/pkg/skills/foo/SKILL.md": "# Foo skill",
  "/pkg/guidance/AGENTS.md": "# Guidance",
  "/pkg/agents/reviewer.yaml": "name: reviewer",
};

function mockFs(files: Record<string, string | true>, listFilesMap?: Record<string, string[]>): FsOps {
  return {
    readFile: vi.fn((p: string) => {
      const v = files[p];
      if (typeof v === "string") return v;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => p in files),
    listFiles: listFilesMap
      ? vi.fn((dirPath: string) => listFilesMap[dirPath] ?? ["SKILL.md"])
      : undefined,
  };
}

function resolvePackage(manifestYaml: string) {
  const fs = mockFs({ "/pkg/package.yaml": manifestYaml });
  return new PackageResolver(fs).resolve("/pkg");
}

describe("InstallPlanner", () => {
  // Test 1: Clean repo -> all safe_projection
  it("clean repo -> all entries classified safe_projection", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    const actionable = plan.actionable;
    expect(actionable.length).toBeGreaterThanOrEqual(2); // skill + guidance (new file)
    for (const entry of actionable) {
      expect(entry.classification).toBe("safe_projection");
      expect(entry.deferred).toBe(false);
    }
  });

  // Test 2: Existing skill -> conflict
  it("existing skill with same name -> conflict detected", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs({
      ...BASIC_SOURCE_FILES,
      "/repo/.agents/skills/foo/SKILL.md": true,
    });
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.exportName).toBe("foo/SKILL.md");
    expect(plan.conflicts[0]!.conflict).toBeDefined();
    expect(plan.conflicts[0]!.conflict!.reason).toContain("already exists");
  });

  // Test 3: Existing AGENTS.md -> managed_merge
  it("existing AGENTS.md -> guidance classified managed_merge", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs({
      ...BASIC_SOURCE_FILES,
      "/repo/AGENTS.md": true,
    });
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    const guidanceEntry = plan.entries.find((e) => e.exportType === "guidance" && !e.deferred);
    expect(guidanceEntry).toBeDefined();
    expect(guidanceEntry!.classification).toBe("managed_merge");
  });

  // Test 4: No existing AGENTS.md -> safe_projection
  it("no existing AGENTS.md -> guidance classified safe_projection", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    const guidanceEntry = plan.entries.find((e) => e.exportType === "guidance" && !e.deferred);
    expect(guidanceEntry).toBeDefined();
    expect(guidanceEntry!.classification).toBe("safe_projection");
  });

  // Test 5: Hook -> deferred
  it("hook export -> classified deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  hooks:
    - source: hooks/check.yaml
      supported_runtimes: [claude-code]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
    }));
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const hookEntry = plan.deferred.find((e) => e.exportType === "hook");
    expect(hookEntry).toBeDefined();
    expect(hookEntry!.deferred).toBe(true);
    expect(hookEntry!.deferReason).toContain("Phase 5");
  });

  // Test 6: MCP -> deferred
  it("MCP export -> classified deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
  mcp:
    - source: mcp/ctx.yaml
      supported_runtimes: [claude-code]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
    }));
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const mcpEntry = plan.deferred.find((e) => e.exportType === "mcp");
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!.deferred).toBe(true);
  });

  // Test 7: Target paths correct per runtime
  it("plan includes correct target paths per runtime", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);

    // Claude Code — guidance is agents_md which defers on claude-code, so only check skill
    const ccPlan = planner.plan(resolved, "/repo", "claude-code");
    const ccSkill = ccPlan.entries.find((e) => e.exportType === "skill");
    expect(ccSkill!.targetPath).toContain(".claude/skills/foo");

    // Codex
    const cxPlan = planner.plan(resolved, "/repo", "codex");
    const cxSkill = cxPlan.entries.find((e) => e.exportType === "skill");
    expect(cxSkill!.targetPath).toContain(".agents/skills/foo");
  });

  // Test 8: Plan separates actionable vs deferred vs conflicts
  it("plan separates actionable vs deferred vs conflicts", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
    - source: skills/bar
      name: bar
  hooks:
    - source: hooks/check.yaml
`;
    const resolved = resolvePackage(manifest);
    const plannerFs = mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
      "/pkg/skills/bar/SKILL.md": "# Bar",
      "/repo/.agents/skills/foo/SKILL.md": true, // conflict
    });
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    expect(plan.conflicts.length).toBeGreaterThanOrEqual(1); // foo conflicts
    expect(plan.actionable.length).toBeGreaterThanOrEqual(1); // bar is clean
    expect(plan.deferred.length).toBeGreaterThanOrEqual(1); // hook deferred
  });

  // Test 9: Multiple exports planned correctly
  it("multiple exports planned correctly", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    // Should have skill + guidance + agent entries
    expect(plan.entries.filter((e) => e.exportType === "skill")).toHaveLength(1);
    expect(plan.entries.filter((e) => e.exportType === "guidance")).toHaveLength(1);
    expect(plan.entries.filter((e) => e.exportType === "agent")).toHaveLength(1);
    expect(plan.packageName).toBe("test-pkg");
    expect(plan.packageVersion).toBe("1.0.0");
  });

  // Test 10: Role-filtered plan
  it("role-filtered exports produce correct plan subset", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
    - source: skills/bar
      name: bar
roles:
  - name: minimal
    skills: [foo]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
      "/pkg/skills/bar/SKILL.md": "# Bar",
    }));
    const plan = planner.plan(resolved, "/repo", "codex", { roleName: "minimal" });

    const skillEntries = plan.entries.filter((e) => e.exportType === "skill");
    expect(skillEntries).toHaveLength(1);
    expect(skillEntries[0]!.exportName).toBe("foo/SKILL.md");
  });

  // Test 11: Agent name derived from source basename
  it("agent without explicit name uses derived basename", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    const agentEntry = plan.entries.find((e) => e.exportType === "agent");
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.exportName).toBe("reviewer");
    expect(agentEntry!.targetPath).toContain("reviewer");
    expect(agentEntry!.sourcePath).toBeDefined();
  });

  // Test 18: Agent targets are .yaml files (not directories)
  it("agent targets are .yaml files, not directories", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);

    const ccPlan = planner.plan(resolved, "/repo", "claude-code");
    const ccAgent = ccPlan.entries.find((e) => e.exportType === "agent");
    expect(ccAgent!.targetPath).toMatch(/\.claude\/agents\/reviewer\.yaml$/);

    const cxPlan = planner.plan(resolved, "/repo", "codex");
    const cxAgent = cxPlan.entries.find((e) => e.exportType === "agent");
    expect(cxAgent!.targetPath).toMatch(/\.agents\/reviewer\.yaml$/);
  });

  // Test 19: sourcePath set on file-backed entries, undefined on requirements
  it("sourcePath set on skills/guidance/agents, undefined on requirements", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
requirements:
  cli_tools:
    - name: ripgrep
`;
    const resolved = resolvePackage(manifest);
    const plannerFs = mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
      "/pkg/guidance/AGENTS.md": "# Guidance",
      "/pkg/agents/reviewer.yaml": "name: reviewer",
    });
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    const skill = plan.entries.find((e) => e.exportType === "skill");
    expect(skill!.sourcePath).toBeDefined();
    expect(skill!.sourcePath).toContain("skills/foo");

    const guidance = plan.entries.find((e) => e.exportType === "guidance" && !e.deferred);
    expect(guidance!.sourcePath).toBeDefined();

    const agent = plan.entries.find((e) => e.exportType === "agent");
    expect(agent!.sourcePath).toBeDefined();

    const req = plan.entries.find((e) => e.exportType === "requirement");
    expect(req!.sourcePath).toBeUndefined();
  });

  // Test 12: generic_rules_overlay -> deferred
  it("generic_rules_overlay guidance -> deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  guidance:
    - source: guidance/rules.md
      kind: generic_rules_overlay
      merge_strategy: managed_block
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    const entry = plan.deferred.find((e) => e.exportName === "rules.md");
    expect(entry).toBeDefined();
    expect(entry!.deferReason).toContain("generic_rules_overlay");
  });

  // Test 13: replace merge strategy -> deferred
  it("replace merge strategy guidance -> deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: replace
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    const entry = plan.deferred.find((e) => e.exportName === "AGENTS.md");
    expect(entry).toBeDefined();
    expect(entry!.deferReason).toContain("replace");
  });

  // Test 14: agents_md on claude-code -> deferred
  it("agents_md guidance on claude-code -> deferred", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const entry = plan.deferred.find((e) => e.exportType === "guidance" && e.exportName === "review-guide");
    expect(entry).toBeDefined();
    expect(entry!.deferReason).toContain("agents_md guidance not applicable to claude-code");
  });

  // Test 15: claude_md on codex -> deferred
  it("claude_md guidance on codex -> deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  guidance:
    - source: guidance/CLAUDE.md
      kind: claude_md
      merge_strategy: managed_block
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    const entry = plan.deferred.find((e) => e.exportType === "guidance");
    expect(entry).toBeDefined();
    expect(entry!.deferReason).toContain("claude_md guidance not applicable to codex");
  });

  // Test 16: Requirements planned as deferred external_install
  it("requirements planned as deferred external_install", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
requirements:
  cli_tools:
    - name: agent-browser
      required_for: [qa-browser]
  system_packages:
    - name: ripgrep
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({
      "/pkg/skills/foo/SKILL.md": "# Foo",
    }));
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const reqEntries = plan.deferred.filter((e) => e.exportType === "requirement");
    expect(reqEntries).toHaveLength(2);
    expect(reqEntries.some((e) => e.exportName === "agent-browser" && e.classification === "external_install")).toBe(true);
    expect(reqEntries.some((e) => e.exportName === "ripgrep" && e.classification === "external_install")).toBe(true);
    expect(reqEntries[0]!.deferReason).toContain("Phase 5");
  });

  // Test 17: packageId is undefined (set by caller on persistence)
  it("plan.packageId is undefined before persistence", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs(BASIC_SOURCE_FILES);
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    expect(plan.packageId).toBeUndefined();
  });

  // --- New tests for R2-H1, R2-H2, F2.1 ---

  // Test 20: Multi-file skill projection
  it("multi-file skill projection creates one entry per file", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/review
      name: review
`;
    const resolved = resolvePackage(manifest);
    const plannerFs = mockFs(
      {
        "/pkg/skills/review/SKILL.md": "# Review skill",
        "/pkg/skills/review/helper.md": "# Helper content",
      },
      {
        "/pkg/skills/review": ["SKILL.md", "helper.md"],
      },
    );
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const skillEntries = plan.entries.filter((e) => e.exportType === "skill");
    expect(skillEntries).toHaveLength(2);
    expect(skillEntries.some((e) => e.exportName === "review/SKILL.md")).toBe(true);
    expect(skillEntries.some((e) => e.exportName === "review/helper.md")).toBe(true);
    // Check target paths
    expect(skillEntries.find((e) => e.exportName === "review/SKILL.md")!.targetPath).toContain(".claude/skills/review/SKILL.md");
    expect(skillEntries.find((e) => e.exportName === "review/helper.md")!.targetPath).toContain(".claude/skills/review/helper.md");
  });

  // Test 21: Incompatible runtime -> throws
  it("incompatible runtime throws error", () => {
    const manifest = `
schema_version: 1
name: codex-only
version: 1.0.0
summary: Codex only package
compatibility:
  runtimes: [codex]
exports:
  skills:
    - source: skills/foo
      name: foo
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));

    expect(() => planner.plan(resolved, "/repo", "claude-code")).toThrow(
      "Package 'codex-only' does not support runtime 'claude-code'. Supported: codex",
    );
  });

  // Test 22: Unsupported scope -> deferred
  it("skill with unsupported scope is deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
      supported_scopes: [user_global]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const entry = plan.deferred.find((e) => e.exportType === "skill");
    expect(entry).toBeDefined();
    expect(entry!.deferred).toBe(true);
    expect(entry!.deferReason).toContain("does not support project_shared scope");
    expect(entry!.exportName).toBe("foo");
  });

  // Test 23: Missing source file -> throws
  it("missing source file throws error", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code]
exports:
  skills:
    - source: skills/foo
      name: foo
`;
    const resolved = resolvePackage(manifest);
    // No source files in the mock -> source doesn't exist
    const planner = new InstallPlanner(mockFs({}));

    expect(() => planner.plan(resolved, "/repo", "claude-code")).toThrow(
      "Source file not found: /pkg/skills/foo/SKILL.md",
    );
  });

  // Test 24: Missing guidance source file -> throws
  it("missing guidance source file throws error", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));

    expect(() => planner.plan(resolved, "/repo", "codex")).toThrow(
      "Source file not found: /pkg/guidance/AGENTS.md",
    );
  });

  // Test 25: Missing agent source file -> throws
  it("missing agent source file throws error", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  agents:
    - source: agents/reviewer.yaml
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));

    expect(() => planner.plan(resolved, "/repo", "codex")).toThrow(
      "Source file not found: /pkg/agents/reviewer.yaml",
    );
  });

  // Test 26: Guidance with unsupported scope -> deferred
  it("guidance with unsupported scope is deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  guidance:
    - source: guidance/AGENTS.md
      kind: agents_md
      merge_strategy: managed_block
      supported_scopes: [user_global]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    const entry = plan.deferred.find((e) => e.exportType === "guidance");
    expect(entry).toBeDefined();
    expect(entry!.deferred).toBe(true);
    expect(entry!.deferReason).toContain("does not support project_shared scope");
  });

  // Test 27: Agent with unsupported scope -> deferred
  it("agent with unsupported scope is deferred", () => {
    const manifest = `
schema_version: 1
name: test
version: 1.0.0
summary: Test
compatibility:
  runtimes: [codex]
exports:
  agents:
    - source: agents/reviewer.yaml
      supported_scopes: [user_global]
`;
    const resolved = resolvePackage(manifest);
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    const entry = plan.deferred.find((e) => e.exportType === "agent");
    expect(entry).toBeDefined();
    expect(entry!.deferred).toBe(true);
    expect(entry!.deferReason).toContain("does not support project_shared scope");
  });
});

// --- Export-name containment (planner-boundary) ---
//
// These use the real filesystem and the real path module, so they exercise the
// same path.join the planner uses and stay portable across POSIX and Windows.
// Each kind has its own base — skills under `.claude/skills/` / `.agents/skills/`,
// agents at `.claude/agents/` / `.agents/` — so an agent escapes with fewer `..`
// than a skill.

import fs from "node:fs";
import os from "node:os";

function realFs(): { fsOps: FsOps; pkgRoot: string } {
  const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-name-"));
  fs.mkdirSync(path.join(pkgRoot, "skills", "x"), { recursive: true });
  fs.mkdirSync(path.join(pkgRoot, "agents"), { recursive: true });
  fs.writeFileSync(path.join(pkgRoot, "skills", "x", "SKILL.md"), "hi");
  fs.writeFileSync(path.join(pkgRoot, "agents", "a.yaml"), "name: a\n");
  const fsOps: FsOps = {
    readFile: (p) => fs.readFileSync(p, "utf-8"),
    exists: (p) => fs.existsSync(p),
    listFiles: () => ["SKILL.md"],
  };
  return { fsOps, pkgRoot };
}

function manifestFor(kind: "skill" | "agent", name: string) {
  const yaml = kind === "skill"
    ? `schema_version: 1\nname: p\nversion: 1.0.0\nsummary: s\ncompatibility: { runtimes: [claude-code, codex] }\nexports:\n  skills:\n    - source: skills/x\n      name: ${JSON.stringify(name)}\n`
    : `schema_version: 1\nname: p\nversion: 1.0.0\nsummary: s\ncompatibility: { runtimes: [claude-code, codex] }\nexports:\n  agents:\n    - source: agents/a.yaml\n      name: ${JSON.stringify(name)}\n`;
  return normalizeManifest(parseManifest(yaml));
}

function planTarget(kind: "skill" | "agent", name: string, runtime: "claude-code" | "codex") {
  const { fsOps, pkgRoot } = realFs();
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "planner-target-"));
  try {
    const resolved = {
      sourceKind: "local_path" as const,
      sourceRef: pkgRoot,
      manifest: manifestFor(kind, name),
      manifestHash: "x",
      rawManifestYaml: "",
    };
    const plan = new InstallPlanner(fsOps).plan(resolved, targetRoot, runtime);
    const entry = plan.entries.find((e) => e.targetPath.length > 0);
    const targetPath = entry?.targetPath ?? "";
    const rel = path.relative(targetRoot, targetPath);
    const escaped = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    return { threw: false, plan, targetPath, escaped, error: "" };
  } catch (err) {
    return { threw: true, plan: null, targetPath: "", escaped: false, error: (err as Error).message };
  } finally {
    fs.rmSync(pkgRoot, { recursive: true, force: true });
    fs.rmSync(targetRoot, { recursive: true, force: true });
  }
}

describe("InstallPlanner export-name containment", () => {
  it("refuses an escaping name at every kind/runtime boundary", () => {
    // `../../../x` climbs above the target for all four bases; the Codex agent
    // base (`.agents`) is shallower, so `../../x` escapes for it alone.
    const cases: Array<["skill" | "agent", string, "claude-code" | "codex"]> = [
      ["skill", "../../../x", "claude-code"],
      ["skill", "../../../x", "codex"],
      ["agent", "../../../x", "claude-code"],
      ["agent", "../../../x", "codex"],
      ["agent", "../../x", "codex"],
    ];
    for (const [kind, name, runtime] of cases) {
      const { threw, error } = planTarget(kind, name, runtime);
      expect(threw, `${kind} '${name}' (${runtime}) should be refused`).toBe(true);
      expect(error).toContain("outside the install target");
    }
  });

  it("accepts names that stay inside the target", () => {
    const cases: Array<["skill" | "agent", string, "claude-code" | "codex"]> = [
      ["skill", "nested/helper", "claude-code"],
      ["skill", "nested/helper", "codex"],
      ["agent", "../x", "claude-code"],
      ["agent", "../x", "codex"],
      ["agent", "", "codex"],
      ["skill", "_helper", "claude-code"],
      ["skill", ".helper", "codex"],
    ];
    for (const [kind, name, runtime] of cases) {
      const { threw, escaped } = planTarget(kind, name, runtime);
      expect(threw, `${kind} '${name}' (${runtime}) should not be refused`).toBe(false);
      expect(escaped, `${kind} '${name}' (${runtime}) should stay inside`).toBe(false);
    }
  });
});

