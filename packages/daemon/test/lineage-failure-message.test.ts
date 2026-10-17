import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { rebindAndVerifyPaneIdentity } from "../src/domain/seat-attention-reconciler.js";
import type { NativeProcessRow } from "../src/domain/native-process-lineage.js";

// A failed exact-lineage check says which check failed. The pane label ("sh" for a script-launched seat)
// only routes the check; it is never the reason the check failed.
const startedAt = "Fri Oct  2 20:00:00 2026";
const STORED = "a5ddbaea-05cf-4723-8a52-4a9f0087b9d4";
const RUNNING = "cda8d870-0478-45df-9aa5-ce029845711c";
const shell: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, command: "/bin/sh /tmp/launch.sh", executableName: "sh", startedAt };
const claude = (token: string | null, pid = 101): NativeProcessRow => ({ pid, ppid: 100, pgid: 100, tpgid: 100, executableName: "2.1.1", startedAt,
  command: `/home/u/.local/share/claude/versions/2.1.1${token ? ` --session-id ${token}` : ""}` });
const codex = (args: string): NativeProcessRow => ({ pid: 101, ppid: 100, pgid: 100, tpgid: 100, executableName: "codex", startedAt, command: `codex ${args}` });
const sleeper: NativeProcessRow = { pid: 101, ppid: 100, pgid: 100, tpgid: 100, executableName: "sleep", startedAt, command: "sleep 300" };

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function check(runtime: "claude-code" | "codex", rows: NativeProcessRow[] | (() => NativeProcessRow[]), opts: { token?: string | null; strict?: boolean; command?: string | null; rotation?: { token: string; process: { pid: number; startedAt: string } }; splitAfterFirstPaneRead?: boolean } = {}) {
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db);
  const rig = repo.createRig("lineage"), name = "worker@lineage";
  const node = repo.addNode(rig.id, "worker", { role: "worker", runtime });
  registry.registerSession(node.id, name);
  const tmux = {
    listPanes: vi.fn(async () => (opts.splitAfterFirstPaneRead && paneReads++ > 0 ? [{ id: "%1" }, { id: "%2" }] : [{ id: "%1" }]) as never),
    getPanePid: vi.fn(async (): Promise<number | null> => 100),
    getPaneCommand: vi.fn(async (): Promise<string | null> => opts.command === undefined ? "sh" : opts.command),
  };
  let paneReads = 0;
  const result = await rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux, nodeId: node.id, sessionName: name, runtime,
    expectedResumeToken: opts.token === undefined ? STORED : opts.token, requireExactResumeLineage: opts.strict ?? true, ...(opts.rotation ? { resumeRotation: opts.rotation } : {}), listProcesses: async () => typeof rows === "function" ? rows() : rows });
  const verdict = db.prepare("SELECT verdict, reason FROM seat_identity_verdicts WHERE node_id = ?").get(node.id);
  return { result, verdict };
}
async function detail(...args: Parameters<typeof check>): Promise<string> {
  const { result, verdict } = await check(...args);
  expect(result.ok).toBe(false);
  // The outcome is unchanged: the same code-bearing verdict as before the message was reworded.
  expect(verdict).toEqual({ verdict: "mismatch", reason: "process_identity_ambiguous" });
  return result.ok ? "" : result.detail;
}

