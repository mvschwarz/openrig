// User Settings v0 — daemon-side settings store.
//
// The CLI's @openrig/cli ConfigStore is the canonical write surface
// (operator + agent edit via `rig config`). The daemon needs read+write
// access too — for the UI's System drawer Settings panel + the daemon
// HTTP route at /api/config. Rather than depend on the CLI package
// (which would require workspace exports + a dist build), this module
// duplicates the small, stable resolution + write logic. The constants
// (VALID_KEYS, ENV_MAP, KEY_TO_PATH) are kept in lockstep with
// cli/src/config-store.ts via cross-package tests.
//
// Storage: same single source of truth at ~/.openrig/config.json.
// Resolution: same env > file > default precedence. Decoded helpers
// (parseNamedPairs / resolveAllowlist / resolveProgressScanRoots /
// resolveWorkspacePaths) project the raw strings into structured data
// the daemon's UEP routes + Slice Story View consume.

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const DEFAULT_CONFIG_PATH = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "config.json",
);

const DEFAULT_WORKSPACE_ROOT = path.join(
  process.env["OPENRIG_HOME"] || process.env["RIGGED_HOME"] || path.join(os.homedir(), ".openrig"),
  "workspace",
);

export const SETTINGS_VALID_KEYS = [
  "daemon.port",
  "daemon.host",
  "db.path",
  "transcripts.enabled",
  "transcripts.path",
  // V1 pre-release CLI/daemon Item 1 — capture-pane rotation tunables.
  // SC-29 EXCEPTION #4 allowlist sub-piece (lockstep with
  // cli/src/config-store.ts).
  "transcripts.lines",
  "transcripts.poll_interval_seconds",
  "workspace.root",
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.field_notes_root",
  "workspace.specs_root",
  "workspace.dogfood_evidence_root",
  "files.allowlist",
  "progress.scan_roots",
  "ui.preview.refresh_interval_seconds",
  "ui.preview.max_pins",
  "ui.preview.default_lines",
  "recovery.auto_drive_provider_prompts",
  "recovery.provider_auth_env_allowlist",
  // V1 attempt-3 Phase 4 — Advisor / Operator rail icon V1 placeholders
  // per universal-shell.md L82–L84. SC-29 EXCEPTION declared in
  // dispatch ACK §4: allowlist-only edit; no migrations / new
  // endpoints / event types.
  "agents.advisor_session",
  "agents.operator_session",
  // V0.3.1 slice 05 kernel-rig-as-default — operator seat name read by
  // mission-control read layer + 2 UI sites. Default derived as
  // `operator-${USER}@kernel` (os.userInfo().username) at daemon
  // resolution time; operator override via `rig config set
  // workspace.operator_seat_name <session>` writes to
  // ~/.openrig/config.json same as other workspace.* settings.
  // OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME only — no RIGGED_* legacy
  // alias (new key per banked feedback_no_rigged_legacy_for_new_keys).
  "workspace.operator_seat_name",
  // V1 attempt-3 Phase 5 P5-3 — For You feed subscription toggles per
  // for-you-feed.md L144–L151. SC-29 EXCEPTION declared in Phase 5
  // dispatch ACK §5 (DRIFT P5-D2; same scope as Phase 4: allowlist-only;
  // no migrations / new endpoints / event types). action_required is
  // forced ON in the UI (cannot be toggled per L145); the key exists
  // for future operator override but is not surfaced as a toggle in V1.
  "feed.subscriptions.action_required",
  "feed.subscriptions.approvals",
  "feed.subscriptions.shipped",
  "feed.subscriptions.progress",
  "feed.subscriptions.audit_log",
] as const;

export type SettingsValidKey = typeof SETTINGS_VALID_KEYS[number];

