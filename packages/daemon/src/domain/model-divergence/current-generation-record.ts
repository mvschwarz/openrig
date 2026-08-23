// D-a (B8-family) — resolve the CURRENT OCCUPANT's provider record by RECORD-LIVENESS.
//
// Fourth cross-generation-keying lesson tonight, and this module's own first cut was specimen #4:
// ~~"the pane's process tree is the only record that IS the occupant"~~ — WRONG, withdrawn by the
// author before review. Measured on dev.planner: the pane process's --session-id ARGUMENT pointed
// at a transcript dormant for a day (reading an old model), while the sidecar/registry id matched
// the transcript being APPENDED that minute (reading the pinned model). Claude rolls session ids
// internally — the launch argument records what was LAUNCHED; hooks report what RUNS (the slice-13
// lesson, met again from the other side). On the B16 specimen the SIDECAR was the stale one. So no
// single pointer — argument, sidecar, or registry row — is generation-true.
//
// What IS generation-true: the record being WRITTEN. LiveClaudeRecordSelector gathers every candidate
// session id this seat is associated with (sidecar, newest registry hook row, pane argument),
// resolves each to its transcript, and selects the freshest-mtime one. Codex differs: the
// pid-to-logs join reads the live process's OWN log rows, so it needs no selection.
//
// Also measured: occupant_tenures.native_session_id_at_boot is NULL on every tenure on this box
// (the ledger join the fix shape named is unpopulated — flagged upstream; when backfilled it joins
// the candidate set, it does not replace liveness).
//
// All process reads are async (the F1/B12 discipline). Every no-answer is a NAMED reason, never a
// silent fall-through — the ruled shape: honest INDETERMINATE over a masked stale read.

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
  /** OPR.0.5.3.10 — the process start time (`ps lstart`), the identity half
   *  of pid+start-time: pid reuse changes it, so consumers can invalidate
   *  cached per-pid answers without another spawn. Optional: injected legacy
   *  rows without it fall back to the resolver's TTL bound. */
  startedAt?: string;
}

export interface CurrentGenerationDeps {
  getPanePid: (sessionTarget: string) => Promise<number | null>;
  listProcesses: () => Promise<ProcessRow[]>;
  /** Codex: thread id for a live codex pid (the logs join; async post-F1).
   *  `identity` = the census row's startedAt (pid+start-time reuse guard). */
  readThreadIdByPid: (pid: number, identity?: string) => Promise<string | undefined> | string | undefined;
}

export type CurrentRecordResolution =
  | { ok: true; id: string }
  | { ok: false; reason: string };

/** Descendants of `parentPid` whose command matches `matches`, breadth-first. (Deliberately local:
 *  the two existing walkers are module-private in the codex adapter and the refresher; a shared
 *  extraction is a cleanup for calmer water.) */
function findDescendants(processes: ProcessRow[], parentPid: number, matches: (command: string) => boolean): number[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const p of processes) {
    const list = byParent.get(p.ppid) ?? [];
    list.push(p);
    byParent.set(p.ppid, list);
  }
  const out: number[] = [];
  const queue = [parentPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    for (const child of byParent.get(pid) ?? []) {
      if (matches(child.command)) out.push(child.pid);
      queue.push(child.pid);
    }
  }
  return out;
}

function commandBasenameIs(name: string): (command: string) => boolean {
  return (command) => command.trim().split(/\s+/).filter(Boolean).some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    return unquoted.split("/").pop() === name;
  });
}

/** The pane process's claude session-id LAUNCH ARGUMENT — one CANDIDATE, never the answer alone:
 *  measured on the live specimen, claude rolls session ids internally (the slice-13 lesson — the
 *  argument records what was LAUNCHED; hooks report what RUNS), so the argument can be the stale
 *  pointer while the sidecar is current. Feed it into LiveClaudeRecordSelector with the others. */
