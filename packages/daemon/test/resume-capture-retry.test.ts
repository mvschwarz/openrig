import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import { lstartToMinTs } from "../src/domain/codex-thread-id.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const roots: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const identity = "Sun Sep  6 23:52:32 2026";
const token = "019d45c3-e909-7152-b52e-34edab4070ed";
const session = { sessionId: "session-1", sessionName: "codex@rig", runtime: "codex", resumeType: null, resumeToken: null };
function fixture(reason?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "resume-capture-retry-")); roots.push(home);
  const codexHome = path.join(home, ".codex"); fs.mkdirSync(codexHome);
  const logsPath = path.join(codexHome, "logs_2.sqlite");
  const logs = new Database(logsPath);
  logs.exec("CREATE TABLE logs (ts INTEGER, process_uuid TEXT, thread_id TEXT)"); logs.close();
  const state = new Database(path.join(codexHome, "state_5.sqlite"));
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, source TEXT, rollout_path TEXT)"); state.close();
  const add = (id: string, source = "cli") => {
    const logs = new Database(logsPath);
    logs.prepare("INSERT INTO logs VALUES (?, ?, ?)").run(lstartToMinTs(identity)! + 1, "pid:901:native", id); logs.close();
    const state = new Database(path.join(codexHome, "state_5.sqlite"));
    state.prepare("INSERT INTO threads VALUES (?, ?, ?)").run(id, source, path.join(home, id + ".jsonl")); state.close();
  };
  const lines: string[] = [];
  const registry = { updateResumeToken: vi.fn(() => true), markResumeProbeResult: vi.fn(), isForkClaimingHeldToken: () => false,
    findResumeContextByName: () => ({ sessionId: session.sessionId }) } as unknown as SessionRegistry;
  const refresher = new ResumeMetadataRefresher({
    sessionRegistry: registry, tmuxAdapter: { getPanePid: async () => reason === "no_pane_pid" ? null : 900 } as TmuxAdapter,
    listProcesses: () => reason === "no_codex_descendant" ? [] : [{ pid: 900, ppid: 1, command: "bash" }, { pid: 901, ppid: 900, command: "codex", startedAt: identity }],
    codexHome, homeDir: home, log: line => lines.push(line), sleep: async () => {},
  });
  return { add, lines, registry, refresher, logsPath };
}

