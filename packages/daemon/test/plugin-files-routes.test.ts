// Slice 28 Checkpoint C-1 — plugin docs-browser routes + skillCount enrichment.
//
// SC-29 EXCEPTION #11 declared verbatim in packages/daemon/src/routes/plugins.ts
// header. This test file exercises the two new endpoints + the additive
// PluginEntry.skillCount field.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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
  const root = mkdtempSync(join(tmpdir(), "plugin-files-routes-"));
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

function writeClaudeManifest(pluginDir: string, manifest: Record<string, unknown>): void {
  const manifestDir = join(pluginDir, ".claude-plugin");
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

function makePluginWithFolders(pluginsDir: string, name: string, opts: { skills?: string[]; readme?: string; hooks?: boolean } = {}): string {
  const pluginDir = join(pluginsDir, name);
  writeClaudeManifest(pluginDir, { name, version: "1.0.0", description: `${name} test plugin` });
  if (opts.readme !== undefined) {
    writeFileSync(join(pluginDir, "README.md"), opts.readme);
  }
  if (opts.skills) {
    const skillsDir = join(pluginDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    for (const skillName of opts.skills) {
      const skillDir = join(skillsDir, skillName);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"), `# ${skillName}\nSkill content.`);
    }
  }
  if (opts.hooks) {
    const hooksDir = join(pluginDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(join(hooksDir, "claude.json"), JSON.stringify({ hooks: {} }));
  }
  return pluginDir;
}

describe("PluginEntry.skillCount enrichment (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("populates skillCount = 0 when plugin has no skills/ folder", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "skinny");
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const skinny = body.find((p) => p.id === "skinny");
    expect(skinny).toBeDefined();
    expect(skinny!.skillCount).toBe(0);
  });

  it("populates skillCount = N when plugin ships N skill folders", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", {
      skills: ["openrig-user", "openrig-architect", "queue-handoff"],
    });
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const core = body.find((p) => p.id === "openrig-core");
    expect(core).toBeDefined();
    expect(core!.skillCount).toBe(3);
  });

  it("populates skillCount on PluginDetail.entry too (detail endpoint parity)", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha", "beta"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core");
    const body = (await res.json()) as { entry: { skillCount: number } };
    expect(body.entry.skillCount).toBe(2);
  });

  it("skillCount counts only subdirectories under skills/ (ignores stray files)", async () => {
    const pluginDir = makePluginWithFolders(env.openrigPluginsDir, "core-with-stray", { skills: ["a", "b"] });
    // Drop a stray file inside skills/ — must NOT count.
    writeFileSync(join(pluginDir, "skills", "README.md"), "stray file");
    const res = await createApp(env.service).request("/api/plugins");
    const body = (await res.json()) as Array<{ id: string; skillCount: number }>;
    const core = body.find((p) => p.id === "core-with-stray");
    expect(core!.skillCount).toBe(2);
  });
});

describe("GET /api/plugins/:id/files/list (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("lists files + dirs at the plugin root (path='')", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", {
      skills: ["alpha"],
      readme: "# OpenRig Core\nplugin docs",
      hooks: true,
    });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pluginId: string; path: string; entries: Array<{ name: string; type: string }> };
    expect(body.pluginId).toBe("openrig-core");
    expect(body.path).toBe("");
    const names = body.entries.map((e) => e.name);
    // Dirs first (sorted by name), then files. Plugin root contains:
    // .claude-plugin/, hooks/, skills/, README.md.
    expect(names).toContain(".claude-plugin");
    expect(names).toContain("hooks");
    expect(names).toContain("skills");
    expect(names).toContain("README.md");
    // Verify dir-before-file ordering.
    const readmeIdx = names.indexOf("README.md");
    const skillsIdx = names.indexOf("skills");
    expect(skillsIdx).toBeLessThan(readmeIdx);
  });

  it("lists nested directory contents (path='skills')", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha", "beta"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=skills");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string; type: string }> };
    const names = body.entries.map((e) => e.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(body.entries.every((e) => e.type === "dir")).toBe(true);
  });

  it("returns 404 when plugin id unknown", async () => {
    const res = await createApp(env.service).request("/api/plugins/missing/files/list?path=");
    expect(res.status).toBe(404);
  });

  it("rejects '..' escape attempt with 400 path_escape", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=..%2Fsomewhere");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });

  it("rejects absolute path with 400 path_invalid", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=%2Fetc");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_invalid");
  });

  it("rejects symlink escape (realpath outside plugin folder)", async () => {
    const pluginDir = makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    // Create a symlink inside the plugin pointing OUTSIDE.
    const escapeTarget = join(env.root, "outside-target");
    mkdirSync(escapeTarget, { recursive: true });
    writeFileSync(join(escapeTarget, "secret.txt"), "out-of-bounds");
    symlinkSync(escapeTarget, join(pluginDir, "escape-link"));
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=escape-link");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("GET /api/plugins/:id/files/read (slice 28)", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("reads README.md at plugin root", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { readme: "# Plugin docs body" });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=README.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pluginId: string;
      path: string;
      content: string;
      contentHash: string;
      size: number;
      truncated: boolean;
    };
    expect(body.pluginId).toBe("openrig-core");
    expect(body.path).toBe("README.md");
    expect(body.content).toContain("Plugin docs body");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.truncated).toBe(false);
  });

  it("reads a nested skill SKILL.md file", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["openrig-user"] });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=skills%2Fopenrig-user%2FSKILL.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain("# openrig-user");
  });

  it("returns 400 path_required when path query missing", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_required");
  });

  it("returns 404 plugin-id unknown", async () => {
    const res = await createApp(env.service).request("/api/plugins/missing/files/read?path=README.md");
    expect(res.status).toBe(404);
  });

  it("returns 404 stat_failed when file does not exist under plugin", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=nonexistent.md");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("stat_failed");
  });

  it("rejects '..' escape attempt with 400 path_escape", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core");
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=..%2Fsomewhere.md");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("path_escape");
  });
});

describe("Route-order discipline (slice 28): /files/list + /files/read mounted BEFORE bare /:id", () => {
  let env: TestEnv;
  beforeEach(() => { env = setup(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("/api/plugins/openrig-core/files/list does NOT get caught by /:id catchall (404 vs detail)", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { skills: ["alpha"] });
    // /:id catchall would treat 'openrig-core' as the id + ignore the
    // remainder. /files/list mounted earlier intercepts the sub-path
    // BEFORE that catchall. Discriminator: response shape includes
    // `entries` (list) not `entry` + `skills` (detail).
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/list?path=");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries?: unknown; entry?: unknown };
    expect(body.entries).toBeDefined();
    expect(body.entry).toBeUndefined();
  });

  it("/api/plugins/openrig-core/files/read does NOT get caught by /:id catchall", async () => {
    makePluginWithFolders(env.openrigPluginsDir, "openrig-core", { readme: "doc" });
    const res = await createApp(env.service).request("/api/plugins/openrig-core/files/read?path=README.md");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content?: unknown; entry?: unknown };
    expect(body.content).toBeDefined();
    expect(body.entry).toBeUndefined();
  });
});
