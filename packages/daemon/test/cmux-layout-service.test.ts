// Slice 24 Checkpoint B — CmuxLayoutService.
// Pure algorithm pieces (computeLayout / chunkAgents / orderAgentsFromRigSpec)
// + buildWorkspace coordinated through a mocked CmuxAdapter.

import { describe, it, expect, vi } from "vitest";
import {
  CmuxLayoutService,
  autoGridCols,
  MAX_COLS,
  MAX_PER_WORKSPACE,
  OP_DELAY_MS,
  FINAL_SETTLE_MS,
  LIST_SURFACES_RETRY_DELAY_MS,
  LIST_SURFACES_MAX_ATTEMPTS,
  EQUALIZE_PASSES,
  EQUALIZE_SETTLE_MS,
} from "../src/domain/cmux-layout-service.js";
import type { CmuxResult } from "../src/adapters/cmux.js";

// Tests inject a recording no-op sleep so the suite doesn't actually
// wait OP_DELAY_MS between operations. The injected sleep records calls
// so tests can assert delays were awaited at the right boundaries.
function makeSleepRecorder(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
}

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
  equalizeSplitsFn: (workspaceId?: string) => Promise<CmuxResult<{ equalized: boolean }>>;
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
    equalizeSplits: vi.fn(async (workspaceId?: string) => {
      calls.push({ method: "equalizeSplits", args: [workspaceId] });
      return overrides.equalizeSplitsFn
        ? overrides.equalizeSplitsFn(workspaceId)
        : { ok: true, data: { equalized: true } };
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

describe("CmuxLayoutService.buildWorkspacePanes (terminal-provider paneCommand core)", () => {
  it("sends each caller-composed command verbatim + newline (read-only -r / ssh-wrap preserved)", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("openrig:v#l1", undefined, [
      "tmux attach -t 'a@r'",
      "ssh 'user@host' tmux attach -r -t 'b@r'",
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.paneCount).toBe(2);
      expect(result.data.blanks).toBe(0);
    }
    const creates = calls.filter((c) => c.method === "createWorkspace");
    expect(creates).toHaveLength(1); // ONE workspace for the whole page
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends.map((s) => s.args[1])).toEqual([
      "tmux attach -t 'a@r'\n",
      "ssh 'user@host' tmux attach -r -t 'b@r'\n",
    ]);
  });

  // PM ruling: the applied grid must match the modal Auto-grid preview
  // (TerminalLauncher suggestLayout: cols = ceil(sqrt(N))). Direct vectors at
  // the acceptance sizes — shape, split count, send count, equalize, ONE
  // workspace.
  const commands = (n: number) => Array.from({ length: n }, (_, i) => `cmd-${i + 1}`);
  const gridCases: Array<{
    n: number; cols: number; rights: number; downs: number; equalizes: number; blanks: number;
  }> = [
    // N=2 → 1×2: one right split, no equalize (2-col is 50/50 already).
    { n: 2, cols: 2, rights: 1, downs: 0, equalizes: 0, blanks: 0 },
    // N=5 → 2 rows × 3 cols: 2 rights + 3 downs, EQUALIZE_PASSES equalizes.
    { n: 5, cols: 3, rights: 2, downs: 3, equalizes: EQUALIZE_PASSES, blanks: 1 },
    // N=7 → 3×3: 2 rights + 6 downs, EQUALIZE_PASSES equalizes, 2 blanks.
    { n: 7, cols: 3, rights: 2, downs: 6, equalizes: EQUALIZE_PASSES, blanks: 2 },
  ];

  it.each(gridCases)(
    "modal Auto-grid N=$n → cols=$cols: $rights right + $downs down splits, $equalizes equalize passes, ONE workspace",
    async ({ n, cols, rights, downs, equalizes, blanks }) => {
      expect(autoGridCols(n)).toBe(cols); // the daemon mirror of suggestLayout
      const { adapter, calls } = makeMockAdapter();
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspacePanes("ws", undefined, commands(n), autoGridCols(n));

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.paneCount).toBe(n);
        expect(result.data.blanks).toBe(blanks);
        expect(result.data.equalized).toBe(equalizes > 0 ? true : undefined);
      }
      expect(calls.filter((c) => c.method === "createWorkspace")).toHaveLength(1);
      const splits = calls.filter((c) => c.method === "splitSurface");
      expect(splits.filter((s) => s.args[1] === "right")).toHaveLength(rights);
      expect(splits.filter((s) => s.args[1] === "down")).toHaveLength(downs);
      expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(equalizes);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends).toHaveLength(n);
      expect(sends.map((s) => s.args[1])).toEqual(commands(n).map((c) => `${c}\n`));
    },
  );

  // The VM-diagnosed timing bug (PM ruling): an equalize fired before pane
  // commands land can report equalized:true and still end 2:1:1 after layout
  // churn. So equalization runs AFTER the last send + final settle, and a
  // SECOND pass always follows a settle delay — never early-exited on the
  // RPC boolean.
  it("equalizes only AFTER the last pane command, and runs a second pass even when the first reports true", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep, sleeps } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("ws", undefined, commands(7), autoGridCols(7));

    expect(result.ok).toBe(true);
    const lastSendIdx = calls.map((c) => c.method).lastIndexOf("sendText");
    const firstEqIdx = calls.map((c) => c.method).indexOf("equalizeSplits");
    expect(firstEqIdx).toBeGreaterThan(lastSendIdx); // after ALL pane commands
    // Mock reports equalized:true on the FIRST pass — the second pass still runs.
    expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(EQUALIZE_PASSES);
    // The final-settle sleep precedes pass 1; the equalize-settle delay separates passes.
    expect(sleeps).toContain(FINAL_SETTLE_MS);
    expect(sleeps.filter((ms) => ms === EQUALIZE_SETTLE_MS)).toHaveLength(EQUALIZE_PASSES - 1);
  });

  it("reports equalized:false honestly when no pass rebalances (acceptance stays pane-frame geometry)", async () => {
    const { adapter, calls } = makeMockAdapter({
      equalizeSplitsFn: async () => ({ ok: true, data: { equalized: false } }),
    });
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspacePanes("ws", undefined, commands(7), autoGridCols(7));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.equalized).toBe(false);
    expect(calls.filter((c) => c.method === "equalizeSplits")).toHaveLength(EQUALIZE_PASSES);
  });

  it("computeGridLayout clamps cols to N and rejects non-positive cols", () => {
    expect(CmuxLayoutService.computeGridLayout(2, 3)).toEqual({ rows: 1, cols: 2, blanks: 0 });
    expect(CmuxLayoutService.computeGridLayout(7, 3)).toEqual({ rows: 3, cols: 3, blanks: 2 });
    expect(() => CmuxLayoutService.computeGridLayout(3, 0)).toThrow(/cols/);
  });
});