describe("S11 Codex capture diagnostics and retry", () => {
  it("S11-1: no log row reports once per session, without token text", async () => {
    const f = fixture();
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual(["[resume-capture] codex@rig: no_log_row"]);
    expect(f.lines.join("\n")).not.toContain(token);
  });
  it("S11-2: ambiguous CLI threads are reported with count, never selected", async () => {
    const f = fixture(); f.add(token); f.add("019d45c3-e909-7152-b52e-34edab4070ee");
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual(["[resume-capture] codex@rig: ambiguous_threads count=2"]);
    expect(f.lines.join("\n")).not.toContain(token);
  });
  it("S11-3: a late SQLite row fills a null token on the next tick and logs redacted success once", async () => {
    const f = fixture();
    await f.refresher.refresh([session], { fillNullOnly: true });
    expect(f.registry.updateResumeToken).not.toHaveBeenCalled();
    f.add(token);
    await f.refresher.refresh([session], { fillNullOnly: true });
    expect(f.registry.updateResumeToken).toHaveBeenCalledWith(session.sessionId, "codex_id", token, "scrape");
    await f.refresher.refresh([{ ...session, resumeToken: token }], { fillNullOnly: true });
    expect(f.lines).toEqual(["[resume-capture] codex@rig: no_log_row", "[resume-capture] codex@rig: captured"]);
    expect(f.lines.join("\n")).not.toContain(token);
    expect(f.lines.join("\n")).not.toContain(token.slice(0, 8));
    console.log(f.lines.join("\n"));
  });
  it("S11-4: null discovery makes one attempt on every configured tick, with no tick-count or time minimum", async () => {
    const read = vi.fn(() => undefined);
    const registry = { isForkClaimingHeldToken: () => false, updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry,
      tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => [{ pid: 901, ppid: 900, command: "codex" }],
      readCodexThreadIdByPid: read, log: () => {}, sleep: async () => {},
    });
    // Right after an adoption attempt (full 8-try loop), the very next tick still attempts once.
    await refresher.captureCodexThreadId(session.sessionName);
    read.mockClear();
    await refresher.refresh([session], { fillNullOnly: true });
    expect(read).toHaveBeenCalledTimes(1);
    // A manual null-fill is the same path: one attempt each, at any spacing.
    await refresher.refresh([session], { fillNullOnly: true });
    expect(read).toHaveBeenCalledTimes(2);
    read.mockClear();
    for (let tick = 1; tick <= 30; tick++) await refresher.refresh([session], { fillNullOnly: true });
    expect(read).toHaveBeenCalledTimes(30);
    // Existing FR-6.1 freshness reads for present tokens remain unchanged.
    read.mockReturnValue(token);
    await refresher.refresh([{ ...session, resumeToken: token }], { fillNullOnly: true });
    expect(registry.markResumeProbeResult).toHaveBeenCalledWith(session.sessionId, "resumable");
  });
  it("S11-6: a pending fork id is filled only by its own conversation, never one another row holds", async () => {
    let held = true; const update = vi.fn(() => true);
    const registry = { isForkClaimingHeldToken: () => held, updateResumeToken: update, markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: registry,
      tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => [{ pid: 901, ppid: 900, command: "codex" }],
      readCodexThreadIdByPid: () => token, log: () => {},
    });
    await refresher.refresh([session], { fillNullOnly: true });
    expect(update).not.toHaveBeenCalled();
    held = false;
    await refresher.refresh([session], { fillNullOnly: true });
    expect(update).toHaveBeenCalledWith(session.sessionId, "codex_id", token, "scrape");
  });
  it("S11-7: a discovery failure is logged once without its text, then reaches the caller as on main", async () => {
    const lines: string[] = [];
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: { isForkClaimingHeldToken: () => false } as unknown as SessionRegistry,
      tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => { throw new Error("ps exploded " + token); }, log: line => lines.push(line) });
    await expect(refresher.refresh([session], { fillNullOnly: true })).rejects.toThrow("ps exploded");
    expect(lines).toEqual(["[resume-capture] codex@rig: process_unreadable"]);
    expect(lines.join("\n")).not.toContain("exploded");
    expect(lines.join("\n")).not.toContain(token);
  });
  it("S11-8: a discovery failure while stopping neither logs it nor throws", async () => {
    const lines: string[] = [];
    let release!: () => void;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: {} as SessionRegistry,
      tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => new Promise((_, reject) => { release = () => reject(new Error("late")); }), log: line => lines.push(line) });
    const capture = refresher.captureCodexThreadId(session.sessionName);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    refresher.stop(); release();
    expect(await capture).toBeUndefined();
    expect(lines).toEqual(["[resume-capture] codex@rig: shutdown"]);
  });
  it("S11-5: shutdown cancels an unresolved adoption read, with retry by a new refresher", async () => {
    const read = vi.fn(() => new Promise<string | undefined>(() => {}));
    const deps = { sessionRegistry: {} as SessionRegistry, tmuxAdapter: { getPanePid: async () => 900 } as TmuxAdapter,
      listProcesses: () => [{ pid: 901, ppid: 900, command: "codex" }], readCodexThreadIdByPid: read, log: () => {} };
    const refresher = new ResumeMetadataRefresher(deps);
    const capture = refresher.captureCodexThreadId(session.sessionName);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    refresher.stop();
    expect(await capture).toBeUndefined();
    const next = new ResumeMetadataRefresher({ ...deps, readCodexThreadIdByPid: () => token });
    expect(await next.captureCodexThreadId(session.sessionName)).toBe(token);
  });
  it("bounds adoption even when a dependency never settles", async () => {
    vi.useFakeTimers();
    const refresher = new ResumeMetadataRefresher({ sessionRegistry: {} as SessionRegistry,
      tmuxAdapter: { getPanePid: () => new Promise(() => {}) } as TmuxAdapter, log: () => {} });
    const capture = refresher.captureCodexThreadId(session.sessionName);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await capture).toBeUndefined();
  });
  it.each(["no_pane_pid", "no_codex_descendant", "no_cli_thread", "sqlite_unreadable"])("reports %s without raw exception data", async reason => {
    const f = fixture(reason);
    if (reason === "no_cli_thread") f.add(token, "exec");
    if (reason === "sqlite_unreadable") fs.writeFileSync(f.logsPath, "not sqlite");
    expect(await f.refresher.captureCodexThreadId(session.sessionName, { attempts: 1 })).toBeUndefined();
    expect(f.lines).toEqual([`[resume-capture] codex@rig: ${reason}`]);
  });
});
