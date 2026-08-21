// D-a (B8-family) — resolve the CURRENT OCCUPANT's provider record via the LIVE PANE PROCESS.
//
// Third cross-generation-keying specimen tonight forced this: name/token-keyed lookups silently
// cross generation boundaries (B16's sidecar overwrite, slice-13's resume_type carry-forward, and
// now the detector itself quoting an OLD generation's transcript — masking a REAL divergence on
// dev.planner, which ran claude-opus-5 unpinned while the reader proclaimed a stale alias).
//
// Why the pane process is the join, measured live on the specimen before building:
//   - occupant_tenures.native_session_id_at_boot is NULL on every tenure on this box (the ledger
//     field the fix shape named is unpopulated — flagged upstream; when it fills, it becomes a
//     cheaper first check, not a replacement for this).
//   - the name-keyed sidecar AND the newest sessions-registry row were BOTH stale together
//     (sidecar session_id 1cb8cd8b == newest row's token, while the live pane process ran
//     --session-id daaeb7b4). Stored records can agree with each other and still not be the
//     occupant. The pane's process tree is the only record that IS the occupant.
//
// All process reads are async (the F1/B12 discipline): pane pid via tmux, one bounded process-table
// sample, argument parse. Every failure is a NAMED reason, never a silent fall-through to a stored
// (possibly stale) record — the ruled shape: honest INDETERMINATE over a masked old-gen read.

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

/** The live claude occupant's session uuid, read from its own launch arguments (--session-id /
 *  --resume <uuid> forms). The process IS the generation; no stored record can go stale under it. */
export async function resolveLiveClaudeSessionId(
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
