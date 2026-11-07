// #2635: take a workflow spec out of the registry. Nothing removed a spec registered by
// `validate` / `instantiate` from a path outside the scanned workflows folder (a probe, a /tmp
// copy), so it stayed listed after its file was gone. The scanner's own removal pass (OQ-4) only
// owns the folder it walks; this is the operator's verb for everything else.
//
// The #511 rule holds here too: a version that unfinished work is pinned to is never removed.
// With --prune-missing such a version is retained (readable by name and version, hidden from
// discovery), exactly as the scanner retains it; a later prune removes it once that work ends.
import * as path from "node:path";
import { statSync } from "node:fs";
import type { EventBus } from "./event-bus.js";
import { RETAINED_STATUS, type WorkflowSpecCache } from "./workflow-spec-cache.js";

export interface UnregisteredSpec {
  name: string;
  version: string;
  sourcePath: string;
}

export interface KeptSpec extends UnregisteredSpec {
  /** pinned: unfinished work reads this version. scanned: the file is still in a folder the
   *  daemon scans (the workflows folder or the built-in starters), so the next scan would
   *  register it again; move or delete the file instead. unchecked: the file's presence couldn't be
   *  checked (an access error such as EACCES, not ENOENT), so --prune-missing doesn't treat it as gone. */
  reason: "pinned" | "scanned" | "unchecked";
}

export interface UnregisterResult {
  removed: UnregisteredSpec[];
  kept: KeptSpec[];
}

export class WorkflowSpecUnregisterError extends Error {
  constructor(public readonly code: "spec_selector_required" | "spec_not_found", message: string) {
    super(message);
    this.name = "WorkflowSpecUnregisterError";
  }
}

export interface UnregisterOpts {
  cache: WorkflowSpecCache;
  eventBus?: EventBus | null;
  /** Remove this workflow name; with pruneMissing, only its versions whose file is gone. */
  name?: string;
  /** Only this version of `name`. */
  version?: string;
  /** Remove every version whose source file no longer exists (scoped by name/version if given). */
  pruneMissing?: boolean;
  /** Folders the daemon scans on its own; an existing file there is not removed. */
  scannedDirs?: Array<string | null | undefined>;
}

/** present, absent (ENOENT / ENOTDIR) or unchecked: any other error, such as EACCES on a parent folder. */
function sourceState(sourcePath: string): "present" | "absent" | "unchecked" {
  try {
    statSync(sourcePath);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unchecked";
  }
}

function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c !== p && c.startsWith(p.endsWith(path.sep) ? p : `${p}${path.sep}`);
}

export function unregisterWorkflowSpecs(opts: UnregisterOpts): UnregisterResult {
  const name = opts.name?.trim() || undefined;
  // An empty version (`flow@`) is a usage error, never "every version" (#2676 review).
  if (opts.version !== undefined && opts.version !== null && opts.version.trim() === "") {
    throw new WorkflowSpecUnregisterError("spec_selector_required", "The version after @ is empty: use <name>@<version>, or <name> for every version.");
  }
  const version = opts.version?.trim() || undefined;
  if (!name && !opts.pruneMissing) {
    throw new WorkflowSpecUnregisterError("spec_selector_required", "Name a workflow spec (<name>[@<version>]) or pass --prune-missing.");
  }
  if (version && !name) {
    throw new WorkflowSpecUnregisterError("spec_selector_required", "A version needs the workflow name: <name>@<version>.");
  }
  const scannedDirs = (opts.scannedDirs ?? []).filter((dir): dir is string => typeof dir === "string" && dir.length > 0);
  const rows = opts.cache.listRowRefs();

  const result: UnregisterResult = { removed: [], kept: [] };
  let matched = 0;
  for (const row of rows) {
    // The stored identity also covers a row an older diagnostic writer blanked (#511).
    const identity = opts.cache.storedIdentity(row.specId);
    if (name && identity?.name !== name) continue;
    if (version && identity?.version !== version) continue;
    const state = sourceState(row.sourcePath);
    const missing = state === "absent";
    if (opts.pruneMissing && state === "present") continue;
    matched += 1;
    const entry: UnregisteredSpec = { name: identity?.name ?? "", version: identity?.version ?? "", sourcePath: row.sourcePath };

    if (identity && opts.cache.isPinnedByUnfinishedWork(identity.name, identity.version)) {
      // A pinned version whose file is gone leaves discovery but stays readable (#511).
      if (missing && row.status !== RETAINED_STATUS) opts.cache.retain(row.specId);
      result.kept.push({ ...entry, reason: "pinned" });
      continue;
    }
    // A file whose presence couldn't be checked is not a missing file: a prune keeps it, and so does an explicit
    // unregister inside a scanned folder, where it may still be there.
    if (state === "unchecked" && (opts.pruneMissing || scannedDirs.some((dir) => isUnder(row.sourcePath, dir)))) {
      result.kept.push({ ...entry, reason: "unchecked" });
      continue;
    }
    if (state === "present" && scannedDirs.some((dir) => isUnder(row.sourcePath, dir))) {
      result.kept.push({ ...entry, reason: "scanned" });
      continue;
    }
    if (opts.cache.removeBySpecId(row.specId) === 0) continue;
    result.removed.push(entry);
    try {
      opts.eventBus?.emit({
        type: "workflow_spec.removed",
        sourcePath: row.sourcePath,
        specId: row.specId,
        specName: identity?.name ?? null,
        specVersion: identity?.version ?? null,
        reason: missing ? "source_missing" : "unregistered",
      });
    } catch {
      // The row is already gone; a failed audit emission must not undo or abort the rest.
    }
  }

  if (name && matched === 0 && !opts.pruneMissing) {
    throw new WorkflowSpecUnregisterError("spec_not_found", `No registered workflow spec ${version ? `${name}@${version}` : name}.`);
  }
  return result;
}
