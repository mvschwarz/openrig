import { Command } from "commander";
import { spawn } from "node:child_process";
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../client.js";
import { daemonStatusGuard, getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { describeUsage, runAcpAssignment, type AcpOutcomeKind, type AcpQueue, type AcpUsage } from "../acp/connector.js";
import type { JsonRpcErrorObject } from "../acp/json-rpc-stdio.js";
import { findRunProcesses, RUN_MARKER } from "../acp/run-processes.js";
import { daemonAcpQueue, newId, processStart, runsDir } from "./acp.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

// `rig exec`: one queue row's task as one turn on a named, version-qualified ACP harness (Claude Code or Codex through
// their maintained adapters), run by a detached connector that outlives the calling CLI. The connector owns the run,
// the run file is its registry, and the row stays the custody record: the outcome is the agent's report, and accepting
// the work stays with the row's custodian. `rig acp run` is the synchronous form and is unchanged.

/** Set only in the connector's own environment, so a run's connector can be found before it records its pid. */
export const CONNECTOR_MARKER = "OPENRIG_EXEC_CONNECTOR";

export interface Harness {
  name: string;
  /** The adapter package, and the version this configuration was checked with. */
  package: string;
  qualified: string;
  bin: string;
  native: { package: string; label: string; versionField?: string };
  /** Environment the caller may set to choose what runs or what the agent asks; passed through untouched. */
  env: string[];
  reject: string;
  /** The adapter's own evidence that a `session/load` error means the session doesn't exist. */
  missingSession: (error: JsonRpcErrorObject, sessionId: string) => boolean;
}

/** The ACP SDK's `sessionNotFound`: -32002 with `data.sessionId` naming the session asked for. A bare -32002 isn't. */
const sessionNotFound = (error: JsonRpcErrorObject, sessionId: string) =>
  error.code === -32002 && (error.data as { sessionId?: unknown } | null | undefined)?.sessionId === sessionId;

export const HARNESSES: Record<string, Harness> = {
  claude: {
    name: "claude", package: "@agentclientprotocol/claude-agent-acp", qualified: "0.101.0", bin: "claude-agent-acp",
    native: { package: "@anthropic-ai/claude-agent-sdk", label: "Claude Code", versionField: "claudeCodeVersion" },
    env: ["CLAUDE_CODE_EXECUTABLE", "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR"],
    reject: "a reject refuses that one action, and the turn continues",
    missingSession: sessionNotFound,
  },
  codex: {
    name: "codex", package: "@agentclientprotocol/codex-acp", qualified: "2.5.0", bin: "codex-acp",
    native: { package: "@openai/codex", label: "Codex" },
    env: ["INITIAL_AGENT_MODE", "CODEX_HOME", "CODEX_CONFIG"],
    reject: "its only refusal, cancel, ends the whole turn",
    // codex-acp 2.5.0 passes a failed thread resume through as -32603 carrying Codex's own text, which the adapter's
    // own code reads as a missing rollout. Any other -32603 is an internal error, not a missing session.
    missingSession: (error, sessionId) => sessionNotFound(error, sessionId) || (error.code === -32603
      && JSON.stringify(error.data ?? "").includes("no rollout found for thread id") && JSON.stringify(error.data).includes(sessionId)),
  },
};

export interface ResolvedHarness {
  harness: Harness;
  /** The adapter's program as found on PATH; it runs as-is. */
  command?: string;
  adapterVersion?: string;
  native: string;
  problem?: string;
}

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

function onPath(bin: string, path = ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    try { if (statSync(join(dir, bin)).isFile()) return join(dir, bin); } catch { /* not in this folder */ }
  }
  return undefined;
}

/** The installed package a file belongs to: the nearest folder above it whose package.json has that name. */
function packageRoot(file: string, name: string): string | undefined {
  for (let dir = dirname(file); dir !== dirname(dir); dir = dirname(dir)) {
    if (readJson(join(dir, "package.json"))?.name === name) return dir;
  }
  return undefined;
}

