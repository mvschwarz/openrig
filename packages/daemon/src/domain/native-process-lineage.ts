import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isShellForeground } from "./shell-classifier.js";
import { runAsyncSite } from "./sync-site-wrap.js";
import { readNativeExecutablePaths } from "./native-process-executable.js";

const execFileAsync = promisify(execFile);

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

export type NativeRuntime = "claude-code" | "codex" | "agy";

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

  return codexResumeToken(args) === expectedToken;
}

// undefined is a fresh command; null is a resume command without an exact token.
function codexResumeToken(args: string[]): string | null | undefined {
  const topLevelOptionsWithValues = new Set([
    "-a", "--ask-for-approval", "-c", "--config", "-m", "--model",
    "-p", "--profile", "-s", "--sandbox",
  ]);
  let resumeIndex = -1;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (topLevelOptionsWithValues.has(arg)) { index += 1; continue; }
    if (arg.startsWith("-")) continue;
    if (arg === "resume") resumeIndex = index;
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

// agy names its conversation with --conversation <id>; undefined is a launch without one.
function agyConversationToken(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--conversation") return args[index + 1];
    if (arg.startsWith("--conversation=")) return arg.slice("--conversation=".length);
  }
  return undefined;
}

// Managed fresh/resume launches name the current Claude identity explicitly.
// A fork's --resume names its parent, so it cannot prove the new occupant.
function claudeSessionToken(args: string[]): string | null {
  let token: string | null = null;
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
    const identity = arg.match(/^--(?:session-id|resume)(?:=(.*))?$/);
    if (!identity) return null; // Unknown argv is not positive identity proof.
    const value = identity[1] ?? args[++index];
    if (token !== null || !value || value.startsWith("-")) return null;
    token = value;
  }
  return token;
}

// Delivery-only reading of a Claude argv. Like the strict selector, it accepts
// launch-only --settings. null: the argv parsed and names no session.
// "unparsed": an argument was not recognised, so the argv proves nothing.
function claudeSessionIdentity(args: string[]): string | null | { unparsed: true } {
  const unparsed = { unparsed: true } as const;
  let token: string | null = null;
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
    const identity = arg.match(/^--(?:session-id|resume)(?:=(.*))?$/);
    if (!identity) return unparsed; // Unknown argv is not positive identity proof.
    const value = identity[1] ?? args[++index];
    if (token !== null || !value || value.startsWith("-")) return unparsed;
    token = value;
  }
  return token;
}

/** Require a live process in the pane's own lineage whose argv names both the
 * declared runtime and the exact native resume identity. */
export function findExactNativeResumeProcess(
  processes: NativeProcessRow[],
  panePid: number,
  runtime: string | null,
  expectedToken: string,
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
    if (process && commandUsesExpectedToken(process.command, runtime, expectedToken)) return process;
    for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
  }
  return null;
}

/** The same OS observation serves menu input, restore proof and periodic identity.
 * Older callers may carry only pid/ppid/command; that is insufficient positive Codex proof. */
export async function listNativeProcesses(): Promise<NativeProcessRow[]> {
  try {
    const output = await runAsyncSite("codex.runtime.list_processes", async () => {
      // lstart is locale-formatted; the child-only C locale keeps the English date the parser expects.
      const { stdout } = await execFileAsync("ps", ["-Ao", "pid,ppid,pgid,tpgid,ucomm,lstart,command"], { encoding: "utf-8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } });
      return stdout;
    });
    const rows: NativeProcessRow[] = output.split("\n").slice(1).flatMap((line) => {
      // ucomm may contain spaces on every platform: macOS app helpers (`Slack Helper`), and on
      // Linux task names set by prctl(PR_SET_NAME) or process.title (`tmux: server`,
      // `node (vitest 1)`). lstart always begins with a weekday word and runs to the year, and
      // ucomm (16 bytes at most) is too short to contain such a date, so matching ucomm lazily
      // up to the first date is exact.
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(-?\d+)\s+(-?\d+)\s+(.+?)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), tpgid: Number(match[4]), executableName: match[5]!, startedAt: match[6]!, command: match[7]! }] : [];
    });
    const candidates = rows.filter(needsClaudeExecutablePath);
    if (candidates.length > 0) {
      const paths = await readNativeExecutablePaths(candidates.map(row => row.pid));
      for (const row of candidates) row.executablePath = paths.get(row.pid);
    }
    return rows;
  } catch { return []; }
}

