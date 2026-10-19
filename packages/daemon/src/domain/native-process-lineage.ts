import { isShellForeground } from "./shell-classifier.js";
import { runAsyncSite } from "./sync-site-wrap.js";
import { readNativeExecutablePaths } from "./native-process-executable.js";
import { readProcessTable } from "./process-table.js";

export interface NativeProcessRow {
  pid: number;
  ppid: number;
  command: string;
  pgid?: number;
  tpgid?: number;
  executableName?: string;
  /** OS executable path, not argv[0], for otherwise unresolved Claude rows. */
  executablePath?: string;
  startedAt?: string;
}

export type NativeRuntime = "claude-code" | "codex";

function tokens(command: string): string[] {
  // ps flattens argv: inline settings JSON retains its string delimiters.
  // A quote inside a name or filename is literal, not a shell span delimiter.
  const result: string[] = [];
  let start = 0;
  let quote: string | null = null;
  const append = (end: number) => {
    if (start === end) return;
    const token = command.slice(start, end);
    result.push(token[0] === '"' && token.at(-1) === '"'
      ? token.slice(1, -1) : token);
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== null) {
      if (quote === '"' && char === "\\") { index += 1; continue; }
      if (char === quote) quote = null;
    } else if (char === '"' && (command.startsWith('"{', start) || command[start] === "{"
      || command.startsWith("'{", start) || command.startsWith("--settings={", start)
      || command.startsWith('--settings="', start))) {
      quote = char;
    } else if (/\s/.test(char)) {
      append(index);
      start = index + 1;
    }
  }
  // Keep an unfinished structured value opaque too. Re-splitting it could
  // promote text inside settings into apparent top-level identity options.
  append(command.length);
  return result;
}

function executableName(token: string): string {
  return (token.split("/").pop() ?? token).toLowerCase().replace(/\.exe$/, "");
}

// The native installer resolves `claude` to this versioned path. A bare version
// number is never executable identity. A launch receipt takes precedence over
// layout recognition, so a later PATH update cannot replace that launch's binary.
function claudeExecutable(token: string, selectedExecutable?: string): boolean {
  // An observed path must match the frozen launch path, even when its basename
  // is claude. A bare process title carries no path and retains legacy token proof.
  if (selectedExecutable && token.includes("/")) return token === selectedExecutable;
  if (executableName(token) === "claude") return true; // includes native process-title spelling
  if (selectedExecutable) return token === selectedExecutable;
  return token.startsWith("/") && !token.split("/").some(part => part === "." || part === "..")
    && /\/\.local\/share\/claude\/versions\/\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(token);
}

// Nixpkgs packages Claude as a wrapper that execs its sibling `.claude-unwrapped`
// (wrapProgram: `.claude-wrapped`) with argv[0] inherited. Linux truncates that OS
// name to 15 bytes, so ucomm reads `.claude-unwrapp`.
const NIX_WRAPPED_CLAUDE_NAMES = [".claude-unwrapped", ".claude-wrapped"];
const TASK_COMM_LENGTH = 15;

function osNameIs(osName: string, name: string): boolean {
  return osName === name || (osName.length === TASK_COMM_LENGTH && name.startsWith(osName));
}

// Only the wrapped binary inside a claude-code store output, and when a launch froze
// its executable, only the sibling of that wrapper.
function nixWrappedClaudeExecutable(path: string, selectedExecutable?: string): boolean {
  const match = path.match(/^(\/nix\/store\/[0-9a-df-np-sv-z]{32}-claude-code(?:-[^/]+)?\/bin)\/\.claude-(?:un)?wrapped$/);
  if (!match || path.split("/").some(part => part === "." || part === "..")) return false;
  return !selectedExecutable || selectedExecutable === `${match[1]}/claude`;
}

function claudeProcess(row: NativeProcessRow, selectedExecutable?: string): boolean {
  const argv0 = tokens(row.command)[0] ?? "";
  if (!claudeExecutable(argv0, selectedExecutable)) return false;
  const osName = row.executableName ?? "";
  if (executableName(osName) === executableName(argv0)) return true;
  // Native Claude can retain its versioned OS name while rewriting argv[0] to
  // claude, and a Nix wrapper leaves its wrapped OS name. Either name only selects
  // candidates for an OS path read; it is not proof.
  const path = row.executablePath;
  if (!needsClaudeExecutablePath(row) || !path) return false;
  if (claudeExecutable(path, selectedExecutable) && executableName(path) === executableName(osName)) return true;
  return nixWrappedClaudeExecutable(path, selectedExecutable) && osNameIs(osName, path.split("/").pop()!);
}

function needsClaudeExecutablePath(row: NativeProcessRow): boolean {
  const argv0 = tokens(row.command)[0] ?? "";
  const osName = row.executableName ?? "";
  return claudeExecutable(argv0)
    && executableName(osName) !== executableName(argv0)
    && (/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(osName)
      || NIX_WRAPPED_CLAUDE_NAMES.some(name => osNameIs(osName, name)));
}

