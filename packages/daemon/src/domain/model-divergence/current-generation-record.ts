// Resolve the CURRENT OCCUPANT's provider record through the registered pane and its verified
// process identity. Transcript metadata is consulted only after that physical/occupant join holds.
// A registry token is continuity metadata, not live identity, and transcript recency is never an
// identity tie-breaker: a deliberately retained predecessor may keep writing forever.

import { dirname, join } from "node:path";

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

export interface ClaudeOccupantRecordInput {
  sessionName: string;
  generation: string | null;
  occupantBootAt: string | null;
  binding: { tmuxSession: string | null; tmuxPane: string | null } | null;
  identity: {
    verdict: string;
    sessionName: string | null;
    observedAt: string;
    evidence: { registeredPane: string | null; observedPid: number | null };
  } | null;
  sidecar: {
    session_id?: string;
    session_name?: string;
    transcript_path?: string;
    sampled_at?: string;
    occupant_generation?: string;
  } | null;
}

export type ClaudeRecordSelection =
  | { ok: true; id: string; path: string; source: "generation-sidecar" | "verified-pane-argument" }
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

/** The pane process's Claude session-id LAUNCH ARGUMENT. It is authoritative only after the caller
 *  verifies the canonical binding and current pane identity. A current-generation sidecar may
 *  supersede it after a provider-internal session rollover. */
export async function paneClaudeSessionIdArgument(
  sessionTarget: string,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
): Promise<CurrentRecordResolution> {
  const panePid = await deps.getPanePid(sessionTarget);
  if (!panePid) return { ok: false, reason: `no live pane pid for ${sessionTarget}` };
  const processes = await deps.listProcesses();
  const claudePids = findDescendants(processes, panePid, commandBasenameIs("claude"));
  if (claudePids.length === 0) return { ok: false, reason: `no claude process under the live pane of ${sessionTarget}` };
  const ids = new Set<string>();
  for (const pid of claudePids) {
    const command = processes.find((p) => p.pid === pid)?.command ?? "";
    const match = command.match(/--session-id[= ]([0-9a-f-]{36})/) ?? command.match(/--resume[= ]([0-9a-f-]{36})/);
    if (match?.[1]) ids.add(match[1]);
  }
  if (ids.size === 1) return { ok: true, id: [...ids][0]! };
  if (ids.size > 1) return { ok: false, reason: `multiple claude session ids under the live pane of ${sessionTarget}: ${[...ids].join(", ")}` };
  return { ok: false, reason: `live claude process under ${sessionTarget} carries no --session-id/--resume argument` };
}

/**
 * Resolve a Claude record only after the canonical seat's current occupant is joined to its
 * registered pane and the pane's PID still matches the durable identity verdict. The pane's launch
 * argument is the legacy identity anchor. A generation-stamped sidecar may supersede it after a
 * provider-internal session rollover; an unstamped sidecar may locate files but cannot override it.
 */
export async function resolveIdentityVerifiedClaudeRecord(
  input: ClaudeOccupantRecordInput,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
  isReadableRecord: (path: string) => boolean,
): Promise<ClaudeRecordSelection> {
  if (!input.generation) {
    return { ok: false, reason: `current occupant generation is unknown for ${input.sessionName}` };
  }
  if (!input.occupantBootAt || !Number.isFinite(Date.parse(input.occupantBootAt))) {
    return { ok: false, reason: `current occupant boot time is unknown for ${input.sessionName}` };
  }
  const binding = input.binding;
  if (!binding?.tmuxPane || binding.tmuxSession !== input.sessionName) {
    return { ok: false, reason: `no canonical tmux pane binding for ${input.sessionName}` };
  }
  const identity = input.identity;
  if (!identity || identity.verdict !== "verified") {
    return { ok: false, reason: `no verified pane identity for ${input.sessionName}${identity ? ` (verdict ${identity.verdict})` : ""}` };
  }
  if (identity.sessionName !== input.sessionName) {
    return { ok: false, reason: `verified identity names ${identity.sessionName ?? "no session"}, not ${input.sessionName}` };
  }
  if (identity.evidence.registeredPane !== binding.tmuxPane) {
    return { ok: false, reason: `verified identity's registered pane does not match binding ${binding.tmuxPane}` };
  }
  const observedAt = Date.parse(identity.observedAt);
  if (!Number.isFinite(observedAt) || observedAt < Date.parse(input.occupantBootAt)) {
    return { ok: false, reason: `verified pane identity predates occupant generation ${input.generation}` };
  }
  if (identity.evidence.observedPid === null) {
    return { ok: false, reason: `verified pane identity carries no observed pid for ${input.sessionName}` };
  }
  const panePid = await deps.getPanePid(binding.tmuxPane);
  if (!panePid) return { ok: false, reason: `registered pane ${binding.tmuxPane} has no live pid` };
  if (panePid !== identity.evidence.observedPid) {
    return {
      ok: false,
      reason: `registered pane pid changed since identity verification (${identity.evidence.observedPid} -> ${panePid})`,
    };
  }

  const processes = await deps.listProcesses();
  const claudePids = findDescendants(processes, panePid, commandBasenameIs("claude"));
  if (claudePids.length === 0) {
    return { ok: false, reason: `no claude process under verified pane ${binding.tmuxPane}` };
  }
  const paneIds = new Set<string>();
  for (const pid of claudePids) {
    const command = processes.find((process) => process.pid === pid)?.command ?? "";
    const match = command.match(/--session-id[= ]([0-9a-f-]{36})/) ?? command.match(/--resume[= ]([0-9a-f-]{36})/);
    if (match?.[1]) paneIds.add(match[1]);
  }
  if (paneIds.size === 0) {
    return { ok: false, reason: `claude process under verified pane ${binding.tmuxPane} carries no session id` };
  }
  if (paneIds.size > 1) {
    return { ok: false, reason: `multiple claude session ids under verified pane ${binding.tmuxPane}: ${[...paneIds].join(", ")}` };
  }
  const paneId = [...paneIds][0]!;
  const sidecar = input.sidecar;
  const sidecarPath = cleanString(sidecar?.transcript_path);
  const sidecarId = cleanString(sidecar?.session_id);
  const sidecarGeneration = cleanString(sidecar?.occupant_generation);

  // A current-generation sidecar is the supported provider-rollover signal. Its generation stamp
  // comes from the managed occupant's launch environment, so a retained predecessor carries its
  // old generation even when its launch-time --name aliases the canonical seat.
  if (sidecarGeneration === input.generation && sidecarId && sidecarPath) {
    const sampledAt = Date.parse(cleanString(sidecar?.sampled_at) ?? "");
    if (
      sidecar?.session_name === input.sessionName
      && Number.isFinite(sampledAt)
      && sampledAt >= Date.parse(input.occupantBootAt)
      && isReadableRecord(sidecarPath)
    ) {
      return { ok: true, id: sidecarId, path: sidecarPath, source: "generation-sidecar" };
    }
  }

  // Legacy sidecars have no occupant-generation stamp. They may locate the project transcript
  // directory, but the verified pane's own launch id chooses the file. No registry token and no
  // mtime participate in this decision.
  if (sidecarPath) {
    const panePath = sidecarId === paneId ? sidecarPath : join(dirname(sidecarPath), `${paneId}.jsonl`);
    if (isReadableRecord(panePath)) {
      return { ok: true, id: paneId, path: panePath, source: "verified-pane-argument" };
    }
  }
  return {
    ok: false,
    reason: `verified occupant ${input.generation} resolves native session ${paneId}, but its transcript is unreadable`,
  };
}

function cleanString(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