describe("a failed lineage check names the check, not the pane label", () => {
  it("Claude launched with another conversation: names both conversations", async () => {
    const text = await detail("claude-code", [shell, claude(RUNNING)]);
    expect(text).toContain(`launched with conversation ${RUNNING.slice(0, 8)}`);
    expect(text).toContain(`the seat records ${STORED.slice(0, 8)}`);
    expect(text).not.toContain("does not positively identify");
    expect(text).not.toContain(RUNNING);
    expect(text).not.toContain(STORED);
  });
  it("Claude whose launch names no conversation", async () => {
    expect(await detail("claude-code", [shell, claude(null)])).toContain("could not read a conversation from the running Claude's launch");
  });
  it("an idle shell with no Claude in it", async () => {
    expect(await detail("claude-code", [shell])).toContain("foreground is an idle shell");
  });
  it("a launch script holding the foreground with no Claude under it", async () => {
    expect(await detail("claude-code", [shell, sleeper])).toContain("does not hold exactly one process the check recognises as Claude");
  });
  it("two Claude processes in the foreground", async () => {
    expect(await detail("claude-code", [shell, claude(STORED), claude(STORED, 102)])).toContain("Multiple Claude processes");
  });
  it("non-strict Claude, no conversation recorded: no single Claude in the foreground", async () => {
    expect(await detail("claude-code", [shell, sleeper], { token: null, strict: false })).toContain("does not hold exactly one process the check recognises as Claude");
  });
  it("Codex resumed on another conversation: names both conversations", async () => {
    const text = await detail("codex", [shell, codex(`resume ${RUNNING}`)]);
    expect(text).toContain(`read conversation ${RUNNING.slice(0, 8)}… from the running Codex`);
    expect(text).toContain(`the seat records ${STORED.slice(0, 8)}`);
    expect(text).not.toContain("does not positively identify");
  });
  it("Codex started fresh instead of resuming", async () => {
    expect(await detail("codex", [shell, codex("-C /project")])).toContain("could not read a resume from the running Codex");
  });
  it("no Codex process in the foreground", async () => {
    expect(await detail("codex", [shell, sleeper])).toContain("does not hold a single process the check recognises as Codex");
  });
  it("Claude under a label that matches the runtime but with another conversation", async () => {
    // The pane's own process is the Claude here, so the label is "claude". The strict exact-resume check reads argv its
    // own way, so the text claims only that the Claude could not be verified.
    const text = await detail("claude-code", [{ ...claude(RUNNING, 100), ppid: 1 }], { command: "claude" });
    expect(text).toContain("The running Claude could not be verified against the stored conversation");
  });
  it("the label is still the reason when no process check ran", async () => {
    // Non-strict, no token and a label that is not a shell wrapper: nothing was checked beyond the label.
    expect(await detail("claude-code", [], { token: null, strict: false, command: "node" })).toContain("foreground command 'node' does not positively identify runtime 'claude-code'");
  });
  it("explainFailure: false keeps the label text and reads the process table once less often", async () => {
    const db = createFullTestDb(); databases.push(db);
    const repo = new RigRepository(db), registry = new SessionRegistry(db);
    const node = repo.addNode(repo.createRig("quiet").id, "worker", { role: "worker", runtime: "claude-code" });
    registry.registerSession(node.id, "worker@quiet");
    const tmux = { listPanes: async () => [{ id: "%1" }] as never, getPanePid: async () => 100, getPaneCommand: async () => "sh" };
    const reads = { explained: 0, quiet: 0 };
    const run = async (explainFailure: boolean, counter: "explained" | "quiet") => rebindAndVerifyPaneIdentity({ db, sessionRegistry: registry, tmux,
      nodeId: node.id, sessionName: "worker@quiet", runtime: "claude-code", expectedResumeToken: STORED, requireExactResumeLineage: true, explainFailure,
      listProcesses: async () => { reads[counter]++; return [shell, claude(RUNNING)]; } });
    const quiet = await run(false, "quiet");
    const explained = await run(true, "explained");
    expect(quiet.ok || quiet.detail).toContain("does not positively identify runtime 'claude-code'");
    expect(explained.ok || explained.detail).toContain("launched with conversation");
    expect(reads.explained).toBeGreaterThan(reads.quiet);
  });
  it("a match still verifies", async () => {
    const { result } = await check("claude-code", [shell, claude(STORED)]);
    expect(result.ok).toBe(true);
  });
});

describe("the explanation names only a cause the check tested", () => {
  // The check reads the table twice and compares; the second read shows the same process started at another time.
  const unsteady = (rows: NativeProcessRow[], pid: number) => {
    let reads = 0;
    return () => { reads++; return reads === 2 ? rows.map((row) => row.pid === pid ? { ...row, startedAt: "Fri Oct  2 20:00:09 2026" } : row) : rows; };
  };
  it("non-strict Codex that fails only on instability is not called 'not a resume'", async () => {
    const text = await detail("codex", unsteady([shell, codex("-C /project")], 101), { strict: false });
    expect(text).toContain("may have changed during the check");
    expect(text).not.toContain("could not read a resume from the running Codex");
    expect(text).not.toContain("names no conversation");
  });
  it("strict Codex started fresh still says so (the check required a resume)", async () => {
    expect(await detail("codex", [shell, codex("-C /project")])).toContain("could not read a resume from the running Codex");
  });
  it("strict Codex with no recorded conversation says there is nothing to match", async () => {
    const text = await detail("codex", [shell, codex(`resume ${RUNNING}`)], { token: null });
    expect(text).toContain("records no conversation");
    expect(text).not.toContain("needs the two to agree");
  });
  it("a tokenless version-label Claude keeps the label text: nothing was compared", async () => {
    const text = await detail("claude-code", [{ ...claude(RUNNING, 100), ppid: 1 }], { token: null, strict: false, command: "2.1.1" });
    expect(text).toContain("foreground command '2.1.1' does not positively identify runtime 'claude-code'");
    expect(text).not.toContain("records no conversation");
  });
  it("a tokenless wrapper Claude that fails only on instability says it may have changed", async () => {
    const text = await detail("claude-code", unsteady([shell, claude(RUNNING)], 101), { token: null, strict: false });
    expect(text).toContain("may have changed during the check");
    expect(text).not.toContain("records no conversation");
    expect(text).not.toContain("agree");
  });
  it("a tokenless wrapper with one stable Claude verifies", async () => {
    const { result } = await check("claude-code", [shell, claude(RUNNING)], { token: null, strict: false });
    expect(result.ok).toBe(true);
  });
  it.each(["claude-code", "codex"] as const)("a failed process listing for %s is not reported as an absence", async (runtime) => {
    const throwing = () => { throw new Error("ps: fork failed"); };
    const text = await detail(runtime, throwing);
    expect(text).toContain("could not be found in the process listing");
    expect(text).not.toContain("does not hold");
  });
  it.each(["claude-code", "codex"] as const)("an empty process table for %s (the default lister's failure) is not reported as an absence", async (runtime) => {
    const text = await detail(runtime, []);
    expect(text).toContain("could not be found in the process listing");
    expect(text).not.toContain("does not hold");
  });
});