// A launch whose frozen file is a `#!` script (a user's wrapper that execs the real Claude) can't be recognised
// by that path: the live process runs the binary the script chose. Only when the exact-path match above finds
// nothing, such a process is Claude when the OS itself names its executable `claude` (or the versioned install
// layout) and agrees with the OS process name. A name alone is not enough: the path is read from the OS, never
// from the script, and the caller pins the fingerprint that contains it.
function claudeProcessAfterScript(row: NativeProcessRow): boolean {
  const path = row.executablePath;
  if (!path || !path.startsWith("/") || path.split("/").some(part => part === "." || part === "..")) return false;
  return claudeExecutable(tokens(row.command)[0] ?? "") && claudeExecutable(path)
    && executableName(path) === executableName(row.executableName ?? "");
}

// The rows whose OS path the script rule reads: a foreground process whose argv[0] is a path named `claude` and
// whose OS name is `claude`. A bare `claude` title carries no path and keeps today's result without a read.
function mayBeClaudeAfterScript(row: NativeProcessRow): boolean {
  const argv0 = tokens(row.command)[0] ?? "";
  return argv0.startsWith("/") && executableName(argv0) === "claude" && executableName(row.executableName ?? "") === "claude"
    && row.pgid !== undefined && row.pgid > 0 && row.pgid === row.tpgid;
}

function commandUsesExpectedToken(command: string, runtime: NativeRuntime, expectedToken: string): boolean {
  const argv = tokens(command);
  const executable = runtime === "claude-code" ? "claude" : "codex";
  const executableIndex = argv.findIndex((token) => runtime === "claude-code" ? claudeExecutable(token) : executableName(token) === executable);
  if (executableIndex < 0) return false;
  const args = argv.slice(executableIndex + 1);
  if (runtime === "claude-code") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if ((arg === "--resume" || arg === "--session-id") && args[index + 1] === expectedToken) return true;
      if (arg === `--resume=${expectedToken}` || arg === `--session-id=${expectedToken}`) return true;
    }
    return false;
  }

  return codexConversationToken(args, "resume") === expectedToken;
}

// undefined is another command; null is the requested command without an exact token.
function codexConversationToken(args: string[], subcommand: "resume" | "fork"): string | null | undefined {
  const topLevelOptionsWithValues = new Set([
    "-a", "--ask-for-approval", "-c", "--config", "-m", "--model",
    "-p", "--profile", "-s", "--sandbox",
  ]);
  let resumeIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (topLevelOptionsWithValues.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    if (arg === subcommand) resumeIndex = index;
    break;
  }
  if (resumeIndex < 0) return undefined;
  const resumeArgs = args.slice(resumeIndex + 1);
  let index = 0;
  while (index < resumeArgs.length) {
    const arg = resumeArgs[index]!;
    if (arg === "--add-dir") { index += 2; continue; }
    if (arg.startsWith("-")) { index += 1; continue; }
    return arg;
  }
  return null;
}

/** A `ps` command line split the way identity proof splits it. */
export function processArgv(command: string): string[] {
  return tokens(command);
}

/** The conversation a Claude command line names (--resume, --session-id, or a fork's own --session-id);
 *  null when it names none or can't be parsed as one. */
export function claudeCommandSessionToken(command: string): string | null {
  return claudeSessionToken(tokens(command).slice(1));
}

/** The conversation a Codex command line resumes: its token, null for a resume naming none, undefined
 *  when the command is not a resume at all (a fresh `codex -C …`). */
export function codexCommandResumeToken(command: string): string | null | undefined {
  return codexConversationToken(tokens(command).slice(1), "resume");
}

type ClaudeArgvIds = { resume: string | null; "session-id": string | null };

/** The conversation a parsed Claude argv names. A fork's --resume names its parent, so with
 *  --fork-session only the fork's own --session-id names it, and both must be present. Without
 *  --fork-session one identity names it and two prove nothing. undefined: no positive proof. */
function claudeArgvIdentity(ids: ClaudeArgvIds, fork: boolean): string | null | undefined {
  if (fork) return ids.resume !== null && ids["session-id"] !== null ? ids["session-id"] : undefined;
  if (ids.resume !== null && ids["session-id"] !== null) return undefined;
  return ids.resume ?? ids["session-id"];
}

// Managed fresh/resume/fork launches name the current Claude identity explicitly.
function claudeSessionToken(args: string[]): string | null {
  const ids: ClaudeArgvIds = { resume: null, "session-id": null };
  let fork = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (index === 0 && /^\(\d+\.\d+\.\d+[^)]*\)$/.test(arg)) continue;
    if (arg === "--settings") {
      const value = args[++index];
      if (!value || value.startsWith("-")) return null;
      continue;
    }
    if (arg === "--remote-control") {
      if (args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (["--permission-mode", "--model", "--name", "--effort"].includes(arg)) { index += 1; continue; }
    if (/^--(?:permission-mode|model|name|settings|effort)=/.test(arg)
      || arg.startsWith("--remote-control=") || arg === "--dangerously-skip-permissions") continue;
    if (arg === "--fork-session") { fork = true; continue; }
    const identity = arg.match(/^--(session-id|resume)(?:=(.*))?$/);
    if (!identity) return null; // Unknown argv is not positive identity proof.
    const kind = identity[1] as keyof ClaudeArgvIds;
    const value = identity[2] ?? args[++index];
    if (ids[kind] !== null || !value || value.startsWith("-")) return null;
    ids[kind] = value;
  }
  return claudeArgvIdentity(ids, fork) ?? null;
}

