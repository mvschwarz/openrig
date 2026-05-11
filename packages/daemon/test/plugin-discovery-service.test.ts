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

    it("slice 3.3 fix-C — scans rig-bundled cwd plugin roots when cwdScanRoots provided", () => {
      // velocity-qa VM verify failure #3 — DESIGN §5.4 union-of-sources
      // must include rig-bundled <cwd>/.claude/plugins/* and
      // <cwd>/.codex/plugins/* (the projection target from IMPL-PRD §1.2).
      // Implementation: PluginDiscoveryService accepts optional
      // cwdScanRoots (constructor + per-call); each scanned cwd contributes
      // discoveries with `rig-cwd:` source label.
      const rigCwd = join(dirs.root, "rig-cwd-1");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      const codexBundleDir = join(rigCwd, ".codex", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      mkdirSync(codexBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "Rig-bundled tool",
      });
      writeCodexPluginManifest(join(codexBundleDir, "rig-codex-tool"), {
        name: "rig-codex-tool",
        version: "1.0.0",
        description: "Rig-bundled codex tool",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
        cwdScanRoots: [rigCwd],
      });
      const plugins = service.listPlugins();
      // Two plugins: one claude-side, one codex-side; both labeled rig-cwd.
      const cwdPlugins = plugins.filter((p) => p.source === "rig-cwd");
      expect(cwdPlugins).toHaveLength(2);
      const names = cwdPlugins.map((p) => p.name).sort();
      expect(names).toEqual(["rig-codex-tool", "rig-tool"]);
      // Source labels embed the rig cwd tail for disambiguation;
      // each plugin's label contains its name (order-independent).
      const labels = cwdPlugins.map((p) => p.sourceLabel);
      expect(labels.some((l) => /^rig-cwd:.*rig-tool$/.test(l))).toBe(true);
      expect(labels.some((l) => /^rig-cwd:.*rig-codex-tool$/.test(l))).toBe(true);
    });

    it("slice 3.3 fix-C — per-call cwdScanRoots overrides constructor option", () => {
      // Allows the API layer to pass ?cwd=<path> dynamically without
      // mutating the service singleton.
      const rigCwd = join(dirs.root, "rig-cwd-dyn");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "ephemeral-tool"), {
        name: "ephemeral-tool",
        version: "0.1.0",
        description: "dynamic",
      });

      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      // No cwds at construction.
      expect(service.listPlugins().filter((p) => p.source === "rig-cwd")).toEqual([]);
      // Per-call cwd surfaces the bundled plugin.
      const withCwd = service.listPlugins({ cwdScanRoots: [rigCwd] });
      expect(withCwd.filter((p) => p.source === "rig-cwd")).toHaveLength(1);
      expect(withCwd.find((p) => p.name === "ephemeral-tool")).toBeDefined();
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

    it("returns MCP server summaries from manifest mcpServers field (slice 3.3 fix-A)", () => {
      // velocity-qa VM verify failure #1: PluginViewer needs an MCP section
      // per DESIGN §5.7 + IMPL-PRD §3.2. Manifest's mcpServers field is
      // an object keyed by server-name → server-config. Discovery returns
      // one PluginMcpServerSummary per key (best-effort; we surface name +
      // declared command/transport metadata if present).
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-mcp",
        version: "0.1.0",
        description: "MCP-bearing plugin",
        mcpServers: {
          "github-mcp": { command: "node", args: ["server.js"], transport: "stdio" },
          "linear-mcp": { command: "linear-mcp", transport: "http" },
        },
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const result = service.getPlugin("openrig-mcp");
      expect(result).not.toBeNull();
      expect(result?.mcpServers).toHaveLength(2);
      const serverNames = result?.mcpServers.map((s) => s.name).sort();
      expect(serverNames).toEqual(["github-mcp", "linear-mcp"]);
      expect(result?.mcpServers.find((s) => s.name === "github-mcp")?.runtime).toBe("claude");
    });

    it("returns empty mcpServers when manifest has no mcpServers field", () => {
      const corePluginDir = join(dirs.openrigPluginsDir, "openrig-no-mcp");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-no-mcp",
        version: "0.1.0",
        description: "no mcp",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("openrig-no-mcp")?.mcpServers).toEqual([]);
    });

    it("slice 3.3 fix-iteration — getPlugin self-resolves rig-cwd: IDs (claude side) without external cwd state", () => {
      // redo-guard-2 BLOCK item 1: /api/plugins?cwd=... lists rig-cwd
      // plugins but /api/plugins/:id detail call 404s because listPlugins()
      // without cwdScanRoots doesn't re-scan the cwd, so getPlugin can't
      // find the entry by id. Fix: parse the cwd out of the rig-cwd: id
      // prefix, re-scan that cwd, resolve the entry. ID format:
      //   rig-cwd:<cwd>/.claude/plugins/<plugin>
      //   rig-cwd:<cwd>/.codex/plugins/<plugin>
      const rigCwd = join(dirs.root, "rig-cwd-self-resolve");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "rig-bundled tool",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [rigCwd] });
      const rigToolEntry = listed.find((p) => p.source === "rig-cwd");
      expect(rigToolEntry).toBeDefined();
      const rigToolId = rigToolEntry!.id;
      // Call getPlugin with that id directly (no cwd opts) — must resolve.
      const detail = service.getPlugin(rigToolId);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("rig-tool");
      expect(detail?.entry.source).toBe("rig-cwd");
    });

    it("slice 3.3 fix-iteration — getPlugin self-resolves rig-cwd: codex IDs too", () => {
      const rigCwd = join(dirs.root, "rig-cwd-self-resolve-codex");
      const codexBundleDir = join(rigCwd, ".codex", "plugins");
      mkdirSync(codexBundleDir, { recursive: true });
      writeCodexPluginManifest(join(codexBundleDir, "codex-tool"), {
        name: "codex-tool",
        version: "2.0.0",
        description: "rig-bundled codex tool",
      });
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      const listed = service.listPlugins({ cwdScanRoots: [rigCwd] });
      const codexToolEntry = listed.find((p) => p.name === "codex-tool");
      expect(codexToolEntry).toBeDefined();
      const detail = service.getPlugin(codexToolEntry!.id);
      expect(detail).not.toBeNull();
      expect(detail?.entry.name).toBe("codex-tool");
    });

    it("slice 3.3 fix-iteration — getPlugin returns null for malformed rig-cwd: ids", () => {
      // Negative: garbled prefix or unresolvable cwd → null (not throw).
      const service = new PluginDiscoveryService({
        openrigPluginsDir: dirs.openrigPluginsDir,
        claudeCacheDir: dirs.claudeCacheDir,
        codexCacheDir: dirs.codexCacheDir,
        specLibraryDir: dirs.specLibraryDir,
      });
      expect(service.getPlugin("rig-cwd:notapath")).toBeNull();
      expect(service.getPlugin("rig-cwd:/nonexistent/.claude/plugins/x")).toBeNull();
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
