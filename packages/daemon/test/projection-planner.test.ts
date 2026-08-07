import { describe, it, expect } from "vitest";
import { planProjection, type ProjectionFsOps, type ProjectionInput } from "../src/domain/projection-planner.js";
import { hashContent } from "../src/domain/conflict-detector.js";
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

function makePluginQR(id: string, path: string, sourceSpec = "base", sourcePath = "/agents/base"): QualifiedResource {
  return { effectiveId: id, sourceSpec, sourcePath, resource: { id, source: { kind: "local", path } } as QualifiedResource["resource"] };
}

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
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

  it("P20: target == manifest last-projected (source advanced) → stale_overwrite, SAFE (0 conflicts)", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content NEW",
      "/project/.claude/skills/skill-a/SKILL.md": "old projected content",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
      lastHashLookup: () => hashContent("old projected content"), // manifest: we wrote exactly this
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("stale_overwrite");
      expect(result.plan.conflicts).toHaveLength(0); // safe refresh — NOT protected
    }
  });

  it("P20: target diverges from BOTH manifest AND source → operator_conflict, PROTECTED (a conflict)", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    const fs = mockFs({
      "/agents/base/skills/a": "source content NEW",
      "/project/.claude/skills/skill-a/SKILL.md": "OPERATOR HAND EDIT",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: () => "/project/.claude/skills/skill-a/SKILL.md",
      lastHashLookup: () => hashContent("what we projected before"), // ≠ current target → operator edited
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("operator_conflict");
      expect(result.plan.conflicts).toHaveLength(1); // PROTECTED (not overwritten)
      expect(result.plan.conflicts[0]!.conflictDetail?.reason).toMatch(/modified after/i);
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
        plugins: [makePluginQR("plugin-z", "/abs/plugins/z")],
      },
    });
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const r1 = planProjection(input);
    const r2 = planProjection(input);
    expect(r1).toEqual(r2);
    if (r1.ok && r2.ok) {
      // Verify sorted order: plugin (p) < skill (s) alphabetically
      expect(r1.plan.entries[0]!.category).toBe("plugin");
      expect(r1.plan.entries[1]!.effectiveId).toBe("a-skill");
      expect(r1.plan.entries[2]!.effectiveId).toBe("b-skill");
    }
  });
});

// ── P17 (finding A2, finder-owns): the dead hash-conflict detector, wired ──
// The planner's conflict lane existed but PRODUCTION never injected
// resolveTargetPath (dropped in the 4.8 restack — the instantiator's own §6
// comment records the warnings-site threading loss), so every entry classified
// safe_projection and operator-modified targets were silently overwritten.
// RED-first against: (1) the missing production resolver, (2) dir-shaped skill
// realism (a real skill source is a DIRECTORY; the classifier must compare the
// representative SKILL.md, not readFile(dir)-throw its way to a false verdict),
// (3) the conflicts->warnings surfacing helper.
import {
  claudeConflictTargetPath,
  projectionConflictWarnings,
} from "../src/domain/projection-planner.js";

describe("P17 — production conflict-target resolver (claudeConflictTargetPath)", () => {
  it("maps skill -> the projected SKILL.md, subagent -> agents/<source basename>, guidance -> CLAUDE.md", () => {
    expect(claudeConflictTargetPath("skill", "skill-a", "/w", "/agents/base/skills/a")).toBe(
      "/w/.claude/skills/skill-a/SKILL.md",
    );
    expect(claudeConflictTargetPath("subagent", "rev", "/w", "/agents/base/subagents/reviewer.md")).toBe(
      "/w/.claude/agents/reviewer.md",
    );
    expect(claudeConflictTargetPath("guidance", "tdd", "/w", "/agents/base/guidance/tdd.md")).toBe("/w/CLAUDE.md");
  });

  it("returns null for merged/complex categories (plugin, runtime_resource) — classification stays deferred", () => {
    expect(claudeConflictTargetPath("plugin", "p", "/w", "/agents/base/plugins/p")).toBeNull();
    expect(claudeConflictTargetPath("runtime_resource", "r", "/w", "/agents/base/rr/r")).toBeNull();
  });
});

describe("P17 — dir-shaped skill sources compare the representative SKILL.md", () => {
  it("an operator-modified projected SKILL.md classifies hash_conflict; an untouched one no_ops", () => {
    const config = makeConfig({
      selectedResources: { ...emptyResources(), skills: [makeQR("skill-a", "skills/a")] },
    });
    // dir-shaped source: readFile on the dir path is NOT defined (a real fs throws);
    // the representative file is what exists.
    const fs = mockFs({
      "/agents/base/skills/a/SKILL.md": "shipped content",
      "/w/.claude/skills/skill-a/SKILL.md": "OPERATOR EDITED",
    });
    const result = planProjection({
      config, collisions: [], fsOps: fs,
      resolveTargetPath: (cat, id, _cwd, src) => claudeConflictTargetPath(cat, id, "/w", src),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.classification).toBe("hash_conflict");
      expect(result.plan.conflicts).toHaveLength(1);
    }
    const clean = planProjection({
      config, collisions: [],
      fsOps: mockFs({
        "/agents/base/skills/a/SKILL.md": "shipped content",
        "/w/.claude/skills/skill-a/SKILL.md": "shipped content",
      }),
      resolveTargetPath: (cat, id, _cwd, src) => claudeConflictTargetPath(cat, id, "/w", src),
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.plan.entries[0]!.classification).toBe("no_op");
  });
});

describe("P17 — conflicts surface LOUDLY (never a silent overwrite)", () => {
  it("projectionConflictWarnings names the file, the reason, and the resolution path", () => {
    const warnings = projectionConflictWarnings({
      conflicts: [
        {
          category: "skill", effectiveId: "skill-a",
          absolutePath: "/agents/base/skills/a",
          classification: "hash_conflict",
          conflictDetail: { reason: 'skill "skill-a" exists at target with different content' },
        },
      ],
    } as never);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skill-a/);
    expect(warnings[0]).toMatch(/different content/);
    expect(warnings[0]).toMatch(/overwritten/i); // the consequence is stated, not implied
  });

  it("WIRING PIN (the P16 class): the production planProjection call injects the resolver and threads conflict warnings", () => {
    const fsMod = require("node:fs") as typeof import("node:fs");
    const src = fsMod.readFileSync(new URL("../src/domain/rigspec-instantiator.ts", import.meta.url), "utf8");
    const callBlock = /planProjection\(\{[\s\S]{0,600}?\}\);/.exec(src)?.[0] ?? "";
    expect(callBlock, "planProjection call must inject resolveTargetPath").toContain("resolveTargetPath: claudeConflictTargetPath");
    expect(src, "conflict warnings must be threaded to the warnings surface").toContain("projectionConflictWarnings(planResult.plan)");
  });
});
