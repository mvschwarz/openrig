import fs from "node:fs";
import path from "node:path";
import { getOpenRigHome } from "../../../openrig-compat.js";

export interface MatrixConnectorConfig {
  enabled: boolean;
  homeserverUrl: string | null;
  deviceId: string | null;
  defaultRoom: string | null;
  secretsEnvFile: string | null;
  inboundDestination: string;
}

export const DEFAULT_CONFIG: MatrixConnectorConfig = {
  enabled: false, homeserverUrl: null, deviceId: null, defaultRoom: null,
  secretsEnvFile: null, inboundDestination: "operator-agent@kernel",
};

// Room identifiers contain a colon; never split them as Slack's positional fields.
export const ROOM_PATTERN = /^[!#][^\s:]+:[^\s]+$/;
export const USER_PATTERN = /^@[^\s:]+:[^\s]+$/;

export function parseMatrixBinding(spec: string): {
  kind: "matrix"; connectorRef: string; secretsRef: string; role: "primary" | "secondary"; handle?: string;
} {
  // Short form uses this connector's configured secret store. The optional suffix
  // keeps role and sender identity explicit without confusing a server's port with a field.
  const match = /^matrix:([^;]+)(?:;role=(primary|secondary))?(?:;handle=([^;]+))?$/.exec(spec);
  if (!match || !ROOM_PATTERN.test(match[1]!)) {
    throw new Error("Matrix binding must be matrix:!room:server or matrix:#alias:server[;role=primary|secondary][;handle=@user:server]");
  }
  if (match[3] && !USER_PATTERN.test(match[3])) throw new Error("Matrix handle must be @user:server");
  return {
    kind: "matrix", connectorRef: match[1]!, secretsRef: "matrix-config",
    role: (match[2] ?? "primary") as "primary" | "secondary",
    ...(match[3] ? { handle: match[3] } : {}),
  };
}

export function validateConfig(cfg: MatrixConnectorConfig): void {
  if (typeof cfg.enabled !== "boolean") throw new Error("Matrix enabled must be a boolean");
  if (cfg.homeserverUrl !== null) {
    if (typeof cfg.homeserverUrl !== "string" || !cfg.homeserverUrl.trim()) throw new Error("Matrix homeserver URL must be a non-empty string or null");
    const url = new URL(cfg.homeserverUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("Matrix homeserver URL must be an HTTP(S) URL without credentials, query or fragment");
    }
  }
  if (cfg.defaultRoom !== null && (typeof cfg.defaultRoom !== "string" || !ROOM_PATTERN.test(cfg.defaultRoom))) throw new Error("Matrix default room must be !room:server or #alias:server");
  for (const key of ["deviceId", "secretsEnvFile"] as const) {
    if (cfg[key] !== null && (typeof cfg[key] !== "string" || !cfg[key]!.trim())) throw new Error(`Matrix ${key} must be a non-empty string or null`);
  }
  if (typeof cfg.inboundDestination !== "string" || !cfg.inboundDestination.trim()) throw new Error("Matrix inbound destination is required");
}

export function configPathFor(home = getOpenRigHome()): string {
  return path.join(home, "matrix-connector.json");
}

export function loadConfig(home?: string): MatrixConnectorConfig {
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(configPathFor(home), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_CONFIG };
    throw error; // A corrupt config is a visible failure, not a disabled connector.
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Matrix config must be an object");
  const cfg = { ...DEFAULT_CONFIG, ...raw };
  validateConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: MatrixConnectorConfig, home?: string): string {
  validateConfig(cfg);
  const file = configPathFor(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return file;
}
