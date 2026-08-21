import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDefaultOpenRigPath } from "./openrig-compat.js";

/**
 * The LEARNED host-identity sidecar — hosts.yaml's `known_hosts`.
 *
 * `hosts.yaml` is hand-authored (the operator's `~/.ssh/config`); this file is machine-learned
 * (first-contact TOFU from `/healthz` `selfHostId` on probes we already run) and DISPOSABLE —
 * delete it to re-learn. The registry write path canonically rewrites hosts.yaml and drops
 * operator comments, so learned bindings NEVER go there; they live here, keyed by the registry
 * entry's alias (`id`).
 *
 * Failure semantics (the known_hosts lesson — a broken binding must fail LOUDLY):
 * - First observation for an alias: bind silently (TOFU).
 * - A LATER observation that DIFFERS: the stored binding is NEVER silently overwritten; the
 *   contradiction is recorded on the binding and surfaced by every reader (host ls flag, doctor
 *   row, resolution warning). A host's self-id is minted once and never re-keyed, so a changed
 *   observation means a genuine re-key or a mis-registration — both deserve a loud surface.
 * - ABSENCE stays fail-open: an unbound alias resolves exactly as today.
 */
export interface HostBinding {
  hostId: string;
  firstObservedAt: string;
  lastObservedAt: string;
  /** A later observation that CONTRADICTED the stored binding — kept visible, never adopted. */
  conflict?: { hostId: string; observedAt: string };
}

export interface HostBindingsFile {
  version: 1;
  /** Keyed by the registry entry's alias (`HostEntry.id`). */
  bindings: Record<string, HostBinding>;
}

export function defaultHostBindingsPath(): string {
  return getDefaultOpenRigPath("host-bindings.json");
}

/** Load the sidecar. Fail-open by contract: missing, unreadable, or corrupt → empty bindings
 *  (a broken sidecar must never break resolution; delete it to re-learn). */
export function loadHostBindings(path: string = defaultHostBindingsPath()): HostBindingsFile {
  const empty: HostBindingsFile = { version: 1, bindings: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return empty;
    // A declared version other than 1 is a FUTURE sidecar shape — treat it as unreadable (empty,
    // fail-open) rather than mis-parsing v2 fields through v1 eyes. Absent version reads as v1
    // (files this code wrote always carry it; hand-trimmed ones stay readable).
    const version = (parsed as { version?: unknown }).version;
    if (version !== undefined && version !== 1) return empty;
    const bindings = (parsed as { bindings?: unknown }).bindings;
    if (!bindings || typeof bindings !== "object") return empty;
    const out: Record<string, HostBinding> = {};
    for (const [alias, b] of Object.entries(bindings as Record<string, unknown>)) {
      if (!b || typeof b !== "object") continue;
      const bb = b as Record<string, unknown>;
      if (typeof bb["hostId"] !== "string" || bb["hostId"].length === 0) continue;
      out[alias] = {
        hostId: bb["hostId"],
        firstObservedAt: typeof bb["firstObservedAt"] === "string" ? bb["firstObservedAt"] : "",
        lastObservedAt: typeof bb["lastObservedAt"] === "string" ? bb["lastObservedAt"] : "",
        ...(bb["conflict"] && typeof bb["conflict"] === "object"
          && typeof (bb["conflict"] as Record<string, unknown>)["hostId"] === "string"
          ? {
              conflict: {
                hostId: (bb["conflict"] as Record<string, string>)["hostId"]!,
                observedAt: typeof (bb["conflict"] as Record<string, unknown>)["observedAt"] === "string"
                  ? (bb["conflict"] as Record<string, string>)["observedAt"]!
                  : "",
              },
            }
          : {}),
      };
    }
    return { version: 1, bindings: out };
  } catch {
    return empty;
  }
}

export type HostObservationOutcome =
  | { outcome: "bound"; binding: HostBinding }
  | { outcome: "confirmed"; binding: HostBinding }
  /** The stored binding was NOT changed; the contradiction was recorded on it. */
  | { outcome: "conflict"; binding: HostBinding };

/**
 * Record one observation of `observedHostId` for registry alias `alias` (TOFU + loud-conflict).
 * Persists via write-temp-then-rename so a crashed writer never leaves a torn file.
 */
export function recordHostObservation(args: {
  alias: string;
  observedHostId: string;
  now?: () => Date;
  path?: string;
}): HostObservationOutcome {
  const path = args.path ?? defaultHostBindingsPath();
  const at = (args.now ?? (() => new Date()))().toISOString();
  const file = loadHostBindings(path);
  const existing = file.bindings[args.alias];

  let result: HostObservationOutcome;
  if (!existing) {
    const binding: HostBinding = { hostId: args.observedHostId, firstObservedAt: at, lastObservedAt: at };
    file.bindings[args.alias] = binding;
    result = { outcome: "bound", binding };
  } else if (existing.hostId === args.observedHostId) {
    const binding: HostBinding = { ...existing, lastObservedAt: at };
    // A re-observation of the ORIGINAL id after a recorded conflict does not clear the conflict —
    // a flapping identity is more alarming than a stable contradiction, not less.
    file.bindings[args.alias] = binding;
    result = { outcome: "confirmed", binding };
  } else {
    const binding: HostBinding = { ...existing, conflict: { hostId: args.observedHostId, observedAt: at } };
    file.bindings[args.alias] = binding;
    result = { outcome: "conflict", binding };
  }

  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
  return result;
}

/** One line naming both ids, shared by every loud surface (ls flag detail, doctor row, resolution
 *  warning) so the operator reads the same story everywhere. */
export function describeBindingConflict(alias: string, binding: HostBinding): string {
  return `host '${alias}': observed self-id '${binding.conflict?.hostId}' contradicts the learned binding '${binding.hostId}' — a host's self-id is minted once, so this is a re-key or a mis-registration. If the re-key is legitimate, delete the '${alias}' entry in ${defaultHostBindingsPath()} to re-learn (TOFU).`;
}
