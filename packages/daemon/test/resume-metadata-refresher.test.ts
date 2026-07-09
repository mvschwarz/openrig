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
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
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
        { pid: 901, ppid: 900, command: "node /opt/homebrew/bin/codex -C /project -a on-request -s danger-full-access" },
        { pid: 902, ppid: 901, command: "/opt/homebrew/lib/node_modules/@openai/codex/vendor/codex/codex -C /project -a on-request -s danger-full-access" },
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
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
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
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
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
      "019d45c3-e909-7152-b52e-34edab4070ed",
      "scrape"
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

  // OPR.0.4.6.02 S1 EXCLUSION — the ephemeral native-resume PROBE session
  // (`rigged-refresh-*`) is NOT a real operator/agent seat, so it must NEVER
  // receive the tmux option defaults. The refresher is deliberately not wired
  // with the shared applier; this pins that the refresh path calls no tmux
  // option-setter across a run (mouse/status/set-clipboard/copy-command).
  it("EXCLUSION: the probe/refresh path never applies tmux option defaults", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    const setSessionOption = vi.fn(async () => ({ ok: true as const }));
    const setServerOption = vi.fn(async () => ({ ok: true as const }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux({ setSessionOption, setServerOption } as Partial<TmuxAdapter>),
      // deterministic probe verdict so we exercise the refresh path without a
      // brittle live native-probe; the exclusion is about option-setters.
      probeClaudeResume: async () => "not_resumable" as const,
      sleep: async () => {},
    });

    await refresher.refresh([
      {
        sessionId: "sess-1",
        sessionName: "dev-design@demo-rig",
        runtime: "claude-code",
        resumeType: "claude_native",
        resumeToken: "abc-123",
      },
    ]);

    expect(setSessionOption).not.toHaveBeenCalled();
    expect(setServerOption).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-6 §2.1b — the default (teardown/legacy) validate path now MARKS
  // STALE instead of clearing: a present-but-not-resumable token stays in the ledger.
  it("marks a not-resumable Claude token STALE without clearing it (FR-6 §2.1b)", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
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
    expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "not_resumable");
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled(); // token SURVIVES for FR-6 to surface
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("stamps a resumable Claude token verified via the validate path (FR-6 §2.1b)", async () => {
    const sessionRegistry = {
      updateResumeToken: vi.fn(),
      clearResumeToken: vi.fn(),
      markResumeProbeResult: vi.fn(),
    } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume: async () => "resumable" as const,
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-1", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "abc-123", cwd: "/repo" },
    ]);
    expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "resumable");
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-4 — Claude sidecar null-fill during snapshot refresh.
  it("FR-4: null-fills a Claude token from the sidecar session_id (scrape)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-uuid-xyz" } }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-c", "claude_id", "claude-uuid-xyz", "scrape");
  });

  it("FR-4: a missing/parse-error sidecar leaves the Claude token null (no write, no throw)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: false as const, reason: "missing_sidecar" }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4: an empty sidecar session_id is not written (honest null)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "   " } }) },
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4: a Claude session with a PRESENT token is validated, NOT sidecar-filled", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
    const readSidecar = vi.fn(() => ({ ok: true as const, data: { session_id: "should-not-be-used" } }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      contextUsageStore: { readSidecar },
      probeClaudeResume: async () => "resumable",
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "existing-tok" },
    ]);
    expect(readSidecar).not.toHaveBeenCalled(); // present token → validate branch, no null-fill
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  it("FR-4: no contextUsageStore wired → Claude null-fill is a silent no-op (back-compat)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const refresher = new ResumeMetadataRefresher({ sessionRegistry, tmuxAdapter: mockTmux() });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ]);
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
  });

  // OPR.0.4.3.20 FR-4 (rev1 fix) — the RECURRING snapshot-refresh mode: fill-null only,
  // never clear a present token (rev1-r2), never spawn a `claude --resume` probe (rev1-r1).
  it("FR-4 rev1: fillNullOnly NEVER clears a present Claude token AND NEVER spawns a resume probe", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    // Probe would say not_resumable — the default path would clear; fillNullOnly must not even call it.
    const probeClaudeResume = vi.fn(async () => "not_resumable" as const);
    const readSidecar = vi.fn(() => ({ ok: true as const, data: { session_id: "unused" } }));
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      contextUsageStore: { readSidecar },
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-1", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: "claude_id", resumeToken: "present-tok", cwd: "/repo" },
    ], { fillNullOnly: true });
    expect(probeClaudeResume).not.toHaveBeenCalled();                // rev1-r1: no `claude --resume` spawn on the recurring path
    expect(sessionRegistry.clearResumeToken).not.toHaveBeenCalled(); // rev1-r2: present-but-not-resumable token SURVIVES for FR-6
    expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    // OPR.0.4.3.20 FR-6.1 — the present token IS now re-derived (pure sidecar read) for the
    // equal-value freshness check. Here the derived value ("unused") does NOT match the stored
    // token ("present-tok"), so nothing is re-stamped — the FR-4 invariants (no probe, no clear,
    // no clobber) still hold even while re-deriving.
    expect(readSidecar).toHaveBeenCalled();
  });

  it("FR-4 rev1: fillNullOnly still null-fills a Claude token from the sidecar (lightweight, no probe)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const probeClaudeResume = vi.fn(async () => "resumable" as const);
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry,
      tmuxAdapter: mockTmux(),
      probeClaudeResume,
      contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-uuid-xyz" } }) },
      sleep: async () => {},
    });
    await refresher.refresh([
      { sessionId: "sess-c", sessionName: "seat@rig", runtime: "claude-code", resumeType: null, resumeToken: null },
    ], { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-c", "claude_id", "claude-uuid-xyz", "scrape");
    expect(probeClaudeResume).not.toHaveBeenCalled();                // still no probe — null-fill is a pure sidecar read
  });

  it("FR-4 rev1: fillNullOnly still null-fills a Codex token via captureCodexThreadId (lightweight pid-log read)", async () => {
    const sessionRegistry = { updateResumeToken: vi.fn(), clearResumeToken: vi.fn() } as unknown as SessionRegistry;
    const tmux = mockTmux({ getPanePid: vi.fn(async () => 900) });
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
      { sessionId: "sess-x", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: null },
    ], { fillNullOnly: true });
    expect(sessionRegistry.updateResumeToken).toHaveBeenCalledWith("sess-x", "codex_id", "019d45c3-e909-7152-b52e-34edab4070ed", "scrape");
  });

  // OPR.0.4.3.20 FR-6.1 — periodic freshness re-stamp for present-and-valid tokens.
  // Equal-value pure-read derive → markResumeProbeResult("resumable"); different/absent →
  // no-op (no re-stamp, no clobber); no probe/spawn on the fillNullOnly path.
  describe("FR-6.1 periodic freshness re-stamp", () => {
    it("Codex present + equal derive → re-stamps freshness via markResumeProbeResult('resumable'), no clobber", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => 900) }),
        listProcesses: () => [{ pid: 900, ppid: 1, command: "-zsh" }, { pid: 901, ppid: 900, command: "codex" }],
        readCodexThreadIdByPid: (pid) => (pid === 901 ? "codex-tok-A" : undefined),
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-1", "resumable");
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled(); // freshness-only, never re-writes the token
    });

    it("Codex present + DIFFERENT derive → no re-stamp, no clobber (left honest)", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => 900) }),
        listProcesses: () => [{ pid: 900, ppid: 1, command: "-zsh" }, { pid: 901, ppid: 900, command: "codex" }],
        readCodexThreadIdByPid: (pid) => (pid === 901 ? "codex-tok-B" : undefined), // rolled/changed
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Codex present + ABSENT derive (no pane pid) → no-op", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux({ getPanePid: vi.fn(async () => null) }),
        listProcesses: () => [],
        readCodexThreadIdByPid: () => undefined,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-1", sessionName: "dev-qa@demo-rig", runtime: "codex", resumeType: null, resumeToken: "codex-tok-A" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude present + equal sidecar derive → re-stamps freshness, NO probe, no clobber", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-tok-A" } }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).toHaveBeenCalledWith("sess-c", "resumable");
      expect(probeClaudeResume).not.toHaveBeenCalled(); // NO heavyweight claude --resume on the periodic path
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude present + DIFFERENT sidecar derive → no re-stamp, no probe, no clobber", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: true as const, data: { session_id: "claude-tok-B" } }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(probeClaudeResume).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });

    it("Claude present + sidecar unreadable (parse-error/not ok) → no-op, no probe", async () => {
      const sessionRegistry = { updateResumeToken: vi.fn(), markResumeProbeResult: vi.fn() } as unknown as SessionRegistry;
      const probeClaudeResume = vi.fn(async () => "resumable" as const);
      const refresher = new ResumeMetadataRefresher({
        sessionRegistry,
        tmuxAdapter: mockTmux(),
        contextUsageStore: { readSidecar: () => ({ ok: false as const, reason: "missing" }) },
        probeClaudeResume,
        sleep: async () => {},
      });
      await refresher.refresh([
        { sessionId: "sess-c", sessionName: "dev-design@demo-rig", runtime: "claude-code", resumeType: null, resumeToken: "claude-tok-A", cwd: "/repo" },
      ], { fillNullOnly: true });
      expect(sessionRegistry.markResumeProbeResult).not.toHaveBeenCalled();
      expect(probeClaudeResume).not.toHaveBeenCalled();
      expect(sessionRegistry.updateResumeToken).not.toHaveBeenCalled();
    });
  });
});
