// User Settings v0 — extended ConfigStore + init-workspace tests.
//
// Pins the load-bearing behaviors of the v0 extension:
//   - new keys parse + validate; legacy 5 keys' behavior preserved
//   - per-subdir override resolution (workspace.root / per-subdir overrides / default)
//   - env > file > default precedence for new keys
//   - UEP env-var graduation: OPENRIG_FILES_ALLOWLIST + OPENRIG_PROGRESS_SCAN_ROOTS still work
//   - reset(key) clears one key; bare reset deletes the file
//   - parseNamedPairs decodes the named-pair format
//   - init-workspace creates mission-aware workspace files; idempotent

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigStore,
  VALID_KEYS,
  parseNamedPairs,
  deriveWorkspaceDefault,
} from "../src/config-store.js";
import { configCommand } from "../src/commands/config.js";
import { initWorkspaceCommand, runInitWorkspace } from "../src/commands/config-init-workspace.js";

// P6/D12-residue: config-store captures DEFAULT_WORKSPACE_ROOT at MODULE-LOAD from
// OPENRIG_HOME, so a beforeEach set is too late (module-load-env-capture). Point
// OPENRIG_HOME at a fresh temp BEFORE the import graph loads (vi.hoisted), never the
// seat's real home and never a fall-through to ~/.openrig (foreign on-box state).
const HOISTED_HOME: string = vi.hoisted(() => {
  const os = require("node:os");
  const fs = require("node:fs");
  const path = require("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-store-home-")) as string;
  process.env["OPENRIG_HOME"] = home;
  return home;
});

