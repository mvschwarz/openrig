import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { processStart } from "../src/commands/acp.js";
import { claimRow, HARNESSES, resolveHarness, rowRun, type ExecRun } from "../src/commands/exec.js";
import { readRows, writeRows } from "./fixtures/exec-file-queue.js";

// `rig exec` end to end: each `rig exec …` is its own process that exits as the CLI does, the connector it starts is
// real and detached, and the adapters are fake installed packages whose program is the fake ACP agent.

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const RUNNER = fileURLToPath(new URL("./fixtures/exec-cli-runner.ts", import.meta.url));
const CONNECTOR_ENTRY = fileURLToPath(new URL("./fixtures/exec-connector-entry.ts", import.meta.url));
const SEAT = "builder@studio";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function install(root: string, pkg: string, version: string, bin?: string, extra: Record<string, unknown> = {}) {
  const dir = join(root, "node_modules", pkg);
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg, version, ...extra }));
  if (!bin) return;
  const program = join(dir, "dist", "index.mjs");
  writeFileSync(program, `#!/usr/bin/env node\nawait import(${JSON.stringify(pathToFileURL(FAKE_AGENT).href)});\n`);
  chmodSync(program, 0o755);
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(program, join(root, "node_modules", ".bin", bin));
}

/** An OpenRig home with both adapters installed and one row owned by this seat, whose body picks the agent's scenario. */
function setup(body = "scenario:reply PONG", env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "rig-exec-"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  install(home, "@agentclientprotocol/claude-agent-acp", "0.101.0", "claude-agent-acp");
  install(home, "@anthropic-ai/claude-agent-sdk", "0.3.318", undefined, { claudeCodeVersion: "2.1.318" });
  install(home, "@agentclientprotocol/codex-acp", "2.5.0", "codex-acp");
  install(home, "@openai/codex", "0.165.0");
  const queueFile = join(home, "queue.json");
  writeRows(queueFile, { "qitem-task": { qitemId: "qitem-task", state: "pending", destinationSession: SEAT, body, resolution: null, tags: ["mission:demo"], notes: [] } });
  const runEnv: NodeJS.ProcessEnv = {
    ...process.env, OPENRIG_HOME: home, OPENRIG_SESSION_NAME: SEAT, EXEC_QUEUE_FILE: queueFile,
    PATH: [join(home, "node_modules", ".bin"), dirname(process.execPath), process.env.PATH].join(delimiter), ...env,
  };
  for (const name of ["FAKE_ACP_LOAD", "FAKE_ACP_MISSING", "FAKE_ACP_COMPANION_PID_FILE", "FAKE_ACP_COST", "FAKE_ACP_PROMPT_USAGE", "FAKE_ACP_IGNORE_EOF", "EXEC_TEST_CONNECTOR", "EXEC_TEST_WINNER", "EXEC_TEST_HOOK", "EXEC_TEST_STALL_MS", "OPENRIG_EXEC_CONNECTOR"]) if (!(name in env)) delete runEnv[name];
  return { home, env: runEnv, queueFile };
}
type Home = ReturnType<typeof setup>;

function start(h: Home, args: string[], options: { group?: boolean } = {}) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", RUNNER, ...args], { env: h.env, stdio: ["ignore", "pipe", "pipe"], detached: options.group });
  let out = "";
  child.stdout!.on("data", (data: Buffer) => { out += data.toString(); });
  child.stderr!.on("data", (data: Buffer) => { out += data.toString(); });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  cleanup.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return { child, exited, out: () => out };
}
async function rig(h: Home, args: string[]) {
  const run = start(h, args);
  const code = await run.exited;
  return { code, out: run.out() };
}

