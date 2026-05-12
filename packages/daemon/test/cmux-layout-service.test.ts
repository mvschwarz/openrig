// Slice 24 Checkpoint B — CmuxLayoutService.
// Pure algorithm pieces (computeLayout / chunkAgents / orderAgentsFromRigSpec)
// + buildWorkspace coordinated through a mocked CmuxAdapter.

import { describe, it, expect, vi } from "vitest";
import { CmuxLayoutService, MAX_COLS, MAX_PER_WORKSPACE } from "../src/domain/cmux-layout-service.js";
import type { CmuxResult } from "../src/adapters/cmux.js";

interface MockAdapterRecord {
  method: string;
  args: unknown[];
}

function makeMockAdapter(overrides: Partial<{
  createWorkspaceFn: (name: string, cwd?: string) => Promise<CmuxResult<string>>;
  splitSurfaceFn: (
    surfaceId: string,
    direction: "left" | "right" | "up" | "down",
    workspaceId?: string,
  ) => Promise<CmuxResult<string>>;
  sendTextFn: (surfaceId: string, text: string, workspaceId?: string) => Promise<CmuxResult<void>>;
  listSurfacesFn: (workspaceId?: string) => Promise<CmuxResult<unknown[]>>;
  closeWorkspaceFn: (workspaceId: string) => Promise<CmuxResult<void>>;
}> = {}): { adapter: { [k: string]: unknown }; calls: MockAdapterRecord[] } {
  const calls: MockAdapterRecord[] = [];
  let surfaceSeq = 0;
  let workspaceSeq = 0;
  const nextSurface = () => `surface:${++surfaceSeq}`;
  const nextWorkspace = () => `workspace:${++workspaceSeq}`;

  const adapter = {
    createWorkspace: vi.fn(async (name: string, cwd?: string) => {
      calls.push({ method: "createWorkspace", args: [name, cwd] });
      return overrides.createWorkspaceFn
        ? overrides.createWorkspaceFn(name, cwd)
        : { ok: true, data: nextWorkspace() };
    }),
    splitSurface: vi.fn(async (surfaceId: string, direction: "left" | "right" | "up" | "down", workspaceId?: string) => {
      calls.push({ method: "splitSurface", args: [surfaceId, direction, workspaceId] });
      return overrides.splitSurfaceFn
        ? overrides.splitSurfaceFn(surfaceId, direction, workspaceId)
        : { ok: true, data: nextSurface() };
    }),
    sendText: vi.fn(async (surfaceId: string, text: string, workspaceId?: string) => {
      calls.push({ method: "sendText", args: [surfaceId, text, workspaceId] });
      return overrides.sendTextFn
        ? overrides.sendTextFn(surfaceId, text, workspaceId)
        : { ok: true, data: undefined };
    }),
    listSurfaces: vi.fn(async (workspaceId?: string) => {
      calls.push({ method: "listSurfaces", args: [workspaceId] });
      return overrides.listSurfacesFn
        ? overrides.listSurfacesFn(workspaceId)
        : { ok: true, data: [{ id: nextSurface(), title: "", type: "terminal" }] };
    }),
    closeWorkspace: vi.fn(async (workspaceId: string) => {
      calls.push({ method: "closeWorkspace", args: [workspaceId] });
      return overrides.closeWorkspaceFn
        ? overrides.closeWorkspaceFn(workspaceId)
        : { ok: true, data: undefined };
    }),
  };

  return { adapter, calls };
}

describe("CmuxLayoutService.computeLayout", () => {
  const cases: Array<[number, number, number, number]> = [
    // [N, rows, cols, blanks]  per README §Layout algorithm table
    [1, 1, 1, 0],
    [2, 1, 2, 0],
    [3, 2, 2, 1],
    [4, 2, 2, 0],
    [5, 3, 2, 1],
    [6, 3, 2, 0],
    [7, 4, 2, 1],
    [8, 4, 2, 0],
    [9, 5, 2, 1],
    [10, 5, 2, 0],
    [11, 6, 2, 1],
    [12, 6, 2, 0],
  ];

  it.each(cases)("N=%i → rows=%i cols=%i blanks=%i", (n, rows, cols, blanks) => {
    const layout = CmuxLayoutService.computeLayout(n);
    expect(layout.rows).toBe(rows);
    expect(layout.cols).toBe(cols);
    expect(layout.blanks).toBe(blanks);
  });

  it("throws on N=0", () => {
    expect(() => CmuxLayoutService.computeLayout(0)).toThrow();
  });

  it("throws on negative N", () => {
    expect(() => CmuxLayoutService.computeLayout(-1)).toThrow();
  });

  it("throws on N > MAX_PER_WORKSPACE (caller should chunk first)", () => {
    expect(() => CmuxLayoutService.computeLayout(13)).toThrow(/chunk/i);
  });
});