const ENV_MAP: Record<SettingsValidKey, { primary: string; legacy?: string }> = {
  // Only the original runtime keys keep RIGGED_* aliases for upgrade
  // compatibility. New typed keys use OPENRIG_* only.
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  "daemon.host": { primary: "OPENRIG_HOST", legacy: "RIGGED_HOST" },
  "db.path": { primary: "OPENRIG_DB", legacy: "RIGGED_DB" },
  "transcripts.enabled": { primary: "OPENRIG_TRANSCRIPTS_ENABLED", legacy: "RIGGED_TRANSCRIPTS_ENABLED" },
  "transcripts.path": { primary: "OPENRIG_TRANSCRIPTS_PATH", legacy: "RIGGED_TRANSCRIPTS_PATH" },
  "transcripts.lines": { primary: "OPENRIG_TRANSCRIPTS_LINES" },
  "transcripts.poll_interval_seconds": { primary: "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS" },
  "workspace.root": { primary: "OPENRIG_WORKSPACE_ROOT" },
  "workspace.slices_root": { primary: "OPENRIG_WORKSPACE_SLICES_ROOT" },
  "workspace.steering_path": { primary: "OPENRIG_WORKSPACE_STEERING_PATH" },
  "workspace.field_notes_root": { primary: "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT" },
  "workspace.specs_root": { primary: "OPENRIG_WORKSPACE_SPECS_ROOT" },
  "workspace.dogfood_evidence_root": { primary: "OPENRIG_DOGFOOD_EVIDENCE_ROOT" },
  "files.allowlist": { primary: "OPENRIG_FILES_ALLOWLIST" },
  "progress.scan_roots": { primary: "OPENRIG_PROGRESS_SCAN_ROOTS" },
  "ui.preview.refresh_interval_seconds": { primary: "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS" },
  "ui.preview.max_pins": { primary: "OPENRIG_UI_PREVIEW_MAX_PINS" },
  "ui.preview.default_lines": { primary: "OPENRIG_UI_PREVIEW_DEFAULT_LINES" },
  "recovery.auto_drive_provider_prompts": { primary: "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS" },
  "recovery.provider_auth_env_allowlist": { primary: "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST" },
  "agents.advisor_session": { primary: "OPENRIG_AGENTS_ADVISOR_SESSION" },
  "agents.operator_session": { primary: "OPENRIG_AGENTS_OPERATOR_SESSION" },
  "workspace.operator_seat_name": { primary: "OPENRIG_WORKSPACE_OPERATOR_SEAT_NAME" },
  "feed.subscriptions.action_required": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED" },
  "feed.subscriptions.approvals": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS" },
  "feed.subscriptions.shipped": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED" },
  "feed.subscriptions.progress": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS" },
  "feed.subscriptions.audit_log": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG" },
};

const KEY_TO_PATH: Record<SettingsValidKey, string[]> = {
  "daemon.port": ["daemon", "port"],
  "daemon.host": ["daemon", "host"],
  "db.path": ["db", "path"],
  "transcripts.enabled": ["transcripts", "enabled"],
  "transcripts.path": ["transcripts", "path"],
  "transcripts.lines": ["transcripts", "lines"],
  "transcripts.poll_interval_seconds": ["transcripts", "pollIntervalSeconds"],
  "workspace.root": ["workspace", "root"],
  "workspace.slices_root": ["workspace", "slicesRoot"],
  "workspace.steering_path": ["workspace", "steeringPath"],
  "workspace.field_notes_root": ["workspace", "fieldNotesRoot"],
  "workspace.specs_root": ["workspace", "specsRoot"],
  "workspace.dogfood_evidence_root": ["workspace", "dogfoodEvidenceRoot"],
  "files.allowlist": ["files", "allowlist"],
  "progress.scan_roots": ["progress", "scanRoots"],
  "ui.preview.refresh_interval_seconds": ["ui", "preview", "refreshIntervalSeconds"],
  "ui.preview.max_pins": ["ui", "preview", "maxPins"],
  "ui.preview.default_lines": ["ui", "preview", "defaultLines"],
  "recovery.auto_drive_provider_prompts": ["recovery", "autoDriveProviderPrompts"],
  "recovery.provider_auth_env_allowlist": ["recovery", "providerAuthEnvAllowlist"],
  "agents.advisor_session": ["agents", "advisorSession"],
  "agents.operator_session": ["agents", "operatorSession"],
  "workspace.operator_seat_name": ["workspace", "operatorSeatName"],
  "feed.subscriptions.action_required": ["feed", "subscriptions", "actionRequired"],
  "feed.subscriptions.approvals": ["feed", "subscriptions", "approvals"],
  "feed.subscriptions.shipped": ["feed", "subscriptions", "shipped"],
  "feed.subscriptions.progress": ["feed", "subscriptions", "progress"],
  "feed.subscriptions.audit_log": ["feed", "subscriptions", "auditLog"],
};

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export function isSettingsValidKey(key: string): key is SettingsValidKey {
  return (SETTINGS_VALID_KEYS as readonly string[]).includes(key);
}

