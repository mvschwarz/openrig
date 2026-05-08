import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  getCompatibleOpenRigPath,
  getDefaultOpenRigPath,
  readOpenRigEnv,
} from "./openrig-compat.js";

// User Settings v0 — extends the existing ConfigStore with new namespaces
// (workspace.*, files.*, progress.*) without changing the existing 5
// daemon/db/transcripts keys' behavior. Storage stays single-source-of-
// truth at ~/.openrig/config.json. Resolution stays env > file > default.

export interface RiggedConfig {
  daemon: { port: number; host: string };
  db: { path: string };
  transcripts: {
    enabled: boolean;
    path: string;
    // V1 pre-release CLI/daemon Item 1 — capture-pane rotation tunables.
    // SC-29 EXCEPTION #4 declared in pre-release ACK §5: same allowlist
    // shape as the Phase 4 / Phase 5 prior exceptions.
    lines: number;
    pollIntervalSeconds: number;
  };
  // User Settings v0 — workspace paths.
  workspace: {
    root: string;
    slicesRoot: string;
    steeringPath: string;
    fieldNotesRoot: string;
    specsRoot: string;
  };
  // User Settings v0 — UEP env-var graduation.
  // Values are stored as raw named-pair strings ("name:/abs/path,...")
  // matching the OPENRIG_FILES_ALLOWLIST / OPENRIG_PROGRESS_SCAN_ROOTS
  // formats; decoded helpers (parseNamedPairs) turn them into structured
  // arrays.
  files: {
    allowlist: string;
  };
  progress: {
    scanRoots: string;
  };
  // Preview Terminal v0 (PL-018) — UI-side preferences for the live
  // terminal preview pane.
  ui: {
    preview: {
      refreshIntervalSeconds: number;
      maxPins: number;
      defaultLines: number;
    };
  };
  recovery: {
    autoDriveProviderPrompts: boolean;
    providerAuthEnvAllowlist: string;
  };
  // V1 attempt-3 Phase 4 — Advisor / Operator rail icon V1 placeholders
  // per universal-shell.md L82–L84. SC-29 EXCEPTION: allowlist-only
  // additions (no schema migrations / new endpoints / event types).
  agents: {
    advisorSession: string;
    operatorSession: string;
  };
  // V1 attempt-3 Phase 5 P5-3 — For You feed subscription toggles per
  // for-you-feed.md L144–L151. SC-29 EXCEPTION declared in Phase 5
  // dispatch ACK §5 DRIFT P5-D2: same scope as Phase 4 (allowlist-only;
  // no migrations / new endpoints / event types).
  feed: {
    subscriptions: {
      actionRequired: boolean;
      approvals: boolean;
      shipped: boolean;
      progress: boolean;
      auditLog: boolean;
    };
  };
}

const DEFAULT_WORKSPACE_ROOT = getDefaultOpenRigPath("workspace");

const DEFAULTS = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: getDefaultOpenRigPath("openrig.sqlite") },
  transcripts: { enabled: true, path: getDefaultOpenRigPath("transcripts"), lines: 1000, pollIntervalSeconds: 2 },
  workspace: {
    root: DEFAULT_WORKSPACE_ROOT,
    slicesRoot: "",
    steeringPath: "",
    fieldNotesRoot: "",
    specsRoot: "",
  },
  files: { allowlist: "" },
  progress: { scanRoots: "" },
  ui: {
    preview: {
      refreshIntervalSeconds: 3,
      maxPins: 4,
      defaultLines: 50,
    },
  },
  recovery: {
    autoDriveProviderPrompts: false,
    providerAuthEnvAllowlist: "",
  },
  // V1 Phase 4 — Advisor default per universal-shell.md L83;
  // Operator default empty per L84 ("not configured").
  agents: {
    advisorSession: "advisor-lead@openrig-velocity",
    operatorSession: "",
  },
  // V1 Phase 5 P5-3 — feed subscription defaults per for-you-feed.md
  // L144–L151. action_required forced ON in UI (load-bearing
  // human-gate items per L145; cannot be disabled); approvals/
  // shipped/progress default ON; audit_log default OFF (verbose;
  // opt-in for triage runs).
  feed: {
    subscriptions: {
      actionRequired: true,
      approvals: true,
      shipped: true,
      progress: true,
      auditLog: false,
    },
  },
} as const;