async function until<T>(check: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await new Promise((r) => setTimeout(r, 50))) {
    const value = check();
    if (value !== undefined) return value;
  }
  throw new Error("timed out");
}
const runFile = (h: Home, runId: string) => JSON.parse(readFileSync(join(h.home, "acp", "runs", `${runId}.json`), "utf8")) as ExecRun;
const ended = (h: Home, runId: string) => until(() => { const run = runFile(h, runId); return run.endedAt ? run : undefined; });
const notes = (h: Home) => readRows(h.queueFile)["qitem-task"]!.notes;
const runIds = (h: Home) => readdirSync(join(h.home, "acp", "runs")).filter((f) => /^exec-[^.]+\.json$/.test(f)).map((f) => f.slice(0, -5));
const startedId = (out: string) => /\[rig exec\] (exec-\S+) for qitem-task/.exec(out)?.[1];
const withEnv = (h: Home, env: Record<string, string>): Home => ({ ...h, env: { ...h.env, ...env } });
function withHome<T>(h: Home, fn: () => T): T {
  const previous = process.env.OPENRIG_HOME;
  process.env.OPENRIG_HOME = h.home;
  try { return fn(); } finally { if (previous === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previous; }
}
/** A run record as rig exec writes one, for the states a test needs. */
function record(h: Home, runId: string, fields: Partial<ExecRun>): string {
  const runs = join(h.home, "acp", "runs");
  mkdirSync(runs, { recursive: true });
  const file = join(runs, `${runId}.json`);
  writeFileSync(file, JSON.stringify({
    runId, qitemId: "qitem-task", harness: "claude", agent: ["claude-agent-acp"], cwd: h.home, self: SEAT, pollMs: 1000, native: "x",
    state: "started", pid: 1, requestedAt: "2026-11-06T00:00:00Z", transcript: join(runs, `${runId}.jsonl`), connectorLog: join(runs, `${runId}.connector.log`), ...fields,
  }));
  return readFileSync(file, "utf8");
}

describe("rig exec", () => {
  it("finds each harness's adapter and native versions, and names the install when it's missing", () => {
    const h = setup();
    const claude = resolveHarness(HARNESSES.claude!, { PATH: h.env.PATH });
    expect(claude).toMatchObject({ adapterVersion: "0.101.0", native: "Claude Code 2.1.318, from @anthropic-ai/claude-agent-sdk 0.3.318" });
    expect(claude.command).toBe(join(h.home, "node_modules", ".bin", "claude-agent-acp"));
    expect(resolveHarness(HARNESSES.claude!, { PATH: h.env.PATH, CLAUDE_CODE_EXECUTABLE: "/opt/claude" }).native)
      .toBe("the Claude Code at /opt/claude (CLAUDE_CODE_EXECUTABLE; its version isn't read here), not Claude Code 2.1.318, from @anthropic-ai/claude-agent-sdk 0.3.318");
    expect(resolveHarness(HARNESSES.codex!, { PATH: h.env.PATH })).toMatchObject({ adapterVersion: "2.5.0", native: "Codex 0.165.0 (@openai/codex)" });
    expect(resolveHarness(HARNESSES.codex!, { PATH: "/nonexistent" }).problem)
      .toBe("codex-acp isn't on PATH; install it with npm install --prefix <dir> @agentclientprotocol/codex-acp@2.5.0 and put <dir>/node_modules/.bin on PATH");
  });

  it("reads a missing session only from each adapter's own evidence, never from a code alone", () => {
    const { claude, codex } = HARNESSES;
    const rollout = { code: -32603, message: "Internal error", data: { details: "no rollout found for thread id s1" } };
    expect(claude!.missingSession({ code: -32002, message: "Resource not found", data: { sessionId: "s1" } }, "s1")).toBe(true);
    expect(claude!.missingSession({ code: -32002, message: "Resource not found" }, "s1")).toBe(false);
    expect(claude!.missingSession({ code: -32002, message: "Resource not found", data: { sessionId: "s2" } }, "s1")).toBe(false);
    expect(claude!.missingSession(rollout, "s1")).toBe(false);
    expect(codex!.missingSession(rollout, "s1")).toBe(true);
    expect(codex!.missingSession(rollout, "s9")).toBe(false);
    expect(codex!.missingSession({ code: -32603, message: "Internal error", data: { details: "context length exceeded" } }, "s1")).toBe(false);
    expect(codex!.missingSession({ code: -32603, message: "Internal error" }, "s1")).toBe(false);
    expect(codex!.missingSession({ code: -32002, message: "Resource not found", data: { sessionId: "s1" } }, "s1")).toBe(true);
  });

  it("--plan shows the versions and what would run, and starts nothing", async () => {
    const h = setup();
    const plan = await rig(h, ["run", "qitem-task", "--harness", "claude", "--plan"]);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain(`claude: @agentclientprotocol/claude-agent-acp 0.101.0 at ${join(h.home, "node_modules", ".bin", "claude-agent-acp")}`);
    expect(plan.out).toContain("runs: Claude Code 2.1.318, from @anthropic-ai/claude-agent-sdk 0.3.318");
    expect(plan.out).toContain("answers: a reject refuses that one action, and the turn continues");
    expect(plan.out).toContain("would run:");
    expect(existsSync(join(h.home, "acp", "runs"))).toBe(false);
    expect(notes(h)).toEqual([]);
  }, 30_000);

  it("keeps running after the calling CLI exits, and records the outcome as the agent's report", async () => {
    const h = setup("scenario:slow");
    const started = await rig(h, ["run", "qitem-task", "--harness", "claude"]);
    expect(started.code).toBe(0);
    const runId = startedId(started.out)!;
    expect(started.out).toContain(`${runId} for qitem-task on claude: started`);
    const live = runFile(h, runId);
    expect(live.state).toBe("started");
    expect(() => process.kill(live.pid, 0)).not.toThrow(); // the connector outlives the CLI that started it
    const run = await ended(h, runId);
    expect(run).toMatchObject({ state: "finished", outcome: "completed", summary: "the agent ended its turn (end_turn)" });
    expect(run.settle).toContain("settled: no process carrying this run's marker remains");
    expect(readRows(h.queueFile)["qitem-task"]!.state).toBe("in-progress"); // accepting the work stays with the custodian
    expect(notes(h).join("\n")).toMatch(/executor fake-acp-agent 0\.0\.1 \(protocol 1, loadSession not advertised\), session fake-session-1 new, custodian builder@studio/);
    const status = await rig(h, ["status", "qitem-task"]);
    expect(status.out).toContain("finished, outcome completed: the agent ended its turn (end_turn)");
    expect(status.out).toContain("The outcome is the agent's report, not acceptance: the row stays open for its custodian to judge and close.");
    expect(status.out).toContain("Usage as the agent reported it: tokens unknown");
  }, 40_000);

  it("leaving --wait, even by a Ctrl-C to its whole process group, stops only the wait", async () => {
    const h = setup("scenario:slow");
    const waiter = start(h, ["run", "qitem-task", "--harness", "codex", "--wait"], { group: true });
    await until(() => (/for qitem-task on codex: started/.test(waiter.out()) ? true : undefined));
    process.kill(-waiter.child.pid!, "SIGINT"); // what a terminal's Ctrl-C sends: the connector is in its own session
    expect(await waiter.exited).toBe(3);
    expect(waiter.out()).toMatch(/stopped waiting; exec-\S+ keeps running/);
    const run = await ended(h, startedId(waiter.out())!);
    expect(run.outcome).toBe("completed");
    expect(notes(h).join("\n")).not.toContain("cancel requested");
  }, 40_000);

  it("a Ctrl-C that lands just after the run is announced, while the CLI is stalled there, still stops only the wait", async () => {
    const h = withEnv(setup("scenario:slow"), { EXEC_TEST_STALL_MS: "1500" });
    const waiter = start(h, ["run", "qitem-task", "--harness", "codex", "--wait"], { group: true });
    await until(() => (/for qitem-task on codex: started/.test(waiter.out()) ? true : undefined));
    process.kill(-waiter.child.pid!, "SIGINT"); // arrives during the stall, before the CLI's next step
    expect(await waiter.exited).toBe(3);
    expect(waiter.out()).toMatch(/stopped waiting; exec-\S+ keeps running/);
    expect((await ended(h, startedId(waiter.out())!)).outcome).toBe("completed");
  }, 40_000);

  it("starts a row's task once: a second start or a retry returns the same run, and --again starts another after it ends", async () => {
    const h = setup();
    const args = ["run", "qitem-task", "--harness", "claude"];
    const [a, b] = await Promise.all([rig(h, args), rig(h, args)]);
    expect(runIds(h)).toHaveLength(1);
    const [runId] = runIds(h);
    expect(`${a.out}\n${b.out}`).toMatch(/started by another caller|already has a run, so the task isn't sent twice/);
    await ended(h, runId!);
    const retry = await rig(h, args);
    expect(retry.out).toContain(`qitem-task already has a run, so the task isn't sent twice:\n${runId} for qitem-task on claude`);
    expect(runIds(h)).toEqual([runId]);
    expect(notes(h).filter((note) => /^ACP run \S+: executor/.test(note))).toHaveLength(1);

    const again = await rig(h, [...args, "--again"]);
    const second = startedId(again.out)!;
    expect(second).not.toBe(runId);
    await ended(h, second);
    expect(notes(h).filter((note) => /^ACP run \S+: executor/.test(note))).toHaveLength(2);
  }, 60_000);

  it("claims a row for one run only: a second claim loses, and a replacement must name the run it replaces", () => {
    const h = setup();
    const previous = process.env.OPENRIG_HOME;
    process.env.OPENRIG_HOME = h.home;
    try {
      expect(claimRow("qitem-task", "exec-a")).toBe(true);
      expect(claimRow("qitem-task", "exec-b")).toBe(false);
      expect(rowRun("qitem-task")).toBe("exec-a");
      expect(claimRow("qitem-task", "exec-c", "exec-b")).toBe(false);
      expect(claimRow("qitem-task", "exec-c", "exec-a")).toBe(true);
      expect(claimRow("qitem-task", "exec-d", "exec-a")).toBe(false);
      expect(rowRun("qitem-task")).toBe("exec-c");
    } finally {
      if (previous === undefined) delete process.env.OPENRIG_HOME; else process.env.OPENRIG_HOME = previous;
    }
  });

  it("lets only one of two callers that read the same current run claim the row, and a fresh start never claims during a replacement", () => {
    withHome(setup(), () => {
      expect(claimRow("qitem-task", "exec-p")).toBe(true);
      let inWindow: boolean | undefined;
      // A and B both read exec-p as the row's run; B publishes inside A's window, so A's publish fails.
      expect(claimRow("qitem-task", "exec-a", "exec-p", () => { inWindow = claimRow("qitem-task", "exec-b", "exec-p"); })).toBe(false);
      expect(inWindow).toBe(true);
      expect(rowRun("qitem-task")).toBe("exec-b");
      // A fresh start inside a replacement's window still sees the row's run, so it never claims.
      expect(claimRow("qitem-task", "exec-c", "exec-b", () => { inWindow = claimRow("qitem-task", "exec-x"); })).toBe(true);
      expect(inWindow).toBe(false);
      expect(rowRun("qitem-task")).toBe("exec-c");
      // Two fresh starts on a row with no run: the one that publishes first wins.
      expect(claimRow("qitem-new", "exec-1", undefined, () => { inWindow = claimRow("qitem-new", "exec-2"); })).toBe(false);
      expect(inWindow).toBe(true);
      expect(rowRun("qitem-new")).toBe("exec-2");
    });
  });

  it("exits by the run's outcome on every path: an ended run returned again, a run that ended before the first look, and a losing caller", async () => {
    const failed = setup("scenario:error");
    const first = startedId((await rig(failed, ["run", "qitem-task", "--harness", "claude"])).out)!;
    expect((await ended(failed, first)).outcome).toBe("failed");
    const again = await rig(failed, ["run", "qitem-task", "--harness", "claude", "--wait"]);
    expect(again.out).toContain("qitem-task already has a run, so the task isn't sent twice");
    expect(again.code).toBe(2);
    expect((await rig(failed, ["run", "qitem-task", "--harness", "claude"])).code).toBe(2);

    const quick = await rig(withEnv(setup(), { EXEC_TEST_CONNECTOR: "instant" }), ["run", "qitem-task", "--harness", "claude"]);
    expect(quick.out).toMatch(/for qitem-task on claude: ended, outcome completed/);
    expect(quick.code).toBe(0);

    for (const [outcome, code] of [["failed", 2], ["completed", 0]] as const) {
      const lost = withEnv(setup(), { EXEC_TEST_WINNER: outcome });
      const loser = await rig(lost, ["run", "qitem-task", "--harness", "claude", "--wait"]);
      expect(loser.out).toContain("qitem-task was started by another caller as exec-winner, so the task isn't sent twice");
      expect(loser.out).toContain(`finished, outcome ${outcome}`);
      expect(loser.code).toBe(code);
      expect(runIds(lost)).toEqual(["exec-winner"]); // the losing caller's own record is gone, and nothing else started
    }
  }, 60_000);

  it("ends a run interrupted when its connector dies before recording itself, even while a waiter or requester lives", async () => {
    const h = setup();
    const died = await rig(withEnv(h, { EXEC_TEST_CONNECTOR: "die" }), ["run", "qitem-task", "--harness", "claude", "--wait"]);
    expect(died.code).toBe(2);
    expect(died.out).toContain("interrupted: its connector exited (code 3, signal none) and never recorded itself, so no turn was sent");
    expect(runFile(h, startedId(died.out)!)).toMatchObject({ state: "interrupted", outcome: "unknown" });

    // A requested record names its requester; a live requester with no connector is not a live run.
    const other = setup();
    record(other, "exec-orphan", { state: "requested", pid: process.pid, processStart: processStart(process.pid) });
    const status = await rig(other, ["status", "exec-orphan"]);
    expect(status.out).toContain("interrupted: its connector isn't running and never recorded itself, so no turn was sent");
  }, 40_000);

  it("settles a run's start and its end exclusively against a concurrent reconciler, in either order", async () => {
    const connectorLog = (h: Home, runId: string) => readFileSync(runFile(h, runId).connectorLog, "utf8");
    const binding = (h: Home) => notes(h).filter((note) => /^ACP run \S+: executor/.test(note));

    // The reconciler first: it settles the run after the connector's guard and before its start, so no turn is sent.
    const first = withEnv(setup(), { EXEC_TEST_HOOK: "after-guard" });
    const a = await rig(first, ["run", "qitem-task", "--harness", "claude", "--wait"]);
    const aId = startedId(a.out)!;
    expect(a.code).toBe(2);
    expect(runFile(first, aId)).toMatchObject({ state: "interrupted", outcome: "unknown", summary: "interrupted by a test reconciler after-guard" });
    await until(() => (/no turn is sent/.test(connectorLog(first, aId)) ? true : undefined));
    expect(connectorLog(first, aId)).toContain("reconciler after-guard: won");
    expect(binding(first)).toEqual([]);
    expect(notes(first).filter((note) => note.startsWith("test reconciler"))).toHaveLength(1);

    // The connector first: the reconciler still holding the requested copy loses, and the turn completes.
    const second = withEnv(setup(), { EXEC_TEST_HOOK: "after-start" });
    const bId = startedId((await rig(second, ["run", "qitem-task", "--harness", "claude"])).out)!;
    expect(await ended(second, bId)).toMatchObject({ state: "finished", outcome: "completed" });
    expect(connectorLog(second, bId)).toContain("reconciler after-start: lost");
    expect(binding(second)).toHaveLength(1);
    expect(notes(second).some((note) => note.startsWith("test reconciler"))).toBe(false);

    // The end: a reconciler that settles the started run before the connector records its end wins, and the
    // connector's own outcome is told to the row without replacing that record.
    const third = withEnv(setup(), { EXEC_TEST_HOOK: "before-end" });
    const cId = startedId((await rig(third, ["run", "qitem-task", "--harness", "claude"])).out)!;
    await until(() => (notes(third).some((note) => note.includes("that record stands")) ? true : undefined));
    expect(runFile(third, cId)).toMatchObject({ state: "interrupted", summary: "interrupted by a test reconciler before-end" });
    expect((await rig(third, ["status", cId])).out).toContain("interrupted by a test reconciler before-end");
    expect(notes(third).join("\n")).toContain(`rig exec run ${cId}: its connector finished with outcome completed (the agent ended its turn (end_turn)) after the run had been recorded interrupted; that record stands`);
  }, 60_000);

  it("recovers a run from its slots when a crash left the copy behind", async () => {
    const h = setup();
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.once("exit", resolve));
    const runs = join(h.home, "acp", "runs");
    // The connector claimed its start and died before writing the copy, which still says requested.
    record(h, "exec-crashed", { state: "requested", pid: process.pid, processStart: processStart(process.pid) });
    writeFileSync(join(runs, "exec-crashed.start.json"), JSON.stringify({ by: "connector", pid: gone.pid, processStart: "Thu Jan  1 00:00:00 2026", startedAt: "2026-11-06T00:00:01Z" }));
    const status = await rig(h, ["status", "exec-crashed"]);
    expect(status.out).toContain("interrupted: its connector ended without recording an outcome, so the outcome is unknown");
    // The connector recorded its end and died before writing the copy, which still says started.
    record(h, "exec-ended", { state: "started", pid: gone.pid, processStart: "Thu Jan  1 00:00:00 2026" });
    writeFileSync(join(runs, "exec-ended.start.json"), JSON.stringify({ by: "connector", pid: gone.pid, startedAt: "2026-11-06T00:00:01Z" }));
    writeFileSync(join(runs, "exec-ended.end.json"), JSON.stringify({ by: "connector", ended: { state: "finished", outcome: "completed", summary: "the agent ended its turn (end_turn)", endedAt: "2026-11-06T00:00:09Z" } }));
    expect((await rig(h, ["status", "exec-ended"])).out).toContain("finished, outcome completed");
    expect(notes(h).filter((note) => note.startsWith("rig exec run exec-ended"))).toEqual([]);
  }, 40_000);

  it("the connector entry runs only the requested run it was started for, and leaves any other record untouched", async () => {
    const h = setup();
    const done = record(h, "exec-done", { state: "finished", outcome: "completed", endedAt: "2026-11-06T00:00:05Z" });
    const waiting = record(h, "exec-waiting", { state: "requested" });
    const connector = async (runId: string, marker?: string) => {
      const child = spawn(process.execPath, ["--import", "tsx", CONNECTOR_ENTRY, runId], { env: { ...h.env, ...(marker ? { OPENRIG_EXEC_CONNECTOR: marker } : {}) }, stdio: "ignore" });
      return new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    };
    expect(await connector("exec-done", "exec-done")).toBe(1);
    expect(await connector("exec-waiting")).toBe(1);
    expect(await connector("exec-waiting", "exec-other")).toBe(1);
    expect(readFileSync(join(h.home, "acp", "runs", "exec-done.json"), "utf8")).toBe(done);
    expect(readFileSync(join(h.home, "acp", "runs", "exec-waiting.json"), "utf8")).toBe(waiting);
    expect(notes(h)).toEqual([]);
  }, 40_000);

  it("reads a run whose connector died, or whose pid now names another process, as interrupted, with one note", async () => {
    const h = setup();
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.once("exit", resolve));
    const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    cleanup.push(() => other.kill("SIGKILL"));
    const runs = join(h.home, "acp", "runs");
    mkdirSync(runs, { recursive: true });
    const record = (runId: string, pid: number) => writeFileSync(join(runs, `${runId}.json`), JSON.stringify({
      runId, qitemId: "qitem-task", harness: "claude", agent: ["claude-agent-acp"], cwd: h.home, self: SEAT, pollMs: 1000, native: "x",
      state: "started", pid, processStart: "Thu Jan  1 00:00:00 2026", requestedAt: "2026-11-06T00:00:00Z", startedAt: "2026-11-06T00:00:01Z",
      transcript: join(runs, `${runId}.jsonl`), connectorLog: join(runs, `${runId}.connector.log`),
    }));
    record("exec-dead", gone.pid!);
    record("exec-reused", other.pid!);
    for (const runId of ["exec-dead", "exec-reused"]) {
      const status = await rig(h, ["status", runId]);
      expect(status.out).toContain("interrupted: its connector ended without recording an outcome, so the outcome is unknown; no process carrying the run's marker remains");
      expect(runFile(h, runId)).toMatchObject({ state: "interrupted", outcome: "unknown" });
      await rig(h, ["status", runId]);
      expect(notes(h).filter((note) => note.startsWith(`rig exec run ${runId} interrupted`))).toHaveLength(1);
    }
    expect(other.exitCode).toBeNull();
    expect(other.signalCode).toBeNull(); // the process that reused the pid was never signalled
  }, 40_000);

  it("cancel asks the agent to stop; the acknowledgement and what still runs are kept apart", async () => {
    const h = setup("scenario:slow");
    const runId = startedId((await rig(h, ["run", "qitem-task", "--harness", "claude"])).out)!;
    await until(() => (notes(h).some((note) => note.includes("executor")) ? true : undefined));
    const cancel = await rig(h, ["cancel", runId]);
    expect(cancel.code).toBe(0);
    expect(cancel.out).toContain("An acknowledgement isn't settlement");
    const run = await ended(h, runId);
    expect(run.outcome).toBe("cancelled");
    expect(run.summary).toMatch(/^cancel requested at \S+, acknowledged by the agent at \S+ \(stopReason cancelled\); upstream spend is unknown$/);
    expect(run.settle).toContain("settled: no process carrying this run's marker remains");
    expect((await rig(h, ["cancel", runId])).code).toBe(1); // an ended run isn't signalled again
  }, 40_000);

  it("records a failed turn as failed, and a completed turn that left a process running as both", async () => {
    const failed = setup("scenario:error");
    const failedId = startedId((await rig(failed, ["run", "qitem-task", "--harness", "codex"])).out)!;
    expect(await ended(failed, failedId)).toMatchObject({ outcome: "failed", summary: 'session/prompt returned error -32603 Internal error {"details":"context length exceeded"}' });

    const pidFile = join(tmpdir(), `rig-exec-companion-${process.pid}`);
    const leftBehind = setup("scenario:reply PONG", { FAKE_ACP_COMPANION_PID_FILE: pidFile });
    const runId = startedId((await rig(leftBehind, ["run", "qitem-task", "--harness", "claude"])).out)!;
    const run = await ended(leftBehind, runId);
    const companion = Number(readFileSync(pidFile, "utf8"));
    cleanup.push(() => { try { process.kill(companion, "SIGKILL"); } catch { /* gone */ } rmSync(pidFile, { force: true }); });
    expect(run.outcome).toBe("completed");
    expect(run.settle).toContain(`incomplete: 1 process(es) carrying this run's marker still run (${companion})`);
    const status = await rig(leftBehind, ["status", runId]);
    expect(status.out).toContain("finished, outcome completed");
    expect(status.out).toContain(`After the turn: agent exited`);
    expect(status.out).toContain(`still run (${companion})`);
  }, 60_000);

  it("a session the adapter says doesn't exist reads missing, and no fresh session is started", async () => {
    const h = setup("scenario:reply PONG", { FAKE_ACP_LOAD: "1", FAKE_ACP_MISSING: "codex" });
    const runId = startedId((await rig(h, ["run", "qitem-task", "--harness", "codex", "--load-session", "sess-gone"])).out)!;
    const run = await ended(h, runId);
    expect(run.outcome).toBe("missing");
    expect(run.summary).toContain("session sess-gone doesn't exist for this agent (session/load returned -32603 Internal error");
    expect(readFileSync(run.transcript, "utf8")).not.toContain("session/new");
  }, 40_000);
});