export type NativeProcessLister = () => NativeProcessRow[] | Promise<NativeProcessRow[]>;
export type NativeProcessObservation = { panePid: number; process: NativeProcessRow; fingerprint: string };
export type CodexProcessObservation = NativeProcessObservation;

function nativeProcessCandidates(rows: NativeProcessRow[], panePid: number, runtime: NativeRuntime, selectedExecutable?: string): NativeProcessObservation[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const root = byPid.get(panePid);
  if (byPid.size !== rows.length || !root?.startedAt || !root.tpgid || root.tpgid <= 0) return [];
  const matches: { process: NativeProcessRow; chain: NativeProcessRow[] }[] = [];
  const executable = runtime === "claude-code" ? "claude" : runtime;
  for (const row of rows) {
    const osExecutable = runtime === "claude-code" ? executableName(row.executableName ?? "") : row.executableName;
    if ((runtime === "claude-code" ? !claudeProcess(row, selectedExecutable)
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

function selectNativeProcess(rows: NativeProcessRow[], panePid: number, expectedToken?: string | null, requireResume = false, runtime: NativeRuntime = "codex", selectedExecutable?: string): NativeProcessObservation | null {
  const matches = nativeProcessCandidates(rows, panePid, runtime, selectedExecutable);
  if (matches.length !== 1) return null;
  const observation = matches[0]!;
  const { process } = observation;
  if (runtime === "claude-code") {
    if (!expectedToken || claudeSessionToken(tokens(process.command).slice(1)) !== expectedToken) return null;
  } else if (runtime === "agy") {
    // An agy without --conversation verifies as the only candidate; one that names a conversation must match the expected token.
    const conversation = agyConversationToken(tokens(process.command).slice(1));
    if (conversation !== undefined && expectedToken && conversation !== expectedToken) return null;
  } else {
    const resumeToken = codexResumeToken(tokens(process.command).slice(1));
    if (requireResume && !expectedToken) return null;
    if ((requireResume || (expectedToken !== undefined && resumeToken !== undefined))
      && (!expectedToken || resumeToken !== expectedToken)) return null;
  }
  return observation;
}

async function observeNativePaneProcess(input: {
  target: string;
  tmux: { getPanePid(target: string): Promise<number | null> };
  listProcesses?: NativeProcessLister;
  expectedToken?: string | null;
  requireResume?: boolean;
  /** Canonical executable frozen by the managed launch, never re-resolved at observation time. */
  selectedExecutable?: string;
}, runtime: NativeRuntime): Promise<NativeProcessObservation | null> {
  try {
    const pid = await input.tmux.getPanePid(input.target);
    if (!pid) return null;
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    return selectNativeProcess(rows, pid, input.expectedToken, input.requireResume, runtime, input.selectedExecutable);
  } catch { return null; }
}

export async function observeCodexPaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<CodexProcessObservation | null> {
  return observeNativePaneProcess(input, "codex");
}

export async function verifyCodexPaneProcess(input: Parameters<typeof observeCodexPaneProcess>[0]): Promise<CodexProcessObservation | null> {
  const first = await observeCodexPaneProcess(input);
  if (!first) return null;
  const second = await observeCodexPaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
}

export async function observeAgyPaneProcess(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<NativeProcessObservation | null> {
  return observeNativePaneProcess(input, "agy");
}

export async function verifyAgyPaneProcess(input: Parameters<typeof observeAgyPaneProcess>[0]): Promise<NativeProcessObservation | null> {
  const first = await observeAgyPaneProcess(input);
  if (!first) return null;
  const second = await observeAgyPaneProcess(input);
  return second?.fingerprint === first.fingerprint ? second : null;
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
    const candidates = nativeProcessCandidates(await (input.listProcesses ?? listNativeProcesses)(), pid, "claude-code", input.selectedExecutable);
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

/** A launcher shim that spawns (rather than execs) Claude leaves several Claude
 * processes on one parent chain. That chain is one runtime: the deepest process
 * receives input, and a shim's argv may carry the identity its child lacks.
 * Returns the chain deepest-first, or null when candidates sit on separate
 * branches, which stays ambiguous. */
function claudeLauncherChain(candidates: NativeProcessObservation[], rows: NativeProcessRow[]): NativeProcessObservation[] | null {
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
  return deepest ? [deepest, ...candidates.filter((candidate) => candidate !== deepest)] : null;
}

export interface ClaudeDeliveryObservation {
  state: "verified" | "unknown" | "idle_shell" | "conflict";
  detail: string;
}

/** Ordinary delivery's uncertainty policy is separate from readiness/identity proof. */
export async function observeClaudeDelivery(input: Parameters<typeof observeNativePaneProcess>[0]): Promise<ClaudeDeliveryObservation> {
  const unknown = { state: "unknown" as const, detail: "Claude runtime identity could not be established" };
  const sample = async (): Promise<ClaudeDeliveryObservation & { fingerprint?: string }> => {
    try {
      const pid = await input.tmux.getPanePid(input.target);
      if (!pid) return unknown;
      const rows = await (input.listProcesses ?? listNativeProcesses)();
      const candidates = nativeProcessCandidates(rows, pid, "claude-code", input.selectedExecutable);
      const chain = claudeLauncherChain(candidates, rows);
      if (!chain) return { state: "conflict", detail: "Multiple Claude processes occupy the bound foreground" };
      const native = chain[0];
      if (native) {
        const fingerprint = native.fingerprint;
        const identities = chain.map((link) => claudeSessionIdentity(tokens(link.process.command).slice(1)));
        const named = new Set(identities.filter((value): value is string => typeof value === "string"));
        if (named.size > 1) return { state: "conflict", detail: "Claude processes in the bound foreground name different conversations", fingerprint };
        if (!input.expectedToken) return { ...unknown, fingerprint };
        // argv records launch identity, not the current conversation: /clear can
        // rotate the hook-persisted token without replacing this process. A sole
        // launch-token mismatch cannot distinguish that from stale resume metadata.
        // Do not promote either source over the other; ordinary delivery warns on
        // uncertainty. Live lineage/binding conflicts and strict resume proof stay
        // separate. A shim's token is never inherited by an opaque child.
        if (named.size === 1 && !named.has(input.expectedToken)) {
          return { state: "unknown", detail: "Claude launch identity differs from the stored conversation; current conversation is unverified", fingerprint };
        }
        return identities[0] === input.expectedToken
          ? { state: "verified", detail: "Expected Claude conversation in the bound foreground", fingerprint }
          : { ...unknown, fingerprint };
      }
      const other = selectNativeProcess(rows, pid);
      if (other) return { state: "conflict", detail: "A different native runtime occupies the bound foreground", fingerprint: other.fingerprint };
      const root = rows.find(row => row.pid === pid);
      // A wrapper's label is not an idle shell. Positive shell proof requires
      // the pane shell itself to own the foreground, with no receiving child.
      // A background child/helper in another group does not receive terminal input.
      if (new Set(rows.map(row => row.pid)).size === rows.length && root?.startedAt
        && root.pgid === pid && root.tpgid === pid
        && isShellForeground(executableName(root.executableName ?? ""))
        && isShellForeground(executableName(tokens(root.command)[0]?.replace(/^-/, "") ?? ""))
        && !rows.some(row => row.pid !== pid && row.pgid === root.tpgid)) {
        return { state: "idle_shell", detail: "The bound foreground is an idle shell with no receiving child", fingerprint: JSON.stringify(root) };
      }
      return unknown;
    } catch { return unknown; }
  };
  const first = await sample();
  const second = await sample();
  if (first.state === "conflict") return first;
  if (second.state === "conflict") return second;
  // An unavailable sample cannot erase a positive idle-shell refusal.
  if (first.state === "idle_shell" && second.state === "unknown") return first;
  if (second.state === "idle_shell" && first.state === "unknown") return second;
  if (first.fingerprint && second.fingerprint && first.fingerprint !== second.fingerprint) {
    return { state: "conflict", detail: "The observed foreground process changed during delivery verification" };
  }
  return first.state === second.state && first.fingerprint && first.fingerprint === second.fingerprint ? second : unknown;
}