export const VALID_KEYS = [
  "daemon.port",
  "daemon.host",
  "db.path",
  "transcripts.enabled",
  "transcripts.path",
  // V1 pre-release CLI/daemon Item 1 — SC-29 EXCEPTION #4 allowlist
  // sub-piece: transcript rotation tunables (line count + poll interval).
  "transcripts.lines",
  "transcripts.poll_interval_seconds",
  "workspace.root",
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.field_notes_root",
  "workspace.specs_root",
  "files.allowlist",
  "progress.scan_roots",
  "ui.preview.refresh_interval_seconds",
  "ui.preview.max_pins",
  "ui.preview.default_lines",
  "recovery.auto_drive_provider_prompts",
  "recovery.provider_auth_env_allowlist",
  // V1 Phase 4 SC-29 exception — allowlist-only additions.
  "agents.advisor_session",
  "agents.operator_session",
  // V1 Phase 5 P5-3 SC-29 exception — allowlist-only additions.
  "feed.subscriptions.action_required",
  "feed.subscriptions.approvals",
  "feed.subscriptions.shipped",
  "feed.subscriptions.progress",
  "feed.subscriptions.audit_log",
] as const;

export type ValidKey = typeof VALID_KEYS[number];

export const ENV_MAP: Record<ValidKey, { primary: string; legacy: string }> = {
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  "daemon.host": { primary: "OPENRIG_HOST", legacy: "RIGGED_HOST" },
  "db.path": { primary: "OPENRIG_DB", legacy: "RIGGED_DB" },
  "transcripts.enabled": { primary: "OPENRIG_TRANSCRIPTS_ENABLED", legacy: "RIGGED_TRANSCRIPTS_ENABLED" },
  "transcripts.path": { primary: "OPENRIG_TRANSCRIPTS_PATH", legacy: "RIGGED_TRANSCRIPTS_PATH" },
  "transcripts.lines": { primary: "OPENRIG_TRANSCRIPTS_LINES", legacy: "RIGGED_TRANSCRIPTS_LINES" },
  "transcripts.poll_interval_seconds": { primary: "OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS", legacy: "RIGGED_TRANSCRIPTS_POLL_INTERVAL_SECONDS" },
  "workspace.root": { primary: "OPENRIG_WORKSPACE_ROOT", legacy: "RIGGED_WORKSPACE_ROOT" },
  "workspace.slices_root": { primary: "OPENRIG_WORKSPACE_SLICES_ROOT", legacy: "RIGGED_WORKSPACE_SLICES_ROOT" },
  "workspace.steering_path": { primary: "OPENRIG_WORKSPACE_STEERING_PATH", legacy: "RIGGED_WORKSPACE_STEERING_PATH" },
  "workspace.field_notes_root": { primary: "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT", legacy: "RIGGED_WORKSPACE_FIELD_NOTES_ROOT" },
  "workspace.specs_root": { primary: "OPENRIG_WORKSPACE_SPECS_ROOT", legacy: "RIGGED_WORKSPACE_SPECS_ROOT" },
  // UEP env-var graduation: existing OPENRIG_FILES_ALLOWLIST /
  // OPENRIG_PROGRESS_SCAN_ROOTS become the env override for the new
  // typed keys (no breaking change).
  "files.allowlist": { primary: "OPENRIG_FILES_ALLOWLIST", legacy: "RIGGED_FILES_ALLOWLIST" },
  "progress.scan_roots": { primary: "OPENRIG_PROGRESS_SCAN_ROOTS", legacy: "RIGGED_PROGRESS_SCAN_ROOTS" },
  "ui.preview.refresh_interval_seconds": { primary: "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS", legacy: "RIGGED_UI_PREVIEW_REFRESH_INTERVAL_SECONDS" },
  "ui.preview.max_pins": { primary: "OPENRIG_UI_PREVIEW_MAX_PINS", legacy: "RIGGED_UI_PREVIEW_MAX_PINS" },
  "ui.preview.default_lines": { primary: "OPENRIG_UI_PREVIEW_DEFAULT_LINES", legacy: "RIGGED_UI_PREVIEW_DEFAULT_LINES" },
  "recovery.auto_drive_provider_prompts": { primary: "OPENRIG_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS", legacy: "RIGGED_RECOVERY_AUTO_DRIVE_PROVIDER_PROMPTS" },
  "recovery.provider_auth_env_allowlist": { primary: "OPENRIG_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST", legacy: "RIGGED_RECOVERY_PROVIDER_AUTH_ENV_ALLOWLIST" },
  "agents.advisor_session": { primary: "OPENRIG_AGENTS_ADVISOR_SESSION", legacy: "RIGGED_AGENTS_ADVISOR_SESSION" },
  "agents.operator_session": { primary: "OPENRIG_AGENTS_OPERATOR_SESSION", legacy: "RIGGED_AGENTS_OPERATOR_SESSION" },
  "feed.subscriptions.action_required": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_ACTION_REQUIRED", legacy: "RIGGED_FEED_SUBSCRIPTIONS_ACTION_REQUIRED" },
  "feed.subscriptions.approvals": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_APPROVALS", legacy: "RIGGED_FEED_SUBSCRIPTIONS_APPROVALS" },
  "feed.subscriptions.shipped": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_SHIPPED", legacy: "RIGGED_FEED_SUBSCRIPTIONS_SHIPPED" },
  "feed.subscriptions.progress": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_PROGRESS", legacy: "RIGGED_FEED_SUBSCRIPTIONS_PROGRESS" },
  "feed.subscriptions.audit_log": { primary: "OPENRIG_FEED_SUBSCRIPTIONS_AUDIT_LOG", legacy: "RIGGED_FEED_SUBSCRIPTIONS_AUDIT_LOG" },
};