/** Node's lookup from the adapter's folder, reading package.json directly (a package's exports map may not list it). */
function dependencyManifest(from: string, name: string): Record<string, unknown> | undefined {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = readJson(join(dir, "node_modules", name, "package.json"));
    if (manifest) return manifest;
  }
  return undefined;
}

export function resolveHarness(harness: Harness, env: NodeJS.ProcessEnv = process.env): ResolvedHarness {
  const found = onPath(harness.bin, env.PATH);
  if (!found) {
    return { harness, native: "unknown", problem: `${harness.bin} isn't on PATH; install it with npm install --prefix <dir> ${harness.package}@${harness.qualified} and put <dir>/node_modules/.bin on PATH` };
  }
  const root = packageRoot(realpathSync(found), harness.package);
  const version = root ? readJson(join(root, "package.json"))?.version : undefined;
  const manifest = root ? dependencyManifest(root, harness.native.package) : undefined;
  const field = harness.native.versionField ? manifest?.[harness.native.versionField] : undefined;
  const bundled = !manifest ? `${harness.native.label}: ${harness.native.package} wasn't found beside the adapter`
    : field !== undefined ? `${harness.native.label} ${String(field)}, from ${harness.native.package} ${String(manifest.version)}`
      : `${harness.native.label} ${String(manifest.version)} (${harness.native.package})`;
  const native = harness.name === "claude" && env.CLAUDE_CODE_EXECUTABLE
    ? `the Claude Code at ${env.CLAUDE_CODE_EXECUTABLE} (CLAUDE_CODE_EXECUTABLE; its version isn't read here), not ${bundled}`
    : bundled;
  return { harness, command: found, adapterVersion: typeof version === "string" ? version : undefined, native };
}

/** The harness's caller-set environment, by name; CODEX_CONFIG's contents aren't shown. */
function callerEnv(harness: Harness, env: NodeJS.ProcessEnv = process.env): string[] {
  return harness.env.filter((name) => env[name] !== undefined).map((name) => (name === "CODEX_CONFIG" ? `${name} (set)` : `${name}=${env[name]}`));
}

export function describeHarness(resolved: ResolvedHarness): string {
  const { harness } = resolved;
  const installed = resolved.problem ? `not installed: ${resolved.problem}`
    : `${harness.package} ${resolved.adapterVersion ?? "(version unreadable)"} at ${resolved.command}${resolved.adapterVersion === harness.qualified ? "" : `; checked with ${harness.qualified}`}`;
  const set = callerEnv(harness);
  return [
    `${harness.name}: ${installed}`,
    `  runs: ${resolved.native}`,
    `  answers: ${harness.reject}`,
    `  permissions: the agent's own mode decides what it asks; rig exec adds no policy. Read here: ${harness.env.join(", ")}${set.length ? ` (set: ${set.join(", ")})` : " (none set)"}`,
  ].join("\n");
}

type ExecState = "requested" | "started" | "finished" | "interrupted";

/** A run's registry entry. `pid` is whichever process owns the run now: the requesting CLI until the connector records itself. */
export interface ExecRun {
  runId: string;
  qitemId: string;
  harness: string;
  agent: string[];
  cwd: string;
  self: string;
  permissionsTo?: string;
  loadSession?: string;
  pollMs: number;
  adapterVersion?: string;
  native: string;
  state: ExecState;
  pid: number;
  processStart?: string;
  requestedAt: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: AcpOutcomeKind;
  summary?: string;
  usage?: AcpUsage;
  settle?: string;
  transcript: string;
  connectorLog: string;
}

const now = () => new Date().toISOString();
const runPath = (runId: string) => join(runsDir(), `${runId}.json`);
/** A row's claims: one file per generation, `000001.json` upward, each published whole and never removed. */
const rowDir = (qitemId: string) => join(runsDir(), "rows", qitemId.replace(/[^A-Za-z0-9._-]/g, "_"));

/** A run's two transitions, each published once: `start` by the connector that runs it, or by whoever settles a run
 *  that never started; `end` by whichever records how a started run ended. The slots are the run's state; the record
 *  file is a copy written after each, for readers like `rig acp cancel`, and may lag a crash. */
