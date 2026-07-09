// OPR.0.4.6.MH1 FR-1/FR-2 — the persisted host-selection read + the
// selected-host routing shim.
//
// WRITE path: `rig host select` → daemon `POST /api/config/host.selected`
// (the one write path — the CLI verb is a thin client; arch FR-1 ruling).
// READ path (this module): the local ConfigStore resolution
// (env OPENRIG_HOST_SELECTED > ~/.openrig/config.json > default "local")
// — the daemon writes the SAME config.json the CLI reads, so reads cost
// zero daemon lookups (the FR-2 zero-regression posture: with no
// selection ever made, every command's behavior is byte-identical to
// pre-MH1 — "local" resolves to undefined and no new code path runs).
//
// Precedence at a command: explicit `--host` > selection context > local.
// Commands with their OWN remote semantics guard the shim themselves:
// ps suppresses it under `--all-hosts`/`--hosts` (fan-out is explicit
// scope), up suppresses it for topology sources (per-entry `host:` is
// the ONLY topology placement mechanism — shipped 0.4.4 rule).

import { ConfigStore } from "./config-store.js";

/** The persisted selection ("local" ≡ no remote selection). Never throws:
 *  a malformed config file falls back to "local" (read paths must not
 *  break). */
export function readSelectedHost(): string {
  try {
    const resolved = new ConfigStore().resolve() as unknown as { host?: { selected?: string } };
    const v = resolved.host?.selected;
    return typeof v === "string" && v.trim() !== "" ? v : "local";
  } catch {
    return "local";
  }
}

/** FR-2: the effective host for a command that already supports `--host`.
 *  Explicit flag wins; else the persisted selection (when not "local");
 *  else undefined (= today's local path, untouched). */
export function resolveEffectiveHost(explicitHost: string | undefined): string | undefined {
  if (explicitHost) return explicitHost;
  const selected = readSelectedHost();
  return selected === "local" ? undefined : selected;
}

/** OPR.0.4.6.MH1 FR-4 — the own-host display name (default "localhost";
 *  arch Ruling 1: home = the settings twins). Same read discipline as
 *  readSelectedHost: local ConfigStore, never throws. */
export function readOwnHostName(): string {
  try {
    const resolved = new ConfigStore().resolve() as unknown as { host?: { name?: string } };
    const v = resolved.host?.name;
    return typeof v === "string" && v.trim() !== "" ? v : "localhost";
  } catch {
    return "localhost";
  }
}
