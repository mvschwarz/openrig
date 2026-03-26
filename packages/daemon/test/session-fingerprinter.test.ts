import { describe, it, expect, vi } from "vitest";
import { SessionFingerprinter } from "../src/domain/session-fingerprinter.js";
import type { CmuxAdapter } from "../src/adapters/cmux.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ScannedPane } from "../src/domain/tmux-discovery-scanner.js";

function makePane(overrides?: Partial<ScannedPane>): ScannedPane {
  return {
    tmuxSession: "sess",
    tmuxWindow: "0",
    tmuxPane: "%0",
    pid: 1234,
    cwd: "/tmp",
    activeCommand: null,
    ...overrides,
  };
}

function mockCmux(agents?: Array<{ pid: number; runtime: string }>): CmuxAdapter {
  return {
    queryAgentPIDs: vi.fn(async () => {
      if (!agents) return { ok: false as const, code: "unavailable" as const, message: "not connected" };
      const map = new Map(agents.map((a) => [a.pid, a]));
      return { ok: true as const, data: map };
    }),
    isAvailable: vi.fn(() => !!agents),
    getStatus: vi.fn(() => ({ available: !!agents, capabilities: {} })),
  } as unknown as CmuxAdapter;
}

function mockTmux(paneContent?: string): TmuxAdapter {
  return {
    capturePaneContent: vi.fn(async () => paneContent ?? null),
  } as unknown as TmuxAdapter;
}

describe("SessionFingerprinter", () => {
  // T1: cmux reports claude_code PID -> claude-code, highest
  it("cmux claude_code PID -> claude-code, highest confidence", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 1234, runtime: "claude_code" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 1234 }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("highest");
    expect(result.evidence.layerUsed).toBe(0);
    expect(result.evidence.cmuxSignal?.pid).toBe(1234);
  });

  // T2: cmux reports codex PID -> codex, highest
  it("cmux codex PID -> codex, highest confidence", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 5678, runtime: "codex" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 5678 }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("highest");
  });

  // T3: cmux unavailable, 'claude' process -> claude-code, high
  it("cmux unavailable + claude process -> claude-code, high", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(), // unavailable
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "claude" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("high");
    expect(result.evidence.layerUsed).toBe(1);
  });

  // T4: cmux unavailable, 'codex' process -> codex, high
  it("cmux unavailable + codex process -> codex, high", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "codex" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("high");
  });

  // T5: shell only (bash) -> terminal, high
  it("shell process (bash) -> terminal, high", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "bash" }));

    expect(result.runtimeHint).toBe("terminal");
    expect(result.confidence).toBe("high");
  });

  // T6: ambiguous process + Claude banner in pane -> claude-code, medium
  it("ambiguous process + Claude banner -> claude-code, medium", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("Some output\nClaude Code v1.0\nMore text"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "node" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("medium");
    expect(result.evidence.layerUsed).toBe(2);
  });

  // T7: ambiguous process + Codex banner in pane -> codex, medium
  it("ambiguous process + Codex banner -> codex, medium", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("Some output\nCodex CLI\nMore text"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: "node" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("medium");
  });

  // T8: no process + no banner -> unknown, low
  it("no process + no banner -> unknown, low", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("just some random terminal output"),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null }));

    expect(result.runtimeHint).toBe("unknown");
    expect(result.confidence).toBe("low");
  });

  // T9: CWD with .claude/ boosts confidence
  it("CWD with .claude/ -> claude-code, low (config context)", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("random output"),
      fsExists: (p) => p === "/projects/.claude",
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null, cwd: "/projects" }));

    expect(result.runtimeHint).toBe("claude-code");
    expect(result.confidence).toBe("low");
    expect(result.evidence.configSignal?.claudeDir).toBe(true);
  });

  // T10: CWD with .agents/ boosts confidence
  it("CWD with .agents/ -> codex, low (config context)", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux(),
      tmuxAdapter: mockTmux("random output"),
      fsExists: (p) => p === "/projects/.agents",
    });

    const result = await fp.fingerprint(makePane({ activeCommand: null, cwd: "/projects" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("low");
    expect(result.evidence.configSignal?.agentsDir).toBe(true);
  });

  // T11: cmux signal overrides process tree (PID match)
  it("cmux signal overrides process tree when PID matches", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 1234, runtime: "codex" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    // Process says "claude" but cmux says "codex" for PID 1234
    const result = await fp.fingerprint(makePane({ pid: 1234, activeCommand: "claude" }));

    expect(result.runtimeHint).toBe("codex");
    expect(result.confidence).toBe("highest");
    expect(result.evidence.layerUsed).toBe(0);
  });

  // T12: Evidence JSON captures all signals including cmux source
  it("evidence captures cmux signal source", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: mockCmux([{ pid: 42, runtime: "claude_code" }]),
      tmuxAdapter: mockTmux(),
      fsExists: () => false,
    });

    const result = await fp.fingerprint(makePane({ pid: 42 }));

    expect(result.evidence.cmuxSignal).toBeDefined();
    expect(result.evidence.cmuxSignal!.runtime).toBe("claude_code");
    expect(result.evidence.cmuxSignal!.pid).toBe(42);
    expect(result.evidence.layerUsed).toBe(0);
  });
});
