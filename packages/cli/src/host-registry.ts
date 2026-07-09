import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getDefaultOpenRigPath } from "./openrig-compat.js";
import type { FailedStep } from "./cross-host-types.js";

export type { FailedStep };

export interface RemoteBearerResolution {
  ok: true;
  token: string;
}

export interface RemoteBearerFailure {
  ok: false;
  failedStep: FailedStep;
  error: string;
}

export function resolveRemoteBearer(host: HttpHostEntry): RemoteBearerResolution | RemoteBearerFailure {
  if (host.bearer_env) {
    const token = process.env[host.bearer_env]?.trim();
    if (token) return { ok: true, token };
    return { ok: false, failedStep: "permission-gate", error: `bearer env var ${host.bearer_env} is not set or empty for host ${host.id}` };
  }
  if (host.bearer_file) {
    try {
      const token = readFileSync(host.bearer_file, "utf-8").trim();
      if (token) return { ok: true, token };
      return { ok: false, failedStep: "permission-gate", error: `bearer file ${host.bearer_file} is empty for host ${host.id}` };
    } catch {
      return { ok: false, failedStep: "permission-gate", error: `bearer file ${host.bearer_file} not readable for host ${host.id}` };
    }
  }
  return { ok: false, failedStep: "permission-gate", error: `host ${host.id} has no bearer_env or bearer_file configured` };
}

export function classifyHttpFailedStep(status: number, body?: { error?: string }): FailedStep {
  if (status >= 200 && status < 300) return "none";
  if (status === 401 || status === 403) return "permission-gate";
  if (status >= 400 && status < 600) return "remote-command-failed";
  return "remote-daemon-unreachable";
}

export function classifyHttpError(_err: unknown): FailedStep {
  return "remote-daemon-unreachable";
}

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

// OPR.0.4.6.MH1 FR-7 — reserved host ids (the cheap collision guard,
// arch rail 4): `kernel` and `host` are lexically claimed by the
// human-seat regex family (`@(kernel|host)$` — a host id reusing them
// would make host-qualified surfaces ambiguous with human-seat
// classification), and `local` is the shipped LOCAL_HOST_ID constant
// (a registered remote named "local" would shadow the local host in
// every selection/fan-out surface). Rejected at add/pair AND surfaced
// as a load-time finding on pre-existing files (fail loud, never
// silent). Mirrored verbatim in the daemon reader twin (parity test).
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local"]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

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
 *         user: your-username  # optional
 *         notes: "Tart VM"     # optional
 *
 * Operator-managed; v0 does NOT auto-write or auto-modify this file. A missing
 * file returns a clear error pointing at the canonical path.
 */
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

/**
 * Resolve a host id against a loaded registry. Unknown id returns an error
 * naming the requested id and listing up to 10 known ids for discoverability.
 */
export function hostDisplayTarget(host: HostEntry): string {
  return host.transport === "ssh" ? host.target : host.url;
}

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

// ---------------------------------------------------------------------------
// OPR.0.4.4.13 FR-1 — the registry WRITE path (rig host add).
//
// ONE validation source: the candidate registry (existing entries + the new
// raw entry) is validated by the SAME validateHostRegistry the loader uses —
// add-time errors are load-time errors, verbatim (incl. duplicate ids,
// transport-appropriate fields, exactly-one-bearer). The standard path never
// hand-edits YAML; note: add REWRITES the file canonically (hand-authored
// comments are not preserved — hand-editing remains the path for exotica).
// ---------------------------------------------------------------------------

export type AddHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

/** OPR.0.4.6.MH1 (arch P3/P4): the CLI half of the ONE registry write
 *  contract — the daemon twin (packages/daemon/src/domain/hosts/
 *  hosts-registry-writer.ts) mirrors this verbatim, byte-parity-pinned by
 *  test. Concurrency ceiling (P4): atomic tmp+rename, whole-file
 *  LAST-WRITE-WINS on a concurrent add — one operator-scale registry
 *  file, NO locking machinery by design; a dropped concurrent entry
 *  re-converges by re-running the add. */
export function addHostEntry(rawEntry: Record<string, unknown>, path: string = defaultHostRegistryPath()): AddHostResult {
  // Load what exists; a MISSING file is a valid starting point for `add`
  // (the verb exists so operators never hand-create the YAML), but a present-
  // but-invalid file is a loud error — never silently clobber operator state.
  let existing: HostEntry[] = [];
  if (existsSync(path)) {
    const loaded = loadHostRegistry(path);
    if (!loaded.ok) {
      return { ok: false, error: `refusing to modify an invalid registry: ${loaded.error}` };
    }
    existing = loaded.registry.hosts;
  }

  const candidate = { hosts: [...existing, rawEntry] };
  const validated = validateHostRegistry(candidate, path);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const entry = validated.registry.hosts[validated.registry.hosts.length - 1]!;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.hosts.yaml.tmp-${process.pid}`);
    writeFileSync(tmp, stringifyYaml({ hosts: validated.registry.hosts }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `failed to write host registry at ${path}: ${(err as Error).message}` };
  }
  return { ok: true, path, entry };
}
