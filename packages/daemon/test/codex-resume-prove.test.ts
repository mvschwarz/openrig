// #1524 (b): a managed Codex resume counts as resumed only when Codex's own records for the exact launched process
// name the requested conversation, read inside the existing resume window with the same process before and after.
// The real CodexRuntimeAdapter.launchHarness runs on scripted tmux frames, a scripted process table and a scripted
// evidence reader. Native Codex is NOT RUN.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import { CodexRuntimeAdapter, type CodexAdapterFsOps, type CodexResumeEvidence } from "../src/adapters/codex-runtime-adapter.js";
import { verifyCodexPaneProcess } from "../src/domain/native-process-lineage.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
import Database from "better-sqlite3";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const token = "019a136b-0000-7000-8000-000000000001";
const other = "019a136b-0000-7000-8000-0000000000ff";
const shellFrame = `user@host repo % codex resume ${token}`;
// A composer and model footer: the probe reads this as a resumed Codex.
const readyFrame = ["", "› Ask Codex to do anything", "", "  gpt-5.1-codex · ~/repo"].join("\n");
const errorFrame = `No saved session found with ID ${token}. Run \`codex resume\` without an ID to choose from existing sessions.\nuser@host repo % `;
const started = "Tue Oct 20 05:00:01 2026";
const rows = (startedAt = started) => [
  { pid: 900, ppid: 1, command: "-zsh", pgid: 900, tpgid: 901, executableName: "zsh", startedAt: "Tue Oct 20 04:59:00 2026" },
  { pid: 901, ppid: 900, command: `codex resume ${token}`, pgid: 901, tpgid: 901, executableName: "codex", startedAt },
];

type Evidence = (pid: number, identity: string) => Promise<CodexResumeEvidence> | CodexResumeEvidence;

function adapter(opts: {
  frames?: string[]; commands?: string[]; evidence?: Evidence; listProcesses?: () => unknown[];
  resumeProofWindowMs?: number; codexHome?: string; noPanePid?: boolean;
  /** After this many screen captures, every further capture takes `slowCaptureMs`. */
  slowCapturesAfter?: number; slowCaptureMs?: number;
}) {
  const frames = opts.frames ?? [shellFrame, readyFrame];
  const commands = opts.commands ?? ["zsh", "codex"];
  const fsOps = { readFile: (p: string) => { throw new Error(`Not found: ${p}`); }, writeFile: () => {}, exists: () => false, mkdirp: () => {}, listFiles: () => [], homedir: os.tmpdir() } as unknown as CodexAdapterFsOps;
  const fast = vi.fn(); for (const f of frames) fast.mockResolvedValueOnce(f); fast.mockResolvedValue(frames.at(-1));
  let captures = 0;
  const screen = vi.fn(async () => {
    if (opts.slowCapturesAfter !== undefined && ++captures > opts.slowCapturesAfter) {
      await new Promise((resolve) => setTimeout(resolve, opts.slowCaptureMs ?? 400));
    }
    return fast();
  });
  const command = vi.fn(); for (const c of commands) command.mockResolvedValueOnce(c); command.mockResolvedValue(commands.at(-1));
  const tmux = mockShellCommand({
    sendText: vi.fn(async () => ({ ok: true as const })), hasSession: vi.fn(async () => true), getPaneCommand: command,
    capturePaneContent: screen, capturePaneScreen: screen, createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })), listSessions: vi.fn(async () => []), listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []), sendKeys: vi.fn(async () => ({ ok: true as const })),
    ...(opts.noPanePid ? {} : { getPanePid: vi.fn(async () => 900) }),
  } as unknown as TmuxAdapter);
  const evidence = opts.evidence ? vi.fn(opts.evidence) : undefined;
  const a = new CodexRuntimeAdapter({
    tmux, fsOps, listProcesses: (opts.listProcesses ?? (() => rows())) as never, sleep: async () => {},
    ...(evidence ? { readResumeEvidence: evidence } : {}),
    ...(opts.resumeProofWindowMs !== undefined ? { resumeProofWindowMs: opts.resumeProofWindowMs } : {}),
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {}),
  });
  return { a, evidence };
}
const binding = (): NodeBinding => ({ id: "b1", nodeId: "n1", tmuxSession: "dev@rig-a", tmuxWindow: null, tmuxPane: null, cwd: "/repo" } as NodeBinding);
const resume = (a: CodexRuntimeAdapter) => a.launchHarness(binding(), { name: "dev@rig-a", resumeToken: token });

