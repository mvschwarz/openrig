import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { answerCommand, classify, chooseOption, runAcpAssignment, type AcpQueue, type AcpQueueRow, type AcpRunOptions } from "../src/acp/connector.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const DETACH_RUNNER = fileURLToPath(new URL("./fixtures/acp-detach-runner.ts", import.meta.url));
const SEAT = "builder@studio";
const dirs: string[] = [];
const leftovers: number[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Row = AcpQueueRow & { notes: string[]; summary?: string; closureReason?: string };
const OPEN = new Set(["pending", "in-progress", "blocked"]);

/** Follows the real queue's rules that matter here (the real-queue cases are in acp-real-queue.test.ts): a note-only
 *  update stores no resolution, `done` needs a closure reason, and a resolution is kept only when an open row closes. */
function memoryQueue(body: string, destinationSession = SEAT) {
  const rows = new Map<string, Row>([["qitem-task", { qitemId: "qitem-task", state: "pending", destinationSession, body, resolution: null, tags: ["mission:demo", "pr-1"], notes: [] }]]);
  let asks = 0;
  let readGate: Promise<void> | undefined;
  const close = (id: string, change: { state: string; closureReason?: string; resolution?: string; note?: string }) => {
    const row = rows.get(id)!;
    if (change.state === "done" && !change.closureReason) throw new Error("missing_closure_reason");
    if (change.note) row.notes.push(change.note);
    if (OPEN.has(row.state) && !OPEN.has(change.state) && change.resolution !== undefined) row.resolution = change.resolution;
    row.state = change.state;
    row.closureReason = change.closureReason;
  };
  const create = (destination: string, rowBody: string, tags: string[], summary?: string) => {
    const id = `qitem-ask-${++asks}`;
    rows.set(id, { qitemId: id, state: "pending", destinationSession: destination, body: rowBody, resolution: null, tags, notes: [], summary });
    return id;
  };
  const queue: AcpQueue = {
    show: async (id) => { const gate = id.startsWith("qitem-ask-") ? readGate : undefined; const copy = { ...rows.get(id)! }; await gate; return copy; },
    claim: async (id) => { rows.get(id)!.state = "in-progress"; },
    update: async (id, change) => {
      if (change.state) close(id, { state: change.state, note: change.note });
      else rows.get(id)!.notes.push(change.note);
    },
    create: async (row) => create(row.destination, row.body, row.tags, row.summary),
  };
  const task = () => rows.get("qitem-task")!;
  const asksFor = (seat: string) => [...rows.values()].filter((row) => row.qitemId.startsWith("qitem-ask-") && row.destinationSession === seat);
  /** What the documented answer command does: close the row done, with a closure reason and the chosen option. */
  const answer = (id: string, resolution: string) => close(id, { state: "done", closureReason: "no-follow-on", resolution });
  const holdAskReads = () => { let open!: () => void; readGate = new Promise((resolve) => { open = resolve; }); return () => { readGate = undefined; open(); }; };
  return { queue, rows, task, asksFor, answer, holdAskReads };
}

function options(extra: Partial<AcpRunOptions> = {}): AcpRunOptions {
  const dir = mkdtempSync(join(tmpdir(), "acp-run-"));
  dirs.push(dir);
  return { qitemId: "qitem-task", agent: [process.execPath, FAKE_AGENT], cwd: dir, self: SEAT, runId: `acp-test-${dirs.length}-${process.pid}`, logPath: join(dir, "run.jsonl"), pollMs: 10, exitWaitMs: 2000, ...extra };
}

/** An owning seat that answers each permission row it receives with the next answer given. */
function owner(q: ReturnType<typeof memoryQueue>, seat: string, answers: string[]) {
  const timer = setInterval(() => {
    for (const ask of q.asksFor(seat)) if (ask.state === "pending" && answers.length > 0) q.answer(ask.qitemId, answers.shift()!);
  }, 5);
  return () => clearInterval(timer);
}

const outcomeNote = (q: ReturnType<typeof memoryQueue>) => q.task().notes.find((note) => /^ACP run \S+ outcome /.test(note)) ?? "";

describe("rig acp run", () => {
  it("sends the row's task to the agent and records its answer on that same row, leaving the row open for the owner", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const outcome = await runAcpAssignment(q.queue, options());
    expect(outcome.kind).toBe("completed");
    expect(q.task().state).toBe("in-progress");
    expect(q.task().resolution).toBeNull(); // the queue keeps a resolution only on close; closing is the owner's
    const notes = q.task().notes.join("\n");
    expect(notes).toMatch(/executor fake-acp-agent 0\.0\.1 \(protocol 1, loadSession not advertised\), session fake-session-1 new, custodian builder@studio/);
    expect(outcomeNote(q)).toMatch(/^ACP run \S+ outcome completed: the agent ended its turn \(end_turn\)\n\nworking… PONG\nThis is the agent's report, not a judgment of the work/);
    expect(q.task().notes.at(-1)).toContain("settled: no process carrying this run's marker remains");
  });

  it("carries a permission request to the owning seat and returns the documented answer to that request once", async () => {
    const q = memoryQueue("scenario:permission");
    const stop = owner(q, "lead@studio", ["allow-once"]);
    try {
      expect(await runAcpAssignment(q.queue, options({ permissionsTo: "lead@studio" }))).toMatchObject({ kind: "completed", text: "permission allow-once" });
    } finally { stop(); }
    const [ask, ...more] = q.asksFor("lead@studio");
    expect(more).toHaveLength(0);
    expect(ask!.body).toContain("Write notes.txt (kind edit");
    expect(ask!.body).toContain("/fixture/notes.txt");
    expect(ask!.body).toMatch(/`allow-once`: Allow once \(allow_once\)[\s\S]*`reject-once`: Reject \(reject_once\)/);
    expect(ask!.body).toMatch(/session fake-session-1, request \d+/);
    expect(ask!.body).toContain(answerCommand("<this row>"));
    expect(answerCommand("X")).toBe("rig queue update X --state done --closure-reason no-follow-on --resolution <optionId>");
    expect(ask!.tags).toEqual(["acp-permission", "mission:demo"]);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the confirmation note is written without delaying the reply
    expect(q.task().notes.join("\n")).toMatch(/lead@studio answered allow-once on qitem-ask-1; sent to the agent once/);
  });

  it("asks again when the answer isn't one of the offered options, rather than guessing", async () => {
    const q = memoryQueue("scenario:permission");
    const stop = owner(q, SEAT, ["yes please", "reject_once"]);
    try {
      expect((await runAcpAssignment(q.queue, options())).text).toBe("permission reject-once");
    } finally { stop(); }
    expect(q.asksFor(SEAT)).toHaveLength(2);
    expect(q.task().notes.join("\n")).toContain('closed done without an offered option ("yes please"); asking again');
  });

  it("keeps a cancel's request, the agent's acknowledgement and unknown upstream spend apart", async () => {
    const q = memoryQueue("scenario:slow");
    const outcome = await runAcpAssignment(q.queue, options({ cancelRequested: new Promise((resolve) => setTimeout(resolve, 80)) }));
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.summary).toMatch(/^cancel requested at \S+, acknowledged by the agent at \S+ \(stopReason cancelled\); upstream spend is unknown$/);
    expect(q.task().notes.join("\n")).toMatch(/cancel requested at \S+; upstream inference and spend are unknown/);
  });

  it("closes an unanswered permission row as stale when the turn is cancelled, and tells the agent cancelled", async () => {
    const q = memoryQueue("scenario:permission");
    let cancel!: () => void;
    const cancelRequested = new Promise<void>((resolve) => { cancel = resolve; });
    const waitForAsk = setInterval(() => { if (q.asksFor(SEAT).length) { clearInterval(waitForAsk); cancel(); } }, 5);
    expect((await runAcpAssignment(q.queue, options({ cancelRequested }))).kind).toBe("cancelled");
    const [ask] = q.asksFor(SEAT);
    expect(ask!.state).toBe("canceled");
    expect(ask!.notes.join("\n")).toContain("any answer here is not sent");
  });

  it("doesn't send an approval when the cancel lands while the answer is being read", async () => {
    const q = memoryQueue("scenario:permission");
    const release = q.holdAskReads();
    let cancel!: () => void;
    const cancelRequested = new Promise<void>((resolve) => { cancel = resolve; });
    const answered = setInterval(() => {
      const [ask] = q.asksFor(SEAT);
      if (ask?.state !== "pending") return;
      clearInterval(answered);
      q.answer(ask.qitemId, "allow-once"); // the owner approves; the connector's read of it is still in flight
      setTimeout(() => { cancel(); setTimeout(release, 20); }, 20);
    }, 5);
    const outcome = await runAcpAssignment(q.queue, options({ cancelRequested }));
    expect(outcome).toMatchObject({ kind: "cancelled" });
    expect(outcome.text).not.toContain("permission allow-once");
    const [ask] = q.asksFor(SEAT);
    expect(ask!.notes.join("\n")).toContain("this answer was not sent");
    expect(q.task().notes.join("\n")).not.toContain("sent to the agent once");
  });

  it("after a detach, the CLI process ends on its own while the agent it left keeps running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-detach-"));
    dirs.push(dir);
    const runner = spawn(process.execPath, ["--import", "tsx", DETACH_RUNNER, FAKE_AGENT, join(dir, "run.jsonl")],
      { env: { ...process.env, FAKE_ACP_IGNORE_EOF: "1" }, stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    runner.stdout.on("data", (data: Buffer) => { out += data.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { runner.kill("SIGKILL"); reject(new Error("the runner didn't end: something still holds its event loop")); }, 20_000);
      runner.once("exit", (exitCode) => { clearTimeout(timer); resolve(exitCode); });
    });
    const result = JSON.parse(out.trim().split("\n").at(-1)!) as { kind: string; summary: string; pids: number[] };
    leftovers.push(...result.pids); // rig acp leaves the agent running; the test stops its own fixture afterwards
    expect(code).toBe(0);
    expect(result).toMatchObject({ kind: "unknown", summary: "detached before the turn ended; the agent may still be working" });
    expect(result.pids.length).toBeGreaterThan(0);
    for (const pid of result.pids) expect(() => process.kill(pid, 0)).not.toThrow();
  }, 30_000);

  it("reads an end_turn with no output and zero usage as unknown, not done", async () => {
    const q = memoryQueue("scenario:empty");
    expect((await runAcpAssignment(q.queue, options())).kind).toBe("unknown");
    expect(outcomeNote(q)).toContain("outcome unknown: the agent ended its turn with no output and zero usage reported; not treated as done");
  });

  it("reads an end_turn that carries OpenClaw's interruption text as unknown, and a real answer as completed", () => {
    expect(classify("end_turn", "[OpenClaw interruption] provider returned 401", { used: 0 }, undefined).kind).toBe("unknown");
    expect(classify("end_turn", "", undefined, undefined).summary).toContain("no output and no usage reported");
    expect(classify("end_turn", "done", { used: 10 }, undefined).kind).toBe("completed");
    expect(classify("max_tokens", "partial", { used: 10 }, undefined)).toMatchObject({ kind: "stopped", summary: "the agent stopped with max_tokens" });
  });

  it("keeps an agent error's original code, message and data on the row", async () => {
    const q = memoryQueue("scenario:error");
    expect((await runAcpAssignment(q.queue, options())).kind).toBe("failed");
    expect(outcomeNote(q)).toContain('outcome failed: session/prompt returned error -32603 Internal error {"details":"context length exceeded"}');
  });

  it("doesn't start a fresh session when the earlier one can't be loaded", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const run = options({ loadSession: "fake-session-9" });
    const outcome = await runAcpAssignment(q.queue, run);
    expect(outcome.kind).toBe("failed");
    expect(outcome.summary).toContain("doesn't advertise loadSession");
    expect(readFileSync(run.logPath, "utf8")).not.toContain("session/new");
  });

  it("reports a process the agent launched that outlives the connection, without stopping it", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const run = options();
    const pidFile = join(run.cwd, "companion.pid");
    vi.stubEnv("FAKE_ACP_COMPANION_PID_FILE", pidFile);
    await runAcpAssignment(q.queue, run);
    const companion = Number(readFileSync(pidFile, "utf8"));
    leftovers.push(companion);
    expect(() => process.kill(companion, 0)).not.toThrow();
    expect(q.task().notes.at(-1)).toMatch(new RegExp(`incomplete: 1 process\\(es\\) carrying this run's marker still run \\(${companion}\\)`));
  });

  it("reports an agent that can't be started as failed, on the row", async () => {
    const q = memoryQueue("scenario:reply PONG");
    expect((await runAcpAssignment(q.queue, options({ agent: ["/nonexistent/acp-agent"] }))).kind).toBe("failed");
    expect(outcomeNote(q)).toMatch(/outcome failed: the agent couldn't be run: .*ENOENT/);
    expect(q.task().notes.at(-1)).toMatch(/detached: agent exited/);
  });

  it("won't run a row another seat owns", async () => {
    const q = memoryQueue("scenario:reply PONG", "someone@else");
    await expect(runAcpAssignment(q.queue, options())).rejects.toThrow(/belongs to someone@else/);
    expect(q.task().notes).toEqual([]);
  });

  it("matches an answer by option id, or by kind when only one option has it", () => {
    const offered = [{ optionId: "a1", kind: "allow_once" }, { optionId: "a2", kind: "allow_always" }, { optionId: "r1", kind: "reject_once" }];
    expect(chooseOption(offered, " a2 ")?.optionId).toBe("a2");
    expect(chooseOption(offered, "reject_once")?.optionId).toBe("r1");
    expect(chooseOption([...offered, { optionId: "r2", kind: "reject_once" }], "reject_once")).toBeUndefined();
    expect(chooseOption(offered, null)).toBeUndefined();
    expect(existsSync(FAKE_AGENT)).toBe(true);
  });
});
