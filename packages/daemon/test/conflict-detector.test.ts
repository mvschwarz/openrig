import { describe, it, expect, vi } from "vitest";
import { detectConflicts, type GuidanceConflictMeta } from "../src/domain/conflict-detector.js";
import { InstallPlanner, type InstallPlanEntry } from "../src/domain/install-planner.js";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";

function mockFs(files: Record<string, string>): FsOps {
  return {
    readFile: vi.fn((p: string) => {
      if (files[p] !== undefined) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => p in files),
  };
}

const SKILL_CONTENT = "# Skill\nSome content";
const SKILL_CONTENT_DIFFERENT = "# Skill\nDifferent content";
const AGENT_CONTENT = "name: reviewer\nruntime: claude-code";
const AGENT_CONTENT_DIFFERENT = "name: reviewer\nruntime: codex";

const BASIC_MANIFEST = `
schema_version: 1
name: test-pkg
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
      name: review-guide
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
`;

function resolveAndPlan(manifestYaml: string, repoFiles: Record<string, string>, runtime: "claude-code" | "codex" = "codex") {
  const pkgFiles: Record<string, string> = { "/pkg/package.yaml": manifestYaml };
  // Add package source files
  pkgFiles["/pkg/skills/foo/SKILL.md"] = SKILL_CONTENT;
  pkgFiles["/pkg/guidance/AGENTS.md"] = "# Guidance content";
  pkgFiles["/pkg/agents/reviewer.yaml"] = AGENT_CONTENT;

  const resolverFs = mockFs(pkgFiles);
  const resolved = new PackageResolver(resolverFs).resolve("/pkg");

  // Planner needs to see repo files for exists() checks
  const allFiles = { ...pkgFiles, ...repoFiles };
  const plannerFs = mockFs(allFiles);
  const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", runtime);

  // Detector needs package source + repo target files
  const detectorFs = mockFs(allFiles);
  return detectConflicts(plan, detectorFs);
}

describe("ConflictDetector", () => {
  // Test 1: New skill -> safe_projection
  it("new skill -> safe_projection unchanged", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const skill = result.actionable.find((e) => e.exportType === "skill");
    expect(skill).toBeDefined();
    expect(skill!.classification).toBe("safe_projection");
    expect(result.noOps).toHaveLength(0);
  });

  // Test 2: Existing skill, different content -> conflict with hashes
  it("existing skill, different content -> conflict with hashes", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT_DIFFERENT,
    });
    const conflict = result.conflicts.find((e) => e.exportName === "foo/SKILL.md");
    expect(conflict).toBeDefined();
    expect(conflict!.conflict!.existingHash).toBeDefined();
    expect(conflict!.conflict!.sourceHash).toBeDefined();
    expect(conflict!.conflict!.existingHash).not.toBe(conflict!.conflict!.sourceHash);
  });

  // Test 3: Existing skill, same content -> no-op
  it("existing skill, same content -> no-op", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT,
    });
    expect(result.noOps).toHaveLength(1);
    expect(result.noOps[0]!.exportName).toBe("foo/SKILL.md");
    expect(result.conflicts).toHaveLength(0);
  });

  // Test 4: New guidance file -> safe_projection
  it("new guidance file -> safe_projection", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const guidance = result.actionable.find((e) => e.exportType === "guidance");
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("safe_projection");
  });

  // Test 5: Existing guidance, no managed block -> managed_merge, hasExistingBlock=false
  it("existing guidance, no managed block -> managed_merge, hasExistingBlock=false", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Some existing content\nNo managed blocks here.",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("managed_merge");
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(false);
  });

  // Test 6: Existing guidance, has managed block -> managed_merge, hasExistingBlock=true
  it("existing guidance, has managed block -> managed_merge, hasExistingBlock=true", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: test-pkg -->\nold content\n<!-- END OpenRig MANAGED BLOCK: test-pkg -->\n# Footer",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.classification).toBe("managed_merge");
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(true);
  });

  // Test 7: Hook -> deferred passthrough
  it("hook -> config_mutation, deferred passthrough", () => {
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
  hooks:
    - source: hooks/check.yaml
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const hook = result.deferred.find((e) => e.exportType === "hook");
    expect(hook).toBeDefined();
    expect(hook!.deferred).toBe(true);
  });

  // Test 8: MCP -> deferred passthrough
  it("MCP -> config_mutation, deferred passthrough", () => {
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
  mcp:
    - source: mcp/ctx.yaml
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const mcp = result.deferred.find((e) => e.exportType === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.deferred).toBe(true);
  });

  // Test 9: Requirement -> external_install, deferred passthrough
  it("requirement -> external_install, deferred passthrough", () => {
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
requirements:
  cli_tools:
    - name: ripgrep
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, plannerFs);

    const req = result.deferred.find((e) => e.exportType === "requirement");
    expect(req).toBeDefined();
    expect(req!.classification).toBe("external_install");
  });

  // Test 10: Multiple conflicts reported together
  it("multiple conflicts reported together", () => {
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
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
      "/pkg/skills/bar/SKILL.md": "# Bar skill",
    };
    const repoFiles: Record<string, string> = {
      "/repo/.agents/skills/foo/SKILL.md": SKILL_CONTENT_DIFFERENT,
      "/repo/.agents/skills/bar/SKILL.md": "# Bar different",
    };
    const allFiles = { ...pkgFiles, ...repoFiles };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(allFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");
    const result = detectConflicts(plan, mockFs(allFiles));

    expect(result.conflicts).toHaveLength(2);
  });

  // Test 11: Managed block for DIFFERENT package -> hasExistingBlock=false
  it("existing guidance with managed block for different package -> hasExistingBlock=false", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/AGENTS.md": "# Header\n<!-- BEGIN OpenRig MANAGED BLOCK: other-package -->\nother content\n<!-- END OpenRig MANAGED BLOCK: other-package -->\n",
    });
    const guidance = result.actionable.find((e) => e.exportType === "guidance") as InstallPlanEntry & { guidanceMeta?: GuidanceConflictMeta };
    expect(guidance).toBeDefined();
    expect(guidance!.guidanceMeta?.hasExistingBlock).toBe(false);
  });

  // Test 12: Existing agent, same content -> no-op
  it("existing agent, same content -> no-op", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/reviewer.yaml": AGENT_CONTENT,
    });
    const agentNoOp = result.noOps.find((e) => e.exportType === "agent");
    expect(agentNoOp).toBeDefined();
    expect(agentNoOp!.exportName).toBe("reviewer");
  });

  // Test 13: Existing agent, different content -> conflict
  it("existing agent, different content -> conflict", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {
      "/repo/.agents/reviewer.yaml": AGENT_CONTENT_DIFFERENT,
    });
    const conflict = result.conflicts.find((e) => e.exportType === "agent");
    expect(conflict).toBeDefined();
    expect(conflict!.conflict!.existingHash).toBeDefined();
    expect(conflict!.conflict!.sourceHash).toBeDefined();
  });

  // Test 14: Agent target paths are YAML files
  it("agent target paths are .yaml files, not directories", () => {
    const result = resolveAndPlan(BASIC_MANIFEST, {});
    const agent = result.entries.find((e) => e.exportType === "agent");
    expect(agent).toBeDefined();
    expect(agent!.targetPath).toMatch(/\.yaml$/);
    expect(agent!.targetPath).toContain("reviewer.yaml");
  });

  // Test 15: Requirement entry has sourcePath undefined
  it("requirement entry has sourcePath undefined, passes through unchanged", () => {
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
requirements:
  cli_tools:
    - name: ripgrep
`;
    const pkgFiles: Record<string, string> = {
      "/pkg/package.yaml": manifest,
      "/pkg/skills/foo/SKILL.md": SKILL_CONTENT,
    };
    const resolverFs = mockFs(pkgFiles);
    const resolved = new PackageResolver(resolverFs).resolve("/pkg");
    const plannerFs = mockFs(pkgFiles);
    const plan = new InstallPlanner(plannerFs).plan(resolved, "/repo", "codex");

    const reqEntry = plan.entries.find((e) => e.exportType === "requirement");
    expect(reqEntry).toBeDefined();
    expect(reqEntry!.sourcePath).toBeUndefined();

    const result = detectConflicts(plan, plannerFs);
    const refinedReq = result.deferred.find((e) => e.exportType === "requirement");
    expect(refinedReq).toBeDefined();
    expect(refinedReq!.sourcePath).toBeUndefined();
  });
});
