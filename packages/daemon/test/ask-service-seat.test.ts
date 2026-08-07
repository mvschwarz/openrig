import { describe, it, expect, vi } from "vitest";
import { AskService, type AskDeps } from "../src/domain/ask-service.js";
import type { PsEntry } from "../src/domain/ps-projection.js";
import type { Rig } from "../src/domain/types.js";
import type { SearchResult, SeatSearchResult } from "../src/domain/history-query.js";

function makeDeps(seatResult: SeatSearchResult, overrides?: Partial<AskDeps>): AskDeps {
  return {
    psProjectionService: {
      getEntries: vi.fn((): PsEntry[] => [
        { rigId: "rig-1", name: "my-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: "5m ago" },
      ]),
    },
    rigRepo: {
      findRigsByName: vi.fn((_n: string): Rig[] => [
        { id: "rig-1", name: "my-rig", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ]),
      getRig: vi.fn(() => null),
    },
    historyQuery: {
      search: vi.fn(async (): Promise<SearchResult> => ({ backend: "rg", excerpts: [], insufficient: true })),
      searchChat: vi.fn(() => []),
      searchSeat: vi.fn(async (): Promise<SeatSearchResult> => seatResult),
    },
    transcriptsEnabled: true,
    ...overrides,
  };
}

describe("AskService — seat-scoped (L1)", () => {
  it("routes to searchSeat (not whole-rig) and returns generation-labeled hits spanning tenures", async () => {
    const deps = makeDeps({
      backend: "read",
      seat: "dev-planner@my-rig",
      generations: 2,
      hits: [
        { generation: 1, text: "gen1 discussed deployment" },
        { generation: 2, text: "gen2 revisited deployment" },
      ],
      insufficient: false,
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "deployment?", { seat: "dev-planner@my-rig" });

    expect(deps.historyQuery.searchSeat).toHaveBeenCalledWith("my-rig", "dev-planner@my-rig", "deployment?");
    expect(deps.historyQuery.search).not.toHaveBeenCalled(); // seat path, not the whole-rig grep
    expect(result.seat).toBeDefined();
    expect(result.seat!.name).toBe("dev-planner@my-rig");
    expect(result.seat!.generations).toBe(2);
    expect(result.seat!.hits.map((h) => h.generation).sort()).toEqual([1, 2]);
    expect(result.insufficient).toBe(false);
    expect(result.evidence.backend).toBe("read");
  });

  it("surfaces honest-degraded as guidance — never a silent empty", async () => {
    const deps = makeDeps({
      backend: "read",
      seat: "dev-guard@my-rig",
      generations: 2,
      hits: [],
      insufficient: true,
      degraded: { reason: "boundary_only", message: "only session-boundary markers — degraded, not absent" },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "deployment?", { seat: "dev-guard@my-rig" });

    expect(result.seat!.degraded!.reason).toBe("boundary_only");
    expect(result.guidance).toContain("boundary");
    expect(result.insufficient).toBe(true);
  });
});