function readEnv(primary: string, legacy?: string): string | undefined {
  const p = process.env[primary];
  if (p !== undefined && p !== "") return p;
  if (legacy) {
    const l = process.env[legacy];
    if (l !== undefined && l !== "") return l;
  }
  return undefined;
}

function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function deriveWorkspaceDefault(key: SettingsValidKey, workspaceRoot: string): string {
  switch (key) {
    case "workspace.slices_root":      return path.join(workspaceRoot, "missions");
    case "workspace.steering_path":    return path.join(workspaceRoot, "STEERING.md");
    case "workspace.field_notes_root": return path.join(workspaceRoot, "field-notes");
    case "workspace.specs_root":       return path.join(workspaceRoot, "specs");
    case "workspace.dogfood_evidence_root": return path.join(workspaceRoot, "dogfood-evidence");
    case "files.allowlist":            return `workspace:${workspaceRoot}`;
    case "progress.scan_roots":        return `workspace:${workspaceRoot}`;
    default: return "";
  }
}

function deriveLegacyWorkspaceDefault(key: SettingsValidKey, workspaceRoot: string): string | null {
  switch (key) {
    case "workspace.slices_root": return path.join(workspaceRoot, "slices");
    case "workspace.steering_path": return path.join(workspaceRoot, "steering", "STEERING.md");
    default: return null;
  }
}

const WORKSPACE_DERIVED_KEYS: ReadonlySet<SettingsValidKey> = new Set([
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.field_notes_root",
  "workspace.specs_root",
  "workspace.dogfood_evidence_root",
  "files.allowlist",
  "progress.scan_roots",
]);

function getDefaultValue(key: SettingsValidKey, workspaceRoot: string): string | number | boolean {
  if (WORKSPACE_DERIVED_KEYS.has(key)) {
    return deriveWorkspaceDefault(key, workspaceRoot);
  }
  switch (key) {
    case "daemon.port": return 7433;
    case "daemon.host": return "127.0.0.1";
    case "db.path": return path.join(path.dirname(DEFAULT_CONFIG_PATH), "openrig.sqlite");
    case "transcripts.enabled": return true;
    case "transcripts.path": return path.join(path.dirname(DEFAULT_CONFIG_PATH), "transcripts");
    // V1 pre-release CLI/daemon Item 1 — capture-pane rotation defaults.
    case "transcripts.lines": return 1000;
    case "transcripts.poll_interval_seconds": return 2;
    // V0.3.1 slice 05 — `operator-${USER}@kernel` derives from the OS
    // username at resolution time; operator override via `rig config
    // set` persists to ~/.openrig/config.json.
    case "workspace.operator_seat_name": return `operator-${os.userInfo().username}@kernel`;
    case "workspace.root": return DEFAULT_WORKSPACE_ROOT;
    // Preview Terminal v0 (PL-018) defaults — match cli/src/config-store.ts.
    case "ui.preview.refresh_interval_seconds": return 3;
    case "ui.preview.max_pins": return 4;
    case "ui.preview.default_lines": return 50;
    case "recovery.auto_drive_provider_prompts": return false;
    case "recovery.provider_auth_env_allowlist": return "";
    // V1 Phase 4 — Advisor default per universal-shell.md L83;
    // Operator default empty per L84 ("not configured").
    case "agents.advisor_session": return "advisor-lead@openrig-velocity";
    case "agents.operator_session": return "";
    // V1 Phase 5 P5-3 — For You feed subscription defaults per
    // for-you-feed.md L144–L151. action_required is forced ON in the UI
    // (cannot be disabled per L145 — load-bearing human-gate items);
    // approvals/shipped/progress default ON; audit_log default OFF
    // (verbose; opt-in for triage runs).
    case "feed.subscriptions.action_required": return true;
    case "feed.subscriptions.approvals": return true;
    case "feed.subscriptions.shipped": return true;
    case "feed.subscriptions.progress": return true;
    case "feed.subscriptions.audit_log": return false;
    default: return "";
  }
}