// Delivery-only reading of a Claude argv. Like the strict selector, it accepts
// launch-only --settings. null: the argv parsed and names no session.
// "unparsed": an argument was not recognised, so the argv proves nothing.
function claudeSessionIdentity(args: string[]): string | null | { unparsed: true } {
  const unparsed = { unparsed: true } as const;
  const ids: ClaudeArgvIds = { resume: null, "session-id": null };
  let fork = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (index === 0 && /^\(\d+\.\d+\.\d+[^)]*\)$/.test(arg)) continue;
    if (["--permission-mode", "--model", "--name", "--settings", "--effort"].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith("-")) return unparsed;
      continue;
    }
    if (arg === "--remote-control") {
      if (args[index + 1] && !args[index + 1]!.startsWith("-")) index += 1;
      continue;
    }
    if (/^--(?:permission-mode|model|name|settings|effort)=/.test(arg)
      || arg.startsWith("--remote-control=") || arg === "--dangerously-skip-permissions") continue;
    if (arg === "--fork-session") { fork = true; continue; }
    const identity = arg.match(/^--(session-id|resume)(?:=(.*))?$/);
    if (!identity) return unparsed; // Unknown argv is not positive identity proof.
    const kind = identity[1] as keyof ClaudeArgvIds;
    const value = identity[2] ?? args[++index];
    if (ids[kind] !== null || !value || value.startsWith("-")) return unparsed;
    ids[kind] = value;
  }
  const named = claudeArgvIdentity(ids, fork);
  return named === undefined ? unparsed : named;
}

const DELETED_WITNESS = " (deleted)";

/** A Claude process with a present executable witness: `claudeProcess`, or a native
 * or Nix Claude whose Linux witness is its unlinked binary (`<path> (deleted)` after
 * an upgrade or garbage collection) and whose stripped path passes `claudeProcess`.
 * Kept out of `claudeProcess` itself, which delivery also uses. Any other present
 * path that does not match stays unverified. */
function witnessedClaudeRow(row: NativeProcessRow): boolean {
  return claudeProcess(row) || (needsClaudeExecutablePath(row) && row.executablePath?.endsWith(DELETED_WITNESS) === true
    && claudeProcess({ ...row, executablePath: row.executablePath.slice(0, -DELETED_WITNESS.length) }));
}

/** A Claude runtime where only main's result is kept: a witnessed Claude, or a
 * native or Nix Claude (argv0 claude, a version or Nix OS name) whose witness is
 * unavailable (unreadable, exited or over budget). Used for the parent role and the
 * intermediate stop only, never to recognise a child that refuses its launcher or
 * takes the proof. */
function claudeRuntimeRow(row: NativeProcessRow): boolean {
  return witnessedClaudeRow(row) || (needsClaudeExecutablePath(row) && row.executablePath === undefined);
}

/** Verified Claude runtimes that `parent` starts directly (same process group,
 * no shell or other Claude runtime between), keyed by the conversation each
 * names. A child counts only on a present executable witness
 * (`witnessedClaudeRow`), never on an argument that mentions claude, and only an
 * explicitly parsed `--session-id`/`--resume` names one: an opaque or unparsed
 * child names nothing. The lowest pid wins, so row order cannot change it. */
function directClaudeChildren(parent: NativeProcessRow, processes: NativeProcessRow[], byPid: Map<number, NativeProcessRow>): Map<string, NativeProcessRow> {
  const children = new Map<string, NativeProcessRow>();
  if (parent.pgid === undefined) return children;
  const isShell = (row: NativeProcessRow) => isShellForeground(executableName(tokens(row.command)[0]?.replace(/^-/, "") ?? ""));
  for (const row of processes) {
    if (row === parent || row.pgid !== parent.pgid || !witnessedClaudeRow(row)) continue;
    const identity = claudeSessionIdentity(tokens(row.command).slice(1));
    if (typeof identity !== "string") continue;
    const seen = new Set<number>();
    let current = byPid.get(row.ppid);
    while (current && !seen.has(current.pid)) {
      if (current.pid === parent.pid) {
        const known = children.get(identity);
        if (!known || row.pid < known.pid) children.set(identity, row);
        break;
      }
      // A child of an intermediate runtime belongs to that runtime, not to parent.
      if (isShell(current) || claudeRuntimeRow(current)) break;
      seen.add(current.pid);
      current = byPid.get(current.ppid);
    }
  }
  return children;
}

/** Parents main already accepts as a Claude runtime, for keeping main's result
 * when a child names another conversation: a Claude runtime by OS evidence
 * (`claudeRuntimeRow`); Node (OS name node or unknown) with a Claude executable
 * among its arguments, which is main's own match and is kept for compatibility,
 * not as runtime evidence (it never feeds child recognition); or an older row
 * with no OS name whose argv0 is claude. A shell script launcher and a helper
 * whose argv merely mentions claude are not runtimes. */
function claudeRuntimeParent(row: NativeProcessRow): boolean {
  if (claudeRuntimeRow(row)) return true;
  const [argv0 = "", ...args] = tokens(row.command);
  if (executableName(argv0) === "node" && args.some((arg) => claudeExecutable(arg))
    && (row.executableName === undefined || executableName(row.executableName) === "node")) return true;
  return row.executableName === undefined && claudeExecutable(argv0);
}

