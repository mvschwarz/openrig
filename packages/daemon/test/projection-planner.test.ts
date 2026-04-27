import { describe, it, expect } from "vitest";
import { planProjection, type ProjectionFsOps, type ProjectionInput } from "../src/domain/projection-planner.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "../src/domain/profile-resolver.js";
import type { ResourceCollision } from "../src/domain/agent-resolver.js";
import type { StartupBlock, StartupFile } from "../src/domain/types.js";

function makeFile(path: string): StartupFile {
  return { path, deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] };
}

function makeQR(id: string, path: string, sourceSpec = "base", sourcePath = "/agents/base"): QualifiedResource {
  return { effectiveId: id, sourceSpec, sourcePath, resource: { id, path } as QualifiedResource["resource"] };
}

function makeGuidanceQR(id: string, path: string, target: string, merge: "managed_block" | "append"): QualifiedResource {
  return { effectiveId: id, sourceSpec: "base", sourcePath: "/agents/base", resource: { id, path, target, merge } as QualifiedResource["resource"] };
}

function makeRuntimeResourceQR(id: string, path: string, runtime: string, type = "plugin"): QualifiedResource {
  return { effectiveId: id, sourceSpec: "base", sourcePath: "/agents/base", resource: { id, path, runtime, type } as QualifiedResource["resource"] };
}

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], hooks: [], runtimeResources: [] };
}

function makeConfig(overrides?: Partial<ResolvedNodeConfig>): ResolvedNodeConfig {
  return {
    runtime: "claude-code",
    model: undefined,
    cwd: ".",
    restorePolicy: "resume_if_possible",
    lifecycle: undefined,
    selectedResources: emptyResources(),
    startup: { files: [], actions: [] },
    resolvedSpecName: "test",
    resolvedSpecVersion: "1.0",
    resolvedSpecHash: "abc",
    ...overrides,
  };
}

function mockFs(files?: Record<string, string>): ProjectionFsOps {
  const store = files ?? {};
  return {
    readFile: (p: string) => { if (p in store) return store[p]!; throw new Error(`Not found: ${p}`); },
    exists: (p: string) => p in store,
  };
}

describe("Projection planner", () => {
  // T1: resolved node produces plan with selected resources only
  it("produces plan with selected resources only", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("skill-a");
      expect(result.plan.entries[0]!.category).toBe("skill");
    }
  });

  // T2: non-matching runtime_resources excluded
  it("excludes non-matching runtime_resources", () => {
    const config = makeConfig({
      runtime: "claude-code",
      selectedResources: { ...emptyResources(), runtimeResources: [makeRuntimeResourceQR("codex-ext", "extensions/codex", "codex")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(0);
    }
  });

  // T3: matching runtime_resources included
  it("includes matching runtime_resources", () => {
    const config = makeConfig({
      runtime: "claude-code",
      selectedResources: { ...emptyResources(), runtimeResources: [makeRuntimeResourceQR("claude-ext", "runtime/claude-settings.json", "claude-code", "claude_settings_fragment")] },
    });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("claude-ext");
      expect(result.plan.entries[0]!.resourceType).toBe("claude_settings_fragment");
    }
  });

  // T4: duplicate startup file delivery preserved in order
  it("preserves duplicate startup files in order", () => {
    const startup: StartupBlock = {
      files: [makeFile("base.md"), makeFile("profile.md"), makeFile("base.md")],
      actions: [],
    };
    const config = makeConfig({ startup });
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.startup.files).toHaveLength(3);
      expect(result.plan.startup.files[0]!.path).toBe("base.md");
      expect(result.plan.startup.files[2]!.path).toBe("base.md");
    }
  });

  // T5: managed-block guidance classified as managed_merge
  it("classifies managed-block guidance as managed_merge via classifyResourceProjection", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), guidance: [makeGuidanceQR("tdd-rules", "guidance/tdd.md", "claude_md", "managed_block")] },
    });
    const result = planProjection({
      config, collisions: [], fsOps: mockFs(),
      resolveTargetPath: () => "/project/CLAUDE.md",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.classification).toBe("managed_merge");
      expect(result.plan.entries[0]!.mergeStrategy).toBe("managed_block");
    }
  });

  // T6: hash mismatch classified as hash_conflict
  it("classifies hash mismatch as hash_conflict via classifyResourceProjection", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content",
      "/project/.claude/skills/skill-a/SKILL.md": "different target content",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("hash_conflict");
      expect(result.plan.conflicts).toHaveLength(1);
    }
  });

  // T7: ambiguous resource in selectedResources with import/import collision -> rejected
  it("rejects ambiguous unqualified resource from import/import collision", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("shared", "skills/shared", "lib-a", "/agents/lib-a")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatch(/[Aa]mbiguous.*shared/);
    }
  });

  // T7b: base/import collision with base owner -> accepted (not ambiguous)
  it("accepts base/import collision where base owns unqualified id", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("foo", "skills/foo", "base", "/agents/base")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "foo",
      sources: [
        { specName: "base", qualifiedId: "foo" }, // base owns it
        { specName: "lib", qualifiedId: "lib:foo" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true);
  });

  // T8: qualified reference succeeds on collision
  it("qualified reference succeeds on collision", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("lib-a:shared", "skills/shared", "lib-a", "/agents/lib-a")] },
    });
    const collisions: ResourceCollision[] = [{
      category: "skills",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("lib-a:shared");
    }
  });

  // T9: identical content = no_op (via classifyResourceProjection)
  it("classifies identical content as no_op via conflict-detector", async () => {
    const { classifyResourceProjection } = await import("../src/domain/conflict-detector.js");
    const fs = {
      readFile: () => "same content",
      exists: () => true,
    };
    const result = classifyResourceProjection("/src/skill", "/target/skill", "skill", undefined, fs);
    expect(result).toBe("no_op");
  });

  // T8c: cross-category collision does not falsely reject
  it("guidance collision on 'shared' does not reject selected skill 'shared'", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("shared", "skills/shared")] },
    });
    // Collision is in guidance category, not skills
    const collisions: ResourceCollision[] = [{
      category: "guidance",
      resourceId: "shared",
      sources: [
        { specName: "lib-a", qualifiedId: "lib-a:shared" },
        { specName: "lib-b", qualifiedId: "lib-b:shared" },
      ],
    }];
    const result = planProjection({ config, collisions, fsOps: mockFs() });
    expect(result.ok).toBe(true); // should NOT be rejected
    if (result.ok) {
      expect(result.plan.entries).toHaveLength(1);
      expect(result.plan.entries[0]!.effectiveId).toBe("shared");
    }
  });

  // T10: deterministic output for identical inputs
  it("produces deterministic output for identical inputs", () => {
    const config = makeConfig({
      selectedResources: {
        ...emptyResources(),
        skills: [makeQR("b-skill", "skills/b"), makeQR("a-skill", "skills/a")],
        hooks: [makeQR("hook-z", "hooks/z")],
      },
    });
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const r1 = planProjection(input);
    const r2 = planProjection(input);
    expect(r1).toEqual(r2);
    if (r1.ok && r2.ok) {
      // Verify sorted order
      expect(r1.plan.entries[0]!.category).toBe("hook");
      expect(r1.plan.entries[1]!.effectiveId).toBe("a-skill");
      expect(r1.plan.entries[2]!.effectiveId).toBe("b-skill");
    }
  });
});