// Maps dotted-string config keys to the camelCase RiggedConfig path.
// Workspace per-subdir keys are stored on disk as `workspace.slices_root`
// (snake) and exposed in RiggedConfig as `workspace.slicesRoot` (camel)
// to match TS conventions.
const KEY_TO_PATH: Record<ValidKey, string[]> = {
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
  "files.allowlist": ["files", "allowlist"],
  "progress.scan_roots": ["progress", "scanRoots"],
  "ui.preview.refresh_interval_seconds": ["ui", "preview", "refreshIntervalSeconds"],
  "ui.preview.max_pins": ["ui", "preview", "maxPins"],
  "ui.preview.default_lines": ["ui", "preview", "defaultLines"],
  "recovery.auto_drive_provider_prompts": ["recovery", "autoDriveProviderPrompts"],
  "recovery.provider_auth_env_allowlist": ["recovery", "providerAuthEnvAllowlist"],
  "agents.advisor_session": ["agents", "advisorSession"],
  "agents.operator_session": ["agents", "operatorSession"],
  "feed.subscriptions.action_required": ["feed", "subscriptions", "actionRequired"],
  "feed.subscriptions.approvals": ["feed", "subscriptions", "approvals"],
  "feed.subscriptions.shipped": ["feed", "subscriptions", "shipped"],
  "feed.subscriptions.progress": ["feed", "subscriptions", "progress"],
  "feed.subscriptions.audit_log": ["feed", "subscriptions", "auditLog"],
};