/** Require a live process in the pane's own lineage whose argv names both the
 * declared runtime and the exact native resume identity. For Claude, one search also accepts a
 * recorded rotation (#1077): the process that qualified it, naming the token it was launched on,
 * with no Claude beneath it in its foreground process group. */
export function findExactNativeResumeProcess(
  processes: NativeProcessRow[],
  panePid: number,
  runtime: string | null,
  expectedToken: string,
  rotation?: ClaudeResumeRotation | null,
): NativeProcessRow | null {
  if (runtime === "codex") return selectNativeProcess(processes, panePid, expectedToken, true)?.process ?? null;
  if (runtime !== "claude-code") return null;
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const process of processes) {
    const children = byParent.get(process.ppid) ?? [];
    children.push(process);
    byParent.set(process.ppid, children);
  }
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const queue = [panePid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const process = byPid.get(pid);
    if (process && commandUsesExpectedToken(process.command, runtime, expectedToken)) {
      const deeper = directClaudeChildren(process, processes, byPid);
      const exact = deeper.get(expectedToken);
      // A deeper runtime naming the token is the proof process, returned directly so
      // the descent never stops at a helper. The pane root keeps its own row: pane
      // identity stays the root, as on main.
      if (exact) return pid === panePid ? process : exact;
      // A launcher that is not itself a Claude runtime is refused only when a
      // deeper runtime positively names another conversation; its subtree
      // is that runtime chain, so nothing below it is searched. A verified Claude
      // on the token keeps its proof: ps cannot tell a launcher binary over the
      // real Claude from a real Claude that started a child Claude.
      if (claudeRuntimeParent(process) || deeper.size === 0) return process;
      continue;
    }
    // #1077: a recorded rotation, as a separate clause. Only a process that does not name the stored
    // token reaches it (the clause above returns or refuses every one that does), and it is
    // accepted only as the launch-observed process with no Claude runtime beneath it.
    if (process && rotationProcess(process, rotation) && commandUsesExpectedToken(process.command, runtime, rotation!.token)
      && !claudeBeneath(process, byParent)) return process;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

/** Whether a Claude process runs beneath `top` in its foreground process group: the deepest Claude
 *  receives input, so `top`'s argv no longer says which conversation the seat holds. */
function claudeBeneath(top: NativeProcessRow, byParent: Map<number, NativeProcessRow[]>): boolean {
  const queue = [...(byParent.get(top.pid) ?? [])];
  const seen = new Set<number>([top.pid]);
  while (queue.length > 0) {
    const row = queue.shift()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    // An unknown process group may be the foreground one; a foreground group of -1 or 0 is unknown.
    const foreground = row.pgid === undefined || top.tpgid === undefined || top.tpgid <= 0 || row.pgid === top.tpgid;
    if (foreground && mayBeClaudeRuntime(row)) return true;
    queue.push(...(byParent.get(row.pid) ?? []));
  }
  return false;
}

/** Any process that may be a Claude runtime. This only refuses a proof, so it is broader than the
 *  identity check: a verified native Claude, any argv0 naming claude (including an older entry with
 *  no OS executable name), and Node with any argument naming a Claude executable or the npm
 *  package's cli.js/cli.mjs. Node's own options are not parsed, so none can hide the script. */
function mayBeClaudeRuntime(row: NativeProcessRow): boolean {
  if (claudeProcess(row)) return true;
  const [argv0 = "", ...args] = tokens(row.command);
  if (claudeExecutable(argv0)) return true;
  return executableName(argv0) === "node"
    && args.some(arg => claudeExecutable(arg) || /\/@anthropic-ai\/claude-code\/cli\.m?js$/.test(arg));
}

/** The same OS observation serves menu input, restore proof and periodic identity.
 * Older callers may carry only pid/ppid/command; that is insufficient positive Codex proof. */
export async function listNativeProcesses(options: { claudeLaunchPaths?: boolean } = {}): Promise<NativeProcessRow[]> {
  try {
    // Copies: the table is shared with concurrent readers, and executable paths are added below.
    const rows: NativeProcessRow[] = (await runAsyncSite("codex.runtime.list_processes", readProcessTable)).map((row) => ({ ...row }));
    // `claudeLaunchPaths`: the caller is proving a launch through a `#!` script, which needs the OS path of the
    // foreground path-named Claude too. Every other listing skips that read (on macOS it starts a helper process).
    const candidates = rows.filter(row => needsClaudeExecutablePath(row) || (options.claudeLaunchPaths === true && mayBeClaudeAfterScript(row)));
    if (candidates.length > 0) {
      const paths = await readNativeExecutablePaths(candidates.map(row => row.pid));
      for (const row of candidates) row.executablePath = paths.get(row.pid);
    }
    return rows;
  } catch { return []; }
}

export type NativeProcessLister = () => NativeProcessRow[] | Promise<NativeProcessRow[]>;

/** One OS process, by pid and `ps` start time: a reused pid has another start time. */
export interface ClaudeLaunchedProcess { pid: number; startedAt: string }

/** A recorded Claude resume rotation (#1077): OpenRig launched `process` to resume `token`, and that
 *  process's first hook said the conversation continued as the stored token. argv may name `token`
 *  instead of the stored one only in that same process. */
export interface ClaudeResumeRotation { token: string; process: ClaudeLaunchedProcess }

function rotationProcess(row: NativeProcessRow, rotation: ClaudeResumeRotation | null | undefined): boolean {
  return !!rotation && row.pid === rotation.process.pid && !!row.startedAt && row.startedAt === rotation.process.startedAt;
}

/** `afterScript`: found by the script-launch rule, not the exact-path match; its first proof must be pinned. */
export type NativeProcessObservation = { panePid: number; process: NativeProcessRow; fingerprint: string; afterScript?: true };
export type CodexProcessObservation = NativeProcessObservation;

function nativeProcessCandidates(rows: NativeProcessRow[], panePid: number, runtime: NativeRuntime, selectedExecutable?: string, scriptLaunch?: boolean): NativeProcessObservation[] {
  const exact = candidatesMatching(rows, panePid, runtime, row => claudeProcess(row, selectedExecutable));
  if (exact.length > 0 || runtime !== "claude-code" || !selectedExecutable || scriptLaunch !== true) return exact;
  return candidatesMatching(rows, panePid, runtime, claudeProcessAfterScript).map(candidate => ({ ...candidate, afterScript: true as const }));
}

function candidatesMatching(rows: NativeProcessRow[], panePid: number, runtime: NativeRuntime, claudeRow: (row: NativeProcessRow) => boolean): NativeProcessObservation[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(panePid);
  if (byPid.size !== rows.length || !root?.startedAt || !root.tpgid || root.tpgid <= 0) return [];
  const matches: { process: NativeProcessRow; chain: NativeProcessRow[] }[] = [];
  const executable = runtime === "claude-code" ? "claude" : "codex";
  for (const row of rows) {
    const osExecutable = runtime === "claude-code" ? executableName(row.executableName ?? "") : row.executableName;
    if ((runtime === "claude-code" ? !claudeRow(row)
      : osExecutable !== executable || executableName(tokens(row.command)[0] ?? "") !== executable)
      || row.pgid !== root.tpgid || row.tpgid !== root.tpgid) continue;
    const chain: NativeProcessRow[] = [];
    const visited = new Set<number>();
    let current: NativeProcessRow | undefined = row;
    while (current && !visited.has(current.pid) && current.startedAt) {
      visited.add(current.pid);
      chain.push(current);
      if (current.pid === panePid) { matches.push({ process: row, chain }); break; }
      current = byPid.get(current.ppid);
    }
  }
  return matches.map(({ process, chain }) => ({ panePid, process,
    fingerprint: JSON.stringify(chain.map(row => [row.pid, row.ppid, row.startedAt, row.pgid, row.tpgid, row.executableName, row.command, row.executablePath])) }));
}

function selectNativeProcess(rows: NativeProcessRow[], panePid: number, expectedToken?: string | null, requireResume = false, runtime: NativeRuntime = "codex", selectedExecutable?: string, rotation?: ClaudeResumeRotation | null, scriptLaunch?: boolean): NativeProcessObservation | null {
  const matches = nativeProcessCandidates(rows, panePid, runtime, selectedExecutable, scriptLaunch);
  // #1079: a Codex launcher that spawns Codex is one runtime on one chain.
  const chain = runtime === "codex" ? launcherChain(matches, rows) : matches;
  if (!chain || chain.length === 0 || (runtime !== "codex" && chain.length !== 1)) return null;
  const observation = chain[0]!;
  const { process } = observation;
  if (runtime === "claude-code") {
    if (!expectedToken) return null;
    const launched = claudeSessionToken(tokens(process.command).slice(1));
    if (launched !== expectedToken && !(launched === rotation?.token && rotationProcess(process, rotation))) return null;
  } else {
    // Every link that names a conversation must name the expected one, and
    // links naming different conversations stay refused. Exact resume proof
    // needs the deepest process's own argv: a launcher's token is never
    // inherited by a child that names nothing, which stays deliverable but unproved.
    const identities = chain.map((link) => codexConversationToken(tokens(link.process.command).slice(1), "resume"));
    if (new Set(identities.filter((value) => typeof value === "string")).size > 1) return null;
    if (requireResume && (!expectedToken || identities[0] !== expectedToken)) return null;
    if (expectedToken !== undefined && identities.some((value) => value !== undefined
      && (!expectedToken || value !== expectedToken))) return null;
  }
  return observation;
}

/** Whether any process in the pane's subtree (the pane's own process included) has a Claude executable anywhere in its
 *  argv: the recognizer `findExactNativeResumeProcess` (via `commandUsesExpectedToken`) starts from. A Claude run as
 *  `node …/bin/claude`, or in the background, counts. */
export function subtreeNamesClaudeExecutable(rows: NativeProcessRow[], panePid: number): boolean {
  const byParent = new Map<number, NativeProcessRow[]>();
  for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const queue = [panePid];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = byPid.get(pid);
    if (row && tokens(row.command).some((token) => claudeExecutable(token))) return true;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return false;
}

/** Why `selectNativeProcess` rejects a snapshot, in the same order it checks. Used only to word a failed check;
 *  a test pins `kind: "passes"` to `selectNativeProcess` returning a process, so the two cannot drift apart. */
export type NativeRejection =
  | { kind: "passes" }
  | { kind: "no_single_process" }
  | { kind: "no_recorded_conversation" }
  | { kind: "names_no_conversation" }
  | { kind: "not_a_resume" }
  | { kind: "other_conversation"; conversation: string }
  | { kind: "conflicting_conversations" }
  | { kind: "rotation_process_mismatch"; conversation: string };

export function explainNativeRejection(rows: NativeProcessRow[], panePid: number, runtime: NativeRuntime,
  expectedToken: string | null | undefined, requireResume: boolean, rotation?: ClaudeResumeRotation | null, selectedExecutable?: string): NativeRejection {
  const matches = nativeProcessCandidates(rows, panePid, runtime, selectedExecutable);
  const chain = runtime === "codex" ? launcherChain(matches, rows) : matches;
  if (!chain || chain.length === 0 || (runtime !== "codex" && chain.length !== 1)) return { kind: "no_single_process" };
  const { process } = chain[0]!;
  if (runtime === "claude-code") {
    if (!expectedToken) return { kind: "no_recorded_conversation" };
    const launched = claudeSessionToken(tokens(process.command).slice(1));
    if (launched === expectedToken) return { kind: "passes" };
    if (launched === null) return { kind: "names_no_conversation" };
    if (launched === rotation?.token) return rotationProcess(process, rotation) ? { kind: "passes" } : { kind: "rotation_process_mismatch", conversation: launched };
    return { kind: "other_conversation", conversation: launched };
  }
  const identities = chain.map((link) => codexConversationToken(tokens(link.process.command).slice(1), "resume"));
  if (new Set(identities.filter((value) => typeof value === "string")).size > 1) return { kind: "conflicting_conversations" };
  if (requireResume) {
    if (!expectedToken) return { kind: "no_recorded_conversation" };
    if (identities[0] === undefined) return { kind: "not_a_resume" };
    if (identities[0] === null) return { kind: "names_no_conversation" };
    if (identities[0] !== expectedToken) return { kind: "other_conversation", conversation: identities[0] };
  }
  if (expectedToken !== undefined) {
    const named = identities.find((value) => value !== undefined && (!expectedToken || value !== expectedToken));
    if (named === null) return { kind: "names_no_conversation" };
    if (typeof named === "string") return { kind: "other_conversation", conversation: named };
  }
  return { kind: "passes" };
}

async function observeNativePaneProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  expectedToken?: string | null;
  requireResume?: boolean;
  /** Canonical executable frozen by the managed launch, never re-resolved at observation time. */
  selectedExecutable?: string;
  /** Claude only: the frozen executable is a `#!` script, so a process whose OS executable path is named `claude` is
   *  recognised when no exact-path match exists, and that path is read from the OS (see `claudeProcessAfterScript`). */
  scriptLaunch?: boolean;
  /** Claude only: the recorded rotation into `expectedToken` (`claudeResumeRotation`). Its process
   *  may name the rotation's token instead of `expectedToken`. */
  rotation?: ClaudeResumeRotation | null;
}, runtime: NativeRuntime): Promise<NativeProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? (() => listNativeProcesses({ claudeLaunchPaths: input.scriptLaunch === true })))();
    return selectNativeProcess(rows, pid, input.expectedToken, input.requireResume, runtime, input.selectedExecutable,
      runtime === "claude-code" ? input.rotation : undefined, input.scriptLaunch);
  } catch { return null; }
}

