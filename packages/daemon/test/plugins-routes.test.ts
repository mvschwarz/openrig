// Phase 3a slice 3.3 — plugins HTTP routes (TDD red→green).
//
// SC-29 EXCEPTION #8 declared verbatim:
// "Slice 3.3 (UI plugin surface) requires daemon-side plugin-discovery-service
// + 3 HTTP routes (GET /api/plugins, GET /api/plugins/:id, GET /api/plugins/:id/used-by)
// as backing API. No additional state, no SQL migration, no mutation routes.
// Read-only discovery surface aggregating filesystem-scan unions per
// DESIGN.md §5.4. Per IMPL-PRD §3.3 'Code touches' this allocation is explicit;
// documenting in compliance with banked SC-29 verbatim-declaration rule."

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PluginDiscoveryService } from "../src/domain/plugin-discovery-service.js";
import { pluginsRoutes } from "../src/routes/plugins.js";

interface TestEnv {
  root: string;
  service: PluginDiscoveryService;
  openrigPluginsDir: string;
  claudeCacheDir: string;
  codexCacheDir: string;
  specLibraryDir: string;
}

function setup(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "plugins-routes-"));
  const openrigPluginsDir = join(root, "openrig-plugins");
  const claudeCacheDir = join(root, "claude-cache");
  const codexCacheDir = join(root, "codex-cache");
  const specLibraryDir = join(root, "specs");
  mkdirSync(openrigPluginsDir, { recursive: true });
  mkdirSync(claudeCacheDir, { recursive: true });
  mkdirSync(codexCacheDir, { recursive: true });
  mkdirSync(specLibraryDir, { recursive: true });
  const service = new PluginDiscoveryService({
    openrigPluginsDir,
    claudeCacheDir,
    codexCacheDir,
    specLibraryDir,
  });
  return { root, service, openrigPluginsDir, claudeCacheDir, codexCacheDir, specLibraryDir };
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

function createApp(service: PluginDiscoveryService): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("pluginDiscoveryService" as never, service);
    await next();
  });
  app.route("/api/plugins", pluginsRoutes());
  return app;
}