describe("#1524 (b): a Codex resume is resumed only when the launched process's records name the conversation", () => {
  it("an exact match from the launched process is resumed (unchanged result)", async () => {
    const { a, evidence } = adapter({ evidence: () => ({ threadId: token }) });
    expect(await resume(a)).toMatchObject({ ok: true, resumeToken: token, resumeType: "codex_id" });
    // Read for the exact launched process: its pid and its start time.
    expect(evidence).toHaveBeenCalledWith(901, started);
  });

  it("a different conversation in the process's records is attention, naming both, with nothing restarted", async () => {
    const { a } = adapter({ evidence: () => ({ threadId: other }) });
    const r = await resume(a);
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(r.ok === false && r.error).toContain(other);
    expect(r.ok === false && r.error).toContain(token);
  });

  it.each(["no_log_row", "no_cli_thread", "ambiguous_threads", "sqlite_unreadable"])(
    "an unknown read (%s) keeps polling, then is attention at the bound with that reason", async (reason) => {
      const { a, evidence } = adapter({ evidence: () => ({ reason }) });
      const r = await resume(a);
      expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(r.ok === false && r.error).toContain(reason);
      // It kept reading through the existing window instead of deciding on the first miss.
      expect(evidence!.mock.calls.length).toBeGreaterThan(6);
    });

  it("a match that arrives on a later poll inside the window is resumed", async () => {
    let calls = 0;
    const { a } = adapter({ evidence: () => (++calls < 4 ? { reason: "no_log_row" } : { threadId: token }) });
    expect(await resume(a)).toMatchObject({ ok: true, resumeToken: token });
  });

  it("a process that changes between the before and after reads proves nothing", async () => {
    let n = 0;
    // Each proof reads the table twice; the second read always shows a replacement process.
    const { a } = adapter({ evidence: () => ({ threadId: token }), listProcesses: () => rows(++n % 2 === 0 ? "Tue Oct 20 05:00:09 2026" : started) });
    const r = await resume(a);
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(r.ok === false && r.error).toMatch(/process changed/);
  });

  it("a read that stalls past the window ends in attention, and its late match is ignored", async () => {
    const { a } = adapter({
      resumeProofWindowMs: 60,
      evidence: () => new Promise<CodexResumeEvidence>((resolve) => setTimeout(() => resolve({ threadId: token }), 400)),
    });
    const r = await resume(a);
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(r.ok).toBe(false);
  });

  it("when the window ends, the attention text keeps the last reason a read gave", async () => {
    const { a } = adapter({
      resumeProofWindowMs: 40,
      evidence: () => new Promise<CodexResumeEvidence>((resolve) => setTimeout(() => resolve({ reason: "no_cli_thread" }), 15)),
    });
    const r = await resume(a);
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(r.ok === false && r.error).toContain("no_cli_thread");
  });

  it("a synchronous read that runs past the deadline can't be interrupted, but its late match is rejected", async () => {
    const { a } = adapter({
      resumeProofWindowMs: 30,
      evidence: () => { const until = Date.now() + 80; while (Date.now() < until) { /* synchronous, like the SQLite reader */ } return { threadId: token }; },
    });
    const r = await resume(a);
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("after an unknown read, a slow screen capture can't carry the check past the deadline", async () => {
    // The launch's own update-prompt check and the first poll capture quickly, and that poll's read is unknown; every
    // later capture takes 400 ms. The window is 80 ms: the check must end near it, not after several slow captures.
    const { a } = adapter({ resumeProofWindowMs: 80, slowCapturesAfter: 4, slowCaptureMs: 400, evidence: () => ({ reason: "no_log_row" }) });
    const started = Date.now();
    const r = await resume(a);
    const elapsed = Date.now() - started;
    expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    expect(r.ok === false && r.error).toContain("no_log_row");
    // It reached the slow capture and stopped at the deadline (not before it, and not after the 400 ms capture).
    expect(elapsed).toBeGreaterThanOrEqual(75);
    expect(elapsed).toBeLessThan(300);
  });

  it("the explicit no-saved-session error is still checked first", async () => {
    const { a, evidence } = adapter({ frames: [shellFrame, errorFrame], commands: ["zsh", "zsh"], evidence: () => ({ threadId: token }) });
    expect(await resume(a)).toMatchObject({ ok: false, recovery: "retry_fresh", missingConversation: true });
    expect(evidence).not.toHaveBeenCalled();
  });

  it("the ready-looking frame drawn before Codex looks the session up is never resumed", async () => {
    const { a } = adapter({
      frames: [shellFrame, ...Array(6).fill(readyFrame), errorFrame], commands: ["zsh", ...Array(6).fill("codex"), "zsh"],
      evidence: () => ({ reason: "no_log_row" }),
    });
    expect(await resume(a)).toMatchObject({ ok: false, recovery: "retry_fresh" });
  });

  it("without a pane process to read, the resume is attention, not resumed", async () => {
    const { a } = adapter({ noPanePid: true, evidence: () => ({ threadId: token }) });
    expect(await resume(a)).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("with an explicit CODEX_HOME, the default reader reads only that home", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    try {
      const { a } = adapter({ codexHome: home });
      const r = await resume(a);
      expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
      expect(r.ok === false && r.error).toMatch(/no_log_row|sqlite_unreadable/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  // The production reader (no injected evidence) on Codex's own log and state databases, the same shapes the
  // resolver's own start-second controls use: a just-launched resume may log only inside its start second.
  it.each([
    ["a lone start-second row from a process instance with no earlier rows", "lone", true],
    ["a start-second row from an instance that logged before the second", "earlier", false],
    ["a start-second row when another log database can't be read", "unreadable", false],
  ])("the default reader, by-process: %s", async (_label, kind, resumed) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-resume-records-"));
    try {
      const identity = "Tue Oct 20 05:00:01 2026";
      const start = lstartToMinTs(identity)!;
      const logs = new Database(path.join(home, "logs_2.sqlite"));
      logs.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, process_uuid TEXT, thread_id TEXT)");
      const state = new Database(path.join(home, "state_5.sqlite"));
      state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)");
      state.prepare("INSERT INTO threads VALUES (?,?,?)").run(token, "cli", `${home}/${token}.jsonl`);
      const log = (ts: number) => logs.prepare("INSERT INTO logs (ts,ts_nanos,process_uuid,thread_id) VALUES (?,0,?,?)").run(ts, "pid:901:native-process", token);
      if (kind === "earlier") log(start - 5);
      log(start);
      logs.close(); state.close();
      if (kind === "unreadable") fs.writeFileSync(path.join(home, "logs_1.sqlite"), "not a database");
      const { a } = adapter({ codexHome: home, listProcesses: () => rows(identity) });
      const r = await resume(a);
      if (resumed) expect(r).toMatchObject({ ok: true, resumeToken: token });
      else expect(r).toMatchObject({ ok: false, recovery: "attention_required" });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  it("the shared pane-process check used by sends and attention is unchanged: it still matches argv only", async () => {
    const observed = await verifyCodexPaneProcess({ target: "%1", tmux: { getPanePid: async () => 900 } as never,
      listProcesses: () => rows() as never, expectedToken: token, requireResume: true });
    expect(observed?.process.pid).toBe(901);
  });
});
