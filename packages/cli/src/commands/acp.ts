import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DaemonClient, type DaemonResponse } from "../client.js";
import { daemonStatusGuard, getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { processIdentity } from "../local-daemon-owner.js";
import { getOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import { answerCommand, runAcpAssignment, type AcpQueue } from "../acp/connector.js";
import { findRunProcesses } from "../acp/run-processes.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const runsDir = () => join(getOpenRigHome(), "acp", "runs");
const newId = (prefix: string, bytes: number) => `${prefix}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(bytes).toString("hex")}`;

interface RunFile { runId: string; qitemId: string; pid: number; processStart?: string; agent: string[]; startedAt: string; endedAt?: string }

/** The connector's queue verbs over the daemon API, acting as the calling seat (the client stamps its session). */
export function daemonAcpQueue(client: DaemonClient): AcpQueue {
  const ok = <T>(response: DaemonResponse<T>, what: string): T => {
    if (response.status >= 400) throw new Error(`${what} returned HTTP ${response.status}: ${JSON.stringify(response.data)}`);
    return response.data;
  };
  return {
    async show(qitemId) {
      const data = ok(await client.get<Record<string, unknown>>(`/api/queue/${encodeURIComponent(qitemId)}`), `queue show ${qitemId}`);
      const row = (data.item ?? data) as Record<string, unknown>;
      return {
        qitemId: String(row.qitemId), state: String(row.state), destinationSession: String(row.destinationSession),
        body: typeof row.body === "string" ? row.body : "", resolution: (row.resolution as string | null) ?? null, tags: (row.tags as string[] | null) ?? null,
      };
    },
    async claim(qitemId) { ok(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {}), `queue claim ${qitemId}`); },
    async update(qitemId, change) {
      ok(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/update`, { transitionNote: change.note, state: change.state }), `queue update ${qitemId}`);
    },
    async create(row) {
      const qitemId = newId("qitem", 8);
      ok(await client.post("/api/queue/create", { qitemId, destinationSession: row.destination, body: row.body, summary: row.summary, tags: row.tags }), `queue create for ${row.destination}`);
      return qitemId;
    },
  };
}

function readRun(runId: string): RunFile | undefined {
  try { return JSON.parse(readFileSync(join(runsDir(), `${runId}.json`), "utf8")) as RunFile; } catch { return undefined; }
}

/** A process's start time, the discriminator the CLI already uses for daemon ownership (pids get reused). `ps` from PATH,
 *  as the other process readers use it: the setuid /bin/ps can't run in a sandbox (macOS CI runs a plain copy). */
export function processStart(pid: number): string | undefined {
  try {
    return processIdentity(execFileSync("ps", ["-o", "uid=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }))?.start;
  } catch { return undefined; }
}

/** The run is live only while it hasn't ended and its pid is still the process that started it. */
function liveConnector(run: RunFile): boolean {
  return !run.endedAt && run.processStart !== undefined && processStart(run.pid) === run.processStart;
}

export function acpCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("acp").description("Hand a queue row's task to an ACP (Agent Client Protocol) agent and keep its outcome on the row");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };
  const connect = async (): Promise<DaemonClient | undefined> => {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    return daemonStatusGuard(status) ? deps.clientFactory(getDaemonUrl(status)) : undefined;
  };
  const self = () => readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");

  cmd
    .command("run <qitemId> <agent...>")
    .usage("<qitemId> [options] -- <agent program> [args...]")
    .description("Send one row's task to an ACP agent as a single turn, and record its outcome on that row")
    .option("--cwd <dir>", "The agent session's working directory", process.cwd())
    .option("--permissions-to <session>", "The seat that answers the agent's permission requests (default: this seat)")
    .option("--load-session <id>", "Continue an earlier session; if the agent can't load it, nothing new is started")
    .option("--poll-seconds <n>", "How often to look for a permission answer", "2")
    .addHelpText("after", `
Runs as this seat, the row's custodian; the agent is recorded as executor. The row's notes get the binding
(agent, session), progress, each permission request and its answer, and the outcome: completed, stopped,
cancelled, failed or unknown. The outcome is the agent's report, not a judgment of the work: the row stays open
for you to judge, then close or hand on with your own resolution.

A permission request becomes a row to --permissions-to, listing the options the agent offered. Answer it with
  ${answerCommand("<that row>")}
on that row; don't hand it off. OpenRig holds no policy of its own: the agent's settings decide what it
asks, and the owner decides the answer.

Ctrl-C (or rig acp cancel <runId>) asks the agent to cancel the turn; a second Ctrl-C detaches without waiting.
Ending the run closes the agent's stdin and reports whether any process carrying the run's marker remains.

Example:
  rig acp run <qitem-id> --cwd ~/work/app -- openclaw acp --url ws://127.0.0.1:18789 --token-file ~/.openclaw/gateway.token

Guide: rig context get reference/acp-agents.md`)
    .action(async (qitemId: string, agent: string[], opts: { cwd: string; permissionsTo?: string; loadSession?: string; pollSeconds: string }) => {
      const seat = self();
      if (!seat) { console.error("rig acp run acts as the seat that owns the row, but OPENRIG_SESSION_NAME isn't set"); process.exitCode = 1; return; }
      const client = await connect();
      if (!client) return;
      const runId = newId("acp", 4);
      mkdirSync(runsDir(), { recursive: true });
      const runFile: RunFile = { runId, qitemId, pid: process.pid, processStart: processStart(process.pid), agent, startedAt: new Date().toISOString() };
      const writeRun = (run: RunFile) => writeFileSync(join(runsDir(), `${runId}.json`), `${JSON.stringify(run)}\n`);
      writeRun(runFile);
      let cancel!: () => void;
      let detach!: () => void;
      const cancelRequested = new Promise<void>((done) => { cancel = done; });
      const detachRequested = new Promise<void>((done) => { detach = done; });
      let interrupts = 0;
      const onInterrupt = () => {
        interrupts += 1;
        if (interrupts === 1) { console.error("\n[rig acp] cancel requested; Ctrl-C again to detach without waiting"); cancel(); } else detach();
      };
      process.on("SIGINT", onInterrupt);
      console.error(`[rig acp] run ${runId} for ${qitemId}; cancel with Ctrl-C or rig acp cancel ${runId}`);
      try {
        const outcome = await runAcpAssignment(daemonAcpQueue(client), {
          qitemId, agent, cwd: resolve(opts.cwd), self: seat, permissionsTo: opts.permissionsTo, loadSession: opts.loadSession,
          runId, logPath: join(runsDir(), `${runId}.jsonl`), pollMs: Math.max(1, Number(opts.pollSeconds) || 2) * 1000,
          progress: (text) => process.stdout.write(text), cancelRequested, detachRequested,
        });
        console.log(`\n[rig acp] ${outcome.kind}: ${outcome.summary}`);
        if (outcome.kind !== "completed") process.exitCode = 2;
      } catch (error) {
        console.error(`rig acp run: ${(error as Error).message}`);
        process.exitCode = 1;
      } finally {
        process.removeListener("SIGINT", onInterrupt);
        writeRun({ ...runFile, endedAt: new Date().toISOString() });
      }
    });

  cmd
    .command("cancel <runId>")
    .description("Ask a running rig acp run to cancel its agent's turn (the same as Ctrl-C there)")
    .action((runId: string) => {
      const run = readRun(runId);
      if (!run || !liveConnector(run)) { console.error(`No running rig acp run ${runId}`); process.exitCode = 1; return; }
      process.kill(run.pid, "SIGINT");
      console.log(`Cancel requested for ${runId}; its row ${run.qitemId} records what the agent acknowledges`);
    });

  cmd
    .command("stop <runId> [stopCommand...]")
    .usage("<runId> [-- <the runtime's own stop command> [args...]]")
    .description("Run the agent runtime's own stop command, if given, then report whether every process the run launched has exited")
    .addHelpText("after", `
rig acp never kills a process it didn't launch. A gateway the agent connects to but didn't start (OpenClaw's, or a
shared one) is left alone; stop it with its own command, if it's yours to stop. The result goes on the run's row.`)
    .action(async (runId: string, stopCommand: string[]) => {
      const run = readRun(runId);
      if (!run) { console.error(`No rig acp run ${runId} on this machine`); process.exitCode = 1; return; }
      if (liveConnector(run)) { console.error(`${runId} is still running; cancel it or detach first`); process.exitCode = 1; return; }
      let ran = "no stop command was given";
      if (stopCommand.length > 0) {
        const result = spawnSync(stopCommand[0]!, stopCommand.slice(1), { stdio: "inherit" });
        ran = `${stopCommand.join(" ")} exited ${result.error ? `with ${result.error.message}` : result.status ?? result.signal}`;
      }
      const left = await findRunProcesses(runId).catch(() => undefined);
      const report = left === undefined ? "unknown: the process table couldn't be read"
        : left.length === 0 ? `settled: no process from ${runId} remains`
          : `incomplete: ${left.length} process(es) from ${runId} still run (${left.map((p) => p.pid).join(", ")}); they were not stopped`;
      console.log(`${ran}; ${report}`);
      if (left?.length !== 0) process.exitCode = 2;
      const client = self() ? await connect() : undefined;
      await client?.post(`/api/queue/${encodeURIComponent(run.qitemId)}/update`, { transitionNote: `ACP run ${runId} stop: ${ran}; ${report}` }).catch(() => {});
    });

  return cmd;
}
