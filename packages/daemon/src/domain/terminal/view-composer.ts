// OPR.0.4.6.02 C2 — the PURE view composer.
//
// Turns a resolved list of view members into a provider-neutral `ComposedView`
// (`{ opened, absent, degraded, pages }`, BR-6 honest-partial). All of the
// partition rules live here, in one testable pure function, so no provider
// re-implements them:
//
//   local live       → `tmux attach -t <session>`
//   view-only / cross-rig (read-only)
//                    → `tmux attach -r -t <session>`
//   ssh host         → `ssh <dest> tmux attach [-r] -t <session>`
//   http host        → NO pane; honest-degrade { seat, host, reason }
//   dead / no session → absent[] (named, never silently dropped)
//
// The composer takes members that already carry a STRUCTURED `host` field (a
// host id, never a `member@rig@host` string — MH BR-1). Host classification
// (ssh vs http vs unknown) is resolved through the operator's read-only hosts
// registry via the injected `resolveHost`.

import type { HostEntry } from "../hosts/hosts-registry-reader.js";
import type {
  AbsentSeat,
  ComposedPane,
  ComposedView,
  DegradedSeat,
} from "./terminal-provider.js";

/**
 * Panes per grid page (3×3). Overflow spills to the next provider tab/page.
 * A module constant in v1 — a future per-rig `terminal.tiles_per_page` config
 * key is a natural extension, but no config key ships in this slice (the plan
 * keeps the C1 config surface to the single `terminal.status_bar` key).
 */
export const PANES_PER_PAGE = 9;

/**
 * One resolved member of a view, ready to compose. `alive` and `readOnly` are
 * decided upstream (liveness probe + cross-rig/saved-read-only policy); the
 * composer only routes on them. `host` is a structured host id or null (local).
 */
export interface ViewMemberInput {
  /** Canonical session name of the seat. */
  seat: string;
  /** Pane label — `<agent> · <slice>` (AC-7). */
  label: string;
  /** The tmux session to attach to (may be null if the seat has no tmux binding). */
  tmuxSession: string | null;
  /** Structured host id when remote; null for a local seat. */
  host: string | null;
  /** View-only / cross-rig membership → read-only (`-r`) attach. */
  readOnly: boolean;
  /** Local liveness (has-session). Ignored for remote members (reachability is an ssh concern). */
  alive: boolean;
}

/** The composer's only side-channel: read-only host resolution from the registry. */
export interface ComposeContext {
  /** Resolve a host id to its registry entry, or null if the id is unknown. */
  resolveHost(id: string): HostEntry | null;
}

/** POSIX single-quote a string so session names / targets are shell-inert in the composed command. */
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

/** The remote ssh destination — `user@target` when a user is declared, else `target`. */
function sshDest(host: Extract<HostEntry, { transport: "ssh" }>): string {
  return host.user ? `${host.user}@${host.target}` : host.target;
}

/** Chunk panes into fixed-size grid pages (one provider tab per page). */
export function chunkPanes(
  panes: ComposedPane[],
  perPage: number = PANES_PER_PAGE,
): ComposedPane[][] {
  if (perPage < 1) throw new Error(`chunkPanes: perPage must be >= 1 (got ${perPage})`);
  const pages: ComposedPane[][] = [];
  for (let i = 0; i < panes.length; i += perPage) {
    pages.push(panes.slice(i, i + perPage));
  }
  return pages;
}

/**
 * Compose a resolved member list into a provider-neutral view. Pure: same
 * inputs → byte-identical output. Member order is preserved into `opened`
 * (and therefore into page assignment), so paging is deterministic.
 */
export function composeView(
  id: string,
  members: ViewMemberInput[],
  ctx: ComposeContext,
): ComposedView {
  const opened: ComposedPane[] = [];
  const absent: AbsentSeat[] = [];
  const degraded: DegradedSeat[] = [];

  for (const m of members) {
    const attachFlag = m.readOnly ? "-r " : "";

    if (m.host !== null) {
      // Remote member: classify by the registry entry's transport.
      const host = ctx.resolveHost(m.host);
      if (!host) {
        // Unknown host id is a config gap, not a live seat — degrade named,
        // never a silent omission.
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `host ${m.host} is not in the hosts registry`,
        });
        continue;
      }
      if (host.transport === "http") {
        // http hosts speak daemon REST, not interactive ssh panes — the tile
        // surface needs ssh. Honest-degrade, R1(a).
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `host ${m.host} is http-registered; tiles need ssh`,
        });
        continue;
      }
      // ssh host: a seat with no recorded tmux session cannot be attached.
      if (!m.tmuxSession) {
        absent.push({
          seat: m.seat,
          host: m.host,
          reason: "no tmux session recorded for this seat",
        });
        continue;
      }
      // Guard G1: the host registry is STRUCTURED data, but the pane command is a
      // shell string — so the ssh destination must be shell-inert AND not
      // option-shaped. A registry `user`/`target` with whitespace or shell
      // metacharacters would otherwise split into extra shell words; a leading
      // `-` would be parsed BY ssh as an option (option injection). We shell-quote
      // the destination so it stays exactly ONE argument, and honest-degrade (named,
      // never run) a destination that begins with `-`.
      const dest = sshDest(host);
      if (dest.startsWith("-")) {
        degraded.push({
          seat: m.seat,
          host: m.host,
          reason: `host ${m.host} ssh destination '${dest}' is option-shaped (leading '-'); refusing to compose an ssh tile`,
        });
        continue;
      }
      opened.push({
        seat: m.seat,
        label: m.label,
        paneCommand: `ssh ${shellQuote(dest)} tmux attach ${attachFlag}-t ${shellQuote(m.tmuxSession)}`,
        readOnly: m.readOnly,
      });
      continue;
    }

    // Local member.
    if (!m.tmuxSession) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: "no tmux session recorded for this seat",
      });
      continue;
    }
    if (!m.alive) {
      absent.push({
        seat: m.seat,
        host: null,
        reason: `tmux session ${m.tmuxSession} is not alive`,
      });
      continue;
    }
    opened.push({
      seat: m.seat,
      label: m.label,
      paneCommand: `tmux attach ${attachFlag}-t ${shellQuote(m.tmuxSession)}`,
      readOnly: m.readOnly,
    });
  }

  return { id, opened, absent, degraded, pages: chunkPanes(opened) };
}
