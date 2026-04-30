import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "./openrig-compat.js";

/**
 * A single declared host in `~/.openrig/hosts.yaml`. v0 supports `transport: ssh`
 * only. `target` is whatever ssh resolves (DNS, SSH config alias, IP, etc.).
 */
export interface HostEntry {
  id: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HostRegistry {
  hosts: HostEntry[];
}

export type HostRegistryLoadResult =
  | { ok: true; registry: HostRegistry }
  | { ok: false; error: string };

export type HostResolution =
  | { ok: true; host: HostEntry }
  | { ok: false; error: string };

const KNOWN_TRANSPORTS = new Set(["ssh"]);

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/**
 * Load and validate the host registry from disk. v0 file shape:
 *
 *     hosts:
 *       - id: vm-claude-test
 *         transport: ssh
 *         target: vm-claude-test.local
 *         user: wrandom        # optional
 *         notes: "Tart VM"     # optional
 *
 * Operator-managed; v0 does NOT auto-write or auto-modify this file. A missing
 * file returns a clear error pointing at the canonical path.
 */
export function loadHostRegistry(path: string = defaultHostRegistryPath()): HostRegistryLoadResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `host registry not found at ${path}. Create it with a 'hosts:' array of { id, transport, target, [user] } entries; v0 supports transport: ssh only.`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, error: `failed to read host registry at ${path}: ${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, error: `failed to parse host registry YAML at ${path}: ${(err as Error).message}` };
  }
  return validateHostRegistry(parsed, path);
}

export function validateHostRegistry(parsed: unknown, sourcePath: string): HostRegistryLoadResult {
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: `host registry at ${sourcePath} must be a YAML object with a 'hosts' array` };
  }
  const obj = parsed as Record<string, unknown>;
  const hosts = obj["hosts"];
  if (!Array.isArray(hosts)) {
    return { ok: false, error: `host registry at ${sourcePath}: 'hosts' must be an array` };
  }

  const seenIds = new Set<string>();
  const validated: HostEntry[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const raw = hosts[i];
    const prefix = `host registry at ${sourcePath}: hosts[${i}]`;
    if (raw === null || typeof raw !== "object") {
      return { ok: false, error: `${prefix}: must be an object with id/transport/target` };
    }
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: `${prefix}.id: required non-empty string` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `${prefix}.id: duplicate host id '${id}' (each host id must be unique within the registry)` };
    }
    seenIds.add(id);
    const transport = entry["transport"];
    if (transport !== "ssh") {
      return {
        ok: false,
        error: `${prefix}.transport: v0 supports 'ssh' only (got ${JSON.stringify(transport)}); declared known transports: ${[...KNOWN_TRANSPORTS].sort().join(", ")}`,
      };
    }
    const target = entry["target"];
    if (typeof target !== "string" || target.trim() === "") {
      return { ok: false, error: `${prefix}.target: required non-empty string (an ssh target — DNS name, SSH config alias, or IP)` };
    }
    const user = entry["user"];
    if (user !== undefined && (typeof user !== "string" || user.trim() === "")) {
      return { ok: false, error: `${prefix}.user: optional, but if present must be a non-empty string` };
    }
    const notes = entry["notes"];
    if (notes !== undefined && typeof notes !== "string") {
      return { ok: false, error: `${prefix}.notes: optional, but if present must be a string` };
    }
    validated.push({
      id,
      transport: "ssh",
      target,
      ...(user !== undefined ? { user: user as string } : {}),
      ...(notes !== undefined ? { notes: notes as string } : {}),
    });
  }
  return { ok: true, registry: { hosts: validated } };
}

/**
 * Resolve a host id against a loaded registry. Unknown id returns an error
 * naming the requested id and listing up to 10 known ids for discoverability.
 */
export function resolveHost(registry: HostRegistry, id: string): HostResolution {
  const match = registry.hosts.find((h) => h.id === id);
  if (match) return { ok: true, host: match };
  const knownIds = registry.hosts.map((h) => h.id).slice(0, 10);
  const idsHint = knownIds.length > 0
    ? ` Known host ids: ${knownIds.join(", ")}${registry.hosts.length > knownIds.length ? ` (+${registry.hosts.length - knownIds.length} more)` : ""}.`
    : " (registry is empty)";
  return {
    ok: false,
    error: `unknown host id '${id}'.${idsHint}`,
  };
}
