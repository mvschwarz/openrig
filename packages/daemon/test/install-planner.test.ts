import { describe, it, expect, vi } from "vitest";
import { InstallPlanner } from "../src/domain/install-planner.js";
import { PackageResolver, type FsOps } from "../src/domain/package-resolver.js";

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

function mockFs(files: Record<string, string | true>): FsOps {
  return {
    readFile: vi.fn((p: string) => {
      const v = files[p];
      if (typeof v === "string") return v;
      throw new Error(`ENOENT: ${p}`);
    }),
    exists: vi.fn((p: string) => p in files),
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
    const plannerFs = mockFs({});
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
      "/repo/.agents/skills/foo/SKILL.md": true,
    });
    const planner = new InstallPlanner(plannerFs);
    const plan = planner.plan(resolved, "/repo", "codex");

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]!.exportName).toBe("foo");
    expect(plan.conflicts[0]!.conflict).toBeDefined();
    expect(plan.conflicts[0]!.conflict!.reason).toContain("already exists");
  });

  // Test 3: Existing AGENTS.md -> managed_merge
  it("existing AGENTS.md -> guidance classified managed_merge", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const plannerFs = mockFs({
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
    const plannerFs = mockFs({});
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
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "claude-code");

    const mcpEntry = plan.deferred.find((e) => e.exportType === "mcp");
    expect(mcpEntry).toBeDefined();
    expect(mcpEntry!.deferred).toBe(true);
  });

  // Test 7: Target paths correct per runtime
  it("plan includes correct target paths per runtime", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const planner = new InstallPlanner(mockFs({}));

    // Claude Code
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
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex", { roleName: "minimal" });

    const skillEntries = plan.entries.filter((e) => e.exportType === "skill");
    expect(skillEntries).toHaveLength(1);
    expect(skillEntries[0]!.exportName).toBe("foo");
  });

  // Test 11: Agent name derived from source basename
  it("agent without explicit name uses derived basename", () => {
    const resolved = resolvePackage(BASIC_MANIFEST);
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));

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
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));
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
    const planner = new InstallPlanner(mockFs({}));
    const plan = planner.plan(resolved, "/repo", "codex");

    expect(plan.packageId).toBeUndefined();
  });
});