function clearEnv(): () => void {
  const keysToClear = [
    // P6/D12-residue: snapshot+clear the HOME vars too so a per-test tmp home can be
    // set (beforeEach) and restored. Leaving OPENRIG_HOME as the seat's value leaked
    // its custom home into default-path resolution; UNSETTING it would fall through
    // to the REAL ~/.openrig (foreign on-box state) — so tests set a fresh tmp home.
    "OPENRIG_HOME", "RIGGED_HOME",
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
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_ENABLED",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_PRE_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_COMPACT_INSTRUCTION",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_INLINE",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_MESSAGE_FILE_PATH",
    "OPENRIG_POLICIES_CLAUDE_COMPACTION_POST_RESTORE_AUDIT_INSTRUCTION",
    "OPENRIG_POLICIES_IDLE_GATE_QITEM_SCAN_INTERVAL_SECONDS",
    "OPENRIG_POLICIES_IDLE_GATE_QITEM_ACTIVE_WAKE_INTERVAL_SECONDS",
    "RIGGED_PORT", "RIGGED_HOST", "RIGGED_DB",
    "RIGGED_TRANSCRIPTS_ENABLED", "RIGGED_TRANSCRIPTS_PATH",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of keysToClear) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return () => {
    for (const k of keysToClear) {
      if (saved[k] !== undefined) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  };
}

describe("ConfigStore — extended namespaces (User Settings v0)", () => {
  let tmpDir: string;
  let configPath: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "config-store-ext-"));
    configPath = join(tmpDir, "config.json");
    restoreEnv = clearEnv();
    // Keep OPENRIG_HOME on the module-load temp (clearEnv cleared it); runtime home
    // reads stay hermetic and consistent with the import-captured default.
    process.env["OPENRIG_HOME"] = HOISTED_HOME;
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("VALID_KEYS includes legacy, user-settings, ui.preview, recovery, agents, feed, and transcript-rotation keys", () => {
    const expected = [
      "daemon.port", "daemon.host",
      // OPR.0.4.6.MH1 FR-1/FR-4 — host-selection pointer + own-host name.
      "host.selected",
      "host.name",
      // OPR.0.4.6.WF5 FR-2 — the host-level maturity-dial default.
      "workflow.exception_routing",
      "db.path",
      "transcripts.enabled", "transcripts.path",
      // V1 pre-release CLI/daemon Item 1 — capture-pane rotation tunables.
      "transcripts.lines", "transcripts.poll_interval_seconds",
      "workspace.root", "workspace.slices_root", "workspace.steering_path",
      "workspace.field_notes_root", "workspace.specs_root",
      "workspace.dogfood_evidence_root",
      // OPR.0.5.3.6 D1 — the topology tree root (instance at its top).
      "topology.root",
      "context.packs_root",
      "onboarding.default_pack.enabled",
      "files.allowlist", "progress.scan_roots",
      "ui.preview.refresh_interval_seconds", "ui.preview.max_pins", "ui.preview.default_lines",
      "recovery.auto_drive_provider_prompts",
      "recovery.provider_auth_env_allowlist",
      // V1 attempt-3 Phase 4 — Advisor/Operator placeholders.
      "agents.advisor_session", "agents.operator_session",
      // V0.3.1 slice 05 kernel-rig-as-default — operator seat name
      // read by daemon mission-control + UI; default
      // `operator-${USER}@kernel` derived in resolve().
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
      "policies.claude_compaction.pre_compact_instruction",
      "policies.claude_compaction.compact_instruction",
      "policies.claude_compaction.message_inline",
      "policies.claude_compaction.message_file_path",
      "policies.claude_compaction.post_restore_audit_instruction",
      // OPR.0.5.1 51-06 W2c — tunable watchdog auto-registration cadence.
      "policies.idle_gate_qitem.scan_interval_seconds",
      "policies.idle_gate_qitem.active_wake_interval_seconds",
      // B6 founder ruling — auto-registration is not default-on.
      "policies.idle_gate_qitem.auto_register",
      "policies.idle_gate_qitem.opt_in_sessions",
      "snapshots.periodic.enabled",
      "snapshots.periodic.interval_seconds",
      "snapshots.periodic.retention_keep",
      // OPR.0.4.6.02 S1 — inner-tmux status-bar launch default (static bool).
      "terminal.status_bar",
      // OPR.0.4.6.FS-1 W2 — queue-retention maintenance knobs.
      "retention.enabled",
      "retention.transitions_days",
      "retention.watchdog_days",
      "retention.watchdog_keep_per_job",
      "retention.batch_size",
      "queue.pickup_stall_threshold_minutes",
      // S02 — standing-stuck-sweep cadence + unclaimed-obligation age.
      "queue.stuck_sweep_interval_seconds",
      "queue.stuck_sweep_unclaimed_age_minutes",
      // S01 — wake-or-escalate ladder knobs.
      "queue.wake_retry_interval_seconds",
      "queue.wake_retry_cap",
      "queue.wake_unconfirmed_window_minutes",
      "queue.wake_swap_grace_seconds",
    ];
    expect([...VALID_KEYS]).toEqual(expected);
  });

  it("W2c idle-gate-qitem cadence defaults to scan=60 and active-wake=900; B6 gate defaults off/empty", () => {
    const config = new ConfigStore(configPath).resolve();
    const idleGate = (config.policies as typeof config.policies & {
      idleGateQitem?: { scanIntervalSeconds: number; activeWakeIntervalSeconds: number; autoRegister: string; optInSessions: string };
    }).idleGateQitem;
    expect(idleGate).toEqual({
      scanIntervalSeconds: 60,
      activeWakeIntervalSeconds: 900,
      autoRegister: "off",
      optInSessions: "",
    });
  });

  it("S04 founder default exposes a 3-minute pickup stall threshold", () => {
    const setting = new ConfigStore(configPath).resolveWithSource(
      "queue.pickup_stall_threshold_minutes" as never,
    );
    expect(setting).toMatchObject({ value: 3, source: "default", defaultValue: 3 });
  });

  it("S01 wake ladder exposes retry cadence, cap, unconfirmed window, and swap grace defaults", () => {
    const store = new ConfigStore(configPath);
    expect(store.resolveWithSource("queue.wake_retry_interval_seconds" as never)).toMatchObject({
      value: 300,
      source: "default",
      defaultValue: 300,
    });
    expect(store.resolveWithSource("queue.wake_retry_cap" as never)).toMatchObject({
      value: 3,
      source: "default",
      defaultValue: 3,
    });
    expect(store.resolveWithSource("queue.wake_unconfirmed_window_minutes" as never)).toMatchObject({
      value: 30,
      source: "default",
      defaultValue: 30,
    });
    expect(store.resolveWithSource("queue.wake_swap_grace_seconds" as never)).toMatchObject({
      value: 180,
      source: "default",
      defaultValue: 180,
    });
  });

  it("S02 standing stuck sweep exposes its cadence and unclaimed-age defaults", () => {
    const store = new ConfigStore(configPath);
    expect(store.resolveWithSource("queue.stuck_sweep_interval_seconds" as never)).toMatchObject({
      value: 300,
      source: "default",
      defaultValue: 300,
    });
    expect(store.resolveWithSource("queue.stuck_sweep_unclaimed_age_minutes" as never)).toMatchObject({
      value: 60,
      source: "default",
      defaultValue: 60,
    });
  });

  it("queue integer settings reject partial and fractional strings", () => {
    const store = new ConfigStore(configPath);
    for (const key of [
      "queue.pickup_stall_threshold_minutes",
      "queue.stuck_sweep_interval_seconds",
      "queue.stuck_sweep_unclaimed_age_minutes",
    ]) {
      for (const raw of ["3junk", "60.5"]) {
        expect(() => store.set(key, raw), `${key} must reject ${raw}`)
          .toThrow(/positive integer/i);
      }
    }
  });

  it("W2c idle-gate-qitem cadence resolves env over file", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("policies.idle_gate_qitem.scan_interval_seconds", "120")).not.toThrow();
    expect(() => store.set("policies.idle_gate_qitem.active_wake_interval_seconds", "1800")).not.toThrow();
    expect(store.resolveWithSource("policies.idle_gate_qitem.scan_interval_seconds"))
      .toMatchObject({ value: 120, source: "file" });
    expect(store.resolveWithSource("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .toMatchObject({ value: 1800, source: "file" });

    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_SCAN_INTERVAL_SECONDS = "30";
    process.env.OPENRIG_POLICIES_IDLE_GATE_QITEM_ACTIVE_WAKE_INTERVAL_SECONDS = "450";
    expect(store.resolveWithSource("policies.idle_gate_qitem.scan_interval_seconds"))
      .toMatchObject({ value: 30, source: "env" });
    expect(store.resolveWithSource("policies.idle_gate_qitem.active_wake_interval_seconds"))
      .toMatchObject({ value: 450, source: "env" });
  });

  it("W2c idle-gate-qitem cadence rejects zero, negative, fractional, and partial numbers", () => {
    const store = new ConfigStore(configPath);
    for (const key of [
      "policies.idle_gate_qitem.scan_interval_seconds",
      "policies.idle_gate_qitem.active_wake_interval_seconds",
    ]) {
      for (const raw of ["0", "-1", "1.5", "60abc"]) {
        expect(() => store.set(key, raw), `${key} must reject ${raw}`)
          .toThrow(/positive integer/i);
      }
    }
  });

  // OPR.0.3.4.9 — CLI config resolve shape + malformed write rejection.
  it("resolve().snapshots.periodic returns defaults", () => {
    const store = new ConfigStore(configPath);
    const config = store.resolve();
    expect(config.snapshots.periodic.enabled).toBe(true);
    expect(config.snapshots.periodic.intervalSeconds).toBe(300);
    expect(config.snapshots.periodic.retentionKeep).toBe(10);
  });

  it("resolve().snapshots.periodic respects typed file writes", () => {
    const store = new ConfigStore(configPath);
    store.set("snapshots.periodic.enabled", "false");
    store.set("snapshots.periodic.interval_seconds", "120");
    store.set("snapshots.periodic.retention_keep", "2");
    const config = store.resolve();
    expect(config.snapshots.periodic.enabled).toBe(false);
    expect(config.snapshots.periodic.intervalSeconds).toBe(120);
    expect(config.snapshots.periodic.retentionKeep).toBe(2);
  });

  it("rejects malformed snapshots.periodic.interval_seconds (60abc, 60.5)", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("snapshots.periodic.interval_seconds", "60abc")).toThrow(/expected an integer/);
    expect(() => store.set("snapshots.periodic.interval_seconds", "60.5")).toThrow(/expected an integer/);
  });

  it("rejects malformed snapshots.periodic.retention_keep (1abc, 1.5)", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("snapshots.periodic.retention_keep", "1abc")).toThrow(/expected an integer/);
    expect(() => store.set("snapshots.periodic.retention_keep", "1.5")).toThrow(/expected an integer/);
  });

  it("rejects out-of-range snapshots.periodic.interval_seconds=30 and retention_keep=0", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("snapshots.periodic.interval_seconds", "30")).toThrow(/must be >= 60/);
    expect(() => store.set("snapshots.periodic.retention_keep", "0")).toThrow(/must be >= 1/);
  });

  it("workspace.operator_seat_name roundtrip — default derives operator-${USER}@kernel; set → resolve reflects override", () => {
    const store = new ConfigStore(configPath);
    const before = store.resolve();
    // Default cascade derives from OS username at resolve() time.
    expect(before.workspace.operatorSeatName).toMatch(/^operator-.+@kernel$/);

    store.set("workspace.operator_seat_name", "operator-test@kernel");
    const after = store.resolve();
    expect(after.workspace.operatorSeatName).toBe("operator-test@kernel");

    store.reset("workspace.operator_seat_name");
    const reset = store.resolve();
    expect(reset.workspace.operatorSeatName).toMatch(/^operator-.+@kernel$/);
  });

  it("workspace.operator_seat_name env override beats file-stored value", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.operator_seat_name", "operator-file@kernel");
    process.env.OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME = "operator-env@kernel";
    try {
      const resolved = store.resolve();
      expect(resolved.workspace.operatorSeatName).toBe("operator-env@kernel");
    } finally {
      delete process.env.OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME;
    }
  });

  it("transcripts.lines + transcripts.poll_interval_seconds roundtrip — set → resolve reflects file-stored values for daemon launch projection", () => {
    const store = new ConfigStore(configPath);
    // Defaults BEFORE set.
    const before = store.resolve();
    expect(before.transcripts.lines).toBe(1000);
    expect(before.transcripts.pollIntervalSeconds).toBe(2);

    store.set("transcripts.lines", "500");
    store.set("transcripts.poll_interval_seconds", "5");

    const after = store.resolve();
    expect(after.transcripts.lines).toBe(500);
    expect(after.transcripts.pollIntervalSeconds).toBe(5);
  });

  it("legacy 5-key behavior preserved: get/set/reset still work", () => {
    const store = new ConfigStore(configPath);
    store.set("daemon.port", "9999");
    expect(store.get("daemon.port")).toBe(9999);
    store.set("transcripts.enabled", "false");
    expect(store.get("transcripts.enabled")).toBe(false);
    store.reset("daemon.port");
    expect(store.get("daemon.port")).toBe(7433);
  });

  it("workspace.root default is <OPENRIG_HOME>/workspace; per-subdir defaults derive from it", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.resolve();
    expect(cfg.workspace.root).toBe(join(HOISTED_HOME, "workspace"));
    expect(cfg.workspace.slicesRoot).toBe(join(cfg.workspace.root, "missions"));
    expect(cfg.workspace.steeringPath).toBe(join(cfg.workspace.root, "STEERING.md"));
    expect(cfg.workspace.fieldNotesRoot).toBe(join(cfg.workspace.root, "field-notes"));
    expect(cfg.workspace.specsRoot).toBe(join(cfg.workspace.root, "specs"));
    expect(cfg.workspace.dogfoodEvidenceRoot).toBe(join(cfg.workspace.root, "dogfood-evidence"));
    expect(cfg.files.allowlist).toBe(`workspace:${cfg.workspace.root}`);
    expect(cfg.progress.scanRoots).toBe(`workspace:${cfg.workspace.root}`);
  });

  it("setting workspace.root cascades into per-subdir defaults", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/custom/ws");
    const cfg = store.resolve();
    expect(cfg.workspace.root).toBe("/custom/ws");
    expect(cfg.workspace.slicesRoot).toBe("/custom/ws/missions");
    expect(cfg.workspace.steeringPath).toBe("/custom/ws/STEERING.md");
    expect(cfg.workspace.dogfoodEvidenceRoot).toBe("/custom/ws/dogfood-evidence");
    expect(cfg.files.allowlist).toBe("workspace:/custom/ws");
    expect(cfg.progress.scanRoots).toBe("workspace:/custom/ws");
  });

  it("treats persisted legacy workspace defaults as default-derived values", () => {
    writeFileSync(configPath, JSON.stringify({
      workspace: {
        root: "/custom/ws",
        slicesRoot: "/custom/ws/slices",
        steeringPath: "/custom/ws/steering/STEERING.md",
      },
    }));
    const store = new ConfigStore(configPath);
    const slices = store.resolveWithSource("workspace.slices_root");
    const steering = store.resolveWithSource("workspace.steering_path");
    expect(slices).toMatchObject({ value: "/custom/ws/missions", source: "default" });
    expect(steering).toMatchObject({ value: "/custom/ws/STEERING.md", source: "default" });
  });

  it("per-subdir override beats workspace.root cascade", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/custom/slices");
    const cfg = store.resolve();
    // workspace.root cascade applies to OTHER subdirs:
    expect(cfg.workspace.fieldNotesRoot).toBe("/ws/field-notes");
    expect(cfg.workspace.dogfoodEvidenceRoot).toBe("/ws/dogfood-evidence");
    // per-subdir override wins:
    expect(cfg.workspace.slicesRoot).toBe("/custom/slices");
  });

  it("env > file > default for new keys", () => {
    const store = new ConfigStore(configPath);
    // No file → default
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("default");

    // File set → file source
    store.set("workspace.slices_root", "/from/file");
    expect(store.resolveWithSource("workspace.slices_root").value).toBe("/from/file");
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("file");

    // Env set → env source
    process.env["OPENRIG_WORKSPACE_SLICES_ROOT"] = "/from/env";
    try {
      const r = store.resolveWithSource("workspace.slices_root");
      expect(r.value).toBe("/from/env");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_WORKSPACE_SLICES_ROOT"];
    }
  });

  it("UEP env-var graduation: OPENRIG_FILES_ALLOWLIST is the env override for files.allowlist", () => {
    const store = new ConfigStore(configPath);
    process.env["OPENRIG_FILES_ALLOWLIST"] = "ws:/Users/me,docs:/var/docs";
    try {
      const r = store.resolveWithSource("files.allowlist");
      expect(r.value).toBe("ws:/Users/me,docs:/var/docs");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_FILES_ALLOWLIST"];
    }
  });

  it("UEP env-var graduation: OPENRIG_PROGRESS_SCAN_ROOTS is the env override for progress.scan_roots", () => {
    const store = new ConfigStore(configPath);
    process.env["OPENRIG_PROGRESS_SCAN_ROOTS"] = "main:/code/main";
    try {
      const r = store.resolveWithSource("progress.scan_roots");
      expect(r.value).toBe("main:/code/main");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_PROGRESS_SCAN_ROOTS"];
    }
  });

  it("dogfood evidence root defaults under workspace.root and supports env override", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/custom/ws");
    expect(store.resolve().workspace.dogfoodEvidenceRoot).toBe("/custom/ws/dogfood-evidence");

    process.env["OPENRIG_DOGFOOD_EVIDENCE_ROOT"] = "/proof/root";
    try {
      const r = store.resolveWithSource("workspace.dogfood_evidence_root");
      expect(r.value).toBe("/proof/root");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_DOGFOOD_EVIDENCE_ROOT"];
    }
  });

  it("set rejects unknown keys with hint listing valid keys", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/Unknown config key/);
    expect(() => store.set("workspace.bogus", "x")).toThrow(/workspace\.root/);
  });

  it("get rejects unknown keys", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.get("nope.doesnt.exist")).toThrow(/Unknown config key/);
  });

  it("reset(key) clears just one key; reset() deletes whole file", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/ws");
    store.set("workspace.slices_root", "/ws/slices-custom");
    store.reset("workspace.slices_root");
    expect(store.resolveWithSource("workspace.slices_root").source).toBe("default");
    expect(store.resolveWithSource("workspace.root").source).toBe("file");

    store.reset();
    expect(existsSync(configPath)).toBe(false);
  });

  it("resolveAllWithSource returns every valid key with source + default", () => {
    const store = new ConfigStore(configPath);
    const all = store.resolveAllWithSource();
    for (const key of VALID_KEYS) {
      expect(all[key]).toBeDefined();
      expect(all[key].source).toBeDefined();
    }
  });

  it("default onboarding pack is on and can be disabled", () => {
    const store = new ConfigStore(configPath);
    expect(store.resolveWithSource("onboarding.default_pack.enabled"))
      .toMatchObject({ value: true, source: "default", defaultValue: true });
    expect(store.resolve().onboarding.defaultPack.enabled).toBe(true);

    store.set("onboarding.default_pack.enabled", "false");
    expect(store.resolveWithSource("onboarding.default_pack.enabled"))
      .toMatchObject({ value: false, source: "file", defaultValue: true });
    expect(store.resolve().onboarding.defaultPack.enabled).toBe(false);
  });

  it("malformed config.json throws with reset hint (preserves legacy behavior)", () => {
    writeFileSync(configPath, "{not-json");
    const store = new ConfigStore(configPath);
    expect(() => store.resolve()).toThrow(/malformed/i);
    expect(() => store.resolve()).toThrow(/reset/i);
  });

  // --- Preview Terminal v0 (PL-018) keys ---
  it("ui.preview.refresh_interval_seconds defaults to 3", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.refresh_interval_seconds")).toBe(3);
  });

  it("ui.preview.max_pins defaults to 4", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.max_pins")).toBe(4);
  });

  it("ui.preview.default_lines defaults to 50", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("ui.preview.default_lines")).toBe(50);
  });

  it("ui.preview.* keys coerce numeric values from set", () => {
    const store = new ConfigStore(configPath);
    store.set("ui.preview.refresh_interval_seconds", "5");
    store.set("ui.preview.max_pins", "2");
    store.set("ui.preview.default_lines", "100");
    expect(store.get("ui.preview.refresh_interval_seconds")).toBe(5);
    expect(store.get("ui.preview.max_pins")).toBe(2);
    expect(store.get("ui.preview.default_lines")).toBe(100);
  });

  it("ui.preview.* keys reject non-numeric values", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("ui.preview.refresh_interval_seconds", "soon")).toThrow(/expected a number/);
  });

  it("OPENRIG_UI_PREVIEW_* env vars override file values", () => {
    const store = new ConfigStore(configPath);
    store.set("ui.preview.refresh_interval_seconds", "5");
    process.env["OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS"] = "10";
    try {
      const r = store.resolveWithSource("ui.preview.refresh_interval_seconds");
      expect(r.value).toBe(10);
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS"];
    }
  });

  it("recovery provider auth env allowlist defaults empty and supports env override", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("recovery.provider_auth_env_allowlist")).toBe("");
    store.set("recovery.provider_auth_env_allowlist", "ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");
    expect(store.resolve().recovery.providerAuthEnvAllowlist).toBe("ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN");

    process.env["OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST"] = "OPENAI_API_KEY";
    try {
      const r = store.resolveWithSource("recovery.provider_auth_env_allowlist");
      expect(r.value).toBe("OPENAI_API_KEY");
      expect(r.source).toBe("env");
    } finally {
      delete process.env["OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST"];
    }
  });

  it("RiggedConfig.ui.preview shape exposed", () => {
    const store = new ConfigStore(configPath);
    const cfg = store.resolve();
    expect(cfg.ui.preview.refreshIntervalSeconds).toBe(3);
    expect(cfg.ui.preview.maxPins).toBe(4);
    expect(cfg.ui.preview.defaultLines).toBe(50);
  });

  it("recovery.auto_drive_provider_prompts defaults false and coerces booleans", () => {
    const store = new ConfigStore(configPath);
    expect(store.get("recovery.auto_drive_provider_prompts")).toBe(false);
    store.set("recovery.auto_drive_provider_prompts", "true");
    expect(store.get("recovery.auto_drive_provider_prompts")).toBe(true);
    expect(store.resolve().recovery.autoDriveProviderPrompts).toBe(true);
  });

  // Slice 27 BLOCKING-FIX-2 — env override + file value validation.
  // Bypass-prevention at the RESOLVE path: an env override like
  // OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT=80abc previously
  // parseInt-coerced to 80 and shipped through resolveOne as a "valid"
  // env-sourced value. With BLOCKING-FIX-2 the env resolution validates;
  // bad env drops the override (falls to file/default) and warns on stderr.
  describe("BLOCKING-FIX-2: env + file source validation", () => {
    const reject = ["0", "101", "-1", "80abc", "80.5", "NaN", "Infinity"];

    for (const raw of reject) {
      it(`env=${JSON.stringify(raw)} → resolve returns default 80; warning emitted`, () => {
        process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = raw;
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const store = new ConfigStore(configPath);
          const resolved = store.resolve();
          expect(resolved.policies.claudeCompaction.thresholdPercent).toBe(80);
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
          delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
        }
      });
    }

    it("discriminator: env=80abc (rejected, source falls to default, warning) vs env=80 (accepted, source=env, no warning)", () => {
      // Case A: rejected → source=default, warning emitted
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80abc";
      let stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const a = new ConfigStore(configPath).resolveWithSource("policies.claude_compaction.threshold_percent");
        expect(a.value).toBe(80);
        expect(a.source).toBe("default");
        const warns = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("env override for policies.claude_compaction.threshold_percent rejected"));
        expect(warns.length).toBe(1);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }

      // Case B: accepted → SAME numeric value (80) but source=env, NO warning
      process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"] = "80";
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const b = new ConfigStore(configPath).resolveWithSource("policies.claude_compaction.threshold_percent");
        expect(b.value).toBe(80);
        expect(b.source).toBe("env");
        const warns = stderrSpy.mock.calls
          .map((c) => String(c[0]))
          .filter((c) => c.includes("rejected"));
        expect(warns.length).toBe(0);
      } finally {
        stderrSpy.mockRestore();
        delete process.env["OPENRIG_POLICIES_CLAUDE_COMPACTION_THRESHOLD_PERCENT"];
      }
    });

    const fileReject: Array<{ name: string; written: unknown }> = [
      { name: "0", written: 0 },
      { name: "101", written: 101 },
      { name: "-1", written: -1 },
      { name: "80.5 (JSON non-integer)", written: 80.5 },
      { name: '"80abc" (JSON string)', written: "80abc" },
    ];

    for (const { name, written } of fileReject) {
      it(`file thresholdPercent=${name} → resolve returns default 80; warning emitted`, () => {
        writeFileSync(configPath, JSON.stringify({
          policies: { claudeCompaction: { thresholdPercent: written } },
        }));
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        try {
          const resolved = new ConfigStore(configPath).resolve();
          expect(resolved.policies.claudeCompaction.thresholdPercent).toBe(80);
          const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
          expect(calls.some((c) => c.includes("file value for policies.claude_compaction.threshold_percent rejected"))).toBe(true);
        } finally {
          stderrSpy.mockRestore();
        }
      });
    }
  });

  // Slice 27 BLOCKING-FIX — strict accept/reject matrix for
  // policies.claude_compaction.threshold_percent. The contract is
  // integer in [1, 100]. parseInt's permissive coercion would otherwise
  // accept "80abc" → 80, "80.5" → 80, and even 0 / 101 / -1 which would
  // break the trigger's safety contract (0 = compact every tick).
  describe("policies.claude_compaction.threshold_percent strict validation matrix", () => {
    const accept = ["1", "2", "50", "80", "99", "100"];
    const reject: Array<{ raw: string; reason: RegExp }> = [
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
    ];

    for (const value of accept) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        const store = new ConfigStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", value)).not.toThrow();
        expect(store.get("policies.claude_compaction.threshold_percent")).toBe(Number(value));
      });
    }

    for (const { raw, reason } of reject) {
      it(`rejects ${JSON.stringify(raw)}`, () => {
        const store = new ConfigStore(configPath);
        expect(() => store.set("policies.claude_compaction.threshold_percent", raw)).toThrow(reason);
      });
    }
  });
});

