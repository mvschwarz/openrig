// User Settings v0 — daemon-side SettingsStore tests.
//
// Pins that the daemon's SettingsStore stays in lockstep with the CLI
// ConfigStore: same VALID_KEYS, same env-map, same env > file > default
// resolution, same file format. Drift between the two would mean the
// daemon's UI route surfaces a different value than the CLI.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SettingsStore,
  SETTINGS_VALID_KEYS,
  DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT,
  defaultClaudeCompactionExtraInstructionFilePath,
  ensureDefaultClaudeCompactionFiles,
  parseNamedPairs,
} from "../src/domain/user-settings/settings-store.js";

const DEFAULT_COMPACT_INSTRUCTION_FRAGMENT = "Create a concise continuity summary";
const DEFAULT_RESTORE_INSTRUCTION_FRAGMENT = "Load/read the claude-compaction-restore skill";
const DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX = "compaction/post-compact-extra.md";

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
    "OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED",
    // Slice 27 — Claude auto-compaction policy env-map.
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH",
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
      // V0.3.1 slice 05 kernel-rig-as-default — operator seat name read
      // by mission-control read layer + 2 UI sites; default
      // `operator-${USER}@kernel`.
      "workspace.operator_seat_name",
      // V1 attempt-3 Phase 5 P5-3 — For You feed subscription toggles.
      "feed.subscriptions.action_required",
      "feed.subscriptions.approvals",
      "feed.subscriptions.shipped",
      "feed.subscriptions.progress",
      "feed.subscriptions.audit_log",
      // plugin-primitive Phase 3a slice 3.5 — Codex feature flag.
      "runtime.codex.hooks_enabled",
      // Slice 27 — Claude auto-compaction policy. SC-29 EXCEPTION #10.
      "policies.claude_compaction.enabled",
      "policies.claude_compaction.threshold_percent",
      "policies.claude_compaction.compact_instruction",
      "policies.claude_compaction.message_inline",
      "policies.claude_compaction.message_file_path",
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

  // Slice 27 — Claude auto-compaction policy resolution.
  it("HG-5 + HG-10: resolveClaudeCompactionPolicy returns defaults when no file/env present (opt-in default-off)", () => {
    const store = new SettingsStore(configPath);
    const policy = store.resolveClaudeCompactionPolicy();
    expect(policy.enabled).toBe(false);
    expect(policy.thresholdPercent).toBe(80);
    expect(policy.compactInstruction).toContain(DEFAULT_COMPACT_INSTRUCTION_FRAGMENT);
    expect(policy.messageInline).toContain(DEFAULT_RESTORE_INSTRUCTION_FRAGMENT);
    expect(policy.messageFilePath).toMatch(/^\//);
    expect(policy.messageFilePath.endsWith(DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX)).toBe(true);
  });

  it("HG-10: resolveClaudeCompactionPolicy picks up direct config.json edits without daemon restart (single resolve call rereads file)", () => {
    const store = new SettingsStore(configPath);
    expect(store.resolveClaudeCompactionPolicy().enabled).toBe(false);

    writeFileSync(
      configPath,
      JSON.stringify({
        policies: {
          claudeCompaction: {
            enabled: true,
            thresholdPercent: 65,
            compactInstruction: "preserve current task and decisions",
            messageInline: "carry-forward note",
            messageFilePath: "",
          },
        },
      }),
    );

    const updated = store.resolveClaudeCompactionPolicy();
    expect(updated.enabled).toBe(true);
    expect(updated.thresholdPercent).toBe(65);
    expect(updated.compactInstruction).toBe("preserve current task and decisions");
    expect(updated.messageInline).toBe("carry-forward note");
    expect(updated.messageFilePath.endsWith(DEFAULT_EXTRA_INSTRUCTION_FILE_SUFFIX)).toBe(true);
  });

  it("Slice 27: ensureDefaultClaudeCompactionFiles creates the user-owned extra instruction placeholder without overwriting edits", () => {
    const openrigHome = join(tmpDir, ".openrig-placeholder");
    const filePath = ensureDefaultClaudeCompactionFiles(openrigHome);
    expect(filePath).toBe(defaultClaudeCompactionExtraInstructionFilePath(openrigHome));
    expect(existsSync(filePath)).toBe(true);
    expect(require("node:fs").readFileSync(filePath, "utf-8")).toBe(
      DEFAULT_CLAUDE_COMPACTION_EXTRA_INSTRUCTION_FILE_CONTENT,
    );

    writeFileSync(filePath, "operator edits\n", "utf-8");
    ensureDefaultClaudeCompactionFiles(openrigHome);
    expect(require("node:fs").readFileSync(filePath, "utf-8")).toBe("operator edits\n");
  });

  it("HG-1: set/get round-trip for each policy key persists to disk and reads back", () => {
    const store = new SettingsStore(configPath);

    store.set("policies.claude_compaction.enabled", "true");
    store.set("policies.claude_compaction.threshold_percent", "60");
    store.set("policies.claude_compaction.compact_instruction", "summarize with decisions first");
    store.set("policies.claude_compaction.message_inline", "rehydrate the agent");
    store.set("policies.claude_compaction.message_file_path", "/tmp/msg.txt");

    const raw = JSON.parse(require("node:fs").readFileSync(configPath, "utf-8"));
    expect(raw.policies.claudeCompaction.enabled).toBe(true);
    expect(raw.policies.claudeCompaction.thresholdPercent).toBe(60);
    expect(raw.policies.claudeCompaction.compactInstruction).toBe("summarize with decisions first");
    expect(raw.policies.claudeCompaction.messageInline).toBe("rehydrate the agent");
    expect(raw.policies.claudeCompaction.messageFilePath).toBe("/tmp/msg.txt");

    expect(store.resolveOne("policies.claude_compaction.enabled").value).toBe(true);
    expect(store.resolveOne("policies.claude_compaction.threshold_percent").value).toBe(60);
    expect(store.resolveOne("policies.claude_compaction.compact_instruction").value).toBe("summarize with decisions first");
    expect(store.resolveOne("policies.claude_compaction.message_inline").value).toBe("rehydrate the agent");
    expect(store.resolveOne("policies.claude_compaction.message_file_path").value).toBe("/tmp/msg.txt");
  });

  it("HG-1: invalid threshold rejected by coerceValue (non-numeric raises)", () => {
    const store = new SettingsStore(configPath);
    expect(() => store.set("policies.claude_compaction.threshold_percent", "not-a-number")).toThrow(/expected a number/);
  });

  // Slice 27 BLOCKING-FIX-2 — env + file source resolution must also
  // reject invalid threshold values. Without this, an env override
  // (OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT=80abc) or a
  // hand-edited config.json poisons the trigger contract because the
  // write-path validators are bypassed entirely.
  //
  // Behavior on bad input: drop the override, warn to stderr, fall
  // through to file/default (env layer) or default (file layer).
  describe("BLOCKING-FIX-2: env + file source validation", () => {
    const reject = ["0", "101", "-1", "80abc", "80.5", "NaN", "Infinity"];

    for (const raw of reject) {
      it(`env=${JSON.stringify(raw)} → resolveOne returns default 80 (env rejected, NOT coerced)`, () => {
        process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = raw;
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const store = new SettingsStore(configPath);
          const resolved = store.resolveOne("policies.claude_compaction.threshold_percent");
          // Default value (80), source falls through to "default"
          expect(resolved.value).toBe(80);
          expect(resolved.source).toBe("default");
          // Warning emitted (operator visibility)
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
          delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        }
      });
    }

    it("discriminator: env=80abc (rejected → source=default, warning emitted) vs env=80 (accepted → source=env, no warning)", () => {
      // Case A: rejected env
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80abc";
      let stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const a = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
        expect(a.value).toBe(80);
        expect(a.source).toBe("default");
        const warnCount = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"))
          .length;
        expect(warnCount).toBe(1);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }

      // Case B: accepted env — same RESOLVED VALUE (80) but DIFFERENT
      // observable: source=env, no warning. This is the discriminator.
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80";
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const b = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
        expect(b.value).toBe(80);
        expect(b.source).toBe("env");
        const warnCount = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("rejected"))
          .length;
        expect(warnCount).toBe(0);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }
    });

    const fileReject: Array<{ name: string; written: unknown }> = [
      { name: "0", written: 0 },
      { name: "101", written: 101 },
      { name: "-1", written: -1 },
      { name: "80.5 (non-integer JSON number)", written: 80.5 },
      { name: '"80abc" (JSON string)', written: "80abc" },
    ];

    for (const { name, written } of fileReject) {
      it(`file thresholdPercent=${name} → resolveOne returns default 80 + warning`, () => {
        writeFileSync(configPath, JSON.stringify({
          policies: { claudeCompaction: { thresholdPercent: written } },
        }));
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const resolved = new SettingsStore(configPath).resolveOne("policies.claude_compaction.threshold_percent");
          expect(resolved.value).toBe(80);
          expect(resolved.source).toBe("default");
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("file value for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
        }
      });
    }
  });

  // Slice 27 BLOCKING-FIX — strict accept/reject matrix for
  // threshold_percent. Per banked feedback_static_gates_mirror_runtime_validators,
  // the runtime validator is the source of truth; this test invokes the
  // same `set()` path the daemon's /api/config POST handler uses so a
  // future drift gets caught at CI.
  describe("HG-1 strict threshold validation matrix", () => {
    const cases = {
      accept: ["1", "2", "50", "80", "99", "100"],
      reject: [
        { raw: "0", reason: /must be in \[1, 100\]/ },
        { raw: "101", reason: /must be in \[1, 100\]/ },
        { raw: "-1", reason: /must be in \[1, 100\]/ },
        { raw: "80abc", reason: /expected an integer/ },
        { raw: "abc80", reason: /expected a number|expected an integer/ },
        { raw: "80.5", reason: /expected an integer/ },
        { raw: "", reason: /expected a number|expected an integer/ },
        { raw: " ", reason: /expected a number|expected an integer/ },
        { raw: "NaN", reason: /expected a number|expected an integer/ },
        { raw: "Infinity", reason: /expected a number|expected an integer/ },
      ],
    };

    for (const value of cases.accept) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        const store = new SettingsStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", value)).not.toThrow();
        expect(store.resolveOne("policies.claude_compaction.threshold_percent").value).toBe(Number(value));
      });
    }

    for (const { raw, reason } of cases.reject) {
      it(`rejects ${JSON.stringify(raw)}`, () => {
        const store = new SettingsStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", raw)).toThrow(reason);
      });
    }
  });

  void existsSync;
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
