import { describe, it, expect, vi } from "vitest";
import { TmuxDiscoveryScanner } from "../src/domain/tmux-discovery-scanner.js";
import type { TmuxAdapter, TmuxSession, TmuxWindow, TmuxPane } from "../src/adapters/tmux.js";

function mockAdapter(opts?: {
  sessions?: TmuxSession[];
  windows?: Record<string, TmuxWindow[]>;
  panes?: Record<string, TmuxPane[]>;
  pidMap?: Record<string, number | null>;
  cmdMap?: Record<string, string | null>;
}): TmuxAdapter {
  const sessions = opts?.sessions ?? [];
  const windows = opts?.windows ?? {};
  const panes = opts?.panes ?? {};
  const pidMap = opts?.pidMap ?? {};
  const cmdMap = opts?.cmdMap ?? {};

  return {
    listSessions: vi.fn(async () => sessions),
    listWindows: vi.fn(async (name: string) => windows[name] ?? []),
    listPanes: vi.fn(async (target: string) => panes[target] ?? []),
    getPanePid: vi.fn(async (paneId: string) => pidMap[paneId] ?? null),
    getPaneCommand: vi.fn(async (paneId: string) => cmdMap[paneId] ?? null),
    hasSession: vi.fn(async () => false),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
  } as unknown as TmuxAdapter;
}

describe("TmuxDiscoveryScanner", () => {
  // T1: Enumerates sessions from tmux adapter
  it("enumerates sessions and returns panes", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "dev", windows: 1, created: "0", attached: true }],
      windows: { dev: [{ index: 0, name: "main", panes: 1, active: true }] },
      panes: { "dev:0": [{ id: "%0", index: 0, cwd: "/home/user", width: 80, height: 24, active: true }] },
      pidMap: { "%0": 1234 },
      cmdMap: { "%0": "claude" },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes).toHaveLength(1);
    expect(result.panes[0]!.tmuxSession).toBe("dev");
    expect(result.scannedAt).toBeTruthy();
  });

  // T2: Resolves pane PID via adapter.getPanePid
  it("resolves pane PID from adapter", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 1, active: true }] },
      panes: { "s:0": [{ id: "%1", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }] },
      pidMap: { "%1": 5678 },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes[0]!.pid).toBe(5678);
    expect(adapter.getPanePid).toHaveBeenCalledWith("%1");
  });

  // T3: Resolves pane cwd from existing pane.cwd field
  it("resolves cwd from pane data", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 1, active: true }] },
      panes: { "s:0": [{ id: "%0", index: 0, cwd: "/projects/rigged", width: 80, height: 24, active: true }] },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes[0]!.cwd).toBe("/projects/rigged");
  });

  // T4: Resolves active command via adapter.getPaneCommand
  it("resolves active command from adapter", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 1, active: true }] },
      panes: { "s:0": [{ id: "%2", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }] },
      cmdMap: { "%2": "codex" },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes[0]!.activeCommand).toBe("codex");
    expect(adapter.getPaneCommand).toHaveBeenCalledWith("%2");
  });

  // T5: All sessions returned — no extra filtering (tmux is per-user)
  it("returns all sessions from adapter without filtering", async () => {
    const adapter = mockAdapter({
      sessions: [
        { name: "session-a", windows: 1, created: "0", attached: true },
        { name: "session-b", windows: 1, created: "0", attached: false },
      ],
      windows: {
        "session-a": [{ index: 0, name: "w", panes: 1, active: true }],
        "session-b": [{ index: 0, name: "w", panes: 1, active: true }],
      },
      panes: {
        "session-a:0": [{ id: "%0", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }],
        "session-b:0": [{ id: "%1", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }],
      },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes).toHaveLength(2);
    expect(result.panes.map((p) => p.tmuxSession)).toEqual(["session-a", "session-b"]);
  });

  // T6: No tmux server -> empty result
  it("no tmux server returns empty result", async () => {
    const adapter = mockAdapter({ sessions: [] });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes).toHaveLength(0);
  });

  // T7: Pane with no foreground process -> pid=null, activeCommand=null
  it("pane with no foreground process returns null pid and command", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 1, active: true }] },
      panes: { "s:0": [{ id: "%0", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }] },
      pidMap: { "%0": null },
      cmdMap: { "%0": null },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    const result = await scanner.scan();

    expect(result.panes[0]!.pid).toBeNull();
    expect(result.panes[0]!.activeCommand).toBeNull();
  });

  // T8: All probes use mock adapter
  it("all operations go through mock adapter", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 1, active: true }] },
      panes: { "s:0": [{ id: "%0", index: 0, cwd: "/tmp", width: 80, height: 24, active: true }] },
    });
    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });

    await scanner.scan();

    expect(adapter.listSessions).toHaveBeenCalledTimes(1);
    expect(adapter.listWindows).toHaveBeenCalledTimes(1);
    expect(adapter.listPanes).toHaveBeenCalledTimes(1);
    expect(adapter.getPanePid).toHaveBeenCalledTimes(1);
    expect(adapter.getPaneCommand).toHaveBeenCalledTimes(1);
  });

  // T9: Partial pane failure -> scan continues with null fields
  it("partial pane metadata failure does not abort scan of other panes", async () => {
    const adapter = mockAdapter({
      sessions: [{ name: "s", windows: 1, created: "0", attached: false }],
      windows: { s: [{ index: 0, name: "w", panes: 2, active: true }] },
      panes: { "s:0": [
        { id: "%0", index: 0, cwd: "/tmp/a", width: 80, height: 24, active: true },
        { id: "%1", index: 1, cwd: "/tmp/b", width: 80, height: 24, active: false },
      ]},
      pidMap: { "%1": 9999 },
      cmdMap: { "%1": "node" },
    });
    // Make %0 PID/command lookups throw
    (adapter.getPanePid as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "%0") throw new Error("pane gone");
      return 9999;
    });
    (adapter.getPaneCommand as ReturnType<typeof vi.fn>).mockImplementation(async (id: string) => {
      if (id === "%0") throw new Error("pane gone");
      return "node";
    });

    const scanner = new TmuxDiscoveryScanner({ tmuxAdapter: adapter });
    const result = await scanner.scan();

    // Both panes should be in the result
    expect(result.panes).toHaveLength(2);
    // Failed pane has nulls
    expect(result.panes[0]!.pid).toBeNull();
    expect(result.panes[0]!.activeCommand).toBeNull();
    // Successful pane has data
    expect(result.panes[1]!.pid).toBe(9999);
    expect(result.panes[1]!.activeCommand).toBe("node");
  });
});
