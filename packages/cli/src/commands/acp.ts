import { Command } from "commander";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DaemonClient, type DaemonResponse } from "../client.js";
import { daemonMayAnswer, daemonStatusGuard, getDaemonStatus, getDaemonUrl, statusGuardMessage } from "../daemon-lifecycle.js";
import { processIdentity } from "../local-daemon-owner.js";
import { getOpenRigHome, readOpenRigEnv } from "../openrig-compat.js";
import { answerCommand, runAcpAssignment, type AcpQueue } from "../acp/connector.js";
import { findRunProcesses } from "../acp/run-processes.js";
import { serveAcpAgent, SESSION_TAG, TeamRefused, type TeamAsk, type TeamConnection, type TeamQueue } from "../acp/agent-server.js";
import { StreamJsonRpcPeer } from "../acp/json-rpc-stdio.js";
import { CLI_VERSION } from "../version.js";
import { ConfigStore } from "../config-store.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export const runsDir = () => join(getOpenRigHome(), "acp", "runs");
export const newId = (prefix: string, bytes: number) => `${prefix}-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(bytes).toString("hex")}`;

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

/** rig acp serve's queue verbs over the daemon API, acting as the caller the client was built for. */
export function daemonTeamQueue(client: DaemonClient): TeamQueue {
  const ok = <T>(response: DaemonResponse<T>, what: string): T => {
    if (response.status >= 400) throw new Error(`${what} returned HTTP ${response.status}: ${JSON.stringify(response.data)}`);
    return response.data;
  };
  const face = (data: Record<string, unknown>) => {
    const row = (data.item ?? data) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      qitemId: String(row.qitemId), state: String(row.state), destinationSession: String(row.destinationSession),
      handedOffTo: text(row.handedOffTo), closureReason: text(row.closureReason), closureTarget: text(row.closureTarget), resolution: text(row.resolution),
      closer: text((row.closingTransition as { actorSession?: unknown } | null | undefined)?.actorSession),
    };
  };
  const list = async (query: string, what: string): Promise<Array<Record<string, unknown>>> => {
    const data = ok(await client.get<unknown>(`/api/queue/list?${query}`), what);
    return (Array.isArray(data) ? data : ((data as { items?: unknown[] }).items ?? [])) as Array<Record<string, unknown>>;
  };
  /** The rows that ask the person for a decision (questions with choices, or a decision in words). */
  const asks = (rows: Array<Record<string, unknown>>): TeamAsk[] =>
    rows.filter((row) => row.humanIntent !== "update" && (Array.isArray(row.humanQuestions) || row.humanIntent === "decision")).map((row) => ({
      qitemId: String(row.qitemId), sourceSession: String(row.sourceSession), state: String(row.state), tsCreated: String(row.tsCreated),
      summary: typeof row.summary === "string" ? row.summary : null, body: typeof row.body === "string" ? row.body : "",
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      questions: Array.isArray(row.humanQuestions) ? (row.humanQuestions as TeamAsk["questions"]) : [],
      // A click records the option's id; a typed reply records its words.
      answers: Object.fromEntries(Object.entries((row.humanAnswers as Record<string, unknown> | null) ?? {})
        .map(([id, value]) => [id, typeof value === "string" ? value : String((value as { text?: unknown } | null)?.text ?? "")])),
    }));
  return {
    async create(row) {
      const response = await client.post("/api/queue/create", { qitemId: row.qitemId, destinationSession: row.destination, body: row.body, summary: row.summary, tags: row.tags });
      // A 4xx is the daemon's answered refusal, with nothing written; a 5xx leaves the write unknown, like no answer.
      if (response.status >= 400 && response.status < 500) throw new TeamRefused(`HTTP ${response.status}: ${JSON.stringify(response.data)}`);
      ok(response, `queue create for ${row.destination}`);
    },
    async show(qitemId) {
      return face(ok(await client.get<Record<string, unknown>>(`/api/queue/${encodeURIComponent(qitemId)}`), `queue show ${qitemId}`));
    },
    async find(qitemId) {
      const response = await client.get<Record<string, unknown>>(`/api/queue/${encodeURIComponent(qitemId)}`);
      if (response.status === 404) return null;
      return face(ok(response, `queue show ${qitemId}`));
    },
    async transitions(qitemId) {
      const data = ok(await client.get<Array<Record<string, unknown>>>(`/api/queue/${encodeURIComponent(qitemId)}/transitions`), `queue transitions ${qitemId}`);
      return data.map((t) => ({
        transitionId: Number(t.transitionId), ts: String(t.ts), state: String(t.state),
        transitionNote: typeof t.transitionNote === "string" ? t.transitionNote : null, actorSession: String(t.actorSession),
      }));
    },
    async successor(qitemId) {
      return (await list(`handedOffFrom=${encodeURIComponent(qitemId)}&limit=1`, `queue successor of ${qitemId}`))[0]?.qitemId as string | undefined;
    },
    async openAsks(person) {
      return asks(await list(`destinationSession=${encodeURIComponent(person)}&state=pending&limit=500`, `open asks to ${person}`));
    },
    async sessionAsks(person, sessionId) {
      const rows = await list(`destinationSession=${encodeURIComponent(person)}&limit=2000`, `rows to ${person}`);
      return asks(rows.filter((row) => Array.isArray(row.tags) && (row.tags as string[]).includes(`${SESSION_TAG}${sessionId}`)));
    },
    async answer(qitemId, questionId, optionId) {
      // The person's answer path, as a click in Slack records one: the daemon takes the actor from this client's caller.
      const bearer = process.env.OPENRIG_AUTH_BEARER_TOKEN;
      const response = await client.post<Record<string, unknown>>("/api/mission-control/action", { verb: "answer", qitemId, questionId, optionId },
        bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined);
      if (response.status < 400) return { ok: true };
      const data = (response.data ?? {}) as { message?: unknown; error?: unknown };
      return { ok: false, reason: String(data.message ?? data.error ?? `HTTP ${response.status}`) };
    },
    async sent(caller) {
      const rows = await list(`sourceSession=${encodeURIComponent(caller)}&limit=2000`, `rows from ${caller}`);
      return rows.filter((row) => Array.isArray(row.tags) && (row.tags as string[]).includes("acp-serve")).map((row) => ({
        qitemId: String(row.qitemId), tsCreated: String(row.tsCreated), tsUpdated: String(row.tsUpdated),
        summary: typeof row.summary === "string" ? row.summary : null, body: typeof row.body === "string" ? row.body : "", tags: row.tags as string[],
      }));
    },
  };
}