describe("parseNamedPairs", () => {
  it("returns empty array for empty/whitespace input", () => {
    expect(parseNamedPairs("")).toEqual([]);
    expect(parseNamedPairs("   ")).toEqual([]);
  });

  it("splits comma-separated name:path pairs", () => {
    const out = parseNamedPairs("ws:/abs/path,docs:/var/docs");
    expect(out).toEqual([
      { name: "ws", path: "/abs/path" },
      { name: "docs", path: "/var/docs" },
    ]);
  });

  it("skips entries without a colon", () => {
    expect(parseNamedPairs("just-name,ws:/path")).toEqual([{ name: "ws", path: "/path" }]);
  });

  it("trims whitespace around each pair + name + path", () => {
    expect(parseNamedPairs(" ws : /abs/path , docs:/var/docs ")).toEqual([
      { name: "ws", path: "/abs/path" },
      { name: "docs", path: "/var/docs" },
    ]);
  });

  it("dedupes by name (last wins)", () => {
    expect(parseNamedPairs("ws:/old,ws:/new")).toEqual([{ name: "ws", path: "/new" }]);
  });
});

describe("deriveWorkspaceDefault", () => {
  it("returns canonical subpaths under workspace root", () => {
    expect(deriveWorkspaceDefault("workspace.slices_root", "/ws")).toBe("/ws/missions");
    expect(deriveWorkspaceDefault("workspace.steering_path", "/ws")).toBe("/ws/STEERING.md");
    expect(deriveWorkspaceDefault("workspace.field_notes_root", "/ws")).toBe("/ws/field-notes");
    expect(deriveWorkspaceDefault("workspace.specs_root", "/ws")).toBe("/ws/specs");
    expect(deriveWorkspaceDefault("workspace.dogfood_evidence_root", "/ws")).toBe("/ws/dogfood-evidence");
  });
});