function coerceValue(key: SettingsValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const def = getDefaultValue(key, workspaceRoot);
  if (typeof def === "number") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) throw new Error(`Invalid value for ${key}: expected a number, got "${raw}"`);
    return n;
  }
  if (typeof def === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`Invalid value for ${key}: expected true/false, got "${raw}"`);
  }
  return raw;
}

export interface ResolvedConfig {
  workspaceRoot: string;
  workspaceSlicesRoot: string;
  workspaceSteeringPath: string;
  workspaceFieldNotesRoot: string;
  workspaceSpecsRoot: string;
  workspaceDogfoodEvidenceRoot: string;
  // V0.3.1 slice 05 — operator seat name read by mission-control read
  // layer (replacing the legacy hardcoded `DEFAULT_OPERATOR_SESSION`
  // constant) and 2 UI cosmetic sites. Default
  // `operator-${USER}@kernel` derived from os.userInfo().username.
  workspaceOperatorSeatName: string;
  filesAllowlistRaw: string;
  progressScanRootsRaw: string;
  // Preview Terminal v0 (PL-018) — UI preview preferences.
  uiPreviewRefreshIntervalSeconds: number;
  uiPreviewMaxPins: number;
  uiPreviewDefaultLines: number;
  recoveryAutoDriveProviderPrompts: boolean;
  recoveryProviderAuthEnvAllowlistRaw: string;
}