/** The seat that takes this agent's tasks: --to, else this machine's acp.to setting (an ACP registry launch has no args).
 *  A setting that can't be read comes back as the reason, for the app's sign-in step to show. */
export function acpReceiver(to: string | undefined, store: Pick<ConfigStore, "get"> = new ConfigStore()): { receiver?: string } | { error: string } {
  if (to?.trim()) return { receiver: to.trim() };
  try {
    return { receiver: String(store.get("acp.to") ?? "").trim() || undefined };
  } catch (error) {
    return { error: `${(error as Error).message} The agent reads acp.to from it; adding --to <member@rig> to the agent's command skips it.` };
  }
}

/** Why the team's questions can't reach `address`, when it's a person this machine's OpenRig doesn't know. Says nothing
 *  for a seat's address, a registered person, or a registry that can't be read (unknown isn't unregistered). */
export async function unregisteredPersonNotice(address: string, home?: string): Promise<string | undefined> {
  const suffix = "@external";
  if (!address.endsWith(suffix)) return undefined;
  try {
    const registry = await import("@openrig/daemon/gateway-human-registry");
    const people = registry.projectHumans(home);
    if (!people.ok || people.entities.some((person) => person.address === address)) return undefined;
  } catch {
    return undefined;
  }
  const id = address.slice(0, -suffix.length);
  return `Your team can't ask you questions here yet: ${address} isn't a registered person on this machine, so OpenRig refuses a question addressed to it. Your work is still sent. To be asked, register yourself with \`rig gateway human add ${id} --display-name "<your name>" --delivery-class <A|B|C|D>\`.`;
}

