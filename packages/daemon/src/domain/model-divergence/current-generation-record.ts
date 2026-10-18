// Resolve the CURRENT OCCUPANT's provider record through the registered pane and its verified
// process identity. Transcript metadata is consulted only after that physical/occupant join holds.
// A registry token is continuity metadata, not live identity, and transcript recency is never an
// identity tie-breaker: a deliberately retained predecessor may keep writing forever.

import { basename, dirname, join, relative, isAbsolute, sep } from "node:path";
import { parseSqliteUtcMs } from "../sqlite-time.js";
import { piPinReadings, piSeatPinReadings, readPiEffectiveModel } from "./effective-model-readers.js";
import { piSeatPaths } from "../../adapters/pi-runner-protocol.js";
import { canonicalModelPin, modelsMatch } from "./model-divergence-monitor.js";
import { isShellForeground } from "../shell-classifier.js";

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
  // occupant_tenures.boot_at is a zone-less SQLite UTC stamp; a bare Date.parse would read it as local time.
  const bootAtMs = input.occupantBootAt ? parseSqliteUtcMs(input.occupantBootAt) : NaN;
  if (!Number.isFinite(bootAtMs)) {
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
  if (!Number.isFinite(observedAt) || observedAt < bootAtMs) {
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
      && sampledAt >= bootAtMs
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
  const ids = new Set<string>();
  for (const pid of codexPids) {
    const threadId = await deps.readThreadIdByPid(pid, processes.find((p) => p.pid === pid)?.startedAt);
    if (threadId) ids.add(threadId);
  }
  if (ids.size === 1) return { ok: true, id: [...ids][0]! };
  if (ids.size > 1) return { ok: false, reason: `multiple codex threads under the live pane of ${sessionTarget}` };
  return { ok: false, reason: `live codex process under ${sessionTarget} yielded no thread id from its logs` };
}

export interface PiOccupantRecordInput {
  sessionName: string;
  generation: string | null;
  occupantBootAt: string | null;
  binding: { tmuxSession: string | null; tmuxPane: string | null } | null;
  /** The seat's runner sidecar (null = absent or unparseable) and its sessions folder, with the
   *  runner entry path and state root the adapter itself launches with. */
  runner: {
    state: { ready?: boolean; launchId?: string; sessionFile?: string; exited?: unknown } | null;
    sessionsDir: string;
    entryPath: string;
    stateRoot: string;
  };
}

export type PiRecordSelection =
  | { ok: true; path: string; launchId: string; notBeforeMs: number }
  | { ok: false; reason: string };

/** The value after `flag` in a whitespace-tokenized process command line, or null. */
function flagValue(tokens: string[], flag: string): string | null {
  const at = tokens.indexOf(flag);
  const value = at >= 0 ? tokens[at + 1] : undefined;
  return value ? value.replace(/^['"]|['"]$/g, "") : null;
}

/**
 * Resolve a Pi seat's session file only when the registered pane runs exactly one runner for this
 * seat, in the supported managed-launch shape, and that runner wrote the sidecar. Every managed
 * launch and resume types `node <runnerEntryPath> --session-name ... --state-root ... --cwd ...
 * --launch-id ...` into the pane's shell, directly or through a staged script or `/usr/bin/env` that
 * execs it, so the runner is a direct child of a pane process that is a shell, and its command
 * starts with exactly those arguments. A runner nested in another program, a copy at another path
 * or state root, a repeated identity flag, or any second process naming this seat with a launch id
 * leaves the seat unknown. This matches the managed-launch shape; it does not prove the daemon
 * started the runner (one typed by hand at the pane's prompt has the same shape). The runner's
 * `--launch-id` must equal the sidecar's, so a sidecar left by an earlier runner never answers. The
 * sidecar must say ready and not exited, and its session file must sit under the seat's own
 * sessions folder. `notBeforeMs` scopes the records to this runner's tenure: the later of the
 * occupant's boot and the runner process start, both second-resolution stamps, so the whole
 * starting second is excluded (a record in it could be the predecessor's). A resume keeps the same
 * session file, so this is what separates the previous occupant's records from this one's.
 */
export async function resolveIdentityVerifiedPiRecord(
  input: PiOccupantRecordInput,
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
  realpath: (path: string) => string | null,
): Promise<PiRecordSelection> {
  if (!input.generation) {
    return { ok: false, reason: `current occupant generation is unknown for ${input.sessionName}` };
  }
  const bootAtMs = input.occupantBootAt ? parseSqliteUtcMs(input.occupantBootAt) : NaN;
  if (!Number.isFinite(bootAtMs)) {
    return { ok: false, reason: `current occupant boot time is unknown for ${input.sessionName}` };
  }
  const binding = input.binding;
  if (!binding?.tmuxPane || binding.tmuxSession !== input.sessionName) {
    return { ok: false, reason: `no canonical tmux pane binding for ${input.sessionName}` };
  }
  const state = input.runner.state;
  if (!state) return { ok: false, reason: `no readable Pi runner sidecar for ${input.sessionName}` };
  if (state.exited) return { ok: false, reason: `Pi runner sidecar for ${input.sessionName} says the runner exited` };
  if (state.ready !== true) return { ok: false, reason: `Pi runner sidecar for ${input.sessionName} is not ready` };
  const launchId = cleanString(state.launchId);
  if (!launchId) return { ok: false, reason: `Pi runner sidecar for ${input.sessionName} carries no launch id` };

  const panePid = await deps.getPanePid(binding.tmuxPane);
  if (!panePid) return { ok: false, reason: `registered pane ${binding.tmuxPane} has no live pid` };
  const processes = await deps.listProcesses();
  // The managed runner is typed into the pane's shell. A program that replaced that shell keeps
  // its pid, so the pane's own process must still read as a shell.
  const paneCommand = processes.find((process) => process.pid === panePid)?.command.trim().split(/\s+/)[0] ?? "";
  if (!isShellForeground(basename(paneCommand.replace(/^-/, "")))) {
    return { ok: false, reason: `the process of registered pane ${binding.tmuxPane} is not a shell` };
  }
  // Candidates: every process under the pane naming this seat with a launch id, whatever its shape.
  const candidates = findDescendants(processes, panePid, (command) => {
    const tokens = command.trim().split(/\s+/);
    return flagValue(tokens, "--session-name") === input.sessionName && flagValue(tokens, "--launch-id") !== null;
  }).map((pid) => processes.find((process) => process.pid === pid)!);
  if (candidates.length === 0) {
    return { ok: false, reason: `no managed Pi runner under registered pane ${binding.tmuxPane}` };
  }
  if (candidates.length > 1) {
    return { ok: false, reason: `${candidates.length} processes under registered pane ${binding.tmuxPane} name ${input.sessionName} with a launch id` };
  }
  const runner = candidates[0]!;
  if (runner.ppid !== panePid) {
    return { ok: false, reason: `the Pi runner under ${binding.tmuxPane} is not a direct child of the pane's shell` };
  }
  // ps joins argv with spaces, and the entry path and state root may contain spaces. Matching the
  // exact order buildPiRunnerCommand writes pins where each value ends: the next fixed flag must
  // follow it, so an extra word after the entry path or the state root does not match.
  const command = runner.command.trim();
  const head = `node ${input.runner.entryPath} --session-name ${input.sessionName} --state-root ${input.runner.stateRoot} --cwd `;
  if (!command.startsWith(head)) {
    return { ok: false, reason: `the Pi runner under ${binding.tmuxPane} does not start with the managed runner arguments` };
  }
  // The runner's parser keeps the last of a repeated flag, and a Pi launch never passes --runtime,
  // so either one leaves the runner's identity ambiguous.
  const words = command.split(/\s+/);
  const repeated = ["--session-name", "--state-root", "--cwd", "--launch-id"].filter((flag) => words.filter((word) => word === flag).length !== 1);
  if (repeated.length > 0 || words.includes("--runtime")) {
    return { ok: false, reason: `the Pi runner under ${binding.tmuxPane} has ambiguous identity arguments` };
  }
  const paneLaunchId = flagValue(words, "--launch-id")!;
  if (paneLaunchId !== launchId) {
    return { ok: false, reason: `Pi runner sidecar launch ${launchId} is not the pane's live runner launch ${paneLaunchId}` };
  }
  const startedMs = Date.parse(runner.startedAt ?? "");
  if (!Number.isFinite(startedMs)) {
    return { ok: false, reason: `the live Pi runner under ${binding.tmuxPane} has no readable start time` };
  }

  const sessionFile = cleanString(state.sessionFile);
  if (!sessionFile) return { ok: false, reason: `Pi runner sidecar for ${input.sessionName} reports no session file` };
  const file = realpath(sessionFile);
  const folder = realpath(input.runner.sessionsDir);
  const inside = file !== null && folder !== null ? relative(folder, file) : null;
  if (inside === null || inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return { ok: false, reason: `Pi session file ${sessionFile} is not under the seat's sessions folder` };
  }
  return { ok: true, path: file!, launchId, notBeforeMs: Math.max(bootAtMs, startedMs) + 999 };
}

/** A Pi seat's effective-model read as the monitor wires it: the pin must resolve to a
 *  `provider/model` id (a Pi record names both, so any other pin could never match and would only
 *  proclaim falsely), then the live runner's own session file, then this occupant's newest record.
 *  Every gap is a named no-answer — pending, never a refusal. */
export async function readCurrentPiOccupantModel(
  input: PiOccupantRecordInput & { pinnedModel: string },
  deps: Pick<CurrentGenerationDeps, "getPanePid" | "listProcesses">,
  realpath: (path: string) => string | null,
): Promise<{ ok: true; model: string; pinReadings: string[] } | { ok: false; reason: string }> {
  if (!/^[^/\s]+\/\S+$/.test(canonicalModelPin(input.pinnedModel))) {
    return { ok: false, reason: `pin ${input.pinnedModel} does not resolve to a provider/model id a Pi record can match` };
  }
  const selection = await resolveIdentityVerifiedPiRecord(input, deps, realpath);
  if (!selection.ok) return selection;
  const read = readPiEffectiveModel(selection.path, { notBeforeMs: selection.notBeforeMs });
  if (!read.ok) return read;
  const pins = piSeatPinReadings(input.pinnedModel, piSeatPaths(input.runner.stateRoot, input.sessionName).agentDir);
  if (pins.ok) return { ...read, pinReadings: pins.readings };
  // An unreadable models.json only hides which reading Pi chose: a record that matches none of them diverges either way.
  const readings = piPinReadings(input.pinnedModel);
  return readings.some((pin) => modelsMatch(pin, read.model)) ? pins : { ...read, pinReadings: readings };
}