export class SettingsStore {
  readonly configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? DEFAULT_CONFIG_PATH;
  }

  resolveOne(key: SettingsValidKey, fileConfig?: Record<string, unknown>, workspaceRoot?: string): ResolvedSetting {
    const fc = fileConfig ?? this.readConfigFile();
    const wr = workspaceRoot ?? this.resolveWorkspaceRootRaw(fc);
    const defaultValue = getDefaultValue(key, wr);
    const envVal = readEnv(ENV_MAP[key].primary, ENV_MAP[key].legacy);
    if (envVal !== undefined && envVal !== "") {
      return { value: coerceValue(key, envVal, wr), source: "env", defaultValue };
    }
    const fileVal = getNestedValue(fc, KEY_TO_PATH[key]);
    if (fileVal !== undefined && fileVal !== null && fileVal !== "") {
      const legacyDefault = deriveLegacyWorkspaceDefault(key, wr);
      if (legacyDefault !== null && fileVal === legacyDefault) {
        return { value: defaultValue, source: "default", defaultValue };
      }
      return { value: fileVal as string | number | boolean, source: "file", defaultValue };
    }
    return { value: defaultValue, source: "default", defaultValue };
  }

  resolveAllWithSource(): Record<SettingsValidKey, ResolvedSetting> {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    const out = {} as Record<SettingsValidKey, ResolvedSetting>;
    for (const key of SETTINGS_VALID_KEYS) {
      out[key] = this.resolveOne(key, fc, wr);
    }
    return out;
  }

  /** Project the raw resolution into a flattened config structure for daemon consumers. */
  resolveConfig(): ResolvedConfig {
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    return {
      workspaceRoot: wr,
      workspaceSlicesRoot: this.resolveOne("workspace.slices_root", fc, wr).value as string,
      workspaceSteeringPath: this.resolveOne("workspace.steering_path", fc, wr).value as string,
      workspaceFieldNotesRoot: this.resolveOne("workspace.field_notes_root", fc, wr).value as string,
      workspaceSpecsRoot: this.resolveOne("workspace.specs_root", fc, wr).value as string,
      workspaceDogfoodEvidenceRoot: this.resolveOne("workspace.dogfood_evidence_root", fc, wr).value as string,
      workspaceOperatorSeatName: this.resolveOne("workspace.operator_seat_name", fc, wr).value as string,
      filesAllowlistRaw: this.resolveOne("files.allowlist", fc, wr).value as string,
      progressScanRootsRaw: this.resolveOne("progress.scan_roots", fc, wr).value as string,
      uiPreviewRefreshIntervalSeconds: this.resolveOne("ui.preview.refresh_interval_seconds", fc, wr).value as number,
      uiPreviewMaxPins: this.resolveOne("ui.preview.max_pins", fc, wr).value as number,
      uiPreviewDefaultLines: this.resolveOne("ui.preview.default_lines", fc, wr).value as number,
      recoveryAutoDriveProviderPrompts: this.resolveOne("recovery.auto_drive_provider_prompts", fc, wr).value as boolean,
      recoveryProviderAuthEnvAllowlistRaw: this.resolveOne("recovery.provider_auth_env_allowlist", fc, wr).value as string,
    };
  }

  set(key: string, value: string): void {
    if (!isSettingsValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${SETTINGS_VALID_KEYS.join(", ")}`);
    }
    const fc = this.readConfigFile();
    const wr = this.resolveWorkspaceRootRaw(fc);
    const coerced = coerceValue(key, value, wr);
    setNestedValue(fc, KEY_TO_PATH[key], coerced);
    mkdirSync(path.dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(fc, null, 2) + "\n", "utf-8");
  }

  reset(key?: string): void {
    if (key === undefined) {
      try { unlinkSync(this.configPath); } catch { /* missing is fine */ }
      return;
    }
    if (!isSettingsValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${SETTINGS_VALID_KEYS.join(", ")}`);
    }
    if (!existsSync(this.configPath)) return;
    const fc = this.readConfigFile();
    const parts = KEY_TO_PATH[key];
    const parent = getNestedValue(fc, parts.slice(0, -1)) as Record<string, unknown> | undefined;
    if (parent && parts[parts.length - 1]! in parent) {
      delete parent[parts[parts.length - 1]!];
    }
    writeFileSync(this.configPath, JSON.stringify(fc, null, 2) + "\n", "utf-8");
  }

  private resolveWorkspaceRootRaw(fileConfig: Record<string, unknown>): string {
    const envVal = readEnv(ENV_MAP["workspace.root"].primary, ENV_MAP["workspace.root"].legacy);
    if (envVal) return envVal;
    const fileVal = getNestedValue(fileConfig, KEY_TO_PATH["workspace.root"]) as string | undefined;
    if (fileVal) return fileVal;
    return DEFAULT_WORKSPACE_ROOT;
  }

  private readConfigFile(): Record<string, unknown> {
    if (!existsSync(this.configPath)) return {};
    const raw = readFileSync(this.configPath, "utf-8");
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Config file at ${this.configPath} is malformed. Fix the JSON or reset with: rig config reset`,
      );
    }
  }
}

// --- User Settings v0: shared decoders ---

export interface NamedPair {
  name: string;
  path: string;
}

export function parseNamedPairs(raw: string): NamedPair[] {
  if (!raw || !raw.trim()) return [];
  const out = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rawPath = trimmed.slice(colon + 1).trim();
    if (!name || !rawPath) continue;
    out.set(name, rawPath);
  }
  return Array.from(out.entries()).map(([name, path]) => ({ name, path }));
}
