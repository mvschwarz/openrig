// Phase 3a slice 3.3 — plugin-discovery-service tests (TDD red→green).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."
//
// Discovery service contract:
//   - listPlugins({ runtimeFilter?, sourceFilter?, agentRefFilter? })
//     → PluginEntry[] union of:
//       * ~/.openrig/plugins/* (vendored)
//       * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/ (claude-cache)
//       * ~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/ (codex-cache)
//       * agent-ref discoveries (plugins referenced inline in agent.yaml resources.plugins[])
//   - getPlugin(id) → PluginManifest with full manifest content + tree summary
//   - findUsedBy(id) → AgentReference[] (which agent.yamls reference this plugin id)
//
// Branch-merge-friendly: this service operates on filesystem reads + raw YAML
// string matching for used-by; doesn't depend on batch 1's PluginResource type
// from plugin-primitive-v0 branch. After convergence into plugin-primitive-v0,
// the service continues to work with the shipped PluginResource types.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";

interface TempDirs {
  root: string;
  openrigPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setupTempDirs(): TempDirs {
  const root = mkdtempSync(join(tmpdir(), "plugin-discovery-test-"));
  const openrigPluginsDir = join(root, "openrig-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs", "agents");
  mkdirSync(openrigPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  return { root, openrigPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
}

function writeClaudePluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

function writeCodexPluginManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".codex-plugin");
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(join(manifestDir, "plugin.json"), JSON.stringify(manifest, null, 2));
}

describe("PluginDiscoveryService", () => {
  let dirs: TempDirs;

  beforeEach(() => {
    dirs = setupTempDirs();
  });

  afterEach(() => {
    rmSync(dirs.root, { recursive: true, force: true });
  });

  describe("listPlugins", () => {
    it("returns empty list when no plugin sources contain plugins", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("discovers a vendored OpenRig plugin (dual-manifest)", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "OpenRig canonical skills and hooks",
      });
      writeCodexPluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "OpenRig canonical skills and hooks",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        runtimes: ["claude", "codex"],
      });
    });

    it("discovers a Claude cache plugin (claude-only manifest)", () => {
      const claudePluginPath = join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0");
      writeClaudePluginManifest(claudePluginPath, {
        name: "github",
        version: "1.0.0",
        description: "GitHub integration",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "github",
        version: "1.0.0",
        source: "claude-cache",
        sourceLabel: "claude-cache:anthropics/github/1.0.0",
        runtimes: ["claude"],
      });
    });

    it("discovers a Codex cache plugin (codex-only manifest)", () => {
      const codexPluginPath = join(dirs.codexCacheDir, "openai", "tools", "0.5.0");
      writeCodexPluginManifest(codexPluginPath, {
        name: "tools",
        version: "0.5.0",
        description: "Codex tools",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0]).toMatchObject({
        name: "tools",
        version: "0.5.0",
        source: "codex-cache",
        sourceLabel: "codex-cache:openai/tools/0.5.0",
        runtimes: ["codex"],
      });
    });

