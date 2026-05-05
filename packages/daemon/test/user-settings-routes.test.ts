// User Settings v0 — daemon HTTP route tests.
//
// Pins the load-bearing behaviors of /api/config:
//   - GET /api/config returns all 12 keys with source + default
//   - GET /api/config/:key returns one key
//   - POST /api/config/:key sets the value, persists to disk
//   - DELETE /api/config/:key reverts one key to default
//   - POST /api/config/init-workspace creates 5 subdirs + READMEs
//   - 503 when settingsStore is unavailable
//   - 400 on unknown keys / missing body

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { configRoutes } from "../src/routes/config.js";

function clearEnv(): () => void {
  const keys = [
    "OPENRIG_PORT", "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "OPENRIG_WORKSPACE_ROOT",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keys) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  };
}

describe("config routes (User Settings v0)", () => {
  let tmpDir: string;
  let configPath: string;
  let store: SettingsStore;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-routes-"));
    configPath = join(tmpDir, "config.json");
    store = new SettingsStore(configPath);
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  function buildApp(): Hono {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("settingsStore" as never, store);
      await next();
    });
    app.route("/api/config", configRoutes());
    return app;
  }

  it("GET /api/config returns all settings keys with source + default", async () => {
    const app = buildApp();
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: Record<string, { value: unknown; source: string }> };
    expect(Object.keys(body.settings).length).toBe(16);
    expect(body.settings["daemon.port"]?.source).toBe("default");
    expect(body.settings["ui.preview.refresh_interval_seconds"]?.value).toBe(3);
    expect(body.settings["ui.preview.max_pins"]?.value).toBe(4);
    expect(body.settings["ui.preview.default_lines"]?.value).toBe(50);
    expect(body.settings["recovery.auto_drive_provider_prompts"]?.value).toBe(false);
  });

  it("GET /api/config/:key returns the resolved value", async () => {
    store.set("workspace.root", "/custom/ws");
    const app = buildApp();
    const res = await app.request("/api/config/workspace.root");
    expect(res.status).toBe(200);
    const body = await res.json() as { value: string; source: string };
    expect(body.value).toBe("/custom/ws");
    expect(body.source).toBe("file");
  });

  it("GET /api/config/:key 400s on unknown key", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.bogus");
    expect(res.status).toBe(400);
    const body = await res.json() as { validKeys: string[] };
    expect(body.validKeys).toContain("workspace.root");
  });

  it("POST /api/config/:key sets the value and persists to disk", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "/founder/slices" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; resolved: { value: string } };
    expect(body.ok).toBe(true);
    expect(body.resolved.value).toBe("/founder/slices");
    // Disk persisted
    expect(JSON.parse(readFileSync(configPath, "utf-8")).workspace.slicesRoot).toBe("/founder/slices");
  });

  it("POST /api/config/:key 400s without value field", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("DELETE /api/config/:key resets to default", async () => {
    store.set("workspace.slices_root", "/x");
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { resolved: { source: string } };
    expect(body.resolved.source).toBe("default");
  });

  it("POST /api/config/init-workspace creates 5 subdirs + READMEs", async () => {
    const root = join(tmpDir, "workspace");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { root: string; subdirs: Array<{ name: string }>; files: Array<{ relPath: string }> };
    expect(body.root).toBe(root);
    expect(body.subdirs.map((s) => s.name)).toEqual([
      "slices", "steering", "progress", "field-notes", "specs",
    ]);
    expect(existsSync(join(root, "slices", "README.md"))).toBe(true);
    expect(existsSync(join(root, "steering", "STEERING.md"))).toBe(true);
  });

  it("POST /api/config/init-workspace --dry-run does not write", async () => {
    const root = join(tmpDir, "ws-dry");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, dryRun: true }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(root)).toBe(false);
  });

  it("503 when settingsStore is missing from context", async () => {
    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    expect(res.status).toBe(503);
  });
});
