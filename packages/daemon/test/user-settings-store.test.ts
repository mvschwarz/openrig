// User Settings v0 — daemon-side SettingsStore tests.
//
// Pins that the daemon's SettingsStore stays in lockstep with the CLI
// ConfigStore: same VALID_KEYS, same env-map, same env > file > default
// resolution, same file format. Drift between the two would mean the
// daemon's UI route surfaces a different value than the CLI.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SettingsStore,
  SETTINGS_VALID_KEYS,
  parseNamedPairs,
} from "../src/domain/user-settings/settings-store.js";

function clearEnv(): () => void {
  const keys = [
    "OPENRIG_PORT", "OPENRIG_HOST", "OPENRIG_DB",
    "OPENRIG_TRANSCRIPTS_ENABLED", "OPENRIG_TRANSCRIPTS_PATH",
    "OPENRIG_TRANSCRIPTS_LINES", "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS",
    "OPENRIG_WORKSPACE_ROOT", "OPENRIG_WORKSPACE_SLICES_ROOT",
    "OPENRIG_WORKSPACE_STEERING_PATH", "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT",
    "OPENRIG_WORKSPACE_SPECS_ROOT", "OPENRIG_DOGFOOD_EVIDENCE_ROOT",
    "OPENRIG_FILES_ALLOWLIST", "OPENRIG_PROGRESS_SCAN_ROOTS",
    "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS",
    "OPENRIG_UI_PREVIEW_MAX_PINS", "OPENRIG_UI_PREVIEW_DEFAULT_LINES",
    "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS",
    "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST",
    "OPENRIG_AGENTS_ADVISOR_SESSION", "OPENRIG_AGENTS_OPERATOR_SESSION",
    "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED", "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS",
    "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED", "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS",
    "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG",
    "RIGGED_PORT", "RIGGED_HOST", "RIGGED_DB",
    "RIGGED_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_PATH",
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

describe("SettingsStore (User Settings v0)", () => {
  let tmpDir: string;
  let configPath: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "settings-store-"));
    configPath = join(tmpDir, "config.json");
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("SETTINGS_VALID_KEYS matches the documented settings key set", () => {
    expect([...SETTINGS_VALID_KEYS]).toEqual([
      "daemon.port", "daemon.host", "db.path",
      "transcripts.enabled", "transcripts.path",
      // V1 pre-release CLI/daemon Item 1 — capture-pane rotation tunables.
      "transcripts.lines", "transcripts.poll_interval_seconds",
      "workspace.root", "workspace.slices_root", "workspace.steering_path",
      "workspace.field_notes_root", "workspace.specs_root",
      "workspace.dogfood_evidence_root",
      "files.allowlist", "progress.scan_roots",
      "ui.preview.refresh_interval_seconds", "ui.preview.max_pins", "ui.preview.default_lines",
      "recovery.auto_drive_provider_prompts",
      "recovery.provider_auth_env_allowlist",
      // V1 attempt-3 Phase 4 — Advisor/Operator placeholders.
      "agents.advisor_session", "agents.operator_session",
      // V1 attempt-3 Phase 5 P5-3 — For You feed subscription toggles.
      "feed.subscriptions.action_required",
      "feed.subscriptions.approvals",
      "feed.subscriptions.shipped",
      "feed.subscriptions.progress",
      "feed.subscriptions.audit_log",
    ]);
  });

  it("resolveAllWithSource returns every key with source + default", () => {
    const store = new SettingsStore(configPath);
    const all = store.resolveAllWithSource();
    for (const key of SETTINGS_VALID_KEYS) {
      expect(all[key]).toBeDefined();
      expect(["env", "file", "default"]).toContain(all[key].source);
    }
  });

  it("env > file > default for daemon.port", () => {
    const store = new SettingsStore(configPath);
    // No file → default
    expect(store.resolveOne("daemon.port").source).toBe("default");
    expect(store.resolveOne("daemon.port").value).toBe(7433);

    // File → file
    store.set("daemon.port", "9999");
    expect(store.resolveOne("daemon.port").value).toBe(9999);
    expect(store.resolveOne("daemon.port").source).toBe("file");

    // Env wins
    process.env["OPENRIG_PORT"] = "8888";
    try {
      expect(store.resolveOne("daemon.port").value).toBe(8888);
      expect(store.resolveOne("daemon.port").source).toBe("env");
    } finally {
      delete process.env["OPENRIG_PORT"];
    }
  });

  it("workspace.root cascades into per-subdir defaults", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/custom/ws");
    const cfg = store.resolveConfig();
    expect(cfg.workspaceRoot).toBe("/custom/ws");
    expect(cfg.workspaceSlicesRoot).toBe("/custom/ws/missions");
    expect(cfg.workspaceSteeringPath).toBe("/custom/ws/STEERING.md");
    expect(cfg.workspaceFieldNotesRoot).toBe("/custom/ws/field-notes");
    expect(cfg.workspaceSpecsRoot).toBe("/custom/ws/specs");
    expect(cfg.workspaceDogfoodEvidenceRoot).toBe("/custom/ws/dogfood-evidence");
    expect(cfg.filesAllowlistRaw).toBe("workspace:/custom/ws");
    expect(cfg.progressScanRootsRaw).toBe("workspace:/custom/ws");
  });

  it("recovery.auto_drive_provider_prompts defaults false and resolves into daemon config", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("recovery.auto_drive_provider_prompts").value).toBe(false);
    store.set("recovery.auto_drive_provider_prompts", "true");
    expect(store.resolveConfig().recoveryAutoDriveProviderPrompts).toBe(true);
  });

  it("recovery.provider_auth_env_allowlist defaults empty and resolves into daemon config", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveOne("recovery.provider_auth_env_allowlist").value).toBe("");
    store.set("recovery.provider_auth_env_allowlist", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");
    expect(store.resolveConfig().recoveryProviderAuthEnvAllowlistRaw).toBe("ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("per-subdir override beats the workspace.root cascade", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/custom/slices");
    const cfg = store.resolveConfig();
    expect(cfg.workspaceSlicesRoot).toBe("/custom/slices");
    // Other subdirs still cascade from workspace.root:
    expect(cfg.workspaceFieldNotesRoot).toBe("/ws/field-notes");
    expect(cfg.workspaceDogfoodEvidenceRoot).toBe("/ws/dogfood-evidence");
  });

  it("workspace.dogfood_evidence_root defaults from workspace.root and supports env override", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.root", "/custom/ws");
    expect(store.resolveConfig().workspaceDogfoodEvidenceRoot).toBe("/custom/ws/dogfood-evidence");

    process.env["OPENRIG_DOGFOOD_EVIDENCE_ROOT"] = "/proof/root";
    try {
      const resolved = store.resolveOne("workspace.dogfood_evidence_root");
      expect(resolved).toMatchObject({ value: "/proof/root", source: "env" });
    } finally {
      delete process.env["OPENRIG_DOGFOOD_EVIDENCE_ROOT"];
    }
  });

  it("treats persisted legacy workspace defaults as default-derived values", () => {
    writeFileSync(configPath, JSON.stringify({
      workspace: {
        root: "/ws",
        slicesRoot: "/ws/slices",
        steeringPath: "/ws/steering/STEERING.md",
      },
    }));
    const store = new SettingsStore(configPath);
    const slices = store.resolveOne("workspace.slices_root");
    const steering = store.resolveOne("workspace.steering_path");
    expect(slices).toMatchObject({ value: "/ws/missions", source: "default" });
    expect(steering).toMatchObject({ value: "/ws/STEERING.md", source: "default" });
  });

  it("UEP env-var graduation: OPENRIG_FILES_ALLOWLIST resolves files.allowlist", () => {
    const store = new SettingsStore(configPath);
    process.env["OPENRIG_FILES_ALLOWLIST"] = "ws:/Users/me";
    try {
      expect(store.resolveOne("files.allowlist").value).toBe("ws:/Users/me");
      expect(store.resolveOne("files.allowlist").source).toBe("env");
    } finally {
      delete process.env["OPENRIG_FILES_ALLOWLIST"];
    }
  });

  it("set + reset round-trips through the file format", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.slices_root", "/custom/slices");
    expect(existsSync(configPath)).toBe(true);
    expect(store.resolveOne("workspace.slices_root").value).toBe("/custom/slices");

    store.reset("workspace.slices_root");
    expect(store.resolveOne("workspace.slices_root").source).toBe("default");

    store.reset();
    expect(existsSync(configPath)).toBe(false);
  });

  it("set rejects unknown keys", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/Unknown config key/);
  });

  it("malformed JSON throws with reset hint", () => {
    writeFileSync(configPath, "{not json");
    const store = new SettingsStore(configPath);
    expect(() => store.resolveAllWithSource()).toThrow(/malformed/i);
  });

  it("file format matches CLI ConfigStore: nested keys persist as JSON", () => {
    const store = new SettingsStore(configPath);
    store.set("workspace.slices_root", "/x");
    store.set("daemon.port", "1234");
    const raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
    expect(raw.workspace.slicesRoot).toBe("/x");
    expect(raw.daemon.port).toBe(1234);
  });
});

describe("parseNamedPairs (daemon copy)", () => {
  it("decodes name:path,name:path pairs", () => {
    expect(parseNamedPairs("ws:/abs/a,docs:/abs/b")).toEqual([
      { name: "ws", path: "/abs/a" },
      { name: "docs", path: "/abs/b" },
    ]);
  });
  it("returns empty for empty/whitespace", () => {
    expect(parseNamedPairs("")).toEqual([]);
    expect(parseNamedPairs("  ")).toEqual([]);
  });
});
