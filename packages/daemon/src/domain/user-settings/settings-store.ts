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
] as const;

export type SettingsValidKey = typeof SETTINGS_VALID_KEYS[number];

const ENV_MAP: Record<SettingsValidKey, { primary: string; legacy: string }> = {
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  "daemon.host": { primary: "OPENRIG_HOST", legacy: "RIGGED_HOST" },
  "db.path": { primary: "OPENRIG_DB", legacy: "RIGGED_DB" },
  "transcripts.enabled": { primary: "OPENRIG_TRANSCRIPTS_ENABLED", legacy: "RIGGED_TRANSCRIPTS_ENABLED" },
  "transcripts.path": { primary: "OPENRIG_TRANSCRIPTS_PATH", legacy: "RIGGED_TRANSCRIPTS_PATH" },
  "workspace.root": { primary: "OPENRIG_WORKSPACE_ROOT", legacy: "RIGGED_WORKSPACE_ROOT" },
  "workspace.slices_root": { primary: "OPENRIG_WORKSPACE_SLICES_ROOT", legacy: "RIGGED_WORKSPACE_SLICES_ROOT" },
  "workspace.steering_path": { primary: "OPENRIG_WORKSPACE_STEERING_PATH", legacy: "RIGGED_WORKSPACE_STEERING_PATH" },
  "workspace.field_notes_root": { primary: "OPENRIG_WORKSPACE_FIELD_NOTES_ROOT", legacy: "RIGGED_WORKSPACE_FIELD_NOTES_ROOT" },
  "workspace.specs_root": { primary: "OPENRIG_WORKSPACE_SPECS_ROOT", legacy: "RIGGED_WORKSPACE_SPECS_ROOT" },
  "files.allowlist": { primary: "OPENRIG_FILES_ALLOWLIST", legacy: "RIGGED_FILES_ALLOWLIST" },
  "progress.scan_roots": { primary: "OPENRIG_PROGRESS_SCAN_ROOTS", legacy: "RIGGED_PROGRESS_SCAN_ROOTS" },
  "ui.preview.refresh_interval_seconds": { primary: "OPENRIG_UI_PREVIEW_REFRESH_INTERVAL_SECONDS", legacy: "RIGGED_UI_PREVIEW_REFRESH_INTERVAL_SECONDS" },
  "ui.preview.max_pins": { primary: "OPENRIG_UI_PREVIEW_MAX_PINS", legacy: "RIGGED_UI_PREVIEW_MAX_PINS" },
  "ui.preview.default_lines": { primary: "OPENRIG_UI_PREVIEW_DEFAULT_LINES", legacy: "RIGGED_UI_PREVIEW_DEFAULT_LINES" },
};

const KEY_TO_PATH: Record<SettingsValidKey, string[]> = {
  "daemon.port": ["daemon", "port"],
  "daemon.host": ["daemon", "host"],
  "db.path": ["db", "path"],
  "transcripts.enabled": ["transcripts", "enabled"],
  "transcripts.path": ["transcripts", "path"],
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

function readEnv(primary: string, legacy: string): string | undefined {
  const p = process.env[primary];
  if (p !== undefined && p !== "") return p;
  const l = process.env[legacy];
  if (l !== undefined && l !== "") return l;
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
    case "workspace.slices_root":      return path.join(workspaceRoot, "slices");
    case "workspace.steering_path":    return path.join(workspaceRoot, "steering", "STEERING.md");
    case "workspace.field_notes_root": return path.join(workspaceRoot, "field-notes");
    case "workspace.specs_root":       return path.join(workspaceRoot, "specs");
    default: return "";
  }
}

const WORKSPACE_DERIVED_KEYS: ReadonlySet<SettingsValidKey> = new Set([
  "workspace.slices_root",
  "workspace.steering_path",
  "workspace.field_notes_root",
  "workspace.specs_root",
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
    case "workspace.root": return DEFAULT_WORKSPACE_ROOT;
    case "files.allowlist": return "";
    case "progress.scan_roots": return "";
    // Preview Terminal v0 (PL-018) defaults — match cli/src/config-store.ts.
    case "ui.preview.refresh_interval_seconds": return 3;
    case "ui.preview.max_pins": return 4;
    case "ui.preview.default_lines": return 50;
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
  filesAllowlistRaw: string;
  progressScanRootsRaw: string;
  // Preview Terminal v0 (PL-018) — UI preview preferences.
  uiPreviewRefreshIntervalSeconds: number;
  uiPreviewMaxPins: number;
  uiPreviewDefaultLines: number;
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
      filesAllowlistRaw: this.resolveOne("files.allowlist", fc, wr).value as string,
      progressScanRootsRaw: this.resolveOne("progress.scan_roots", fc, wr).value as string,
      uiPreviewRefreshIntervalSeconds: this.resolveOne("ui.preview.refresh_interval_seconds", fc, wr).value as number,
      uiPreviewMaxPins: this.resolveOne("ui.preview.max_pins", fc, wr).value as number,
      uiPreviewDefaultLines: this.resolveOne("ui.preview.default_lines", fc, wr).value as number,
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
