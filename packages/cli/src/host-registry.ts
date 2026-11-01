import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { getDefaultOpenRigPath } from "./openrig-compat.js";
import { VIRTUAL_DOMAIN_TOKENS } from "./session-name.js";
import type { FailedStep } from "./cross-host-types.js";

export type { FailedStep };

// Only reading and writing hosts.yaml need yaml (~70 modules): it is required on that first use, so a
// caller that only validates an entry (a seat's origin check, on each of its commands) never loads it.
const yaml = (): typeof import("yaml") => createRequire(import.meta.url)("yaml") as typeof import("yaml");

export interface RemoteBearerResolution {
  ok: true;
  /** Absent for an anonymous (URL-only) host — a tokenless daemon, no
   *  Authorization header is sent. Present when bearer_env/bearer_file resolves. */
  token?: string;
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
  // No bearer configured is now a VALID anonymous host — a tokenless daemon
  // (host+VM are one founder-owned trust domain; the mesh is the auth
  // boundary). No token means no Authorization header downstream. A
  // configured-but-unresolvable pointer still fails above (fail-closed).
  return { ok: true };
}

/** Build the Authorization header for a resolved remote bearer. An anonymous
 *  (URL-only) host resolves to no token → no header (tokenless daemon). */
export function bearerAuthHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
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
  /**
   * The observed, immutable self-id of the host this entry points at — the JOIN KEY.
   *
   * `id` is MY label for that machine; `hostId` is what that machine calls itself and stamps into
   * every envelope it sends. Optional because every entry that exists today predates the field:
   * absent means "never learned", which resolves exactly as it does now. Nothing populates this
   * automatically in this slice.
   */
  hostId?: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HttpHostEntry {
  id: string;
  /** The observed self-id of the host this entry points at — the join key. See SshHostEntry.hostId. */
  hostId?: string;
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
//
// M1 A1 — the virtual-domain tokens (VIRTUAL_DOMAIN_TOKENS, the A2 closed set = ONE
// source of truth) join the reserved host ids: a host registered `external` would make
// the `<local>@external` virtual-domain classification ambiguous (X@Y@external). The
// rig-name mint gate reserves the SAME tokens for the rig namespace (rigspec-preflight).
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local", ...VIRTUAL_DOMAIN_TOKENS]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/**
 * Load and validate the host registry from disk. v0 file shape:
 *
 *     hosts:
 *       - id: remote-dev
 *         transport: ssh
 *         target: remote-dev.local
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
      error: `host registry not found at ${path}. Create it with a 'hosts:' array; transport: ssh (target + user) or http (url; optional bearer_env or bearer_file — omit both for a tokenless daemon).`,
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
    parsed = yaml().parse(raw);
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
    // The join key is an id like any other, so it earns the SAME rules `id` already has — it can
    // reach a table and a path just as easily. The generated `host-XXXXXXXX` form passes them.
    const hostId = entry["hostId"];
    if (hostId !== undefined) {
      if (typeof hostId !== "string" || hostId.trim() === "") {
        return { ok: false, error: `${prefix}.hostId: optional, but if present must be a non-empty string` };
      }
      if (RESERVED_HOST_IDS.has(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId: '${hostId}' is a reserved host id (reserved set: ${[...RESERVED_HOST_IDS].sort().join(", ")}) — a join key names a real machine's own identity and can never be one of these.`,
        };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId: '${hostId}' is not a valid host id — allowed: letters, digits, dot, underscore, dash (starting with a letter or digit).`,
        };
      }
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
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
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
      // bearer_env / bearer_file are OPTIONAL: omit both for an
      // anonymous/tokenless daemon (no Authorization sent). At most one may
      // be set — never both.
      if (hasEnv && hasFile) {
        return { ok: false, error: `${prefix}: specify at most one of bearer_env or bearer_file, not both (omit both for an anonymous/tokenless daemon)` };
      }
      if (hasEnv && (typeof bearerEnv !== "string" || bearerEnv.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_env: must be a non-empty env var name` };
      }
      if (hasFile && (typeof bearerFile !== "string" || bearerFile.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_file: must be a non-empty file path` };
      }
      validated.push({
        id,
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
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

export function resolveHost(
  registry: HostRegistry,
  id: string,
  learnedBindings?: Record<string, { hostId: string }>,
): HostResolution {
  // alias -> id -> transport. The human alias is the intentional handle, so an `id` match is tried
  // across the WHOLE registry before any join key — that tiebreak is defined rather than accidental,
  // even though a collision with a random self-id is near-impossible. A registry-declared `hostId`
  // outranks a sidecar-learned binding for the same reason: the operator wrote it down.
  const match = registry.hosts.find((h) => h.id === id)
    ?? registry.hosts.find((h) => h.hostId === id)
    ?? (learnedBindings ? registry.hosts.find((h) => learnedBindings[h.id]?.hostId === id) : undefined);
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
// transport-appropriate fields, at-most-one-bearer — bearer optional for a
// tokenless daemon, never both). The standard path never
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
    writeFileSync(tmp, yaml().stringify({ hosts: validated.registry.hosts }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `failed to write host registry at ${path}: ${(err as Error).message}` };
  }
  return { ok: true, path, entry };
}

// ---------------------------------------------------------------------------
// OPR.0.4.6.MH1 FR-1 extension (issue #2128, maintainer boundary) — the
// edit/remove write paths, through the SAME ONE write contract as add:
// load-validate (a present-but-invalid registry is NEVER overwritten),
// candidate through validateHostRegistry (add-time errors are load-time
// errors, verbatim), atomic tmp+rename at 0600.
//
// Boundary pinned here: an edit keeps the host's id and transport FIXED;
// unknown fields fail loud with the allowed set (a typo'd flag must never
// silently no-op an edit); an empty string clears an OPTIONAL field (user,
// notes) — clearing is how a wrong value is dropped, while required fields
// (target, url) keep the validator's non-empty rule; remove deletes ONLY the
// registry entry (no credential files, no learned identity, no selection).
//
// The daemon twin (packages/daemon/src/domain/hosts/hosts-registry-writer.ts)
// mirrors updateHostEntry/removeHostEntry verbatim; byte parity is pinned by
// packages/daemon/test/hosts-registry-parity.test.ts.
// ---------------------------------------------------------------------------

/** Fields an edit may touch, per transport. id/transport never appear here. */
const EDITABLE_FIELDS: Record<"ssh" | "http", readonly string[]> = {
  ssh: ["target", "user", "notes"],
  http: ["url", "notes"],
};

/** Optional editable fields an empty string CLEARS (drops the key). */
const CLEARABLE_FIELDS = new Set(["user", "notes"]);

export type UpdateHostResult =
  | { ok: true; path: string; entry: HostEntry; previous: HostEntry }
  | { ok: false; error: string };

export type RemoveHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

/** The write-path load: MISSING is an error here (nothing to edit/remove) with
 *  the loader's canonical message; INVALID is a loud refusal, never clobbered. */
function loadExistingForWrite(path: string): { ok: true; existing: HostEntry[] } | { ok: false; error: string } {
  const loaded = loadHostRegistry(path);
  if (loaded.ok) return { ok: true, existing: loaded.registry.hosts };
  const prefix = existsSync(path) ? "refusing to modify an invalid registry: " : "";
  return { ok: false, error: prefix + loaded.error };
}

/** Unknown-id error for a WRITE: names the id, lists known ids (resolveHost's shape). */
function unknownHostIdError(existing: HostEntry[], id: string): string {
  const knownIds = existing.map(h => h.id).slice(0, 10);
  const hint = knownIds.length > 0
    ? ` Known host ids: ${knownIds.join(", ")}${existing.length > knownIds.length ? ` (+${existing.length - knownIds.length} more)` : ""}.`
    : " (registry is empty)";
  return `unknown host id '${id}'.${hint}`;
}

/** The atomic registry write the write contract shares (tmp+rename, 0600). */
function writeRegistryFile(path: string, hosts: HostEntry[]): string | null {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.hosts.yaml.tmp-${process.pid}`);
    writeFileSync(tmp, yaml().stringify({ hosts }), { mode: 0o600 });
    renameSync(tmp, path);
    return null;
  } catch (err) {
    return `failed to write host registry at ${path}: ${(err as Error).message}`;
  }
}