export async function paneClaudeSessionIdArgument(
  sessionTarget: string,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
): Promise<CurrentRecordResolution> {
  const panePid = await deps.getPanePid(sessionTarget);
  if (!panePid) return { ok: false, reason: `no live pane pid for ${sessionTarget}` };
  const processes = await deps.listProcesses();
  const claudePids = findDescendants(processes, panePid, commandBasenameIs("claude"));
  if (claudePids.length === 0) return { ok: false, reason: `no claude process under the live pane of ${sessionTarget}` };
  for (const pid of claudePids) {
    const command = processes.find((p) => p.pid === pid)?.command ?? "";
    const match = command.match(/--session-id[= ]([0-9a-f-]{36})/) ?? command.match(/--resume[= ]([0-9a-f-]{36})/);
    if (match?.[1]) return { ok: true, id: match[1] };
  }
  return { ok: false, reason: `live claude process under ${sessionTarget} carries no --session-id/--resume argument` };
}

export interface ClaudeRecordCandidate {
  /** Where this candidate id came from (sidecar / registry / pane-argument) — rides the verdict. */
  source: string;
  id: string;
  /** Absolute transcript path for the id, when derivable. */
  path: string | null;
}

export type ClaudeRecordSelection =
  | { ok: true; id: string; path: string; source: string }
  | { ok: false; reason: string };

export interface RecordStat {
  mtimeMs: number;
  size: number;
}

/** The CURRENT claude record via CROSS-POLL OBSERVED ADVANCEMENT (r2 rounds 2-4 on this family):
 *  neither existence, nor recency, nor a 1.5s in-poll sample proves a record is being written —
 *  the in-poll window forgot everything between polls and oscillated truth/indeterminate with
 *  write timing (r2 round-4). This selector is STATEFUL per seat:
 *  - an id is readable if ANY of its candidate paths stats (all paths retained per id — r2's
 *    adjacent pin: a dead sidecar path must not mask a readable registry-derived one).
 *  - an UNREADABLE contender with a different id → ALWAYS a named INDETERMINATE.
 *  - exactly one readable id, no differing unreadable contender → that record (unanimity).
 *  - multiple readable ids → advancement is observed ACROSS POLLS: current stats vs the previous
 *    poll's cached stats (the full poll interval is the observation window, catching every
 *    intervening write). Exactly one record advanced → selected and RETAINED until the candidate
 *    id set changes; none/several advanced → named INDETERMINATE, re-observed next poll. The
 *    first observation of a disagreeing set is INDETERMINATE by construction (nothing to compare
 *    against yet — named as such). */
export class LiveClaudeRecordSelector {
  private readonly perSeat = new Map<string, {
    idSetKey: string;
    prevStats: Map<string, RecordStat>;
    selected: { id: string; path: string; source: string } | null;
  }>();

