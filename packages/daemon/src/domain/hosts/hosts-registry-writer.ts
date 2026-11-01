// OPR.0.4.6.MH1 FR-5/FR-6 — the daemon-side hosts-registry WRITE twin
// (arch B1 ruling, pins P1–P4).
//
// The browser surface cannot reach the CLI's fs code, so the dashboard
// add/pair path writes through THIS module — a deliberate VERBATIM MIRROR
// of packages/cli/src/host-registry.ts addHostEntry, byte-parity-pinned
// by packages/daemon/test/hosts-add-pair-routes.test.ts (same entries in
// → identical yaml bytes out; P3) and sharing the reader twin's
// validateHostRegistry (identical validation: at-most-one-bearer — bearer
// optional for a tokenless daemon, never both — reserved ids, duplicate ids
// — P3). The reader module stays READ-ONLY
// FOREVER; writes flow ONLY through the single parity-pinned write
// contract (CLI addHostEntry + this twin), reachable daemon-side solely
// via the narrow named add/pair routes (P1 — no generic registry-write
// route exists).
//
// Concurrency (P4): atomic tmp+rename, whole-file LAST-WRITE-WINS on a
// concurrent add — the ceiling is one operator-scale registry file; NO
// locking machinery by design. Two simultaneous adds may drop one entry;
// re-running the add re-converges (add-time validation = load-time
// validation, verbatim).

import { existsSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  defaultHostRegistryPath,
  loadHostRegistry,
  validateHostRegistry,
  type HostEntry,
} from "./hosts-registry-reader.js";

export type AddHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

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

// ---------------------------------------------------------------------------
// OPR.0.4.6.MH1 FR-1 extension (issue #2128, maintainer boundary) — the
// edit/remove write paths, a VERBATIM MIRROR of the CLI twins in
// packages/cli/src/host-registry.ts (byte-parity-pinned by
// packages/daemon/test/hosts-registry-parity.test.ts). Same ONE write
// contract as add: load-validate (a present-but-invalid registry is NEVER
// overwritten), candidate through validateHostRegistry, atomic tmp+rename.
//
// Boundary pinned here: an edit keeps the host's id and transport FIXED;
// unknown fields fail loud with the allowed set; an empty string clears an
// OPTIONAL field (user, notes) while required fields (target, url) keep the
// validator's non-empty rule; remove deletes ONLY the registry entry.
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
    writeFileSync(tmp, stringifyYaml({ hosts }), { mode: 0o600 });
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