export async function observeCodexPaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<CodexProcessObservation | null> {
  return observeNativePaneProcess(input, "codex");
}

/** A single foreground Codex chain that explicitly forks the requested parent.
 * The child's PID-owned native record must still supply its own identity. */
export async function observeCodexForkProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  parentToken: string;
}): Promise<CodexProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid || !input.parentToken) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    const chain = launcherChain(nativeProcessCandidates(rows, pid, "codex"), rows);
    if (!chain?.length) return null;
    const args = chain.map(link => tokens(link.process.command).slice(1));
    const parents = args.map(argv => codexConversationToken(argv, "fork"));
    if (!parents.includes(input.parentToken)
      || parents.some(parent => parent !== undefined && parent !== input.parentToken)
      || args.some(argv => codexConversationToken(argv, "resume") !== undefined)) return null;
    return chain[0]!;
  } catch { return null; }
}

export async function verifyCodexPaneProcess(input: Parameters<typeof observeCodexPaneProcess>[0]): Promise<CodexProcessObservation | null> {
  const first = await observeCodexPaneProcess(input);
  if (!first) return null;
  const second = await observeCodexPaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}

/** #1077 — the process OpenRig launched to resume `launchToken`, when it emitted a Claude hook:
 *  the pane's one foreground Claude, whose argv names that token, must be the hook process's parent
 *  or grandparent (Claude runs a hook through a shell, which may exec it), with no other Claude
 *  between. A `claude -p --resume` started from inside the seat inherits the launch environment,
 *  but its own hooks have that child as their nearest Claude. Null on anything unobserved. */
export async function claudeHookFromLaunchedProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  launchToken: string;
  hookPid: number;
}): Promise<ClaudeLaunchedProcess | null> {
  try {
    const panePid = await input.tmux.getPanePid(input.target);
    if (!panePid) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    const launched = selectNativeProcess(rows, panePid, input.launchToken, false, "claude-code");
    if (!launched) return null;
    const byPid = new Map(rows.map((row) => [row.pid, row]));
    let current = byPid.get(input.hookPid);
    if (!current) return null;
    for (let hop = 0; hop < 2; hop++) {
      current = byPid.get(current.ppid);
      if (!current) return null;
      if (current.pid === launched.process.pid) {
        return current.startedAt && current.startedAt === launched.process.startedAt
          ? { pid: current.pid, startedAt: current.startedAt } : null;
      }
      if (claudeExecutable(tokens(current.command)[0] ?? "") || /claude/i.test(current.executableName ?? "")) return null;
    }
    return null;
  } catch { return null; }
}

/** #1077 — the launch path's own record of the process it started to resume `token`: the pane's one
 *  foreground Claude naming that token, stable across two samples, observed right after the launch
 *  succeeded. A rotation counts only for this process. Null when it cannot be observed. */
export async function observeClaudeResumeLaunch(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  token: string;
}): Promise<ClaudeLaunchedProcess | null> {
  const native = await verifyClaudePaneProcess({ target: input.target, tmux: input.tmux, listProcesses: input.listProcesses,
    expectedToken: input.token });
  return native?.process.startedAt ? { pid: native.process.pid, startedAt: native.process.startedAt } : null;
}