  select(
    seatKey: string,
    candidates: ClaudeRecordCandidate[],
    statRecord: (path: string) => RecordStat | null,
  ): ClaudeRecordSelection {
    // Dedupe by id, RETAINING every path offered for the id (first source labels it).
    const byId = new Map<string, { source: string; paths: string[] }>();
    for (const c of candidates) {
      if (!c.id) continue;
      const entry = byId.get(c.id) ?? { source: c.source, paths: [] };
      if (c.path && !entry.paths.includes(c.path)) entry.paths.push(c.path);
      byId.set(c.id, entry);
    }
    const readable: Array<{ id: string; path: string; source: string; stat: RecordStat }> = [];
    const unreadable: string[] = [];
    for (const [id, { source, paths }] of byId) {
      let hit: { path: string; stat: RecordStat } | null = null;
      for (const path of paths) {
        const stat = statRecord(path);
        if (stat) { hit = { path, stat }; break; }
      }
      if (hit) readable.push({ id, path: hit.path, source, stat: hit.stat });
      else unreadable.push(`${source}:${id.slice(0, 8)}… (${paths.length ? "no file" : "no path"})`);
    }
    if (readable.length === 0) {
      this.perSeat.delete(seatKey);
      return { ok: false, reason: `no readable transcript for any candidate session (${unreadable.join(", ") || "no candidates"})` };
    }
    if (unreadable.length > 0) {
      // ALWAYS indeterminate: the unreadable contender may be the current record before its first
      // readable byte — confident stale truth here is the exact defect class.
      this.rememberStats(seatKey, byIdKey(byId), readable);
      return {
        ok: false,
        reason: `candidate sessions disagree and ${unreadable.length} contender(s) are unreadable (${unreadable.join(", ")}; readable: ${readable.map((r) => `${r.source}:${r.id.slice(0, 8)}…`).join(", ")}) — the unreadable one may be the record being written`,
      };
    }
    if (readable.length === 1) {
      const only = readable[0]!;
      this.rememberSelection(seatKey, byIdKey(byId), readable, only);
      return { ok: true, id: only.id, path: only.path, source: only.source };
    }

    const idSetKey = byIdKey(byId);
    const state = this.perSeat.get(seatKey);
    const retainedCurrent = state && state.idSetKey === idSetKey && state.selected
      ? readable.find((r) => r.id === state.selected!.id)
      : undefined;
    if (retainedCurrent) {
      // RETAIN the resolved ID until the candidate set changes (r2 round-4 remedy) — but rebind
      // path/source to THIS poll's readable entry (r2 round-5): the cached path can die while a
      // same-id fallback path stays readable, and returning the cached path verbatim is the
      // temporal form of the dead-first-path-masks-readable-second defect.
      const selected = { id: retainedCurrent.id, path: retainedCurrent.path, source: retainedCurrent.source };
      this.rememberSelection(seatKey, idSetKey, readable, selected);
      return { ok: true, ...selected };
    }
    const prev = state && state.idSetKey === idSetKey ? state.prevStats : null;
    if (prev) {
      const advanced = readable.filter((r) => {
        const before = prev.get(r.id);
        return before !== undefined && (before.size !== r.stat.size || before.mtimeMs !== r.stat.mtimeMs);
      });
      if (advanced.length === 1) {
        const winner = advanced[0]!;
        const selected = { id: winner.id, path: winner.path, source: winner.source };
        this.rememberSelection(seatKey, idSetKey, readable, selected);
        return { ok: true, ...selected };
      }
      this.rememberStats(seatKey, idSetKey, readable);
      return {
        ok: false,
        reason:
          `candidate sessions disagree (${readable.map((r) => `${r.source}:${r.id.slice(0, 8)}…`).join(", ")}) and ` +
          (advanced.length === 0
            ? "no record advanced since the previous poll — idle; re-observed next poll"
            : `${advanced.length} records advanced since the previous poll — genuinely ambiguous`),
      };
    }
    this.rememberStats(seatKey, idSetKey, readable);
    return {
      ok: false,
      reason: `candidate sessions disagree (${readable.map((r) => `${r.source}:${r.id.slice(0, 8)}…`).join(", ")}) — first observation of this candidate set; advancement compares from the next poll`,
    };
  }

  private rememberStats(
    seatKey: string,
    idSetKey: string,
    readable: Array<{ id: string; stat: RecordStat }>,
    selected: { id: string; path: string; source: string } | null = null,
  ): void {
    this.perSeat.set(seatKey, {
      idSetKey,
      prevStats: new Map(readable.map((r) => [r.id, r.stat])),
      selected,
    });
  }

  private rememberSelection(
    seatKey: string,
    idSetKey: string,
    readable: Array<{ id: string; stat: RecordStat }>,
    selected: { id: string; path: string; source: string },
  ): void {
    this.rememberStats(seatKey, idSetKey, readable, selected);
  }
}

function byIdKey(byId: Map<string, unknown>): string {
  return [...byId.keys()].sort().join("|");
}

/** The live codex occupant's thread id, via its own pid's log join — bypasses the stored resume
 *  token entirely (the stored token is exactly what went stale on the specimen class). */
export async function resolveLiveCodexThreadId(
  sessionTarget: string,
  deps: CurrentGenerationDeps,
): Promise<CurrentRecordResolution> {
  const panePid = await deps.getPanePid(sessionTarget);
  if (!panePid) return { ok: false, reason: `no live pane pid for ${sessionTarget}` };
  const processes = await deps.listProcesses();
  const codexPids = findDescendants(processes, panePid, commandBasenameIs("codex"));
  if (codexPids.length === 0) return { ok: false, reason: `no codex process under the live pane of ${sessionTarget}` };
  for (const pid of codexPids) {
    const threadId = await deps.readThreadIdByPid(pid, processes.find((p) => p.pid === pid)?.startedAt);
    if (threadId) return { ok: true, id: threadId };
  }
  return { ok: false, reason: `live codex process under ${sessionTarget} yielded no thread id from its logs` };
}