describe("the explanation mirrors the check's own rejection (round 2)", () => {
  const unsteady = (rows: NativeProcessRow[], pid: number) => {
    let reads = 0;
    return () => { reads++; return reads === 2 ? rows.map((row) => row.pid === pid ? { ...row, startedAt: "Fri Oct  2 20:00:09 2026" } : row) : rows; };
  };
  it("non-strict Codex resume that names no conversation (--last) is not called unsteady", async () => {
    for (const token of [STORED, null]) {
      const text = await detail("codex", [shell, codex("resume --last")], { strict: false, token });
      expect(text).toContain("resume names no conversation");
      expect(text).not.toContain("may have changed during the check");
    }
  });
  it("a Codex launcher chain whose outer link names another conversation is that conversation, not unsteady", async () => {
    const launcher: NativeProcessRow = { ...codex(`resume ${RUNNING}`), pid: 101 };
    const inner: NativeProcessRow = { ...codex("-C /p"), pid: 102, ppid: 101 };
    // Non-strict: any link naming another conversation rejects. Strict: the deepest link must name the conversation itself, and it names none.
    const loose = await detail("codex", [shell, launcher, inner], { strict: false });
    expect(loose).toContain(`read conversation ${RUNNING.slice(0, 8)}… from the running Codex`);
    expect(loose).not.toContain("may have changed during the check");
    expect(loose).not.toContain("could not read a resume from the running Codex");
    expect(await detail("codex", [shell, launcher, inner], { strict: true })).toContain("could not read a resume from the running Codex");
  });
  it("a recorded rotation counts as a match: an unsteady second read is unsteady, not a mismatch", async () => {
    const rotation = { token: RUNNING, process: { pid: 101, startedAt } };
    const rows = [shell, claude(RUNNING)];
    const text = await detail("claude-code", unsteady(rows, 101), { rotation });
    expect(text).toContain("may have changed during the check");
    expect(text).not.toContain("launched with conversation");
    expect(text).not.toContain("needs the two to agree");
  });
  it("a rotation's conversation in a process other than the recorded one says so", async () => {
    const rotation = { token: RUNNING, process: { pid: 999, startedAt } };
    const text = await detail("claude-code", [shell, claude(RUNNING)], { rotation });
    expect(text).toContain("not the process that rotation recorded");
  });
  it("a strict tokenless Claude wrapper says the seat records no conversation, not unsteady", async () => {
    const text = await detail("claude-code", [shell, claude(RUNNING)], { token: null, strict: true });
    expect(text).toContain("records no conversation, so the running Claude cannot be matched");
    expect(text).not.toContain("may have changed during the check");
  });
  it("Codex with a steady matching resume that fails only a second read is unsteady", async () => {
    const text = await detail("codex", unsteady([shell, codex(`resume ${STORED}`)], 101), { strict: true });
    expect(text).toContain("may have changed during the check");
  });
});

describe("exact-resume Claude and a passing re-read (round 3)", () => {
  it("claude --verbose --resume RUNNING (strict, token STORED) is not 'names no conversation'", async () => {
    // The exact-resume check accepts unknown flags around --resume; the single-process parser stops at the first one.
    const row: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "claude", startedAt, command: `claude --verbose --resume ${RUNNING}` };
    const text = await detail("claude-code", [row], { command: "claude" });
    expect(text).not.toContain("names no conversation");
    expect(text).toContain("could not be verified against the stored conversation");
  });
  it("the same argv naming STORED passes the strict check", async () => {
    const row: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "claude", startedAt, command: `claude --verbose --resume ${STORED}` };
    expect((await check("claude-code", [row], { command: "claude" })).result.ok).toBe(true);
  });
  it("strict, label claude, an idle shell says so; no Claude in the foreground says so", async () => {
    expect(await detail("claude-code", [shell], { command: "claude" })).toContain("foreground is an idle shell");
    expect(await detail("claude-code", [shell, sleeper], { command: "claude" })).toContain("names a Claude executable");
  });
  it("a session that has grown a second pane says so, not that the process changed", async () => {
    const text = await detail("claude-code", [shell, claude(STORED)], { splitAfterFirstPaneRead: true });
    expect(text).toContain("The session now has 2 panes");
    expect(text).not.toContain("may have changed during the check");
  });
});