describe("CmuxLayoutService.buildWorkspace", () => {
  it("for N=1: creates workspace, sends tmux attach to default surface, no splits", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
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
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
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
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);

    expect(result.ok).toBe(true);
    const splits = calls.filter((c) => c.method === "splitSurface");
    expect(splits).toHaveLength(3);
    expect(splits[0]!.args[1]).toBe("right");
    expect(splits[1]!.args[1]).toBe("down");
    expect(splits[2]!.args[1]).toBe("down");
    const sends = calls.filter((c) => c.method === "sendText");
    expect(sends).toHaveLength(4);
  });

  it("for N=12 (2×6): 11 splits (1 right + 10 downs), 12 sends", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
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
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
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
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/duplicate/i);
  });

  it("propagates split failure", async () => {
    const { adapter } = makeMockAdapter({
      splitSurfaceFn: async () => ({ ok: false, code: "request_failed", message: "split failed" }),
    });
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/split failed/);
  });

  it("for N=0: returns ok with workspaceName set but no agents", async () => {
    const { adapter, calls } = makeMockAdapter();
    const { sleep } = makeSleepRecorder();
    const service = new CmuxLayoutService(adapter as never, { sleep });
    const result = await service.buildWorkspace("my-rig", "/cwd", []);
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => c.method === "splitSurface")).toHaveLength(0);
    expect(calls.filter((c) => c.method === "sendText")).toHaveLength(0);
  });

  // velocity-guard 24.B BLOCKING-CONCERN regressions:
  // README §94 + skill §5 require timing guards. Tests prove the
  // injectable sleep is awaited at the right boundaries.

  describe("timing gotchas (slice 24 README §94 + skill §5)", () => {
    it("awaits sleep(OP_DELAY_MS) after every splitSurface", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      // N=4 (2×2): 3 splits → expect 3 OP_DELAY_MS sleeps after splits
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);
      const opDelays = sleeps.filter((ms) => ms === OP_DELAY_MS);
      expect(opDelays).toHaveLength(3);
    });

    it("awaits sleep(FINAL_SETTLE_MS) once after the last sendText", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2", "s3", "s4"]);
      const finalSettles = sleeps.filter((ms) => ms === FINAL_SETTLE_MS);
      expect(finalSettles).toHaveLength(1);
    });

    it("final settle is the LAST sleep called (no further ops after)", async () => {
      const { adapter } = makeMockAdapter();
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["s1", "s2"]);
      expect(sleeps[sleeps.length - 1]).toBe(FINAL_SETTLE_MS);
    });

    it("retries listSurfaces with backoff when initial response is empty", async () => {
      let listCallCount = 0;
      const { adapter } = makeMockAdapter({
        listSurfacesFn: async () => {
          listCallCount += 1;
          if (listCallCount < 3) {
            return { ok: true, data: [] };
          }
          return { ok: true, data: [{ id: "surface:default", title: "", type: "terminal" }] };
        },
      });
      const { sleep, sleeps } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);
      expect(result.ok).toBe(true);
      expect(listCallCount).toBe(3);
      // 2 retry-backoff sleeps before the third (successful) list
      const retryBackoffs = sleeps.filter((ms) => ms === LIST_SURFACES_RETRY_DELAY_MS);
      expect(retryBackoffs.length).toBeGreaterThanOrEqual(2);
    });

    it("returns request_failed after LIST_SURFACES_MAX_ATTEMPTS empty listSurfaces", async () => {
      const { adapter } = makeMockAdapter({
        listSurfacesFn: async () => ({ ok: true, data: [] }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      const result = await service.buildWorkspace("my-rig", "/cwd", ["s1"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("request_failed");
        expect(result.message).toMatch(new RegExp(String(LIST_SURFACES_MAX_ATTEMPTS)));
      }
    });

    it("constants exposed: OP_DELAY_MS=500, FINAL_SETTLE_MS=1000", () => {
      expect(OP_DELAY_MS).toBe(500);
      expect(FINAL_SETTLE_MS).toBe(1000);
    });
  });

  // velocity-guard 24.B SECONDARY regression:
  // README §52 fill order is "top-to-bottom, left-to-right" — column-major.
  // Each column's surfaces are populated top-to-bottom before moving to the
  // next column.

  describe("fill order (column-major per README §52)", () => {
    it("for N=3 in 2×2 grid: agent-2 → first down-split (col0,row1); agent-3 → right-split (col1,row0); blank at (col1,row1) — DISCRIMINATING for column-major", async () => {
      // Split sequence per impl: (1) right-split off initial first,
      // (2) then for r=1: down-split off col0/row0=initial, then
      // down-split off col1/row0=right-split.
      const splitCalls: Array<{ src: string; dir: string }> = [];
      let surfaceCounter = 100;
      const { adapter, calls } = makeMockAdapter({
        splitSurfaceFn: async (src, dir) => {
          const id = `surface:${++surfaceCounter}`;
          splitCalls.push({ src, dir });
          return { ok: true, data: id };
        },
        listSurfacesFn: async () => ({
          ok: true,
          data: [{ id: "surface:initial", title: "", type: "terminal" }],
        }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["agent-1", "agent-2", "agent-3"]);

      // Verify the split sequence: 1 right + 2 downs.
      expect(splitCalls).toHaveLength(3);
      expect(splitCalls[0]).toEqual({ src: "surface:initial", dir: "right" });
      // splitCalls[0] returns surface:101 = col1/row0 (right-split)
      // splitCalls[1] returns surface:102 (down off col0/row0 = col0/row1)
      // splitCalls[2] returns surface:103 (down off col1/row0 = col1/row1)
      expect(splitCalls[1]!.dir).toBe("down");
      expect(splitCalls[1]!.src).toBe("surface:initial"); // down off col 0 row 0
      expect(splitCalls[2]!.dir).toBe("down");
      expect(splitCalls[2]!.src).toBe("surface:101"); // down off col 1 row 0 (the right-split surface)

      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends).toHaveLength(3);

      // COLUMN-MAJOR fill expectations (these assertions DISCRIMINATE
      // the row-major-to-column-major switch — they would fail under
      // the prior row-major impl):
      //   agent-1 → col 0 / row 0 = "surface:initial"
      //   agent-2 → col 0 / row 1 = "surface:102" (FIRST down-split)
      //   agent-3 → col 1 / row 0 = "surface:101" (right-split)
      // Under row-major, agent-2 would land on "surface:101"
      // (col 1 / row 0) and agent-3 would land on "surface:102"
      // (col 0 / row 1) — both surface-id assertions below would
      // flip and fail.
      expect(sends[0]!.args[0]).toBe("surface:initial");
      expect((sends[0]!.args[1] as string)).toContain("agent-1");

      expect(sends[1]!.args[0]).toBe("surface:102");
      expect((sends[1]!.args[1] as string)).toContain("agent-2");

      expect(sends[2]!.args[0]).toBe("surface:101");
      expect((sends[2]!.args[1] as string)).toContain("agent-3");
    });

    it("for N=4 in 2×2 grid: send order (col-major) is initial → first-down → right → second-down", async () => {
      // Same impl produces splits in the same order; for N=4 all four
      // surfaces are populated. Under column-major:
      //   send 0: col0/row0 = initial
      //   send 1: col0/row1 = first down-split (off initial) = surface:102
      //   send 2: col1/row0 = right-split = surface:101
      //   send 3: col1/row1 = second down-split (off right-split) = surface:103
      // Under row-major the order would be initial → 101 → 102 → 103.
      let surfaceCounter = 100;
      const { adapter, calls } = makeMockAdapter({
        splitSurfaceFn: async (_src, _dir) => ({ ok: true, data: `surface:${++surfaceCounter}` }),
        listSurfacesFn: async () => ({
          ok: true,
          data: [{ id: "surface:initial", title: "", type: "terminal" }],
        }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["a1", "a2", "a3", "a4"]);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends.map((s) => s.args[0])).toEqual([
        "surface:initial",
        "surface:102",
        "surface:101",
        "surface:103",
      ]);
    });

    it("for N=2 in 2×1 grid: agent 1 → col0 row0; agent 2 → col1 row0", async () => {
      const { adapter, calls } = makeMockAdapter({
        listSurfacesFn: async () => ({ ok: true, data: [{ id: "surface:initial", title: "", type: "terminal" }] }),
        splitSurfaceFn: async (_src, _dir) => ({ ok: true, data: "surface:right" }),
      });
      const { sleep } = makeSleepRecorder();
      const service = new CmuxLayoutService(adapter as never, { sleep });
      await service.buildWorkspace("my-rig", "/cwd", ["agent-1", "agent-2"]);
      const sends = calls.filter((c) => c.method === "sendText");
      expect(sends[0]!.args[0]).toBe("surface:initial");
      expect((sends[0]!.args[1] as string)).toContain("agent-1");
      expect(sends[1]!.args[0]).toBe("surface:right");
      expect((sends[1]!.args[1] as string)).toContain("agent-2");
    });
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
