// User Settings v0 — daemon HTTP route tests.
//
// Pins the load-bearing behaviors of /api/config:
//   - GET /api/config returns all settings keys with source + default
//   - GET /api/config/:key returns one key
//   - POST /api/config/:key sets the value, persists to disk
//   - DELETE /api/config/:key reverts one key to default
//   - POST /api/config/init-workspace creates a repo-ready project workspace
//   - 503 when settingsStore is unavailable
//   - 400 on unknown keys / missing body

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { configRoutes } from "../src/routes/config.js";

function clearEnv(): () => void {
  const keys = [
    "OPENRIG_PORT", "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "OPENRIG_WORKSPACE_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT",
    "OPENRIG_WORKSPACE_PROJECTS_ROOT", "OPENRIG_WORKSPACE_CATALOG_PATH",
    "OPENRIG_CONTEXT_ROOT", "OPENRIG_CONTEXT_PACKS_ROOT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION",
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
    // 18 v0 keys + 2 Phase 4 (advisor/operator) + 5 Phase 5 (feed.subscriptions.*)
    // + 2 V1 pre-release Item 1 (transcripts.lines / transcripts.poll_interval_seconds)
    // + 1 plugin-primitive Phase 3a slice 3.5 (runtime.codex.hooks_enabled)
    // + 1 V0.3.1 slice 05 (workspace.operator_seat_name)
    // + 7 slice 27 (policies.claude_compaction.*)
    // + 3 OPR.0.3.4.9 (snapshots.periodic.*)
    // + 1 OPR.0.4.0.1 (ui.terminal.max_live_terminals)
    // + 2 OPR.0.4.6.MH1 (host.selected / host.name)
    // + 1 OPR.0.4.6.WF5 (workflow.exception_routing)
    // + 1 OPR.0.4.6.02 (terminal.status_bar — the ratified sole v1 terminal key)
    // + 5 OPR.0.4.6.FS-1 W2 (retention.enabled / transitions_days / watchdog_days /
    //   watchdog_keep_per_job / batch_size — the CLI-settable queue-retention knobs;
    //   + retention.usage_samples_days, 51-08 A2)
    // + 2 OPR.0.5.1 W2c (policies.idle_gate_qitem.scan_interval_seconds /
    //   active_wake_interval_seconds)
    // + 2 B6 founder ruling (policies.idle_gate_qitem.auto_register /
    //   opt_in_sessions — the not-default-on gate)
    // + 1 OPR.0.5.3.6 D1 (topology.root — the topology tree root)
    // + 1 OPR.0.5.9.5 Wave B (context.root)
    // + 1 S15 (onboarding.default_pack.enabled)
    // + 1 S04 (queue.pickup_stall_threshold_minutes)
    // + 2 S02 (queue.stuck_sweep_interval_seconds /
    //   stuck_sweep_unclaimed_age_minutes)
    // + 4 S01 (queue.wake_retry_interval_seconds / wake_retry_cap /
    //   wake_unconfirmed_window_minutes / wake_swap_grace_seconds)
    // + 1 OPR.0.5.9.4 (skills.root) → 65 total.
    expect(Object.keys(body.settings).length).toBe(65);
    expect(body.settings["daemon.port"]?.source).toBe("default");
    expect(body.settings["ui.preview.refresh_interval_seconds"]?.value).toBe(3);
    expect(body.settings["ui.preview.max_pins"]?.value).toBe(4);
    expect(body.settings["ui.preview.default_lines"]?.value).toBe(50);
    expect(body.settings["recovery.auto_drive_provider_prompts"]?.value).toBe(false);
    expect(body.settings["recovery.provider_auth_env_allowlist"]?.value).toBe("");
    expect(body.settings["host.selected"]).toMatchObject({ value: "local", source: "default" });
    expect(body.settings["host.name"]).toMatchObject({ value: "localhost", source: "default" });
    expect(body.settings["onboarding.default_pack.enabled"]).toMatchObject({ value: true, source: "default" });
    expect(String(body.settings["workspace.projects_root"]?.value)).toMatch(/projects$/);
    expect(String(body.settings["workspace.catalog_path"]?.value)).toMatch(/workspace\.yaml$/);
    expect(String(body.settings["context.root"]?.value)).toMatch(/context$/);
    expect(body.settings["workspace.field_notes_root"]).toBeUndefined();
    expect(body.settings["workspace.dogfood_evidence_root"]).toBeUndefined();
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

  it("GET /api/config rebases persisted legacy workspace defaults", async () => {
    store.set("workspace.root", "/custom/ws");
    store.set("workspace.slices_root", "/custom/ws/slices");
    store.set("workspace.steering_path", "/custom/ws/steering/STEERING.md");
    const app = buildApp();
    const res = await app.request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: Record<string, { value: unknown; source: string }> };
    expect(body.settings["workspace.slices_root"]).toMatchObject({
      value: "/custom/ws/missions",
      source: "default",
    });
    expect(body.settings["workspace.steering_path"]).toMatchObject({
      value: "/custom/ws/STEERING.md",
      source: "default",
    });
  });

  it("GET /api/config/:key 400s on unknown key", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.bogus");
    expect(res.status).toBe(400);
    const body = await res.json() as { validKeys: string[] };
    expect(body.validKeys).toContain("workspace.root");
  });

  it.each(["GET", "POST", "DELETE"] as const)(
    "%s /api/config/context.packs_root refuses the removed key with its replacement",
    async (method) => {
      const app = buildApp();
      const res = await app.request("/api/config/context.packs_root", {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify({ value: "/legacy" }) : undefined,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ replacement: "context.root" });
    },
  );

  it("GET /api/config refuses a persisted context.packsRoot before projecting settings", async () => {
    writeFileSync(configPath, JSON.stringify({ context: { packsRoot: "/legacy" } }));
    const res = await buildApp().request("/api/config");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("context.root") });
  });

  it("GET /api/config/context.root preserves removed environment-setting guidance", async () => {
    process.env.OPENRIG_CONTEXT_PACKS_ROOT = "/legacy";

    const res = await buildApp().request("/api/config/context.root");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("OPENRIG_CONTEXT_ROOT"),
    });
  });

  it("GET /api/config/context.root preserves removed persisted-setting guidance", async () => {
    writeFileSync(configPath, JSON.stringify({ context: { packsRoot: "/legacy" } }));

    const res = await buildApp().request("/api/config/context.root");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("context.root") });
  });

  it("POST /api/config/:key sets the value and persists to disk", async () => {
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "/custom/slices" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; resolved: { value: string } };
    expect(body.ok).toBe(true);
    expect(body.resolved.value).toBe("/custom/slices");
    // Disk persisted
    expect(JSON.parse(readFileSync(configPath, "utf-8")).workspace.slicesRoot).toBe("/custom/slices");
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

  // Slice 27 BLOCKING-FIX — /api/config POST must reject invalid
  // threshold_percent input. The route catches the error thrown by
  // SettingsStore.set and maps it to 400; the integration test asserts
  // the contract end-to-end so a future drift gets caught at CI.
  describe("POST /api/config/policies.claude_compaction.threshold_percent strict validation", () => {
    const rejectCases = ["0", "101", "-1", "80abc", "80.5", "", " ", "NaN", "Infinity"];

    for (const raw of rejectCases) {
      it(`returns 400 for ${JSON.stringify(raw)}`, async () => {
        const app = buildApp();
        const res = await app.request("/api/config/policies.claude_compaction.threshold_percent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: raw }),
        });
        expect(res.status).toBe(400);
        const body = await res.json() as { error?: string };
        expect(body.error).toMatch(/integer|number|in \[1, 100\]/);
      });
    }

    it("accepts valid integer in range and persists to disk", async () => {
      const app = buildApp();
      const res = await app.request("/api/config/policies.claude_compaction.threshold_percent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value: "60" }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(readFileSync(configPath, "utf-8")).policies.claudeCompaction.thresholdPercent).toBe(60);
    });
  });

  it("DELETE /api/config/:key resets to default", async () => {
    store.set("workspace.slices_root", "/x");
    const app = buildApp();
    const res = await app.request("/api/config/workspace.slices_root", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json() as { resolved: { source: string } };
    expect(body.resolved.source).toBe("default");
  });

  it("POST /api/config/init-workspace creates the canonical six-item workspace", async () => {
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
    expect(body.subdirs.map((s) => s.name)).toEqual(["missions", "exhaust"]);
    expect(body.files.map((file) => file.relPath)).toEqual(["SPEC.md", "project.yaml", "workspace.yaml", ".gitignore"]);
    for (const path of ["SPEC.md", "project.yaml", "workspace.yaml", ".gitignore", "missions", "exhaust"]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
    for (const retired of ["README.md", "STEERING.md", "artifacts", "evidence", "progress", "field-notes", "specs", "dogfood-evidence", "skills", "context", "state"]) {
      expect(existsSync(join(root, retired))).toBe(false);
    }
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

  it("POST /api/config/init-workspace preserves existing files even with force", async () => {
    const root = join(tmpDir, "ws-existing");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SPEC.md"), "operator-owned", "utf-8");
    const app = buildApp();
    const res = await app.request("/api/config/init-workspace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ root, force: true }),
    });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, "SPEC.md"), "utf-8")).toBe("operator-owned");
  });

  it("503 when settingsStore is missing from context", async () => {
    const app = new Hono();
    app.route("/api/config", configRoutes());
    const res = await app.request("/api/config");
    expect(res.status).toBe(503);
  });

  it("project-only initialization does not consult mission-note overrides", async () => {
    const root = join(tmpDir, "project-only-workspace");
    expect(existsSync(root)).toBe(false);
    const original = process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
    process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = join(tmpDir, "does-not-exist.md");
    try {
      const app = buildApp();
      const res = await app.request("/api/config/init-workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root }),
      });
      expect(res.status).toBe(200);
      expect(existsSync(root)).toBe(true);
      expect(existsSync(join(root, "missions", "getting-started"))).toBe(false);
    } finally {
      if (original === undefined) delete process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH;
      else process.env.OPENRIG_MISSION_NOTES_TEMPLATE_PATH = original;
    }
  });
});
