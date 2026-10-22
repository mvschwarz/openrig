import { existsSync, readFileSync } from "node:fs";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import type { HostRegistry } from "./hosts-registry-reader.js";

/**
 * Read-only twin of the CLI's learned host-identity file (`host-bindings.json`, written only by
 * `rig host doctor`): registry alias → the self-id the host at that entry's URL reported. This
 * daemon reads the file in its own OPENRIG_HOME, beside the `hosts.yaml` its aliases come from, so a
 * binding always names one of its own registry entries. Fail-open like the CLI's loader: a missing,
 * unreadable, corrupt or future-version file is an empty set.
 */
export interface LearnedHostBinding {
  hostId: string;
  observedUrl?: string;
  conflict?: { hostId: string };
}

export interface LearnedHostBindingsFile {
  version: 1;
  bindings: Record<string, LearnedHostBinding>;
}

export function defaultHostBindingsPath(): string {
  return getDefaultOpenRigPath("host-bindings.json");
}

export function loadLearnedHostBindings(path: string = defaultHostBindingsPath()): LearnedHostBindingsFile {
  const empty: LearnedHostBindingsFile = { version: 1, bindings: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { version?: unknown; bindings?: unknown } | null;
    if (!parsed || typeof parsed !== "object") return empty;
    if (parsed.version !== undefined && parsed.version !== 1) return empty;
    if (!parsed.bindings || typeof parsed.bindings !== "object") return empty;
    const bindings: Record<string, LearnedHostBinding> = {};
    for (const [alias, raw] of Object.entries(parsed.bindings as Record<string, unknown>)) {
      const b = raw as { hostId?: unknown; observedUrl?: unknown; conflict?: unknown } | null;
      if (!b || typeof b !== "object" || typeof b.hostId !== "string" || b.hostId.length === 0) continue;
      const conflict = b.conflict as { hostId?: unknown } | null | undefined;
      bindings[alias] = {
        hostId: b.hostId,
        ...(typeof b.observedUrl === "string" && b.observedUrl.length > 0 ? { observedUrl: b.observedUrl } : {}),
        ...(conflict && typeof conflict === "object" && typeof conflict.hostId === "string" ? { conflict: { hostId: conflict.hostId } } : {}),
      };
    }
    return { version: 1, bindings };
  } catch {
    return empty;
  }
}

/** Why the binding for `alias` can't route a queue write, or null when it can: it must belong to an
 *  http entry, record the URL it was learned at, still match that entry's URL, and carry no recorded
 *  conflict. An equal URL makes a binding eligible; it isn't live proof the host is the same one. */
function ineligibility(registry: HostRegistry, alias: string, binding: LearnedHostBinding): string | null {
  const entry = registry.hosts.find((h) => h.id === alias);
  if (!entry) return "its registry entry no longer exists";
  if (binding.conflict) return `it has a recorded conflict (a later observation saw '${binding.conflict.hostId}')`;
  if (entry.transport !== "http") return "its entry is SSH-declared, and queue writes need an http entry";
  if (binding.observedUrl === undefined) return "it was learned before its URL was recorded";
  if (binding.observedUrl !== entry.url) return `it was learned at ${binding.observedUrl}, but the entry now points at ${entry.url}`;
  return null;
}

/** The learned bindings a queue forward may resolve through, in `resolveHost`'s shape. */
export function eligibleQueueBindings(registry: HostRegistry, file: LearnedHostBindingsFile): Record<string, { hostId: string }> {
  const out: Record<string, { hostId: string }> = {};
  for (const [alias, binding] of Object.entries(file.bindings)) {
    if (ineligibility(registry, alias, binding) === null) out[alias] = { hostId: binding.hostId };
  }
  return out;
}

/** For a token only an ineligible binding names: why it isn't used, and the routes that work. */
export function ineligibleBindingDetail(registry: HostRegistry, file: LearnedHostBindingsFile, token: string): string | null {
  for (const [alias, binding] of Object.entries(file.bindings)) {
    if (binding.hostId !== token) continue;
    const why = ineligibility(registry, alias, binding);
    if (why === null) continue;
    const relearn = binding.conflict
      ? `If the re-key is legitimate, delete the '${alias}' entry in ${defaultHostBindingsPath()} and run rig host doctor ${alias}`
      : `Run rig host doctor ${alias} with this daemon's OPENRIG_HOME to record it again`;
    return `Host '${token}' has a learned binding for '${alias}' in ${defaultHostBindingsPath()} that isn't used: ${why}. ${relearn}, or name the host by its registry id with --host ${alias}.`;
  }
  return null;
}