describe("exact-resume Claude: 'no Claude' uses the exact check's recognizer (round 4)", () => {
  it("an npm-installed Claude (node …/bin/claude --resume RUNNING) is a Claude, not 'no Claude'", async () => {
    const node = (token: string): NativeProcessRow => ({ pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "node", startedAt, command: `node /home/u/.npm-global/bin/claude --resume ${token}` });
    const text = await detail("claude-code", [node(RUNNING)], { command: "node" });
    expect(text).toContain("could not be verified against the stored conversation");
    expect(text).not.toContain("holds no Claude process");
    // The same row on the stored conversation passes the strict check.
    expect((await check("claude-code", [node(STORED)], { command: "node" })).result.ok).toBe(true);
  });
  it("a background Claude under an idle shell is not 'an idle shell with no Claude'", async () => {
    const root: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "bash", startedAt, command: "-bash" };
    const background: NativeProcessRow = { pid: 101, ppid: 100, pgid: 101, tpgid: 100, executableName: "claude", startedAt, command: `claude --resume ${RUNNING}` };
    const text = await detail("claude-code", [root, background], { command: "claude" });
    expect(text).toContain("could not be verified against the stored conversation");
    expect(text).not.toContain("idle shell with no Claude");
  });
});

describe("absence texts say only what the check examined (round 5)", () => {
  it("wrapper path: a background Claude under an idle shell is not 'no Claude in it'", async () => {
    const root: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "bash", startedAt, command: "-bash" };
    const background: NativeProcessRow = { pid: 101, ppid: 100, pgid: 101, tpgid: 100, executableName: "claude", startedAt, command: `claude --resume ${STORED}` };
    for (const strict of [false, true]) {
      const text = await detail("claude-code", [root, background], { strict });
      expect(text).toContain("The pane's foreground is an idle shell");
      expect(text).not.toContain("no Claude process");
    }
  });
  it("wrapper path: an npm Claude in the foreground is not 'exactly one Claude' denied outright", async () => {
    const npm: NativeProcessRow = { pid: 101, ppid: 100, pgid: 100, tpgid: 100, executableName: "node", startedAt, command: `node /home/u/.npm-global/bin/claude --resume ${STORED}` };
    const text = await detail("claude-code", [shell, npm]);
    expect(text).toContain("does not hold exactly one process the check recognises as Claude");
    expect(text).not.toContain("does not hold exactly one Claude process");
  });
  it("exact path: a node …/cli.js Claude is not 'no Claude process', only 'names no Claude executable'", async () => {
    const cli: NativeProcessRow = { pid: 100, ppid: 1, pgid: 100, tpgid: 100, executableName: "node", startedAt, command: `node /home/u/node_modules/@anthropic-ai/claude-code/cli.js --resume ${RUNNING}` };
    const text = await detail("claude-code", [cli], { command: "node" });
    expect(text).toContain("No process in the pane's process tree names a Claude executable");
    expect(text).not.toContain("holds no Claude process");
  });
});

describe("'names no conversation' is scoped to what the reader could read (verify finding)", () => {
  it("claude --verbose --resume STORED on the wrapper path (seat records STORED) does not say the launch names no conversation", async () => {
    // claudeSessionToken stops at the first flag it does not know, so it reads null although --resume STORED is there.
    const verbose: NativeProcessRow = { ...claude(null), command: `/home/u/.local/share/claude/versions/2.1.1 --verbose --resume ${STORED}` };
    const text = await detail("claude-code", [shell, verbose]);
    expect(text).toContain("The check could not read a conversation from the running Claude's launch");
    expect(text).not.toContain("names no conversation");
  });
  it("Codex: a flag's value read as the conversation is worded as what the check read", async () => {
    // codexResumeToken reads "gpt-5" (the value of -m) as the conversation for `resume -m gpt-5 STORED`.
    const text = await detail("codex", [shell, codex(`resume -m gpt-5 ${STORED}`)]);
    expect(text).toContain("The check read conversation gpt-5 from the running Codex's launch");
    expect(text).not.toContain("resumed conversation");
  });
  it("Codex: 'resume names no conversation' stays, since the reader returns null only when no positional follows resume", async () => {
    for (const args of ["resume", "resume --last", "resume --all"]) {
      expect(await detail("codex", [shell, codex(args)], { strict: false })).toContain("resume names no conversation");
    }
  });
});
