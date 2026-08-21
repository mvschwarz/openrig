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
// What IS generation-true: the record being WRITTEN. selectLiveClaudeRecord gathers every candidate
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
}

export interface CurrentGenerationDeps {
  getPanePid: (sessionTarget: string) => Promise<number | null>;
  listProcesses: () => Promise<ProcessRow[]>;
  /** Codex: thread id for a live codex pid (the logs join; async post-F1). */
  readThreadIdByPid: (pid: number) => Promise<string | undefined> | string | undefined;
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
 *  pointer while the sidecar is current. Feed it into selectLiveClaudeRecord with the others. */
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

/** Gap between the two advancement samples: long enough for a working seat to append, short enough
 *  to stay inside one monitor poll even across several claude seats. */
export const ADVANCEMENT_PROBE_MS = 1_500;

/** The CURRENT claude record, FAIL-CLOSED (r2 rounds 2+3 on this family): neither existence nor
 *  RECENCY proves a record is being written — the old record can take its final write seconds
 *  before the new one becomes readable at exactly the handover boundary this hardening covers.
 *  Semantics:
 *  - candidates dedupe by id (an id is readable if ANY of its paths stats).
 *  - an UNREADABLE contender with a different id → ALWAYS a named INDETERMINATE (it might be the
 *    advancing one we cannot see; no readable evidence can outvote it).
 *  - exactly one readable id, no differing unreadable contender → that record (unanimity has
 *    nothing to disambiguate).
 *  - multiple readable ids → OBSERVED ADVANCEMENT across two samples: stat all, wait
 *    ADVANCEMENT_PROBE_MS, stat again; exactly ONE record advancing (size or mtime) wins. None
 *    advancing (idle seat) or several advancing → named INDETERMINATE — and the monitor's pending
 *    machinery re-probes every poll, so the ambiguity resolves the moment the live session writes. */
export async function selectLiveClaudeRecord(
  candidates: ClaudeRecordCandidate[],
  statRecord: (path: string) => RecordStat | null,
  opts?: { probeDelayMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<ClaudeRecordSelection> {
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const probeDelayMs = opts?.probeDelayMs ?? ADVANCEMENT_PROBE_MS;

  const byId = new Map<string, { source: string; path: string | null }>();
  for (const c of candidates) {
    if (!c.id) continue;
    const existing = byId.get(c.id);
    if (!existing || (existing.path === null && c.path !== null)) byId.set(c.id, { source: c.source, path: c.path });
  }
  const readable: Array<{ id: string; path: string; source: string; first: RecordStat }> = [];
  const unreadable: string[] = [];
  for (const [id, { source, path }] of byId) {
    const stat = path ? statRecord(path) : null;
    if (path && stat) readable.push({ id, path, source, first: stat });
    else unreadable.push(`${source}:${id.slice(0, 8)}… (${path ? "no file" : "no path"})`);
  }
  if (readable.length === 0) {
    return { ok: false, reason: `no readable transcript for any candidate session (${unreadable.join(", ") || "no candidates"})` };
  }
  const readableIds = new Set(readable.map((r) => r.id));
  if (unreadable.length > 0) {
    // ALWAYS indeterminate: the unreadable contender may be the current record before its first
    // readable byte — confident stale truth here is the exact defect class (r2 round-2 + round-3).
    return {
      ok: false,
      reason: `candidate sessions disagree and ${unreadable.length} contender(s) are unreadable (${unreadable.join(", ")}; readable: ${readable.map((r) => `${r.source}:${r.id.slice(0, 8)}…`).join(", ")}) — the unreadable one may be the record being written`,
    };
  }
  if (readableIds.size === 1) {
    const only = readable[0]!;
    return { ok: true, id: only.id, path: only.path, source: only.source };
  }
  await sleep(probeDelayMs);
  const advanced = readable.filter((r) => {
    const second = statRecord(r.path);
    return second !== null && (second.size !== r.first.size || second.mtimeMs !== r.first.mtimeMs);
  });
  if (advanced.length === 1) {
    const winner = advanced[0]!;
    return { ok: true, id: winner.id, path: winner.path, source: winner.source };
  }
  return {
    ok: false,
    reason:
      `candidate sessions disagree (${readable.map((r) => `${r.source}:${r.id.slice(0, 8)}…`).join(", ")}) and ` +
      (advanced.length === 0
        ? `no record advanced during the ${probeDelayMs}ms probe — idle or between writes; re-probed next poll`
        : `${advanced.length} records advanced simultaneously — genuinely ambiguous`),
  };
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
    const threadId = await deps.readThreadIdByPid(pid);
    if (threadId) return { ok: true, id: threadId };
  }
  return { ok: false, reason: `live codex process under ${sessionTarget} yielded no thread id from its logs` };
}
