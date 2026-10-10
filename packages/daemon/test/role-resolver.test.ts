import { describe, it, expect } from "vitest";
import { resolveExports } from "../src/domain/role-resolver.js";
import { normalizeManifest, parseManifest } from "../src/domain/package-manifest.js";

function makeManifest(yaml: string) {
  return normalizeManifest(parseManifest(yaml));
}

const FULL_MANIFEST = makeManifest(`
schema_version: 1
name: test-pkg
version: 1.0.0
summary: Test
compatibility:
  runtimes: [claude-code, codex]
exports:
  skills:
    - source: skills/foo
      name: foo
    - source: skills/bar
      name: bar
  guidance:
    - source: guidance/AGENTS.md
      name: review-guidelines
      kind: agents_md
      merge_strategy: managed_block
  agents:
    - source: agents/reviewer.yaml
  hooks:
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
  mcp:
    - source: mcp/context7.yaml
      supported_runtimes: [claude-code]
roles:
  - name: reviewer
    skills: [foo]
    guidance: [review-guidelines]
    hooks: [hooks/checkpoint.yaml]
    context: [docs/workflow-guide.md]
  - name: full-stack
    skills: [foo, bar]
`);

describe("RoleResolver", () => {
  it("a stale hook reference does not block actionable exports or another role", () => {
    const manifest = structuredClone(FULL_MANIFEST);
    manifest.roles![0]!.hooks = ["hooks/missing.yaml"];
    const result = resolveExports(manifest, "reviewer");
    expect(result.skills.map((skill) => skill.name)).toEqual(["foo"]);
    expect(result.guidance.map((guidance) => guidance.name)).toEqual(["review-guidelines"]);
    expect(result.agents).toHaveLength(1);
    expect(result.deferred.some((entry) => entry.exportType === "hook")).toBe(false);
    expect(resolveExports(manifest, "full-stack").skills).toHaveLength(2);
  });

  // Test 1: Role with skills only -> referenced skills in output
  it("role with skills only -> referenced skills in output", () => {
    const result = resolveExports(FULL_MANIFEST, "full-stack");
    expect(result.skills).toHaveLength(2);
    expect(result.skills.map((s) => s.name).sort()).toEqual(["bar", "foo"]);
  });

  // Test 2: Role with hooks -> hooks deferred, skills still actionable
  it("role with hooks -> hooks deferred, skills still in actionable", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]!.name).toBe("foo");
    expect(result.deferred.some((d) => d.exportType === "hook")).toBe(true);
  });

  // Test 3: Role references nonexistent skill -> error
  it("role references nonexistent skill -> throws", () => {
    const manifest = makeManifest(`
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
roles:
  - name: broken
    skills: [nonexistent]
`);
    expect(() => resolveExports(manifest, "broken")).toThrow(/nonexistent/);
  });

  // Test 4: No role -> full package exports
  it("no role -> full package exports with hooks/mcp deferred", () => {
    const result = resolveExports(FULL_MANIFEST);
    expect(result.skills).toHaveLength(2);
    expect(result.guidance).toHaveLength(1);
    expect(result.agents).toHaveLength(1);
    expect(result.deferred).toHaveLength(2); // 1 hook + 1 mcp
  });

  // Test 5: Deferred items include reason string
  it("deferred items include reason string", () => {
    const result = resolveExports(FULL_MANIFEST);
    const hook = result.deferred.find((d) => d.exportType === "hook");
    expect(hook).toBeDefined();
    expect(hook!.reason).toContain("Phase 5");

    const mcp = result.deferred.find((d) => d.exportType === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp!.reason).toContain("Phase 5");
  });

  // Test 6: Mixed role -> correct split
  it("mixed role (skills + guidance + hooks) -> correct actionable/deferred split", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    // Actionable: 1 skill + 1 guidance + 1 agent (all agents always included)
    expect(result.skills).toHaveLength(1);
    expect(result.guidance).toHaveLength(1);
    expect(result.agents).toHaveLength(1);
    // Deferred: hooks + mcp
    expect(result.deferred.length).toBeGreaterThanOrEqual(1);
  });

  // Test 7: Role not found -> throws
  it("roleName not found -> throws error", () => {
    expect(() => resolveExports(FULL_MANIFEST, "nonexistent-role")).toThrow(/not found/);
  });

  // Test 8: Role filter preserves all agent exports
  it("role filter preserves all agent exports unchanged", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.source).toBe("agents/reviewer.yaml");
  });

  // Test 9: Role with context -> context ignored
  it("role with context references -> context not in output", () => {
    const result = resolveExports(FULL_MANIFEST, "reviewer");
    // Context should not appear in skills, guidance, agents, or deferred
    const allSources = [
      ...result.skills.map((s) => s.source),
      ...result.guidance.map((g) => g.source),
      ...result.agents.map((a) => a.source),
      ...result.deferred.map((d) => d.source),
    ];
    expect(allSources).not.toContain("docs/workflow-guide.md");
  });

  // Test 10: Role with specific hooks -> only selected hooks deferred
  it("role-filtered resolve defers only role-selected hooks", () => {
    const manifest = makeManifest(`
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
    - source: hooks/checkpoint.yaml
      supported_runtimes: [claude-code]
    - source: hooks/other.yaml
      supported_runtimes: [claude-code]
roles:
  - name: selective
    skills: [foo]
    hooks: [hooks/checkpoint.yaml]
`);
    const result = resolveExports(manifest, "selective");
    const hookSources = result.deferred.filter((d) => d.exportType === "hook").map((d) => d.source);
    expect(hookSources).toEqual(["hooks/checkpoint.yaml"]);
    expect(hookSources).not.toContain("hooks/other.yaml");
  });
});