export async function observeClaudePaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<NativeProcessObservation | null> {
  return observeNativePaneProcess(input, "claude-code");
}

export async function verifyClaudePaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<NativeProcessObservation | null> {
  const first = await observeClaudePaneProcess(input);
  if (!first) return null;
  const second = await observeClaudePaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}

/** One foreground-runtime observation, without a conversation identity claim.
 * Sweep callers must compare two independent samples before using this as proof. */
export async function observeClaudePaneRuntime(input: Omit<Parameters<typeof observeNativePaneProcess>[0], "expectedToken" | "requireResume">): Promise<NativeProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? (() => listNativeProcesses({ claudeLaunchPaths: input.scriptLaunch === true })))();
    const candidates = nativeProcessCandidates(rows, pid, "claude-code", input.selectedExecutable, input.scriptLaunch);
    return candidates.length === 1 ? candidates[0]! : null;
  } catch { return null; }
}

/** Stable runtime occupancy only; never a substitute for exact resume proof. */
export async function verifyClaudePaneRuntime(input: Parameters<typeof observeClaudePaneRuntime>[0]): Promise<NativeProcessObservation | null> {
  const first = await observeClaudePaneRuntime(input);
  if (!first) return null;
  const second = await observeClaudePaneRuntime(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}

/** The `ps` start time (lstart, local time) of the one stable Claude foreground
 * process. This makes no claim about its conversation token. */
export async function observeClaudePaneStartedAt(input: Parameters<typeof observeClaudePaneRuntime>[0]): Promise<string | null> {
  return (await verifyClaudePaneRuntime(input))?.process.startedAt ?? null;
}

/** A launcher shim that spawns (rather than execs) Claude or Codex leaves several
 * same-runtime processes on one parent chain. That chain is one runtime: the deepest process
 * receives input, and a shim's argv may carry the identity its child lacks.
 * Returns the chain deepest-first, or null when candidates sit on separate
 * branches, which stays ambiguous. */
function launcherChain(candidates: NativeProcessObservation[], rows: NativeProcessRow[]): NativeProcessObservation[] | null {
  if (candidates.length <= 1) return candidates;
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const ancestors = (observation: NativeProcessObservation): Set<number> => {
    const seen = new Set<number>();
    let current = byPid.get(observation.process.ppid);
    while (current && !seen.has(current.pid)) {
      seen.add(current.pid);
      if (current.pid === observation.panePid) break;
      current = byPid.get(current.ppid);
    }
    return seen;
  };
  const deepest = candidates.find((candidate) => {
    const above = ancestors(candidate);
    return candidates.every((other) => other === candidate || above.has(other.process.pid));
  });
  if (!deepest) return null;
  // On one chain every link has a distinct depth; order them all by it, so an
  // ancestor's identity is never read ahead of a deeper link's.
  const depth = new Map(candidates.map((candidate) => [candidate, ancestors(candidate).size]));
  return [...candidates].sort((a, b) => depth.get(b)! - depth.get(a)!);
}

/** The pane's own shell when it owns the foreground with nothing else in its group, else null. A wrapper's label is
 * not an idle shell: positive shell proof requires the pane shell itself to own the foreground, with no receiving
 * child. A background child/helper in another group does not receive terminal input. Any runtime. */
function idleShellRoot(rows: NativeProcessRow[], pid: number): NativeProcessRow | null {
  const root = rows.find(row => row.pid === pid);
  return new Set(rows.map(row => row.pid)).size === rows.length && root?.startedAt
    && root.pgid === pid && root.tpgid === pid
    && isShellForeground(executableName(root.executableName ?? ""))
    && isShellForeground(executableName(tokens(root.command)[0]?.replace(/^-/, "") ?? ""))
    && !rows.some(row => row.pid !== pid && row.pgid === root.tpgid) ? root : null;
}

/** Whether the bound pane is a stable idle shell: in two samples the pane's own shell owns the foreground with
 * nothing else in its group, and it is the same shell both times. A missing, failed or changing listing is not idle:
 * a launch script still starting the runtime holds the foreground the same way a shell label would suggest. */
export async function verifyPaneIdleShell(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
}): Promise<boolean> {
  const sample = async (): Promise<string | null> => {
    try {
      const pid = await input.tmux.getPanePid(input.target);
      if (!pid) return null;
      const root = idleShellRoot(await (input.listProcesses ?? listNativeProcesses)(), pid);
      return root ? JSON.stringify(root) : null;
    } catch { return null; }
  };
  const first = await sample();
  return first !== null && await sample() === first;
}

