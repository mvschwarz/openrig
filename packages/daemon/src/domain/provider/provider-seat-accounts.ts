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
import type { ClaudeWindowSample } from "./claude-usage-windows.js";
import type { CodexAuthMetadata } from "./codex-auth-reader.js";
import type { ProviderSeat } from "./provider-collect.js";
import type { ProviderUsageAllowance, SeatConfiguredAccount } from "./provider-types.js";

export interface SeatAccountsInput {
  seats: ProviderSeat[];
  auth: CodexAuthMetadata;
  usage: ProviderUsageAllowance[];
  /** Each Claude seat's own latest status-line samples (ClaudeUsageWindows.seatSamples()); null when not available. */
  claudeSamples: ClaudeWindowSample[] | null;
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
  // Each seat's newest sample time. The samples carry no time bound, so "sampled" always comes with its time.
  let claudeSampled: Map<string, string> | null = null;
  if (input.claudeSamples) {
    claudeSampled = new Map();
    for (const s of input.claudeSamples) {
      const prev = claudeSampled.get(s.seatSession);
      if (prev === undefined || Date.parse(s.sampledAt) > Date.parse(prev)) claudeSampled.set(s.seatSession, s.sampledAt);
    }
  }
  const claudeDiffers = currentDisagreements(input.usage);
  const registryGap = codexRegistryGap(input.auth);
  const sharedBySession = new Map<string, number>();
  for (const seat of input.seats) sharedBySession.set(seat.seatSession, (sharedBySession.get(seat.seatSession) ?? 0) + 1);

  return input.seats.map((seat): SeatConfiguredAccount => {
    const base = { seatSession: seat.seatSession, rigName: seat.rigName, runtime: seat.runtime };
    const row = registryBySeat.get(seat.seatSession);
    const notes: string[] = [];
    const shared = sharedBySession.get(seat.seatSession) ?? 1;
    if (row && seat.runtime !== "codex") {
      notes.push(`stale registry row: names profile ${row.authProfile} (recorded ${row.updatedTs}) for runtime ${row.runtime}; not applied: this seat now runs ${seat.runtime}`);
    }

    if (seat.runtime === "codex") {
      if (row) {
        if (row.runtime !== "codex") notes.push(`the registry row's runtime column says ${row.runtime}, not codex`);
        // An unreadable profile folder can't say either way: profileSaved is null, never "not saved".
        const folder = input.auth.profilesRead;
        const profileSaved = folder?.status === "unreadable" ? null : profiles.has(row.authProfile);
        if (profileSaved === null) notes.push(`can't tell whether profile ${row.authProfile} is saved on this host: the profile folder couldn't be read (${folder!.code ?? "unknown"})`);
        else if (!profileSaved) notes.push(`profile ${row.authProfile} is not saved on this host`);
        if (row.rig && row.rig !== seat.rigName) notes.push(`registry row names rig ${row.rig}; this seat is in rig ${seat.rigName}`);
        if (shared > 1) notes.push(`${shared} seats share session name ${seat.seatSession}; the seat-keyed registry row cannot tell them apart`);
        return {
          ...base,
          configured: { source: "registry", profileRef: row.authProfile, recordedAt: row.updatedTs, profileSaved },
          ...(notes.length ? { registryNotes: notes } : {}),
          allowance: { linked: false, reason: REGISTRY_NOT_LINKED },
          observed: { note: "no per-seat observation for Codex" },
        };
      }
      // No parsed row is a supported absence only when the registry was read whole (or isn't there).
      if (registryGap) {
        return {
          ...base,
          configured: { source: "unknown", reason: registryGap },
          allowance: { linked: false, reason: "no configured account" },
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
      const differs = claudeDiffers.get(seat.seatSession);
      return {
        ...base,
        configured: { source: "default_login", home: claudeHome.home, homeNote: claudeHome.note },
        ...(notes.length ? { registryNotes: notes } : {}),
        allowance: { linked: false, reason: DEFAULT_LOGIN_NOT_LINKED },
        observed: shared > 1
          ? { withheld: true, note: `observation withheld: ${shared} seats share session name ${seat.seatSession}; status-line samples are keyed by session name and cannot be attributed to one seat` }
          : !claudeSampled
          ? { note: "status-line samples were not available to this read" }
          : claudeSampled.has(seat.seatSession)
          ? {
              windowsSampled: true,
              lastSampledAt: claudeSampled.get(seat.seatSession)!,
              ...(differs?.size ? { differsFrom: [...differs].sort(), note: DIFFERS_NOTE } : {}),
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
  // As the launch resolver does (claude-managed-launch.ts:59, `CLAUDE_CONFIG_DIR ?? HOME/.claude`, resolved against
  // the seat's cwd): only an unset value falls back to HOME; an empty one resolves to each seat's working directory.
  if (configDir === undefined) {
    return home ? { home: path.join(home, ".claude"), note: shared } : { home: null, note: "the daemon's HOME is not set" };
  }
  if (configDir === "") {
    return { home: null, note: "CLAUDE_CONFIG_DIR is set but empty: it resolves to each seat's working directory" };
  }
  if (!path.isAbsolute(configDir)) {
    return { home: null, note: `CLAUDE_CONFIG_DIR ${configDir} is relative: it resolves against each seat's working directory` };
  }
  return { home: configDir, note: shared };
}

/** Why a Codex seat with no parsed registry row can't be called default login, or null when it can. */
function codexRegistryGap(auth: CodexAuthMetadata): string | null {
  const read = auth.registry;
  if (!read) return null;
  if (read.status === "unreadable") return `the seat registry exists but couldn't be read (${read.code ?? "unknown"})`;
  if (read.malformedRows > 0) return `the registry has ${read.malformedRows} malformed row${read.malformedRows === 1 ? "" : "s"}; this seat may be among them`;
  return null;
}

/** Disagreements on the CURRENT Claude row only: fresh windows of rows that are the latest from their source. A
 *  frozen earlier row's disagreement stays in the usage history, labelled there, and never becomes a current one. */
function currentDisagreements(usage: ProviderUsageAllowance[]): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const touch = (seat: string) => {
    let set = seen.get(seat);
    if (!set) seen.set(seat, (set = new Set()));
    return set;
  };
  for (const row of usage) {
    if (row.provider !== "claude" || row.latestFromSource === false) continue;
    for (const window of row.windows) {
      if (!window.seatSession || window.freshness !== "fresh") continue;
      const own = touch(window.seatSession);
      for (const other of window.disagreeingSeats ?? []) {
        own.add(other.seatSession);
        touch(other.seatSession).add(window.seatSession);
      }
    }
  }
  return seen;
}
