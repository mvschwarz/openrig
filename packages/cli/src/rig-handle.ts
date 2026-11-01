import type { DaemonClient } from "./client.js";

interface RigSummaryEntry {
  id: string;
  name: string;
  archivedAt?: string | null;
  lifecycleState?: string;
}

/**
 * Outcome of resolving a rig handle (name OR id) to a concrete id, shared by
 * `rig down` and `rig add`. A mutation only ever runs on a `resolved` id or a
 * `passthrough` handle; callers halt on `ambiguous` (and `rig down` also on
 * `not_found`) BEFORE any POST.
 */
export type HandleResolution =
  // `byName` is true when the handle matched an active rig's name, not an id.
  | { kind: "resolved"; id: string; byName: boolean }
  | { kind: "ambiguous"; name: string; ids: string[] }
  | { kind: "not_found"; handle: string }
  // Summary unavailable (non-200 / fetch error): fall back to today's id-only
  // behavior - POST the raw handle as the id and let the daemon resolve it by
  // exact id (404 if absent). Safe: the daemon matches a single exact id, so a
  // name posted this way cannot reach the wrong rig.
  | { kind: "passthrough"; handle: string };

/** A rig list entry as the daemon writes it: a string id and name, and archivedAt a string or null. */
function isSummaryEntry(entry: unknown): boolean {
  const rig = (entry ?? {}) as Record<string, unknown>;
  return typeof rig.id === "string" && typeof rig.name === "string" && (rig.archivedAt === null || typeof rig.archivedAt === "string");
}

/**
 * Resolve a rig handle (rig name OR id) to a concrete rig id, mirroring the
 * `/api/rigs/summary` path `rig up` uses. Resolution is a PRE-STEP: each
 * command's existing request + guards downstream are unchanged; this only maps
 * the handle to an id.
 *
 * Safety order (mutating ops):
 *  1. id-exact-match FIRST, across ALL rigs incl. archived - an id is unique, so
 *     it is never ambiguous, and an archived rig's id must still reach the
 *     canonical id path (also when an active rig is NAMED like that id).
 *  2. else name-filter over ACTIVE (non-archived) rigs only:
 *     - exactly 1 active match -> resolve to that id;
 *     - >1 active matches      -> AMBIGUOUS: halt, never guess;
 *     - 0 active matches       -> NOT_FOUND.
 *
 * `/api/rigs/summary` defaults to ACTIVE-only and exposes `archivedAt`; we fetch
 * with `includeArchived=true` so an archived id still id-matches, then filter
 * names to active. So an active+archived same-name pair is NOT ambiguous (only
 * the active candidate counts), and an archived-only name does not resolve by
 * name (use the id, or the archive path).
 */
export async function resolveRigHandle(
  client: DaemonClient,
  handle: string,
  // `archived: true` matches names among ARCHIVED rigs instead (for `rig unarchive`, whose target is archived).
  // `strict: true` reads a rig list with any malformed entry as unavailable (passthrough), for a caller that must not
  // count an incomplete list as an answer.
  opts: { archived?: boolean; strict?: boolean } = {},
): Promise<HandleResolution> {
  let summaries: RigSummaryEntry[];
  try {
    // includeArchived=true so an archived rig's id still id-matches below;
    // names are filtered to active.
    const res = await client.get<RigSummaryEntry[]>("/api/rigs/summary?includeArchived=true");
    if (res.status !== 200 || !Array.isArray(res.data)) {
      return { kind: "passthrough", handle };
    }
    if (opts.strict && !res.data.every(isSummaryEntry)) return { kind: "passthrough", handle };
    summaries = res.data;
  } catch {
    return { kind: "passthrough", handle };
  }

  // 1. id-exact-match first, across ALL rigs incl. archived (ids are never
  //    ambiguous; archived ids still reach the id path).
  if (summaries.some((r) => r.id === handle)) {
    return { kind: "resolved", id: handle, byName: false };
  }

  // 2. name-filter over ACTIVE (non-archived) rigs only, symmetric with `up`.
  const activeNameMatches = summaries.filter((r) => r.name === handle && (opts.archived ? r.archivedAt != null : r.archivedAt == null));
  if (activeNameMatches.length === 1) {
    return { kind: "resolved", id: activeNameMatches[0]!.id, byName: true };
  }
  if (activeNameMatches.length > 1) {
    return { kind: "ambiguous", name: handle, ids: activeNameMatches.map((r) => r.id) };
  }
  return { kind: "not_found", handle };
}

/**
 * The rig id for a read or snapshot command given a rig name or id: the id a name resolves to, or the
 * handle itself when it matches no rig or the rig list can't be read (the daemon then answers for that
 * exact id, as before). `known` is false only when the rig list was read and no rig matched. An ambiguous
 * name stops the command with the candidate ids.
 */
export async function rigIdForHandle(
  client: DaemonClient,
  handle: string,
): Promise<{ ok: true; id: string; known: boolean } | { ok: false; message: string; candidates: string[] }> {
  const resolution = await resolveRigHandle(client, handle);
  if (resolution.kind === "ambiguous") {
    return { ok: false, message: `'${handle}' matches ${resolution.ids.length} rigs (${resolution.ids.join(", ")}). Nothing was done; pass one of these ids instead.`, candidates: resolution.ids };
  }
  if (resolution.kind === "resolved") return { ok: true, id: resolution.id, known: true };
  return { ok: true, id: handle, known: resolution.kind === "passthrough" };
}
