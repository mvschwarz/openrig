import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import Database from "better-sqlite3";
import { describe, it, expect, vi } from "vitest";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    getPanePid: vi.fn(async () => null),
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => null),
    capturePaneContent: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function createCodexLogsDb(homeDir: string, pid: number, threadId: string, dbName = "logs_1.sqlite"): void {
  const codexDir = nodePath.join(homeDir, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  const db = new Database(nodePath.join(codexDir, dbName));
  try {
    db.exec(`
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        ts_nanos INTEGER NOT NULL,
        process_uuid TEXT NOT NULL,
        thread_id TEXT
      );
    `);
    db.prepare(
      "INSERT INTO logs (ts, ts_nanos, process_uuid, thread_id) VALUES (?, ?, ?, ?)"
    ).run(
      1,
      1,
      `pid:${pid}:test-process`,
      threadId
    );
  } finally {
    db.close();
  }
}

describe("ResumeMetadataRefresher", () => {
  it("refreshes missing Codex resume token from the live child process", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      readCodexThreadIdByPid: (pid) => pid === 901 ? "019d45c3-e909-7152-b52e-34edab4070ed" : undefined,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed"
    );
  });

  it("refreshes missing Codex resume token from a nested wrapper -> vendor codex process tree", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -C /project -a never -s workspace-write" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -C /project -a never -s workspace-write" },
      ],
      readCodexThreadIdByPid: (pid) => pid === 902 ? "019d45c3-e909-7152-b52e-34edab4070ed" : undefined,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed"
    );
  });

  it("refreshes missing Codex resume token from the child process home directory", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-refresh-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45c3-e909-7152-b52e-34edab4070ed");

    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      homeDir: "/wrong-home",
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed"
    );
  });

  it("refreshes missing Codex resume token from the current versioned logs database", async () => {
    const tempRoot = fs.mkdtempSync(nodePath.join(os.tmpdir(), "rigged-codex-refresh-"));
    const actualHome = nodePath.join(tempRoot, "actual-home");
    createCodexLogsDb(actualHome, 901, "019d45c3-e909-7152-b52e-34edab4070ed", "logs_2.sqlite");

    const sessionRegistry = {
      updateResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const tmux = mockTmux({
      getPanePid: vi.fn(async () => 900),
    });
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: tmux,
      listProcesses: () => [
        { pid: 900, ppid: 1, command: "-zsh" },
        { pid: 901, ppid: 900, command: "codex" },
      ],
      resolveHomeDirByPid: (pid) => pid === 901 ? actualHome : undefined,
      homeDir: "/wrong-home",
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: null,
        resumeToken: null,
      },
    ]);

    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith(
      "sess-1",
      "codex_id",
      "019d45c3-e909-7152-b52e-34edab4070ed"
    );
  });

  it("skips sessions that already have a resume token", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-qa@demo-rig",
        runtime: "codex",
        resumeType: "codex_id",
        resumeToken: "existing-token",
      },
    ]);

    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("clears Claude resume metadata when the stored token is not natively resumable", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
    } as unknown as SessionRegistry;
    const probeClaudeResume = vi.fn(async () => "not_resumable" as const);
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-design@demo-rig",
        runtime: "claude-code",
        resumeType: "claude_id",
        resumeToken: "abc-123",
        cwd: "/repo",
      },
    ]);

    expect(probeClaudeResume).toHaveBeenCalledWith("dev-design@demo-rig", "abc-123", "/repo");
    expect(sessionRegistry.clearResumeToken).toHaveBeenCalledWith("sess-1");
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });
});
