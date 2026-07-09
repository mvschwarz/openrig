// OPR.0.4.4.11 — the SHARED daemon-side hosts-registry read module (the P3/P4
// interface cell, pm-lead ruling c): P3 uses it for topology placement
// resolution + validation messages; P4's fan-out aggregation consumes the
// SAME module. Land once, here; P4 must not re-implement it.
//
// READ-ONLY FOREVER (arch ruling 3): the registry is operator-managed YAML at
// ~/.openrig/hosts.yaml; nothing in the daemon ever writes it. This module
// MIRRORS the CLI's packages/cli/src/host-registry.ts schema + validation
// (incl. the exactly-one-bearer rule) — the CLI copy is deliberately
// untouched this slice (no-unification boundary); the twin is held in sync by
// packages/daemon/test/hosts-registry-parity.test.ts, the same discipline as
// the scope-audit CLI/daemon twins.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";

export interface SshHostEntry {
  id: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HttpHostEntry {
  id: string;
  transport: "http";
  url: string;
  bearer_env?: string;
  bearer_file?: string;
  notes?: string;
}

export type HostEntry = SshHostEntry | HttpHostEntry;

export interface HostRegistry {
  hosts: HostEntry[];
}

export type HostRegistryLoadResult =
  | { ok: true; registry: HostRegistry }
  | { ok: false; error: string };

export type HostResolution =
  | { ok: true; host: HostEntry }
  | { ok: false; error: string };

// OPR.0.4.6.MH1 FR-7 — reserved host ids, MIRRORED verbatim from the
// CLI twin (packages/cli/src/host-registry.ts RESERVED_HOST_IDS; the
// parity test pins both). See the CLI twin for the collision rationale.
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local"]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/** Load + validate the operator's hosts registry (read-only). Mirrors the CLI
 *  loader's error surfaces so operators see one vocabulary everywhere. */
export function loadHostRegistry(path: string = defaultHostRegistryPath()): HostRegistryLoadResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `host registry not found at ${path}. Create it with a 'hosts:' array; transport: ssh (target + user) or http (url + bearer_env/bearer_file).`,
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
    if (RESERVED_HOST_IDS.has(id)) {
      return {
        ok: false,
        error: `${prefix}.id: '${id}' is a reserved host id (reserved set: ${[...RESERVED_HOST_IDS].sort().join(", ")}). 'kernel' and 'host' collide with human-seat session classification (@kernel/@host), and 'local' is the local host itself — pick a different id.`,
      };
    }
    // OPR.0.4.6.MH1 rev1-r2 B1 — host ids name FILES (the pair verb's
    // bearer_file path embeds the id) and render in tables: path-bearing
    // ids are rejected at the registry door, same home as reserved ids.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return {
        ok: false,
        error: `${prefix}.id: '${id}' is not a valid host id — allowed: letters, digits, dot, underscore, dash (starting with a letter or digit). Host ids name credential files; path characters are not allowed.`,
      };
    }
    seenIds.add(id);
    const transport = entry["transport"];
    if (typeof transport !== "string" || !KNOWN_TRANSPORTS.has(transport)) {
      return {
        ok: false,
        error: `${prefix}.transport: must be one of ${[...KNOWN_TRANSPORTS].sort().join(", ")} (got ${JSON.stringify(transport)})`,
      };
    }
    const notes = entry["notes"];
    if (notes !== undefined && typeof notes !== "string") {
      return { ok: false, error: `${prefix}.notes: optional, but if present must be a string` };
    }

    if (transport === "ssh") {
      const target = entry["target"];
      if (typeof target !== "string" || target.trim() === "") {
        return { ok: false, error: `${prefix}.target: required non-empty string (an ssh target)` };
      }
      const user = entry["user"];
      if (user !== undefined && (typeof user !== "string" || user.trim() === "")) {
        return { ok: false, error: `${prefix}.user: optional, but if present must be a non-empty string` };
      }
      validated.push({
        id,
        transport: "ssh",
        target,
        ...(user !== undefined ? { user: user as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    } else if (transport === "http") {
      const url = entry["url"];
      if (typeof url !== "string" || url.trim() === "") {
        return { ok: false, error: `${prefix}.url: required non-empty string (the remote daemon's base URL)` };
      }
      const bearerEnv = entry["bearer_env"];
      const bearerFile = entry["bearer_file"];
      const hasEnv = bearerEnv !== undefined;
      const hasFile = bearerFile !== undefined;
      if (!hasEnv && !hasFile) {
        return { ok: false, error: `${prefix}: http transport requires exactly one of bearer_env or bearer_file` };
      }
      if (hasEnv && hasFile) {
        return { ok: false, error: `${prefix}: specify exactly one of bearer_env or bearer_file, not both` };
      }
      if (hasEnv && (typeof bearerEnv !== "string" || bearerEnv.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_env: must be a non-empty env var name` };
      }
      if (hasFile && (typeof bearerFile !== "string" || bearerFile.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_file: must be a non-empty file path` };
      }
      validated.push({
        id,
        transport: "http",
        url: url as string,
        ...(hasEnv ? { bearer_env: bearerEnv as string } : {}),
        ...(hasFile ? { bearer_file: bearerFile as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    }
  }
  return { ok: true, registry: { hosts: validated } };
}

/** Resolve a host id for placement. Unknown id names the requested id and
 *  lists up to 10 known ids — the FR-4 per-entry validation message rides
 *  this (what/why/fix, before any launch attempt). */
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

/** FR-4: placement requires a transport that can carry remote-up. v0 that is
 *  the http transport (the shipped remote single-rig leaf is POST /api/up
 *  over runRemoteHttpOp); ssh-transport hosts are reachable for send/capture
 *  but cannot carry remote-up — a structured per-entry error, not a launch
 *  attempt. */
export function resolvePlacementHost(registry: HostRegistry, id: string): HostResolution {
  const res = resolveHost(registry, id);
  if (!res.ok) return res;
  if (res.host.transport !== "http") {
    return {
      ok: false,
      error: `host '${id}' uses transport '${res.host.transport}', which cannot carry remote rig-up. Placement requires an http-transport host (url + bearer_env/bearer_file) — update the registry entry or launch that rig locally.`,
    };
  }
  return res;
}
