import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, chooseOption, runAcpAssignment, type AcpQueue, type AcpQueueRow, type AcpRunOptions } from "../src/acp/connector.js";

const FAKE_AGENT = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SEAT = "builder@studio";
const dirs: string[] = [];
const companions: number[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const pid of companions.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Row = AcpQueueRow & { notes: string[]; summary?: string };

function memoryQueue(body: string, destinationSession = SEAT) {
  const rows = new Map<string, Row>([["qitem-task", { qitemId: "qitem-task", state: "pending", destinationSession, body, resolution: null, tags: ["mission:demo", "pr-1"], notes: [] }]]);
  let asks = 0;
  const queue: AcpQueue = {
    show: async (id) => ({ ...rows.get(id)! }),
    claim: async (id) => { rows.get(id)!.state = "in-progress"; },
    update: async (id, change) => {
      const row = rows.get(id)!;
      row.notes.push(change.note);
      if (change.resolution !== undefined) row.resolution = change.resolution;
      if (change.state) row.state = change.state;
    },
    create: async (row) => {
      const id = `qitem-ask-${++asks}`;
      rows.set(id, { qitemId: id, state: "pending", destinationSession: row.destination, body: row.body, resolution: null, tags: row.tags, notes: [], summary: row.summary });
      return id;
    },
  };
  const task = () => rows.get("qitem-task")!;
  const asksFor = (seat: string) => [...rows.values()].filter((row) => row.qitemId.startsWith("qitem-ask-") && row.destinationSession === seat);
  return { queue, rows, task, asksFor };
}

function options(extra: Partial<AcpRunOptions> = {}): AcpRunOptions {
  const dir = mkdtempSync(join(tmpdir(), "acp-run-"));
  dirs.push(dir);
  return { qitemId: "qitem-task", agent: [process.execPath, FAKE_AGENT], cwd: dir, self: SEAT, runId: `acp-test-${dirs.length}-${process.pid}`, logPath: join(dir, "run.jsonl"), pollMs: 10, ...extra };
}

/** An owning seat that answers each permission row it receives with the next answer given. */
function owner(q: ReturnType<typeof memoryQueue>, seat: string, answers: string[]) {
  const timer = setInterval(() => {
    for (const ask of q.asksFor(seat)) {
      if (ask.state !== "pending" || answers.length === 0) continue;
      ask.state = "done";
      ask.resolution = answers.shift()!;
    }
  }, 5);
  return () => clearInterval(timer);
}

describe("rig acp run", () => {
  it("sends the row's task to the agent and records its answer on that same row, as the agent's report", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const outcome = await runAcpAssignment(q.queue, options());
    expect(outcome.kind).toBe("completed");
    expect(q.task().state).toBe("in-progress"); // claimed by the custodian; handing it on stays the seat's call
    expect(q.task().resolution).toBe("completed: the agent ended its turn (end_turn)");
    const notes = q.task().notes.join("\n");
    expect(notes).toMatch(/executor fake-acp-agent 0\.0\.1 \(protocol 1, loadSession not advertised\), session fake-session-1 new, custodian builder@studio/);
    expect(notes).toContain("PONG");
    expect(notes).toContain("not an owner's judgment");
    expect(notes).toContain("settled: no process from this run remains");
  });

  it("carries a permission request to the owning seat and returns its answer to that request once", async () => {
    const q = memoryQueue("scenario:permission");
    const stop = owner(q, "lead@studio", ["allow-once"]);
    try {
      const outcome = await runAcpAssignment(q.queue, options({ permissionsTo: "lead@studio" }));
      expect(outcome).toMatchObject({ kind: "completed", text: "permission allow-once" });
    } finally { stop(); }
    const [ask, ...more] = q.asksFor("lead@studio");
    expect(more).toHaveLength(0);
    expect(ask!.body).toContain("asks permission");
    expect(ask!.body).toContain("Write notes.txt (kind edit");
    expect(ask!.body).toContain("/fixture/notes.txt");
    expect(ask!.body).toMatch(/`allow-once`: Allow once \(allow_once\)[\s\S]*`reject-once`: Reject \(reject_once\)/);
    expect(ask!.body).toMatch(/session fake-session-1, request \d+/);
    expect(ask!.tags).toEqual(["acp-permission", "mission:demo"]);
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
    const outcome = await runAcpAssignment(q.queue, options({ cancelRequested }));
    expect(outcome.kind).toBe("cancelled");
    const [ask] = q.asksFor(SEAT);
    expect(ask!.state).toBe("canceled");
    expect(ask!.notes.join("\n")).toContain("any answer here is not sent");
  });

  it("reads an end_turn with no output and zero usage as unknown, not done", async () => {
    const q = memoryQueue("scenario:empty");
    const outcome = await runAcpAssignment(q.queue, options());
    expect(outcome.kind).toBe("unknown");
    expect(q.task().resolution).toBe("unknown: the agent ended its turn with no output and zero usage reported; not treated as done");
  });

  it("reads an end_turn that carries OpenClaw's interruption text as unknown, and a real answer as completed", () => {
    expect(classify("end_turn", "[OpenClaw interruption] provider returned 401", { used: 0 }, undefined).kind).toBe("unknown");
    expect(classify("end_turn", "", undefined, undefined).summary).toContain("no output and no usage reported");
    expect(classify("end_turn", "done", { used: 10 }, undefined).kind).toBe("completed");
    expect(classify("max_tokens", "partial", { used: 10 }, undefined)).toMatchObject({ kind: "stopped", summary: "the agent stopped with max_tokens" });
  });

  it("keeps an agent error's original code, message and data on the row", async () => {
    const q = memoryQueue("scenario:error");
    const outcome = await runAcpAssignment(q.queue, options());
    expect(outcome.kind).toBe("failed");
    expect(q.task().resolution).toBe('failed: session/prompt returned error -32603 Internal error {"details":"context length exceeded"}');
  });

  it("doesn't start a fresh session when the earlier one can't be loaded", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const run = options({ loadSession: "fake-session-9" });
    const outcome = await runAcpAssignment(q.queue, run);
    expect(outcome).toMatchObject({ kind: "failed" });
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
    companions.push(companion);
    expect(() => process.kill(companion, 0)).not.toThrow(); // still running: rig acp didn't kill it
    expect(q.task().notes.at(-1)).toMatch(new RegExp(`incomplete: 1 process\\(es\\) this run launched still run \\(${companion}\\)`));
  });

  it("reports an agent that can't be started as failed, on the row", async () => {
    const q = memoryQueue("scenario:reply PONG");
    const outcome = await runAcpAssignment(q.queue, options({ agent: ["/nonexistent/acp-agent"] }));
    expect(outcome.kind).toBe("failed");
    expect(q.task().resolution).toMatch(/^failed: the agent couldn't be run: .*ENOENT/);
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
