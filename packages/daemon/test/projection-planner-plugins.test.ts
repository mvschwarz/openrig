// Test suite for plugin-primitive Phase 3a slice 3.1 — projection planner
// plugin path semantics. Per velocity-guard cadence boundary (b)
// 2026-05-10: tests for ~, absolute, relative path resolution before
// any further impl on this surface.
//
// Plugin source.path can take three shapes (per DESIGN.md §5.2 example):
//   1. absolute system path  e.g.  /Users/op/.openrig/plugins/openrig-core
//   2. tilde-home-prefixed   e.g.  ~/.openrig/plugins/openrig-core
//   3. relative to spec dir  e.g.  ./plugins/openrig-core
//
// Each must resolve to a single concrete absolute entry.absolutePath the
// adapter can use to copy the plugin tree. Tilde expansion is required
// because vendored plugins live at ~/.openrig/plugins/<id>/ by convention
// and operators write that literal path in their agent.yaml resources.

import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as nodePath from "node:path";
import { planProjection, type ProjectionInput, type ProjectionFsOps } from "../src/domain/projection-planner.js";
import type { ResolvedNodeConfig, QualifiedResource, ResolvedResources } from "../src/domain/profile-resolver.js";

function emptyResources(): ResolvedResources {
  return { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] };
}

function makePluginQR(id: string, path: string, sourcePath = "/specs/test-agent"): QualifiedResource {
  return {
    effectiveId: id,
    sourceSpec: "test-agent",
    sourcePath,
    resource: { id, source: { kind: "local", path } } as QualifiedResource["resource"],
  };
}

function makeConfig(plugins: QualifiedResource[]): ResolvedNodeConfig {
  return {
    runtime: "claude-code",
    model: undefined,
    cwd: "/runtime/agent-cwd",
    restorePolicy: "resume_if_possible",
    lifecycle: undefined,
    selectedResources: { ...emptyResources(), plugins },
    startup: { files: [], actions: [] },
    resolvedSpecName: "test-agent",
    resolvedSpecVersion: "1.0",
    resolvedSpecHash: "deadbeef",
  };
}

function mockFs(): ProjectionFsOps {
  return {
    readFile: () => { throw new Error("not used"); },
    exists: () => false,
  };
}