    it("aggregates discoveries across all 3 source roots with distinct source labels", () => {
      // Drift-discriminator regression check per banked feedback_poc_regression_must_discriminate.
      // Three sources × distinct values per source so layer discrimination is
      // observable.
      writeClaudePluginManifest(join(dirs.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(dirs.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });
      writeCodexPluginManifest(join(dirs.codexCacheDir, "openai", "tools", "0.5.0"), {
        name: "tools",
        version: "0.5.0",
        description: "codex-cache",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const plugins = service.listPlugins();
      expect(plugins).toHaveLength(3);
      // Distinct source labels per layer.
      const sources = plugins.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });

    it("ignores directories without plugin manifests", () => {
      mkdirSync(join(dirs.openrigPluginsDir, "not-a-plugin"), { recursive: true });
      writeFileSync(
        join(dirs.openrigPluginsDir, "not-a-plugin", "README.md"),
        "Not a plugin",
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.listPlugins()).toEqual([]);
    });

    it("filters by runtime when requested", () => {
      writeClaudePluginManifest(join(dirs.openrigPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(dirs.openrigPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const claudeOnly = service.listPlugins({ runtimeFilter: "claude" });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0]?.name).toBe("claude-only");
      const codexOnly = service.listPlugins({ runtimeFilter: "codex" });
      expect(codexOnly).toHaveLength(1);
      expect(codexOnly[0]?.name).toBe("codex-only");
    });
  });

  describe("getPlugin", () => {
    it("returns null when plugin not found", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("nonexistent")).toBeNull();
    });

    it("returns full manifest + tree summary for a discovered plugin", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
        author: { name: "OpenRig" },
        skills: "./skills",
        hooks: "./hooks/claude.json",
      });
      // Add a skill folder + hook config so tree summary has content.
      mkdirSync(join(corePluginDir, "skills", "openrig-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "openrig-user", "SKILL.md"),
        "---\nname: openrig-user\ndescription: User skill\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(join(corePluginDir, "hooks", "claude.json"), JSON.stringify({
        hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
      }));

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("openrig-core");
      expect(result).not.toBeNull();
      expect(result?.entry.name).toBe("openrig-core");
      expect(result?.claudeManifest).toMatchObject({
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
      });
      expect(result?.skills).toContainEqual(
        expect.objectContaining({ name: "openrig-user" }),
      );
      expect(result?.hooks).toContainEqual(
        expect.objectContaining({ runtime: "claude" }),
      );
    });
  });

  describe("findUsedBy", () => {
    it("returns empty list when no agent specs reference the plugin", () => {
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.findUsedBy("openrig-core")).toEqual([]);
    });

    it("finds agents whose resources.plugins[] references the plugin id", () => {
      const advisorDir = join(dirs.specLibraryDir, "advisor");
      mkdirSync(advisorDir, { recursive: true });
      writeFileSync(
        join(advisorDir, "agent.yaml"),
        `name: advisor-lead
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - openrig-core
        - superpowers
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
    - id: superpowers
      source:
        kind: local
        path: ~/.claude/plugins/cache/anthropics/superpowers/5.1.0
  skills: []
startup:
  files: []
  actions: []
`,
      );
      const driverDir = join(dirs.specLibraryDir, "driver");
      mkdirSync(driverDir, { recursive: true });
      writeFileSync(
        join(driverDir, "agent.yaml"),
        `name: velocity-driver
version: "1.0"
defaults:
  runtime: claude-code
profiles:
  default:
    uses:
      plugins:
        - openrig-core
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const usedBy = service.findUsedBy("openrig-core");
      expect(usedBy).toHaveLength(2);
      expect(usedBy.map((u) => u.agentName).sort()).toEqual(["advisor-lead", "velocity-driver"]);
      const superpowersUsedBy = service.findUsedBy("superpowers");
      expect(superpowersUsedBy).toHaveLength(1);
      expect(superpowersUsedBy[0]?.agentName).toBe("advisor-lead");
    });

    it("does NOT match plugin ids that appear only in comments or non-resource fields", () => {
      const agentDir = join(dirs.specLibraryDir, "false-positive-test");
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(
        join(agentDir, "agent.yaml"),
        `name: false-positive-test
version: "1.0"
defaults:
  runtime: claude-code
# Note: this agent does NOT use openrig-core (just a comment mention).
profiles:
  default:
    uses:
      plugins: []
resources:
  plugins: []
  skills:
    - id: my-skill
      # related to openrig-core skill set but not using the plugin
      path: ./skills/my-skill.md
startup:
  files: []
  actions: []
`,
      );

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // Comment + skill description mention openrig-core but resources.plugins is empty.
      // The implementation parses YAML and walks resources.plugins[].id — comments
      // and unrelated string positions are ignored.
      expect(service.findUsedBy("openrig-core")).toEqual([]);
    });
  });
});