describe("init-workspace runner", () => {
  let tmpDir: string;
  let configPath: string;
  let workspaceRoot: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "init-workspace-"));
    configPath = join(tmpDir, "config.json");
    workspaceRoot = join(tmpDir, "workspace");
    restoreEnv = clearEnv();
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    restoreEnv();
  });

  it("--dry-run reports what would be created without writing anything", () => {
    const result = runInitWorkspace({ dryRun: true, root: workspaceRoot, configPath });
    expect(result.dryRun).toBe(true);
    expect(result.subdirs.map((s) => s.name)).toEqual(expect.arrayContaining([
      "missions",
      "artifacts",
      "evidence",
      "progress",
      "field-notes",
      "specs",
      "dogfood-evidence",
      "missions/getting-started/slices/first-conveyor-run",
      "missions/getting-started/slices/inspect-project-evidence",
    ]));
    expect(existsSync(workspaceRoot)).toBe(false);
  });

  it("command --json emits parseable JSON for agent setup flows", async () => {
    const cmd = initWorkspaceCommand(configPath);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await cmd.parseAsync(["node", "init-workspace", "--root", workspaceRoot, "--dry-run", "--json"]);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logs.join("\n")) as { root: string; dryRun: boolean; subdirs: Array<{ name: string }> };
    expect(parsed.root).toBe(workspaceRoot);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.subdirs.map((s) => s.name)).toContain("missions/getting-started/slices/first-conveyor-run");
  });

  it("rig-level --json emits parseable JSON for config init-workspace", async () => {
    const cmd = new Command("rig");
    cmd.exitOverride();
    cmd.option("--json", "emit machine-readable JSON");
    cmd.addCommand(configCommand(configPath));

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => { logs.push(String(msg)); };
    try {
      await cmd.parseAsync([
        "node",
        "rig",
        "--json",
        "config",
        "init-workspace",
        "--root",
        workspaceRoot,
        "--dry-run",
      ]);
    } finally {
      console.log = origLog;
    }

    const parsed = JSON.parse(logs.join("\n")) as { root: string; dryRun: boolean; subdirs: Array<{ name: string }> };
    expect(parsed.root).toBe(workspaceRoot);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.subdirs.map((s) => s.name)).toContain("missions/getting-started/slices/inspect-project-evidence");
  });

  it("creates project + mission-aware workspace files + STEERING placeholder", () => {
    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    expect(result.dryRun).toBe(false);
    expect(existsSync(workspaceRoot)).toBe(true);
    for (const sub of ["missions", "artifacts", "evidence", "progress", "field-notes", "specs", "dogfood-evidence"]) {
      expect(existsSync(join(workspaceRoot, sub))).toBe(true);
      expect(existsSync(join(workspaceRoot, sub, "README.md"))).toBe(true);
    }
    expect(existsSync(join(workspaceRoot, "missions", "getting-started", "slices", "first-conveyor-run", "SPEC.md"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "missions", "getting-started", "slices", "inspect-project-evidence", "SPEC.md"))).toBe(true);
    const projectSpec = readFileSync(join(workspaceRoot, "SPEC.md"), "utf-8");
    expect(projectSpec).toContain("intent:");
    expect(projectSpec).toContain("# Project");
    const steeringMd = readFileSync(join(workspaceRoot, "STEERING.md"), "utf-8");
    expect(steeringMd).toContain("OpenRig Priority Stack");
  });

  it("OPR.0.4.1.23 AC-2/AC-3: backfills root PROOF.md + sibling empty proof/ dir for an existing slice", () => {
    const sliceDir = join(workspaceRoot, "missions", "getting-started", "slices", "first-conveyor-run");
    mkdirSync(sliceDir, { recursive: true });
    writeFileSync(join(sliceDir, "README.md"), "operator pre-existing slice", "utf-8");

    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    const proofFile = result.files.find((f) =>
      f.relPath === "missions/getting-started/slices/first-conveyor-run/PROOF.md");
    const proofDir = result.subdirs.find((d) =>
      d.name === "missions/getting-started/slices/first-conveyor-run/proof");

    expect(proofFile).toBeDefined();
    expect(proofFile?.created).toBe(true);
    expect(proofDir).toBeDefined();
    expect(proofDir?.created).toBe(true);

    const proofPath = join(sliceDir, "PROOF.md");
    const mediaDir = join(sliceDir, "proof");
    expect(existsSync(proofPath)).toBe(true);
    expect(statSync(proofPath).isFile()).toBe(true);
    expect(existsSync(mediaDir)).toBe(true);
    expect(statSync(mediaDir).isDirectory()).toBe(true);
    expect(existsSync(join(mediaDir, "PROOF.md"))).toBe(false);
    expect(readdirSync(mediaDir)).toEqual([]);

    const proof = readFileSync(proofPath, "utf-8");
    expect(proof).toContain("# PROOF — OPR.99.0.1.1 First Conveyor Run");
    expect(proof).toContain("## Artifacts (media in proof/)");
  });

  it("adds current mission surfaces alongside an existing legacy README", () => {
    const missionDir = join(workspaceRoot, "missions", "getting-started");
    mkdirSync(missionDir, { recursive: true });
    writeFileSync(join(missionDir, "README.md"), "operator pre-existing mission", "utf-8");

    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    const specFile = result.files.find((f) =>
      f.relPath === "missions/getting-started/SPEC.md");

    expect(specFile).toBeDefined();
    expect(specFile?.created).toBe(true);

    expect(existsSync(join(missionDir, "SPEC.md"))).toBe(true);
    expect(existsSync(join(missionDir, "NOTES.md"))).toBe(true);
    expect(existsSync(join(missionDir, "MISSION_BRIEF.md"))).toBe(false);
    expect(readFileSync(join(missionDir, "README.md"), "utf-8")).toBe("operator pre-existing mission");
  });

  it("is idempotent: running twice without --force is a no-op for existing files", () => {
    runInitWorkspace({ root: workspaceRoot, configPath });
    const projectSpec = join(workspaceRoot, "SPEC.md");
    writeFileSync(projectSpec, "operator-edited content", "utf-8");

    const second = runInitWorkspace({ root: workspaceRoot, configPath });
    const projectFile = second.files.find((f) => f.relPath === "SPEC.md");
    expect(projectFile?.skipped).toBe("exists");
    expect(readFileSync(projectSpec, "utf-8")).toBe("operator-edited content");
  });

  it("--force overwrites existing files but never deletes operator content under directories", () => {
    runInitWorkspace({ root: workspaceRoot, configPath });
    const operatorFile = join(workspaceRoot, "missions", "getting-started", "slices", "first-conveyor-run", "operator-note.md");
    writeFileSync(operatorFile, "my work", "utf-8");
    const operatorSpec = join(workspaceRoot, "missions", "getting-started", "slices", "first-conveyor-run", "SPEC.md");
    writeFileSync(operatorSpec, "edited", "utf-8");

    runInitWorkspace({ root: workspaceRoot, force: true, configPath });
    // Operator file under the subdir survives
    expect(existsSync(operatorFile)).toBe(true);
    expect(readFileSync(operatorFile, "utf-8")).toBe("my work");
    // Current SPEC is overwritten
    expect(readFileSync(operatorSpec, "utf-8")).toContain("# First Conveyor Run");
  });

  it("--root override beats configured workspace.root", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", "/should/not/be/used");
    const result = runInitWorkspace({ root: workspaceRoot, configPath });
    expect(result.root).toBe(workspaceRoot);
    expect(existsSync(workspaceRoot)).toBe(true);
  });

  it("reads workspace.root from settings when --root is not given", () => {
    const store = new ConfigStore(configPath);
    store.set("workspace.root", workspaceRoot);
    const result = runInitWorkspace({ configPath });
    expect(result.root).toBe(workspaceRoot);
    expect(existsSync(workspaceRoot)).toBe(true);
  });
});