describe("Projection planner — plugin path semantics", () => {
  // ============================================================
  // Absolute paths — preserved exactly
  // ============================================================

  it("absolute plugin source.path yields entry.absolutePath = same absolute path", () => {
    const config = makeConfig([makePluginQR("openrig-core", "/Users/op/.openrig/plugins/openrig-core")]);
    const input: ProjectionInput = { config, collisions: [], fsOps: mockFs() };
    const result = planProjection(input);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const pluginEntry = result.plan.entries.find((e) => e.category === "plugin");
      expect(pluginEntry).toBeDefined();
      expect(pluginEntry!.absolutePath).toBe("/Users/op/.openrig/plugins/openrig-core");
      expect(pluginEntry!.resourcePath).toBe("/Users/op/.openrig/plugins/openrig-core");
    }
  });

  it("absolute path is NOT re-resolved against spec sourcePath", () => {
    const config = makeConfig([makePluginQR("p", "/abs/plugin", "/some/other/spec/dir")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toBe("/abs/plugin");
      // Specifically should NOT be /some/other/spec/dir/abs/plugin
      expect(entry.absolutePath).not.toMatch(/^\/some\/other\/spec\/dir/);
    }
  });

  // ============================================================
  // Tilde-home-prefixed paths — expanded to $HOME
  // ============================================================

  it("tilde-prefixed plugin source.path expands to $HOME absolute path", () => {
    const config = makeConfig([makePluginQR("openrig-core", "~/.openrig/plugins/openrig-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries[0]!;
      const expectedAbs = nodePath.join(os.homedir(), ".openrig/plugins/openrig-core");
      expect(entry.absolutePath).toBe(expectedAbs);
      expect(entry.absolutePath).not.toMatch(/^~/);
    }
  });

  it("bare tilde plugin source.path expands to $HOME exactly", () => {
    const config = makeConfig([makePluginQR("home-plugin", "~")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe(os.homedir());
    }
  });

  it("tilde-with-username (~user/...) is preserved as-is (NOT expanded — operator path)", () => {
    // Per Node's nodePath behavior: only ~/ (with slash) expands; ~user/ doesn't.
    // We follow the same convention to avoid surprising operators with implicit lookups.
    const config = makeConfig([makePluginQR("p", "~bob/plugins/p")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // ~bob is treated as a relative path component → joined with sourcePath
      const entry = result.plan.entries[0]!;
      expect(entry.absolutePath).toContain("~bob");
    }
  });

  // ============================================================
  // Relative paths — resolved against spec sourcePath
  // ============================================================

  it("relative plugin source.path resolves against qr.sourcePath", () => {
    const config = makeConfig([makePluginQR("local-plugin", "plugins/local-plugin", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local-plugin");
    }
  });

  it("./-prefixed relative plugin source.path resolves correctly", () => {
    const config = makeConfig([makePluginQR("local", "./plugins/local", "/specs/my-agent")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.plan.entries[0]!.absolutePath).toBe("/specs/my-agent/plugins/local");
    }
  });

  // ============================================================
  // Drift discriminator — distinct values per layer (per banked
  // feedback_poc_regression_must_discriminate)
  // ============================================================

  it("three plugins with three different path shapes produce distinct absolutePaths (drift discriminator)", () => {
    const config = makeConfig([
      makePluginQR("abs-plugin", "/abs/plugins/abs-plugin", "/specs/agent-X"),
      makePluginQR("home-plugin", "~/.openrig/plugins/home-plugin", "/specs/agent-X"),
      makePluginQR("rel-plugin", "plugins/rel-plugin", "/specs/agent-X"),
    ]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byId = new Map(result.plan.entries.map((e) => [e.effectiveId, e.absolutePath]));
      expect(byId.get("abs-plugin")).toBe("/abs/plugins/abs-plugin");
      expect(byId.get("home-plugin")).toBe(nodePath.join(os.homedir(), ".openrig/plugins/home-plugin"));
      expect(byId.get("rel-plugin")).toBe("/specs/agent-X/plugins/rel-plugin");
      // All three distinct
      expect(new Set(Array.from(byId.values())).size).toBe(3);
    }
  });

  // ============================================================
  // Plugin entry shape preserved through planner
  // ============================================================

  it("plugin entry preserves category 'plugin' and effectiveId through planner", () => {
    const config = makeConfig([makePluginQR("openrig-core", "/p/openrig-core")]);
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const entry = result.plan.entries.find((e) => e.category === "plugin");
      expect(entry).toBeDefined();
      expect(entry!.effectiveId).toBe("openrig-core");
      expect(entry!.sourceSpec).toBe("test-agent");
    }
  });

  it("entries are deterministically sorted: plugin (p) sorts before skill (s)", () => {
    const config: ResolvedNodeConfig = {
      ...makeConfig([makePluginQR("z-plugin", "/p/z")]),
      selectedResources: {
        ...emptyResources(),
        skills: [{
          effectiveId: "a-skill",
          sourceSpec: "test-agent",
          sourcePath: "/specs/test-agent",
          resource: { id: "a-skill", path: "skills/a" } as QualifiedResource["resource"],
        }],
        plugins: [makePluginQR("z-plugin", "/p/z")],
      },
    };
    const result = planProjection({ config, collisions: [], fsOps: mockFs() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // p < s alphabetically; plugin entry comes first
      expect(result.plan.entries[0]!.category).toBe("plugin");
      expect(result.plan.entries[1]!.category).toBe("skill");
    }
  });
});
