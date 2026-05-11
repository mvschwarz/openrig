// Test suite for plugin-primitive Phase 3a slice 3.1 — agent-manifest support
// for resources.plugins[] + profile.uses.plugins[] AND explicit rejection of
// legacy resources.hooks + profile.uses.hooks per redo-guard-2 verdict
// 2026-05-10 (BLOCKING-CONCERN: silent-drop-not-reject is not adequate
// backward-compat; legacy field must produce clear error so authors update).

import { describe, it, expect } from "vitest";
import { parseAgentSpec, validateAgentSpec, normalizeAgentSpec } from "../src/domain/agent-manifest.js";

describe("AgentSpec plugin support — validator + normalizer", () => {
  // ============================================================
  // Category 1 — REJECT LEGACY HOOKS FIELD (per redo-guard-2 #1)
  // ============================================================

  it("rejects legacy resources.hooks with clear migration error", () => {
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
resources:
  hooks:
    - id: old-hook
      path: hooks/old.yaml
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("resources.hooks") && e.includes("removed"))).toBe(true);
  });

  it("rejects legacy profile.uses.hooks with clear migration error", () => {
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
profiles:
  default:
    uses:
      hooks: [old-hook]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("profiles.default.uses.hooks") && e.includes("removed"))).toBe(true);
  });

  it("legacy hooks rejection error names plugins as the migration target", () => {
    // The error message should point operators at the new field so the migration
    // path is obvious without reading docs.
    const raw = parseAgentSpec(`
name: legacy-rig
version: "0.2"
resources:
  hooks: []
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    const hookErr = result.errors.find((e) => e.includes("resources.hooks"));
    expect(hookErr).toBeDefined();
    expect(hookErr).toMatch(/plugins/);
  });

  // ============================================================
  // Category 2 — ACCEPT/NORMALIZE PLUGIN RESOURCES (per redo-guard-2 #2)
  // ============================================================

  it("accepts resources.plugins with id + source.kind=local + source.path", () => {
    const raw = parseAgentSpec(`
name: pluginned
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);

    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins).toHaveLength(1);
    expect(spec.resources.plugins[0]!.id).toBe("openrig-core");
    expect(spec.resources.plugins[0]!.source.kind).toBe("local");
    expect(spec.resources.plugins[0]!.source.path).toBe("~/.openrig/plugins/openrig-core");
  });

  it("accepts plugin_type field (claude/codex/auto)", () => {
    const raw = parseAgentSpec(`
name: pluginned
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source: { kind: local, path: /abs/plugins/openrig-core }
      plugin_type: auto
    - id: superpowers
      source: { kind: local, path: /abs/plugins/superpowers }
      plugin_type: claude
    - id: codex-special
      source: { kind: local, path: /abs/plugins/codex-special }
      plugin_type: codex
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins[0]!.pluginType).toBe("auto");
    expect(spec.resources.plugins[1]!.pluginType).toBe("claude");
    expect(spec.resources.plugins[2]!.pluginType).toBe("codex");
  });

  it("rejects plugin entry missing id", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ source: { kind: "local", path: "/p" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].id"))).toBe(true);
  });

  it("rejects plugin entry missing source", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p" }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source"))).toBe(true);
  });

  it("rejects plugin entry with unsupported source.kind (only 'local' at v0)", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "git", url: "github:foo/bar" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("source.kind") && e.includes("local"))).toBe(true);
  });

  it("rejects plugin entry with empty source.path", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "local", path: "" } }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins[0].source.path"))).toBe(true);
  });

  it("rejects duplicate plugin ids", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: dup
      source: { kind: local, path: /a }
    - id: dup
      source: { kind: local, path: /b }
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate id") && e.includes("dup"))).toBe(true);
  });

  it("rejects invalid plugin_type value", () => {
    const raw = { name: "test", version: "1.0", resources: { plugins: [{ id: "p", source: { kind: "local", path: "/p" }, plugin_type: "gemini" }] } };
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugin_type"))).toBe(true);
  });

  it("plugin source.path may be absolute (operator-managed plugin location)", () => {
    // Plugins live OUTSIDE the spec dir (vendored at ~/.openrig/plugins/<id>/
    // or operator-installed elsewhere). Unlike skill paths which must be
    // spec-relative for safety, plugin source paths are explicitly absolute.
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: vendored
      source: { kind: local, path: /Users/op/.openrig/plugins/openrig-core }
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
  });

  // ============================================================
  // Category 3 — PROFILE USES.PLUGINS RESOLUTION (per redo-guard-2 #3)
  // ============================================================

  it("profile.uses.plugins references resolve against declared plugin pool", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
resources:
  plugins:
    - id: openrig-core
      source: { kind: local, path: /p/openrig-core }
profiles:
  default:
    uses:
      plugins: [openrig-core]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("unqualified profile.uses.plugins reference to undeclared plugin fails", () => {
    const raw = parseAgentSpec(`
name: test
version: "0.2"
profiles:
  default:
    uses:
      plugins: [missing-plugin]
`);
    const result = validateAgentSpec(raw);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("plugins") && e.includes("missing-plugin"))).toBe(true);
  });

  it("normalize produces empty plugins[] when not declared", () => {
    const raw = parseAgentSpec(`
name: minimal
version: "0.2"
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.resources.plugins).toEqual([]);
  });

  it("normalize produces empty profile.uses.plugins[] when not declared in profile", () => {
    const raw = parseAgentSpec(`
name: minimal-profile
version: "0.2"
profiles:
  default:
    uses:
      skills: []
`);
    expect(validateAgentSpec(raw).valid).toBe(true);
    const spec = normalizeAgentSpec(raw);
    expect(spec.profiles["default"]!.uses.plugins).toEqual([]);
  });
});