// GHOST-STAGE (d) — the CLI `rig config set` write-target must be the CANONICAL config the DAEMON
// reads (getOpenRigHome/config.json), never the existence-based legacy ~/.rigged sidecar. The
// operator hit config-set-success-without-persist: the setter wrote the sidecar, the daemon read
// canonical, so `disabled` never took. RED provenance: on a host WITH a legacy ~/.rigged/config.json
// the OLD getCompatibleOpenRigPath returns that real-home sidecar while OPENRIG_HOME points at the
// canonical home — so `configPath` diverges and this pin RED-fails. (A host-independent RED needs
// os.homedir() mocking — harness note.)
describe("ConfigStore — GHOST-STAGE (d): write-canonical + verify-readback", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedPort: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "cfg-d-home-"));
    savedHome = process.env["OPENRIG_HOME"];
    savedPort = process.env["OPENRIG_PORT"];
    delete process.env["OPENRIG_PORT"];
    process.env["OPENRIG_HOME"] = home; // the canonical home the daemon resolves
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = savedHome;
    if (savedPort === undefined) delete process.env["OPENRIG_PORT"];
    else process.env["OPENRIG_PORT"] = savedPort;
    rmSync(home, { recursive: true, force: true });
  });

  it("a DEFAULT store writes to <OPENRIG_HOME>/config.json (where the daemon reads), not a legacy sidecar", () => {
    const store = new ConfigStore(); // no explicit path -> getDefaultOpenRigPath (the fix)
    const canonical = join(home, "config.json");
    expect(store.configPath).toBe(canonical); // writes EXACTLY where the daemon reads (the write-target fix)
    store.set("policies.claude_compaction.enabled", "false");
    // read it back the way the DAEMON does — via the canonical path — proving the write reached it
    const daemonSees = JSON.parse(readFileSync(canonical, "utf-8")) as { policies?: { claudeCompaction?: { enabled?: boolean } } };
    expect(daemonSees.policies?.claudeCompaction?.enabled).toBe(false);
  });

  it("verify-readback round-trips: a set() value is read back from the same file (no phantom success)", () => {
    const store = new ConfigStore();
    store.set("daemon.port", "9191");
    expect(store.get("daemon.port")).toBe(9191);
    expect((JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as { daemon?: { port?: number } }).daemon?.port).toBe(9191);
  });
});