const slotPath = (runId: string, slot: "start" | "end") => join(runsDir(), `${runId}.${slot}.json`);
type StartSlot = { by: "connector"; pid: number; processStart?: string; startedAt: string } | { by: "settled"; ended: Partial<ExecRun> };
type EndSlot = { by: "connector" | "settled"; ended: Partial<ExecRun> };

let drafts = 0;
/** Publishes `content` at `target` whole, and only if nothing is there: a hard link fails if the target exists. */
function publishOnce(target: string, content: unknown): boolean {
  const draft = `${target}.${process.pid}.${++drafts}.tmp`;
  writeFileSync(draft, `${JSON.stringify(content)}\n`);
  try {
    linkSync(draft, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { rmSync(draft, { force: true }); }
}

export function readRun(runId: string): ExecRun | undefined {
  const base = readJson(runPath(runId)) as ExecRun | undefined;
  if (!base || typeof base.state !== "string") return undefined;
  const start = readJson(slotPath(runId, "start")) as StartSlot | undefined;
  if (start?.by === "settled") return { ...base, ...start.ended };
  let run: ExecRun = start?.by === "connector"
    ? { ...base, state: "started", pid: start.pid, processStart: start.processStart, startedAt: start.startedAt }
    : base;
  const end = readJson(slotPath(runId, "end")) as EndSlot | undefined;
  if (end) run = { ...run, ...end.ended };
  return run;
}

function writeRun(run: ExecRun): void {
  const tmp = `${runPath(run.runId)}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(run)}\n`);
  renameSync(tmp, runPath(run.runId));
}

function topClaim(qitemId: string): { generation: number; runId?: string } | undefined {
  let names: string[];
  try { names = readdirSync(rowDir(qitemId)); } catch { return undefined; }
  const generation = Math.max(0, ...names.filter((name) => /^\d{6}\.json$/.test(name)).map((name) => Number(name.slice(0, 6))));
  if (generation === 0) return undefined;
  const runId = readJson(join(rowDir(qitemId), `${String(generation).padStart(6, "0")}.json`))?.runId;
  return { generation, runId: typeof runId === "string" ? runId : undefined };
}

export const rowRun = (qitemId: string): string | undefined => topClaim(qitemId)?.runId;

/** Makes `runId` the row's run: when the row has none, or when its current run is exactly `previous`. The next
 *  generation's file is published with a hard link, which fails if it exists, so of two callers that read the same
 *  current run only one claims, and nothing is ever moved aside. `afterRead` lets a test act between the read and
 *  the publish. */
export function claimRow(qitemId: string, runId: string, previous?: string, afterRead?: () => void): boolean {
  const dir = rowDir(qitemId);
  mkdirSync(dir, { recursive: true });
  const top = topClaim(qitemId);
  if (top?.runId !== previous) return false;
  afterRead?.();
  return publishOnce(join(dir, `${String((top?.generation ?? 0) + 1).padStart(6, "0")}.json`), { runId, qitemId, replaces: previous ?? null });
}

type Liveness = "live" | "dead" | "unknown";

/** A started run is live while its recorded process is still the one that recorded itself. A requested run is live
 *  only while a process carries its connector marker: the record then names the requester, which isn't the connector
 *  and may itself be waiting. */
async function liveness(run: ExecRun): Promise<Liveness> {
  if (run.endedAt) return "dead";
  if (run.state !== "requested" && run.processStart !== undefined && processStart(run.pid) === run.processStart) return "live";
  const found = await findRunProcesses(run.runId, CONNECTOR_MARKER).catch(() => undefined);
  return found === undefined ? "unknown" : found.length > 0 ? "live" : "dead";
}

/** Ends `run` as `ended`, exclusively: a run that hasn't started by claiming its start slot, so its connector can no
 *  longer start; a started run by claiming its end slot, so its connector can no longer record an outcome over this.
 *  Only the winner writes the copy and the row note; a loser gets the run as whoever won left it. */
export async function settleRun(run: ExecRun, ended: Partial<ExecRun>, note?: string, queue?: () => Promise<AcpQueue | undefined>): Promise<{ won: boolean; run: ExecRun }> {
  const won = run.state === "requested"
    ? publishOnce(slotPath(run.runId, "start"), { by: "settled", ended } satisfies StartSlot)
    : publishOnce(slotPath(run.runId, "end"), { by: "settled", ended } satisfies EndSlot);
  const after = readRun(run.runId) ?? run;
  if (!won) return { won, run: after };
  writeRun(after);
  const q = note ? await queue?.().catch(() => undefined) : undefined;
  await q?.update(run.qitemId, { note: note! }).catch(() => {});
  return { won, run: after };
}

/** A run whose connector is gone without recording an outcome reads interrupted, outcome unknown, with one row note. */
export async function reconcileRun(run: ExecRun, queue?: () => Promise<AcpQueue | undefined>, connectorExit?: string): Promise<ExecRun> {
  if (run.endedAt || (await liveness(run)) !== "dead") return run;
  const current = readRun(run.runId) ?? run;
  if (current.endedAt || (current.state !== run.state && (await liveness(current)) !== "dead")) return current;
  const left = await findRunProcesses(run.runId, RUN_MARKER).catch(() => undefined);
  const agent = left === undefined ? "whether an agent process remains is unknown (the process table couldn't be read)"
    : left.length === 0 ? "no process carrying the run's marker remains"
      : `${left.length} process(es) carrying the run's marker still run (${left.map((p) => p.pid).join(", ")})`;
  const summary = current.state === "requested"
    ? `interrupted: its connector ${connectorExit ?? "isn't running"} and never recorded itself, so no turn was sent; ${agent}; its log is ${current.connectorLog}`
    : `interrupted: its connector ended without recording an outcome, so the outcome is unknown; ${agent}`;
  const settled = await settleRun(current, { state: "interrupted", outcome: "unknown", summary, endedAt: now() },
    `rig exec run ${run.runId} ${summary}. Its transcript: ${run.transcript}`, queue);
  return settled.run;
}

export function describeRun(run: ExecRun): string {
  const state = run.state === "requested" ? "requested; its connector hasn't recorded itself yet"
    : run.state === "started" ? `running (connector pid ${run.pid}, since ${run.startedAt})`
      : run.state === "interrupted" ? run.summary ?? "interrupted; outcome unknown"
        : `finished, outcome ${run.outcome}: ${run.summary}`;
  return [
    `${run.runId} for ${run.qitemId} on ${run.harness} (${run.agent[0]}${run.adapterVersion ? ` ${run.adapterVersion}` : ""}; runs ${run.native})`,
    `  ${state}`,
    run.state === "finished" ? `  ${describeUsage(run.usage)}` : undefined,
    run.endedAt ? "  The outcome is the agent's report, not acceptance: the row stays open for its custodian to judge and close." : undefined,
    run.settle ? `  After the turn: ${run.settle}` : undefined,
    `  transcript ${run.transcript}; connector log ${run.connectorLog}`,
  ].filter((line) => line !== undefined).join("\n");
}

/** Tests only: points where a test acts as a concurrent reconciler would. */
export interface ConnectorHooks { afterGuard?: () => Promise<void>; afterStart?: () => Promise<void>; beforeEnd?: () => Promise<void> }

/** The detached connector: claims the run's start, runs the turn as `rig acp run` does, then claims its end. */
export async function runExecConnector(runId: string, queue: AcpQueue | undefined, hooks: ConnectorHooks = {}): Promise<number> {
  const run = readRun(runId);
  if (!run) { console.error(`No rig exec run ${runId} on this machine`); return 1; }
  // Only the connector `rig exec run` started for this record runs it, once: anything else would send the row's task a
  // second time. The record is left untouched.
  if (run.state !== "requested" || process.env[CONNECTOR_MARKER] !== runId) {
    console.error(`${runId} is ${run.state}${run.state === "requested" ? ", and this process wasn't started for it" : ""}; rig exec connector runs only the run rig exec run started it for`);
    return 1;
  }
  delete process.env[CONNECTOR_MARKER]; // the agent doesn't inherit it; this process's own environment still shows it
  // Before the run names this process, so a `rig exec cancel` that reads the record can't reach a default SIGINT.
  let cancel!: () => void;
  let detach!: () => void;
  const cancelRequested = new Promise<void>((done) => { cancel = done; });
  const detachRequested = new Promise<void>((done) => { detach = done; });
  let interrupts = 0;
  process.on("SIGINT", () => { interrupts += 1; if (interrupts === 1) cancel(); else detach(); });
  process.on("SIGHUP", () => { /* no terminal owns this process; a hangup isn't a cancel */ });
  await hooks.afterGuard?.();
  // Claiming the start is what lets this process send the turn. A reconciler that judged the run dead may have claimed
  // it first; then the run stays settled and nothing is sent.
  if (!publishOnce(slotPath(runId, "start"), { by: "connector", pid: process.pid, processStart: processStart(process.pid), startedAt: now() } satisfies StartSlot)) {
    console.error(`${runId} was settled before this connector started (${readRun(runId)?.summary ?? "no summary"}); no turn is sent`);
    return 1;
  }
  const started = readRun(runId)!;
  writeRun(started);
  await hooks.afterStart?.();
  /** Records the end only if nothing recorded one first; a reconciler's record stands, and the row hears what happened. */
  const end = async (ended: Partial<ExecRun>): Promise<void> => {
    await hooks.beforeEnd?.();
    if (publishOnce(slotPath(runId, "end"), { by: "connector", ended } satisfies EndSlot)) { writeRun(readRun(runId)!); return; }
    const recorded = readRun(runId);
    console.error(`${runId} was recorded ${recorded?.state} before this connector finished; its own outcome was ${ended.outcome}`);
    await queue?.update(run.qitemId, { note: `rig exec run ${runId}: its connector finished with outcome ${ended.outcome} (${ended.summary}) after the run had been recorded ${recorded?.state}; that record stands` }).catch(() => {});
  };
  if (!queue) {
    await end({ state: "finished", outcome: "failed", summary: "the OpenRig daemon couldn't be reached, so no turn was sent", endedAt: now() });
    return 1;
  }
  let settle: string | undefined;
  try {
    const outcome = await runAcpAssignment(queue, {
      qitemId: run.qitemId, agent: run.agent, cwd: run.cwd, self: run.self, permissionsTo: run.permissionsTo,
      loadSession: run.loadSession, runId, logPath: run.transcript, pollMs: run.pollMs,
      progress: (text) => process.stdout.write(text), cancelRequested, detachRequested,
      missingSession: HARNESSES[run.harness]?.missingSession, onSettled: (report) => { settle = report; },
    });
    await end({ state: "finished", outcome: outcome.kind, summary: outcome.summary, usage: outcome.usage, settle, endedAt: now() });
    return outcome.kind === "completed" ? 0 : 2;
  } catch (error) {
    await end({ state: "finished", outcome: "failed", summary: (error as Error).message, settle, endedAt: now() });
    return 1;
  }
}

export interface ExecDeps {
  status?: StatusDeps;
  /** The queue as the calling seat (default: the daemon's). */
  queue?: () => Promise<AcpQueue | undefined>;
  /** The detached connector's command line (default: this CLI's own entry, `exec connector <runId>`). */
  connectorCommand?: (runId: string) => string[];
  pollMs?: number;
  startWaitMs?: number;
  /** Tests only: acts between the row-claim read and its publish, as a concurrent caller would. */
  beforeClaim?: () => void;
  /** Tests only: runs right after the CLI has told its caller about the run, as a process descheduled there would. */
  afterAnnounce?: () => void;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const exitFor = (run: ExecRun) => (run.outcome === "completed" ? 0 : 2);
type Waiter = { left: boolean; leave: () => void };

export function execCommand(deps: ExecDeps = {}): Command {
  const cmd = new Command("exec").description("Run a queue row's task on a named harness (Claude Code or Codex over ACP) in a connector that outlives the command, with the outcome kept on the row");
  const queueFor = deps.queue ?? (async () => {
    const d = deps.status ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };
    const status = await getDaemonStatus(d.lifecycleDeps);
    return daemonStatusGuard(status) ? daemonAcpQueue(d.clientFactory(getDaemonUrl(status))) : undefined;
  });
  const connectorCommand = deps.connectorCommand
    ?? ((runId: string) => [process.execPath, fileURLToPath(new URL("../index.js", import.meta.url)), "exec", "connector", runId]);
  const pollMs = deps.pollMs ?? 1000;

  /** The wait's own Ctrl-C, armed before the CLI tells its caller anything about the run, so a Ctrl-C from then on
   *  only stops the wait: armed later, one landing just after the announcement met the default and killed the CLI. The
   *  connector is in its own session either way. */
  const armWait = (wait: boolean | undefined): Waiter | undefined => {
    if (!wait) return undefined;
    const waiter: Waiter = { left: false, leave: () => { waiter.left = true; } };
    process.on("SIGINT", waiter.leave);
    return waiter;
  };
  /** Polls the run file until it ends, or until the waiter leaves. */
  const waitForEnd = async (runId: string, waiter: Waiter): Promise<ExecRun | "left"> => {
    for (let polls = 1; ; polls++) {
      const run = readRun(runId);
      if (!run) throw new Error(`the record of ${runId} is gone`);
      if (run.endedAt) return run;
      if (waiter.left) return "left";
      if (polls % 5 === 0) { const checked = await reconcileRun(run, queueFor); if (checked.endedAt) return checked; }
      await sleep(pollMs);
    }
  };
  const finish = (result: ExecRun | "left", runId: string) => {
    if (result === "left") {
      console.log(`\n[rig exec] stopped waiting; ${runId} keeps running. rig exec status ${runId} shows it; rig exec cancel ${runId} cancels it.`);
      process.exitCode = 3;
      return;
    }
    console.log(describeRun(result));
    process.exitCode = exitFor(result);
  };
  /** Every path that holds the row's run ends here: a run that has ended exits by its outcome (0 completed, 2 any
   *  other), --wait waits for one still going (3 if the waiter leaves), and without --wait a run still going exits 0. */
  const report = async (run: ExecRun, waiter: Waiter | undefined) => {
    try {
      if (run.endedAt) process.exitCode = exitFor(run);
      else if (waiter) finish(await waitForEnd(run.runId, waiter), run.runId);
    } finally { if (waiter) process.removeListener("SIGINT", waiter.leave); }
  };

  cmd
    .command("harnesses")
    .description("List the named harnesses: the adapter and native versions installed here, and how each one differs")
    .option("--json", "JSON output")
    .action((opts: { json?: boolean }) => {
      const all = Object.values(HARNESSES).map((harness) => resolveHarness(harness));
      if (opts.json) {
        console.log(JSON.stringify(all.map((r) => ({
          name: r.harness.name, package: r.harness.package, checkedWith: r.harness.qualified, installed: r.adapterVersion ?? null,
          command: r.command ?? null, runs: r.native, answers: r.harness.reject, reads: r.harness.env, set: callerEnv(r.harness), problem: r.problem ?? null,
        })), null, 2));
        return;
      }
      console.log(all.map(describeHarness).join("\n\n"));
    });

  cmd
    .command("run <qitemId>")
    .description("Start one row's task as a single turn on a named harness, in a connector that outlives this command")
    .requiredOption("--harness <name>", `The harness: ${Object.keys(HARNESSES).join(" or ")} (rig exec harnesses)`)
    .option("--cwd <dir>", "The agent session's working directory", process.cwd())
    .option("--permissions-to <session>", "The seat that answers the agent's permission requests (default: this seat)")
    .option("--load-session <id>", "Continue an earlier session; nothing new starts when it can't be loaded")
    .option("--wait", "Wait here for the outcome; leaving the wait (Ctrl-C) never cancels the run")
    .option("--plan", "Show what would run, with its versions, and start nothing")
    .option("--again", "Start another turn on a row whose earlier run has ended")
    .option("--poll-seconds <n>", "How often the connector looks for a permission answer", "2")
    .addHelpText("after", `
A connector owns the run and outlives this command: closing this terminal, or leaving --wait, doesn't stop it.
It runs one turn of the row's task on the harness's ACP adapter, as rig acp run does, and records the binding,
progress, permission requests and the outcome on the row. The outcome is the agent's report: a completed turn isn't
accepted work, so the row stays open for you to judge and close.

One run per row: running it again returns the row's run, still going or ended, instead of sending the task twice.
--again starts another turn once that run has ended. A run whose connector died without recording an outcome reads
interrupted, outcome unknown.

The agent keeps its own permission mode, and rig exec adds no policy: your environment passes through (rig exec
harnesses lists what each harness reads). A permission request becomes a row to --permissions-to.

  rig exec status <runId|qitemId>   state, outcome, usage and cost as the agent reported them, and what still runs
  rig exec cancel <runId>           asks the agent to cancel its turn; the acknowledgement isn't settlement

Guide: rig context get reference/acp-agents.md`)
    .action(async (qitemId: string, opts: { harness: string; cwd: string; permissionsTo?: string; loadSession?: string; wait?: boolean; plan?: boolean; again?: boolean; pollSeconds: string }) => {
      const harness = HARNESSES[opts.harness];
      if (!harness) { console.error(`No harness ${opts.harness}; the named ones are ${Object.keys(HARNESSES).join(", ")}`); process.exitCode = 1; return; }
      const resolved = resolveHarness(harness);
      if (opts.plan) {
        console.log(`${describeHarness(resolved)}\n  would run: ${resolved.command ?? harness.bin} for ${qitemId} in ${resolve(opts.cwd)}${opts.loadSession ? `, continuing session ${opts.loadSession}` : ", in a new session"}; permission requests to ${opts.permissionsTo ?? "this seat"}`);
        if (resolved.problem) process.exitCode = 1;
        return;
      }
      const seat = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
      if (!seat) { console.error("rig exec run acts as the seat that owns the row, but OPENRIG_SESSION_NAME isn't set"); process.exitCode = 1; return; }
      if (resolved.problem) { console.error(resolved.problem); process.exitCode = 1; return; }
      const queue = await queueFor();
      if (!queue) { process.exitCode = 1; return; }
      mkdirSync(runsDir(), { recursive: true });

      const previousId = rowRun(qitemId);
      const previous = previousId ? readRun(previousId) : undefined;
      if (previous) {
        const run = await reconcileRun(previous, async () => queue);
        if (opts.again && !run.endedAt) {
          console.error(`${run.runId} is still ${run.state} on ${qitemId}; cancel it (rig exec cancel ${run.runId}) or let it end before --again`);
          process.exitCode = 1;
          return;
        }
        if (!opts.again) {
          const waiter = armWait(opts.wait);
          console.log(`${qitemId} already has a run, so the task isn't sent twice:\n${describeRun(run)}\nOnce it has ended, --again starts another turn on this row.`);
          await report(run, waiter);
          return;
        }
      }

      const row = await queue.show(qitemId).catch((error: Error) => error);
      if (row instanceof Error) { console.error(`rig exec run: ${row.message}`); process.exitCode = 1; return; }
      if (row.destinationSession !== seat) { console.error(`${qitemId} belongs to ${row.destinationSession}; run rig exec from that seat, or hand the row to ${seat} first`); process.exitCode = 1; return; }
      if (row.state !== "pending" && row.state !== "in-progress") { console.error(`${qitemId} is ${row.state}; rig exec runs an in-progress or pending row`); process.exitCode = 1; return; }

      const runId = newId("exec", 4);
      const run: ExecRun = {
        runId, qitemId, harness: harness.name, agent: [resolved.command!], cwd: resolve(opts.cwd), self: seat,
        permissionsTo: opts.permissionsTo, loadSession: opts.loadSession, pollMs: Math.max(1, Number(opts.pollSeconds) || 2) * 1000,
        adapterVersion: resolved.adapterVersion, native: resolved.native, state: "requested", pid: process.pid,
        processStart: processStart(process.pid), requestedAt: now(),
        transcript: join(runsDir(), `${runId}.jsonl`), connectorLog: join(runsDir(), `${runId}.connector.log`),
      };
      writeRun(run);
      if (!claimRow(qitemId, runId, previousId, deps.beforeClaim)) {
        rmSync(runPath(runId), { force: true });
        const winnerId = rowRun(qitemId);
        const winner = winnerId ? readRun(winnerId) : undefined;
        const waiter = winner ? armWait(opts.wait) : undefined;
        console.log(`${qitemId} was started by another caller as ${winnerId ?? "another run"}, so the task isn't sent twice${winner ? `:\n${describeRun(winner)}` : ""}`);
        if (winner) await report(winner, waiter);
        else process.exitCode = 1;
        return;
      }

      const log = openSync(run.connectorLog, "a");
      const [file, ...args] = connectorCommand(runId);
      let spawnError: Error | undefined;
      let connectorExit: string | undefined;
      try {
        const child = spawn(file!, args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, [CONNECTOR_MARKER]: runId } });
        child.once("error", (error) => { spawnError = error; });
        child.once("exit", (code, signal) => { connectorExit = `exited (code ${code ?? "none"}, signal ${signal ?? "none"})`; });
        child.unref();
      } finally { closeSync(log); }
      const waiter = armWait(opts.wait);
      let current: ExecRun = run;
      for (const deadline = Date.now() + (deps.startWaitMs ?? 10_000); Date.now() < deadline; await sleep(50)) {
        current = readRun(runId) ?? current;
        if (current.state !== "requested" || spawnError || connectorExit || waiter?.left) break;
      }
      if (spawnError && current.state === "requested") {
        current = (await settleRun(current, { state: "finished", outcome: "failed", summary: `the connector couldn't be started: ${spawnError.message}`, endedAt: now() })).run;
      } else if (connectorExit && current.state === "requested") {
        current = await reconcileRun(current, async () => queue, connectorExit);
      }
      console.log(`[rig exec] ${runId} for ${qitemId} on ${harness.name}: ${current.endedAt ? `ended, outcome ${current.outcome}: ${current.summary}` : current.state === "started" ? "started" : "requested; its connector hasn't recorded itself yet"}`);
      console.log(`  rig exec status ${runId} shows it; rig exec cancel ${runId} cancels it.`);
      deps.afterAnnounce?.();
      await report(current, waiter);
    });

  cmd
    .command("status <runIdOrQitemId>")
    .description("Show a run's state, the outcome as the agent reported it, usage and cost, and what still runs")
    .option("--json", "JSON output")
    .action(async (target: string, opts: { json?: boolean }) => {
      const runId = readRun(target) ? target : rowRun(target);
      const run = runId ? readRun(runId) : undefined;
      if (!run) { console.error(`No rig exec run for ${target} on this machine`); process.exitCode = 1; return; }
      const current = await reconcileRun(run, queueFor);
      console.log(opts.json ? JSON.stringify(current, null, 2) : describeRun(current));
    });

  cmd
    .command("cancel <runId>")
    .description("Ask a running rig exec run's agent to cancel its turn")
    .action((runId: string) => {
      const run = readRun(runId);
      if (!run || run.endedAt || run.state !== "started" || run.processStart === undefined || processStart(run.pid) !== run.processStart) {
        console.error(`No running rig exec run ${runId}`);
        process.exitCode = 1;
        return;
      }
      process.kill(run.pid, "SIGINT");
      console.log(`Cancel requested for ${runId}; its row ${run.qitemId} records what the agent acknowledges. An acknowledgement isn't settlement: rig exec status ${runId} shows the outcome and what still runs.`);
    });

  cmd
    .command("connector <runId>", { hidden: true })
    .description("The detached connector that owns a run (started by rig exec run)")
    .action(async (runId: string) => { process.exitCode = await runExecConnector(runId, await queueFor()); });

  return cmd;
}