describe("plugins HTTP routes", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    rmSync(env.root, { recursive: true, force: true });
  });

  describe("GET /api/plugins", () => {
    it("returns empty array when no plugins discovered", async () => {
      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("returns aggregated plugin list", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeCodexPluginManifest(join(env.openrigPluginsDir, "openrig-core"), {
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "github", "1.0.0"), {
        name: "github",
        version: "1.0.0",
        description: "claude-cache",
      });

      const res = await createApp(env.service).request("/api/plugins");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; source: string; runtimes: string[] }>;
      expect(body).toHaveLength(2);
      const names = body.map((p) => p.name).sort();
      expect(names).toEqual(["github", "openrig-core"]);
    });

    it("supports runtime filter via query string", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "claude-only"), {
        name: "claude-only",
        version: "1.0.0",
        description: "x",
      });
      writeCodexPluginManifest(join(env.openrigPluginsDir, "codex-only"), {
        name: "codex-only",
        version: "1.0.0",
        description: "x",
      });

      const claudeRes = await createApp(env.service).request("/api/plugins?runtime=claude");
      expect(claudeRes.status).toBe(200);
      const claudeBody = await claudeRes.json() as Array<{ name: string }>;
      expect(claudeBody.map((p) => p.name)).toEqual(["claude-only"]);

      const codexRes = await createApp(env.service).request("/api/plugins?runtime=codex");
      expect(codexRes.status).toBe(200);
      const codexBody = await codexRes.json() as Array<{ name: string }>;
      expect(codexBody.map((p) => p.name)).toEqual(["codex-only"]);
    });

    it("slice 3.3 fix-C — supports rig-cwd discovery via ?cwd=<path> query param", async () => {
      // velocity-qa VM verify failure #3 — DESIGN §5.4 union 4th category
      // (rig-bundled cwd plugin roots). API exposes the per-call cwd scan
      // via ?cwd=<path>; service emits discoveries with rig-cwd source.
      const rigCwd = join(env.root, "rig-cwd-api");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "rig-tool"), {
        name: "rig-tool",
        version: "1.0.0",
        description: "rig-bundled tool",
      });

      // Without ?cwd — no rig-cwd discoveries.
      const baseRes = await createApp(env.service).request("/api/plugins");
      const base = await baseRes.json() as Array<{ source: string }>;
      expect(base.some((p) => p.source === "rig-cwd")).toBe(false);

      // With ?cwd=<path> — rig-tool surfaces.
      const cwdRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(rigCwd)}`,
      );
      const cwdPlugins = await cwdRes.json() as Array<{ name: string; source: string }>;
      const rigCwdSubset = cwdPlugins.filter((p) => p.source === "rig-cwd");
      expect(rigCwdSubset).toHaveLength(1);
      expect(rigCwdSubset[0]?.name).toBe("rig-tool");
    });

    it("slice 3.3 fix-iteration — list ?cwd= + detail roundtrip for rig-cwd plugin (no 404)", async () => {
      // redo-guard-2 BLOCK item 1: /api/plugins?cwd= lists;
      // /api/plugins/<encoded-rig-cwd-id> must 200 not 404. Fix lands in
      // PluginDiscoveryService.getPlugin via self-resolve from id prefix.
      const rigCwd = join(env.root, "rig-cwd-roundtrip");
      const claudeBundleDir = join(rigCwd, ".claude", "plugins");
      mkdirSync(claudeBundleDir, { recursive: true });
      writeClaudePluginManifest(join(claudeBundleDir, "roundtrip-tool"), {
        name: "roundtrip-tool",
        version: "1.0.0",
        description: "roundtrip",
      });

      // Step 1: list with ?cwd= — captures id.
      const listRes = await createApp(env.service).request(
        `/api/plugins?cwd=${encodeURIComponent(rigCwd)}`,
      );
      expect(listRes.status).toBe(200);
      const list = await listRes.json() as Array<{ id: string; source: string }>;
      const rigCwdEntry = list.find((p) => p.source === "rig-cwd");
      expect(rigCwdEntry).toBeDefined();
      const rigCwdId = rigCwdEntry!.id;

      // Step 2: detail call with that id — must 200 (was 404 pre-fix).
      const detailRes = await createApp(env.service).request(
        `/api/plugins/${encodeURIComponent(rigCwdId)}`,
      );
      expect(detailRes.status).toBe(200);
      const detail = await detailRes.json() as { entry: { name: string; source: string } };
      expect(detail.entry.name).toBe("roundtrip-tool");
      expect(detail.entry.source).toBe("rig-cwd");
    });

    it("supports source filter via query string", async () => {
      writeClaudePluginManifest(join(env.openrigPluginsDir, "vended"), {
        name: "vended",
        version: "0.1.0",
        description: "x",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "cached", "1.0.0"), {
        name: "cached",
        version: "1.0.0",
        description: "x",
      });

      const vendoredRes = await createApp(env.service).request("/api/plugins?source=vendored");
      const vendored = await vendoredRes.json() as Array<{ name: string }>;
      expect(vendored.map((p) => p.name)).toEqual(["vended"]);

      const cacheRes = await createApp(env.service).request("/api/plugins?source=claude-cache");
      const cache = await cacheRes.json() as Array<{ name: string }>;
      expect(cache.map((p) => p.name)).toEqual(["cached"]);
    });

    it("returns 503 when service is not provisioned", async () => {
      const app = new Hono();
      app.route("/api/plugins", pluginsRoutes());
      const res = await app.request("/api/plugins");
      expect(res.status).toBe(503);
    });
  });

  describe("GET /api/plugins/:id", () => {
    it("returns 404 for unknown plugin id", async () => {
      const res = await createApp(env.service).request("/api/plugins/nonexistent");
      expect(res.status).toBe(404);
    });

    it("returns plugin detail with manifest + skills + hooks", async () => {
      const corePluginDir = join(env.openrigPluginsDir, "openrig-core");
      writeClaudePluginManifest(corePluginDir, {
        name: "openrig-core",
        version: "0.1.0",
        description: "Canonical OpenRig content",
      });
      mkdirSync(join(corePluginDir, "skills", "openrig-user"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "skills", "openrig-user", "SKILL.md"),
        "---\nname: openrig-user\n---\n",
      );
      mkdirSync(join(corePluginDir, "hooks"), { recursive: true });
      writeFileSync(
        join(corePluginDir, "hooks", "claude.json"),
        JSON.stringify({
          hooks: { SessionStart: [{ type: "command", command: "echo hi" }] },
        }),
      );

      const res = await createApp(env.service).request("/api/plugins/openrig-core");
      expect(res.status).toBe(200);
      const body = await res.json() as {
        entry: { name: string };
        claudeManifest: { name: string };
        skills: Array<{ name: string }>;
        hooks: Array<{ runtime: string; events: string[] }>;
      };
      expect(body.entry.name).toBe("openrig-core");
      expect(body.claudeManifest?.name).toBe("openrig-core");
      expect(body.skills.map((s) => s.name)).toEqual(["openrig-user"]);
      expect(body.hooks).toHaveLength(1);
      expect(body.hooks[0]?.runtime).toBe("claude");
      expect(body.hooks[0]?.events).toContain("SessionStart");
    });
  });

  describe("GET /api/plugins/:id/used-by", () => {
    it("returns empty list when plugin not used by any agent", async () => {
      const res = await createApp(env.service).request("/api/plugins/openrig-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toEqual([]);
    });

    it("returns agent references with profile names", async () => {
      const advisorDir = join(env.specLibraryDir, "advisor");
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
  review:
    uses:
      plugins:
        - openrig-core
        - reviewer-tools
resources:
  plugins:
    - id: openrig-core
      source:
        kind: local
        path: ~/.openrig/plugins/openrig-core
    - id: reviewer-tools
      source:
        kind: local
        path: ~/.openrig/plugins/reviewer-tools
  skills: []
startup:
  files: []
  actions: []
`,
      );

      const res = await createApp(env.service).request("/api/plugins/openrig-core/used-by");
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ agentName: string; profiles: string[] }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.agentName).toBe("advisor-lead");
      expect(body[0]?.profiles.sort()).toEqual(["default", "review"]);
    });
  });

  describe("drift-discriminator regression coverage", () => {
    it("each route shape is observably distinct (per banked feedback_poc_regression_must_discriminate)", async () => {
      // Place 3 plugins in 3 source roots so the list endpoint must aggregate
      // across all 3; verify response distinguishes them.
      writeClaudePluginManifest(join(env.openrigPluginsDir, "vended"), {
        name: "vended", version: "0.1.0", description: "v",
      });
      writeClaudePluginManifest(join(env.claudeCacheDir, "anthropics", "claude-tool", "2.0.0"), {
        name: "claude-tool", version: "2.0.0", description: "c",
      });
      writeCodexPluginManifest(join(env.codexCacheDir, "openai", "codex-tool", "3.0.0"), {
        name: "codex-tool", version: "3.0.0", description: "x",
      });

      const listRes = await createApp(env.service).request("/api/plugins");
      const list = await listRes.json() as Array<{ source: string }>;
      const sources = list.map((p) => p.source).sort();
      expect(sources).toEqual(["claude-cache", "codex-cache", "vendored"]);
    });
  });
});