function isValidKey(key: string): key is ValidKey {
  return (VALID_KEYS as readonly string[]).includes(key);
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

// Per-subdir defaults derived from workspace.root. Steering is a FILE path.
// Slice discovery defaults to the mission-aware workspace/missions contract;
// the indexer remains backward-compatible with flat slice roots when an
// operator sets workspace.slices_root explicitly.
// Files and Progress default to the whole workspace so a fresh
// `rig config init-workspace` install is browsable without extra env wiring.
export function deriveWorkspaceDefault(key: ValidKey, workspaceRoot: string): string {
  switch (key) {
    case "workspace.slices_root":      return join(workspaceRoot, "missions");
    case "workspace.steering_path":    return join(workspaceRoot, "STEERING.md");
    case "workspace.field_notes_root": return join(workspaceRoot, "field-notes");
    case "workspace.specs_root":       return join(workspaceRoot, "specs");
    case "files.allowlist":            return `workspace:${workspaceRoot}`;
    case "progress.scan_roots":        return `workspace:${workspaceRoot}`;
    default: return "";
  }
}

const WORKSPACE_DERIVED_KEYS: ReadonlySet<ValidKey> = new Set([
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.field_notes_root",
  "workspace.specs_root",
  "files.allowlist",
  "progress.scan_roots",
]);

function getDefaultValue(key: ValidKey, workspaceRoot: string): string | number | boolean {
  if (WORKSPACE_DERIVED_KEYS.has(key)) {
    return deriveWorkspaceDefault(key, workspaceRoot);
  }
  return getNestedValue(DEFAULTS as unknown as Record<string, unknown>, KEY_TO_PATH[key]) as string | number | boolean;
}

function coerceValue(key: ValidKey, raw: string, workspaceRoot: string): string | number | boolean {
  const defaultVal = getDefaultValue(key, workspaceRoot);
  if (typeof defaultVal === "number") {
    const n = parseInt(raw, 10);
    if (isNaN(n)) throw new Error(`Invalid value for ${key}: expected a number, got "${raw}"`);
    return n;
  }
  if (typeof defaultVal === "boolean") {
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    throw new Error(`Invalid value for ${key}: expected true/false, got "${raw}"`);
  }
  return raw;
}

export type SettingSource = "env" | "file" | "default";

export interface ResolvedSetting {
  value: string | number | boolean;
  source: SettingSource;
  defaultValue: string | number | boolean;
}

export class ConfigStore {
  readonly configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? getCompatibleOpenRigPath("config.json");
  }

  resolve(): RiggedConfig {
    const fileConfig = this.readConfigFile();

    // Workspace root must be resolved first so derived per-subdir
    // defaults can use it.
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;

    const v = (key: ValidKey) =>
      this.resolveOne(key, fileConfig, workspaceRoot).value;

    return {
      daemon: {
        port: v("daemon.port") as number,
        host: v("daemon.host") as string,
      },
      db: {
        path: v("db.path") as string,
      },
      transcripts: {
        enabled: v("transcripts.enabled") as boolean,
        path: v("transcripts.path") as string,
        lines: v("transcripts.lines") as number,
        pollIntervalSeconds: v("transcripts.poll_interval_seconds") as number,
      },
      workspace: {
        root: workspaceRoot,
        slicesRoot: v("workspace.slices_root") as string,
        steeringPath: v("workspace.steering_path") as string,
        fieldNotesRoot: v("workspace.field_notes_root") as string,
        specsRoot: v("workspace.specs_root") as string,
      },
      files: {
        allowlist: v("files.allowlist") as string,
      },
      progress: {
        scanRoots: v("progress.scan_roots") as string,
      },
      ui: {
        preview: {
          refreshIntervalSeconds: v("ui.preview.refresh_interval_seconds") as number,
          maxPins: v("ui.preview.max_pins") as number,
          defaultLines: v("ui.preview.default_lines") as number,
        },
      },
      recovery: {
        autoDriveProviderPrompts: v("recovery.auto_drive_provider_prompts") as boolean,
        providerAuthEnvAllowlist: v("recovery.provider_auth_env_allowlist") as string,
      },
      agents: {
        advisorSession: v("agents.advisor_session") as string,
        operatorSession: v("agents.operator_session") as string,
      },
      feed: {
        subscriptions: {
          actionRequired: v("feed.subscriptions.action_required") as boolean,
          approvals: v("feed.subscriptions.approvals") as boolean,
          shipped: v("feed.subscriptions.shipped") as boolean,
          progress: v("feed.subscriptions.progress") as boolean,
          auditLog: v("feed.subscriptions.audit_log") as boolean,
        },
      },
    };
  }

  /**
   * Resolve a single key with its source. Used by the daemon HTTP route
   * + UI Settings panel for honest provenance display (env / file /
   * default).
   */
  resolveWithSource(key: string): ResolvedSetting {
    if (!isValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
    }
    const fileConfig = this.readConfigFile();
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;
    return this.resolveOne(key, fileConfig, workspaceRoot);
  }

  /** Resolve all valid keys with sources. Convenience for the UI. */
  resolveAllWithSource(): Record<ValidKey, ResolvedSetting> {
    const fileConfig = this.readConfigFile();
    const workspaceRoot = this.resolveOne("workspace.root", fileConfig, DEFAULT_WORKSPACE_ROOT).value as string;
    const out = {} as Record<ValidKey, ResolvedSetting>;
    for (const key of VALID_KEYS) {
      out[key] = this.resolveOne(key, fileConfig, workspaceRoot);
    }
    return out;
  }

  private resolveOne(key: ValidKey, fileConfig: Record<string, unknown>, workspaceRoot: string): ResolvedSetting {
    const defaultValue = getDefaultValue(key, workspaceRoot);
    // 1. Environment variable
    const envVal = readOpenRigEnv(ENV_MAP[key].primary, ENV_MAP[key].legacy);
    if (envVal !== undefined && envVal !== "") {
      return { value: coerceValue(key, envVal, workspaceRoot), source: "env", defaultValue };
    }
    // 2. Config file
    const fileVal = getNestedValue(fileConfig, KEY_TO_PATH[key]);
    if (fileVal !== undefined && fileVal !== null && fileVal !== "") {
      return { value: fileVal as string | number | boolean, source: "file", defaultValue };
    }
    // 3. Default
    return { value: defaultValue, source: "default", defaultValue };
  }

  get(key: string): string | number | boolean {
    return this.resolveWithSource(key).value;
  }

  set(key: string, value: string): void {
    if (!isValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
    }
    const fileConfig = this.readConfigFile();
    const workspaceRoot = (getNestedValue(fileConfig, KEY_TO_PATH["workspace.root"]) as string | undefined)
      || readOpenRigEnv(ENV_MAP["workspace.root"].primary, ENV_MAP["workspace.root"].legacy)
      || DEFAULT_WORKSPACE_ROOT;
    const coerced = coerceValue(key, value, workspaceRoot);
    setNestedValue(fileConfig, KEY_TO_PATH[key], coerced);
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  }

  /**
   * Clear an override. Without a key argument, deletes the whole config
   * file (revert all to defaults). With a key, removes just that key
   * from the config file.
   */
  reset(key?: string): void {
    if (key === undefined) {
      try { unlinkSync(this.configPath); } catch { /* missing is fine */ }
      return;
    }
    if (!isValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
    }
    if (!existsSync(this.configPath)) return;
    const fileConfig = this.readConfigFile();
    const parts = KEY_TO_PATH[key];
    const parentParts = parts.slice(0, -1);
    const leaf = parts[parts.length - 1]!;
    const parent = getNestedValue(fileConfig, parentParts) as Record<string, unknown> | undefined;
    if (parent && leaf in parent) {
      delete parent[leaf];
    }
    writeFileSync(this.configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  }

  private readConfigFile(): Record<string, unknown> {
    if (!existsSync(this.configPath)) return {};
    const raw = readFileSync(this.configPath, "utf-8");
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(
        `Config file at ${this.configPath} is malformed. Fix the JSON or reset with: rig config reset`
      );
    }
  }
}

// --- User Settings v0: named-pair decoder ---
//
// `files.allowlist` and `progress.scan_roots` are stored as the same
// comma-separated `name:/abs/path` strings UEP introduced via env var.
// This helper decodes the raw string into structured pairs. Invalid
// entries (no colon, empty name/path) are silently skipped per UEP
// convention; duplicate names: last wins.

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