/** The person this machine's OpenRig names as its default (`<id>@external`), or why there isn't one. */
async function defaultPersonAddress(): Promise<{ address: string } | { reason: string }> {
  try {
    const registry = await import("@openrig/daemon/gateway-human-registry");
    const people = registry.projectHumans();
    if (!people.ok) return { reason: people.error };
    const chosen = registry.resolveDefaultPerson(people.entities);
    return chosen.person ? { address: chosen.person.address } : { reason: chosen.source === "none" ? chosen.reason : "no default person" };
  } catch (error) {
    return { reason: (error as Error).message };
  }
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
  const cmd = new Command("acp").description("ACP (Agent Client Protocol): hand a queue row's task to an ACP agent, or serve OpenRig as an agent to ACP apps");
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
    .command("serve")
    .description("Serve OpenRig as an ACP agent on stdio, for an ACP app (Zed and others) to launch: its prompts go to your team as queue rows")
    .option("--to <member@rig>", "The seat that receives your tasks: your team's entry point (default: rig config get acp.to)")
    .option("--as <address>", "Who the tasks come from (default: OPENRIG_SESSION_NAME, else this machine's default person)")
    .option("--poll-seconds <n>", "How often to read the work's progress while a turn is open", "2")
    .addHelpText("after", `
An ACP app launches this command and talks to it on stdin and stdout. Each prompt becomes a queue row from you to
--to. The app shows the row's notes and handoffs as progress, and the closing resolution as the reply. A later
prompt in the same session goes to --to as a follow-up that names the earlier items. A question the working seats
ask you meanwhile comes to the app as a choice, recorded as your answer. The app can list and reopen your sessions.

The turn ends when the team closes the item, or when you cancel. Cancelling stops this process waiting; the team's
work carries on. A turn that ended doesn't mean the work was accepted: the reply says how the item was closed.

Without --to, the receiver is the acp.to setting (rig config set acp.to <member@rig>), which is how an app that
starts the agent from the ACP registry, with no arguments, reaches your team.

It uses the same OpenRig daemon as rig: the one on this computer, started with rig daemon start, unless OPENRIG_URL
names another. The app's sign-in step ("OpenRig on this machine") checks that the daemon answers and that you
resolve to an address: --as, OPENRIG_SESSION_NAME, or the default person: the only one registered
(rig gateway human add <id> ...), or with several, the one chosen with rig gateway default <id>.

In Zed's settings.json:
  "agent_servers": { "OpenRig": { "type": "custom", "command": "rig", "args": ["acp", "serve", "--to", "lead@my-team"] } }

Guide: rig context get reference/acp-agents.md#openrig-as-an-agent-in-acp-apps`)
    .action(async (opts: { to?: string; as?: string; pollSeconds: string }) => {
      // Only ACP messages may reach stdout: anything a helper prints goes to stderr instead.
      console.log = console.error;
      console.info = console.error;
      process.stdout.on("error", () => { /* EPIPE once the app has gone; the input closing ends the server */ });
      const connectTeam = async (): Promise<TeamConnection | { error: string }> => {
        const status = await getDaemonStatus(getDeps().lifecycleDeps);
        if (!daemonMayAnswer(status)) {
          const err = statusGuardMessage(status);
          return { error: `${err.fact} ${err.action}` };
        }
        let caller = opts.as?.trim() || self()?.trim();
        if (!caller) {
          const person = await defaultPersonAddress();
          if ("reason" in person) return { error: `OpenRig doesn't know who you are on this machine (${person.reason}). Register yourself with rig gateway human add <id> --display-name "<your name>" --delivery-class <A|B|C|D> (the only registered person is the default; with several, choose one with rig gateway default <id>), or add --as <address> to the agent's command.` };
          caller = person.address;
        }
        const target = acpReceiver(opts.to);
        if ("error" in target) return target;
        return { queue: daemonTeamQueue(new DaemonClient(getDaemonUrl(status), { sessionName: caller })), caller, receiver: target.receiver, notice: await unregisteredPersonNotice(caller) };
      };
      const peer = new StreamJsonRpcPeer(process.stdin, process.stdout);
      serveAcpAgent(peer, {
        connect: connectTeam, version: CLI_VERSION, pollMs: Math.max(1, Number(opts.pollSeconds) || 2) * 1000,
        log: (line) => console.error(`[rig acp serve] ${line}`), closed: peer.closed,
      });
      await peer.closed;
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