export interface ClaudeDeliveryObservation {
  state: "verified" | "unknown" | "idle_shell" | "conflict";
  detail: string;
}

/** Ordinary delivery's uncertainty policy is separate from readiness/identity proof.
 *  `unknownKeepsIdle` (default true, for delivery): one unavailable sample can't erase a positive idle-shell refusal,
 *  because declining to type into an idle shell is safe. Launch passes false: there idle means "tell the person to
 *  restart", so it needs both samples idle with the same fingerprint, and a foreground starting between them reads
 *  unknown. */
export async function observeClaudeDelivery(
  input: Parameters<typeof observeNativePaneProcess>[0],
  opts: { unknownKeepsIdle?: boolean } = {},
): Promise<ClaudeDeliveryObservation> {
  const unknown = { state: "unknown" as const, detail: "Claude runtime identity could not be established" };
  const sample = async (): Promise<ClaudeDeliveryObservation & { fingerprint?: string }> => {
    try {
      const pid = await input.tmux.getPanePid(input.target);
      if (!pid) return unknown;
      const rows = await (input.listProcesses ?? listNativeProcesses)();
      const candidates = nativeProcessCandidates(rows, pid, "claude-code", input.selectedExecutable);
      const chain = launcherChain(candidates, rows);
      if (!chain) return { state: "conflict", detail: "Multiple Claude processes occupy the bound foreground" };
      const native = chain[0];
      if (native) {
        const fingerprint = native.fingerprint;
        const identities = chain.map((link) => claudeSessionIdentity(tokens(link.process.command).slice(1)));
        const named = new Set(identities.filter((value): value is string => typeof value === "string"));
        if (named.size > 1) {
          // A Claude can start a fork of its own conversation, and ancestry in one foreground group doesn't show which
          // of them receives input. When only a --fork-session link names the second conversation, keep the warn-and-send
          // that held before forks were read, without verifying either.
          const unforked = new Set(identities.filter((value, index): value is string =>
            typeof value === "string" && !tokens(chain[index]!.process.command).includes("--fork-session")));
          if (unforked.size <= 1) return { state: "unknown", detail: "A Claude process and a fork of a conversation share the bound foreground; current conversation is unverified", fingerprint };
          return { state: "conflict", detail: "Claude processes in the bound foreground name different conversations", fingerprint };
        }
        if (!input.expectedToken) return { ...unknown, fingerprint };
        // argv records launch identity, not the current conversation: /clear can
        // rotate the hook-persisted token without replacing this process. A sole
        // launch-token mismatch cannot distinguish that from stale resume metadata.
        // Do not promote either source over the other; ordinary delivery warns on
        // uncertainty. Live lineage/binding conflicts and strict resume proof stay
        // separate. A shim's token is never inherited by an opaque child.
        // The one exception is a launch token the runtime itself reported resuming
        // into the stored one, named by the process that reported it (rotation).
        const launchedAs = (index: number) => identities[index] === input.expectedToken
          || (identities[index] === input.rotation?.token && rotationProcess(chain[index]!.process, input.rotation));
        if (named.size === 1 && !chain.some((_link, index) => launchedAs(index))) {
          return { state: "unknown", detail: "Claude launch identity differs from the stored conversation; current conversation is unverified", fingerprint };
        }
        return launchedAs(0)
          ? { state: "verified", detail: "Expected Claude conversation in the bound foreground", fingerprint }
          : { ...unknown, fingerprint };
      }
      // Main's rule here: only a single Codex process is a conflicting runtime.
      // A Codex launcher chain in a Claude seat keeps warn-and-send (#1088 review).
      const other = nativeProcessCandidates(rows, pid, "codex").length === 1 ? selectNativeProcess(rows, pid) : null;
      if (other) return { state: "conflict", detail: "A different native runtime occupies the bound foreground", fingerprint: other.fingerprint };
      const root = idleShellRoot(rows, pid);
      if (root) {
        return { state: "idle_shell", detail: "The bound foreground is an idle shell with no receiving child", fingerprint: JSON.stringify(root) };
      }
      return unknown;
    } catch { return unknown; }
  };
  const first = await sample();
  const second = await sample();
  if (first.state === "conflict") return first;
  if (second.state === "conflict") return second;
  // An unavailable sample cannot erase a positive idle-shell refusal (delivery only; see unknownKeepsIdle).
  if (opts.unknownKeepsIdle !== false) {
    if (first.state === "idle_shell" && second.state === "unknown") return first;
    if (second.state === "idle_shell" && first.state === "unknown") return second;
  }
  if (first.fingerprint && second.fingerprint && first.fingerprint !== second.fingerprint) {
    return { state: "conflict", detail: "The observed foreground process changed during delivery verification" };
  }
  return first.state === second.state && first.fingerprint && first.fingerprint === second.fingerprint ? second : unknown;
}
