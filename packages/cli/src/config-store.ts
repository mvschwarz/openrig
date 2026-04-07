import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  getCompatibleOpenRigPath,
  getDefaultOpenRigPath,
  readOpenRigEnv,
} from "./openrig-compat.js";

export interface RiggedConfig {
  daemon: { port: number; host: string };
  db: { path: string };
  transcripts: { enabled: boolean; path: string };
}

const DEFAULTS: RiggedConfig = {
  daemon: { port: 7433, host: "127.0.0.1" },
  db: { path: getDefaultOpenRigPath("openrig.sqlite") },
  transcripts: { enabled: true, path: getDefaultOpenRigPath("transcripts") },
};

const VALID_KEYS = [
  "daemon.port",
  "daemon.host",
  "db.path",
  "transcripts.enabled",
  "transcripts.path",
] as const;

type ValidKey = typeof VALID_KEYS[number];

const ENV_MAP: Record<ValidKey, { primary: string; legacy: string }> = {
  "daemon.port": { primary: "OPENRIG_PORT", legacy: "RIGGED_PORT" },
  "daemon.host": { primary: "OPENRIG_HOST", legacy: "RIGGED_HOST" },
  "db.path": { primary: "OPENRIG_DB", legacy: "RIGGED_DB" },
  "transcripts.enabled": { primary: "OPENRIG_TRANSCRIPTS_ENABLED", legacy: "RIGGED_TRANSCRIPTS_ENABLED" },
  "transcripts.path": { primary: "OPENRIG_TRANSCRIPTS_PATH", legacy: "RIGGED_TRANSCRIPTS_PATH" },
};

function isValidKey(key: string): key is ValidKey {
  return (VALID_KEYS as readonly string[]).includes(key);
}

function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
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

function getDefaultValue(key: ValidKey): string | number | boolean {
  return getNestedValue(DEFAULTS as unknown as Record<string, unknown>, key) as string | number | boolean;
}

function coerceValue(key: ValidKey, raw: string): string | number | boolean {
  const defaultVal = getDefaultValue(key);
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

export class ConfigStore {
  readonly configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? getCompatibleOpenRigPath("config.json");
  }

  resolve(): RiggedConfig {
    const fileConfig = this.readConfigFile();

    const resolveKey = (key: ValidKey): string | number | boolean => {
      // 1. Environment variable
      const envVal = readOpenRigEnv(ENV_MAP[key].primary, ENV_MAP[key].legacy);
      if (envVal !== undefined && envVal !== "") {
        return coerceValue(key, envVal);
      }
      // 2. Config file
      const fileVal = getNestedValue(fileConfig, key);
      if (fileVal !== undefined && fileVal !== null) {
        return fileVal as string | number | boolean;
      }
      // 3. Default
      return getDefaultValue(key);
    };

    return {
      daemon: {
        port: resolveKey("daemon.port") as number,
        host: resolveKey("daemon.host") as string,
      },
      db: {
        path: resolveKey("db.path") as string,
      },
      transcripts: {
        enabled: resolveKey("transcripts.enabled") as boolean,
        path: resolveKey("transcripts.path") as string,
      },
    };
  }

  get(key: string): string | number | boolean {
    if (!isValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
    }
    const config = this.resolve();
    return getNestedValue(config as unknown as Record<string, unknown>, key) as string | number | boolean;
  }

  set(key: string, value: string): void {
    if (!isValidKey(key)) {
      throw new Error(`Unknown config key "${key}". Valid keys: ${VALID_KEYS.join(", ")}`);
    }
    const coerced = coerceValue(key, value);
    // readConfigFile (not Raw) — throws on malformed config so set doesn't silently overwrite
    const fileConfig = this.readConfigFile();
    setNestedValue(fileConfig, key, coerced);
    mkdirSync(dirname(this.configPath), { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
  }

  reset(): void {
    try {
      unlinkSync(this.configPath);
    } catch {
      // File doesn't exist — that's fine
    }
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
