// Slice 01 (OPR.0.7.0.1) — each seat's CONFIGURED account, kept apart from any observed allowance.
//
// A pure function over facts the provider service already has: the live seat universe, the codex-auth
// registry METADATA (profile names and the seat TSV, via readCodexAuthMetadata: no profile contents are
// ever opened), the usage rows already in memory, and the daemon's own Codex home and Claude config dir.
//
// What it never does: join a configured profile to an observed allowance. A registry profile name and an
// observed account are different kinds of fact, and a shared home says which login a seat STARTED on, not
// which one the home holds now. Equal resets, a shared email or a matching spelling never link anything.

import path from "node:path";
import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import type { ProviderSeat } from "./provider-collect.js";
import type { ProviderUsageAllowance, SeatConfiguredAccount } from "./provider-types.js";

export interface SeatAccountsInput {
  seats: ProviderSeat[];
  auth: CodexAuthMetadata;
  usage: ProviderUsageAllowance[];
  /** The CODEX_HOME every Codex seat on this daemon launches with. */
  codexHome: string;
  /** The daemon's CLAUDE_CONFIG_DIR as set (may be relative), and its HOME. */
  claudeConfigDir: string | undefined;
  home: string | undefined;
}

const REGISTRY_NOT_LINKED =
  "a registry profile name and an observed account are different kinds of fact; nothing supported links them without reading the profile's contents";
const DEFAULT_LOGIN_NOT_LINKED =
  "the usage read reads the login this home holds now; the seat runs the login that was active when it launched";
const DIFFERS_NOTE =
  "possibly a different login: this seat's status line reports windows that differ from another seat's (a reset more than 60 s apart); not a verdict";

export function configuredSeatAccounts(input: SeatAccountsInput): SeatConfiguredAccount[] {
  const profiles = new Set(input.auth.profiles);
  const registryBySeat = new Map(input.auth.seats.map((row) => [row.seat, row]));
  const claudeHome = claudeConfigHome(input.claudeConfigDir, input.home);
  const claudeObserved = claudeObservations(input.usage);

  return input.seats.map((seat): SeatConfiguredAccount => {
    const base = { seatSession: seat.seatSession, rigName: seat.rigName, runtime: seat.runtime };
    const row = registryBySeat.get(seat.seatSession);
    const notes: string[] = [];
    if (row && seat.runtime !== "codex") {
      notes.push(`stale registry row: names profile ${row.authProfile} (recorded ${row.updatedTs}) for runtime ${row.runtime}; not applied: this seat now runs ${seat.runtime}`);
    }

    if (seat.runtime === "codex") {
      if (row) {
        if (row.runtime !== "codex") notes.push(`the registry row's runtime column says ${row.runtime}, not codex`);
        const profileSaved = profiles.has(row.authProfile);
        if (!profileSaved) notes.push(`profile ${row.authProfile} is not saved on this host`);
        return {
          ...base,
          configured: { source: "registry", profileRef: row.authProfile, recordedAt: row.updatedTs, profileSaved },
          ...(notes.length ? { registryNotes: notes } : {}),
          allowance: { linked: false, reason: REGISTRY_NOT_LINKED },
          observed: { note: "no per-seat observation for Codex" },
        };
      }
      return {
        ...base,
        configured: { source: "default_login", home: input.codexHome, homeNote: "the login active in the daemon's CODEX_HOME when this seat launched" },
        allowance: { linked: false, reason: DEFAULT_LOGIN_NOT_LINKED },
        observed: { note: "no per-seat observation for Codex" },
      };
    }

    if (seat.runtime === "claude-code") {
      const observed = claudeObserved.get(seat.seatSession);
      return {
        ...base,
        configured: { source: "default_login", home: claudeHome.home, homeNote: claudeHome.note },
        ...(notes.length ? { registryNotes: notes } : {}),
        allowance: { linked: false, reason: DEFAULT_LOGIN_NOT_LINKED },
        observed: observed
          ? {
              windowsSampled: true,
              ...(observed.size ? { differsFrom: [...observed].sort(), note: DIFFERS_NOTE } : {}),
            }
          : { windowsSampled: false },
      };
    }

    return {
      ...base,
      configured: { source: "unknown", reason: `no account configuration is known for runtime ${seat.runtime}` },
      ...(notes.length ? { registryNotes: notes } : {}),
      allowance: { linked: false, reason: "no configured account" },
    };
  });
}

function claudeConfigHome(configDir: string | undefined, home: string | undefined): { home: string | null; note: string } {
  const shared = "the login in the daemon's Claude config dir, shared by every Claude seat on this daemon";
  if (configDir === undefined || configDir === "") {
    return home ? { home: path.join(home, ".claude"), note: shared } : { home: null, note: "the daemon's HOME is not set" };
  }
  if (!path.isAbsolute(configDir)) {
    return { home: null, note: `CLAUDE_CONFIG_DIR ${configDir} is relative: it resolves against each seat's working directory` };
  }
  return { home: configDir, note: shared };
}

/** Seats whose own status-line samples appear in a Claude usage row, with the seats they disagree with. */
function claudeObservations(usage: ProviderUsageAllowance[]): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const touch = (seat: string) => {
    let set = seen.get(seat);
    if (!set) seen.set(seat, (set = new Set()));
    return set;
  };
  for (const row of usage) {
    if (row.provider !== "claude") continue;
    for (const window of row.windows) {
      if (!window.seatSession) continue;
      const own = touch(window.seatSession);
      for (const other of window.disagreeingSeats ?? []) {
        own.add(other.seatSession);
        touch(other.seatSession).add(window.seatSession);
      }
    }
  }
  return seen;
}