describe("CmuxLayoutService.chunkAgents", () => {
  function agents(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `agent-${i + 1}`);
  }

  it("single agent → one chunk of one", () => {
    expect(CmuxLayoutService.chunkAgents(agents(1))).toEqual([["agent-1"]]);
  });

  it("12 agents → one chunk of 12", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(12));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(12);
  });

  it("13 agents → two chunks (12 + 1)", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(13));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[1]![0]).toBe("agent-13");
  });

  it("24 agents → two chunks (12 + 12)", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(24));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(12);
  });

  it("30 agents → three chunks (12 + 12 + 6)", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(30));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(12);
    expect(chunks[1]).toHaveLength(12);
    expect(chunks[2]).toHaveLength(6);
  });

  it("0 agents → empty array (no workspaces to build)", () => {
    expect(CmuxLayoutService.chunkAgents([])).toEqual([]);
  });

  it("preserves input order across chunk boundaries", () => {
    const chunks = CmuxLayoutService.chunkAgents(agents(13));
    expect(chunks[0]![0]).toBe("agent-1");
    expect(chunks[0]![11]).toBe("agent-12");
    expect(chunks[1]![0]).toBe("agent-13");
  });
});

describe("CmuxLayoutService.orderAgentsFromRigSpec", () => {
  it("returns pod-then-member order (deterministic across runs)", () => {
    const rigSpec = {
      pods: [
        { id: "orch", members: [{ id: "lead" }, { id: "peer" }] },
        { id: "dev", members: [{ id: "impl" }, { id: "qa" }, { id: "design" }] },
      ],
    };
    const ordered = CmuxLayoutService.orderAgentsFromRigSpec(rigSpec);
    expect(ordered).toEqual(["orch.lead", "orch.peer", "dev.impl", "dev.qa", "dev.design"]);
  });

  it("returns empty for empty rig spec", () => {
    expect(CmuxLayoutService.orderAgentsFromRigSpec({ pods: [] })).toEqual([]);
  });

  it("works with one pod / one member", () => {
    const rigSpec = { pods: [{ id: "solo", members: [{ id: "only" }] }] };
    expect(CmuxLayoutService.orderAgentsFromRigSpec(rigSpec)).toEqual(["solo.only"]);
  });

  it("preserves pod order from spec (not alphabetical)", () => {
    const rigSpec = {
      pods: [
        { id: "zulu", members: [{ id: "z1" }] },
        { id: "alpha", members: [{ id: "a1" }] },
      ],
    };
    const ordered = CmuxLayoutService.orderAgentsFromRigSpec(rigSpec);
    expect(ordered).toEqual(["zulu.z1", "alpha.a1"]);
  });
});

describe("CmuxLayoutService.buildWorkspace", () => {
  it("for N=1: creates workspace, sends tmux attach to default surface, no splits", async () => {
    const { adapter, calls } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["session-a"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(0);
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(1);
    expect((sends[0]!.args[1] as string)).toMatch(/tmux attach -t session-a/);
  });

  it("for N=2: creates workspace, 1 split right, 2 sends", async () => {
    const { adapter, calls } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(1);
    expect(splits[0]!.args[1]).toBe("right");
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(2);
  });

  it("for N=4 (2×2): 3 splits (right + 2 downs), 4 sends", async () => {
    const { adapter, calls } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(3);
    // First split is "right" to make column 2
    expect(splits[0]!.args[1]).toBe("right");
    // Subsequent are "down" to add rows
    expect(splits[1]!.args[1]).toBe("down");
    expect(splits[2]!.args[1]).toBe("down");
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(4);
  });

  it("for N=12 (2×6): 11 splits (1 right + 10 downs), 12 sends", async () => {
    const { adapter, calls } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const agents = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    const result = await service.buildWorkspace("my-rig", "/cwd", agents);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(11);
    const rightSplits = splits.filter((s) => s.args[1] === "right");
    const downSplits = splits.filter((s) => s.args[1] === "down");
    expect(rightSplits).toHaveLength(1);
    expect(downSplits).toHaveLength(10);
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(12);
  });

  it("returns blanks count when N is odd (one trailing blank panel)", async () => {
    const { adapter } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3"]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.blanks).toBe(1);
    }
  });

  it("returns error when createWorkspace fails", async () => {
    const { adapter } = makeMockAdapter({
      createWorkspaceFn: async () => ({ ok: false, code: "request_failed", message: "duplicate name" }),
    });
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/duplicate/i);
  });

  it("propagates split failure", async () => {
    const { adapter } = makeMockAdapter({
      splitSurfaceFn: async () => ({ ok: false, code: "request_failed", message: "split failed" }),
    });
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/split failed/);
  });

  it("for N=0: returns ok with workspaceName set but no agents", async () => {
    const { adapter, calls } = makeMockAdapter();
    const service = new CmuxLayoutService(adapter as never);
    const result = await service.buildWorkspace("my-rig", "/cwd", []);
    expect(result.ok).toBe(true);
    // No splits or sends since there are no agents
    expect(calls.filter((c) => c.method === "splitSurface")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "sendText")).toHaveLength(0);
  });
});

describe("CmuxLayoutService constants", () => {
  it("MAX_COLS = 2 per slice 24 README", () => {
    expect(MAX_COLS).toBe(2);
  });

  it("MAX_PER_WORKSPACE = 12 per slice 24 README", () => {
    expect(MAX_PER_WORKSPACE).toBe(12);
  });
});