/** Apply an edit to ONE entry: id/transport fixed, unknown fields refused,
 *  empty string clears an optional field, then the WHOLE registry validates. */
export function updateHostEntry(id: string, changes: Record<string, unknown>, path: string = defaultHostRegistryPath()): UpdateHostResult {
  const loaded = loadExistingForWrite(path);
  if (!loaded.ok) return loaded;
  const idx = loaded.existing.findIndex(h => h.id === id);
  if (idx === -1) return { ok: false, error: unknownHostIdError(loaded.existing, id) };
  const previous = loaded.existing[idx]!;

  if (changes["id"] !== undefined && changes["id"] !== id) {
    return { ok: false, error: `an edit keeps the host's id fixed — '${id}' cannot become '${String(changes["id"])}'` };
  }
  if (changes["transport"] !== undefined) {
    return { ok: false, error: `an edit keeps the host's transport fixed — '${id}' stays '${previous.transport}'` };
  }
  const allowed = EDITABLE_FIELDS[previous.transport];
  const effective: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "id") continue; // an id echo naming the same host is a no-op
    if (!allowed.includes(key)) {
      return { ok: false, error: `field '${key}' is not editable on an ${previous.transport} host (editable fields: ${allowed.join(", ")})` };
    }
    effective[key] = value;
  }
  if (Object.keys(effective).length === 0) {
    return { ok: false, error: "no changes given" };
  }

  const updated = { ...previous } as Record<string, unknown>;
  for (const [key, value] of Object.entries(effective)) {
    if (CLEARABLE_FIELDS.has(key) && value === "") delete updated[key];
    else updated[key] = value;
  }
  const candidate = loaded.existing.map((h, i) => (i === idx ? updated as unknown as HostEntry : h));
  const validated = validateHostRegistry({ hosts: candidate }, path);
  if (!validated.ok) return { ok: false, error: validated.error };
  const entry = validated.registry.hosts.find(h => h.id === id);
  if (!entry) return { ok: false, error: `host '${id}' did not survive validation` };
  const writeError = writeRegistryFile(path, validated.registry.hosts);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, path, entry, previous };
}

/** Remove ONE entry — only the registry entry; nothing else is touched. */
export function removeHostEntry(id: string, path: string = defaultHostRegistryPath()): RemoveHostResult {
  const loaded = loadExistingForWrite(path);
  if (!loaded.ok) return loaded;
  const idx = loaded.existing.findIndex(h => h.id === id);
  if (idx === -1) return { ok: false, error: unknownHostIdError(loaded.existing, id) };
  const entry = loaded.existing[idx]!;
  const remaining = loaded.existing.filter((_, i) => i !== idx);
  const validated = validateHostRegistry({ hosts: remaining }, path);
  if (!validated.ok) return { ok: false, error: validated.error };
  const writeError = writeRegistryFile(path, validated.registry.hosts);
  if (writeError) return { ok: false, error: writeError };
  return { ok: true, path, entry };
}
