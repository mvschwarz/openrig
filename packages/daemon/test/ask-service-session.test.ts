import { describe, it, expect, vi } from "vitest";
import { AskService, type AskDeps } from "../src/domain/ask-service.js";
import type { PsEntry } from "../src/domain/ps-projection.js";
import type { Rig } from "../src/domain/types.js";
import type { SearchResult, SeatSearchResult, SessionSearchResult } from "../src/domain/history-query.js";

function makeDeps(sessionResult: SessionSearchResult): AskDeps {
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
      searchSeat: vi.fn(async (): Promise<SeatSearchResult> => ({ backend: "read", seat: "x", generations: 1, hits: [], insufficient: true })),
      searchSession: vi.fn(async (): Promise<SessionSearchResult> => sessionResult),
    },
    transcriptsEnabled: true,
  };
}

describe("AskService — session-scoped (L2)", () => {
  it("routes to searchSession (not whole-rig, not seat) and returns content excerpts", async () => {
    const deps = makeDeps({
      backend: "rg",
      token: "abc-123",
      found: true,
      path: "/home/.claude/projects/-p/abc-123.jsonl",
      excerpts: ['{"text":"the SECRET_MARKER"}'],
      insufficient: false,
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "SECRET_MARKER", { session: "abc-123" });

    expect(deps.historyQuery.searchSession).toHaveBeenCalledWith("abc-123", "SECRET_MARKER");
    expect(deps.historyQuery.search).not.toHaveBeenCalled();
    expect(deps.historyQuery.searchSeat).not.toHaveBeenCalled();
    expect(result.session).toBeDefined();
    expect(result.session!.token).toBe("abc-123");
    expect(result.session!.found).toBe(true);
    expect(result.evidence.excerpts.some((e) => e.includes("SECRET_MARKER"))).toBe(true);
    expect(result.insufficient).toBe(false);
  });

  it("surfaces session_not_found as guidance — never a silent empty", async () => {
    const deps = makeDeps({
      backend: "none",
      token: "bogus",
      found: false,
      excerpts: [],
      insufficient: true,
      degraded: { reason: "session_not_found", message: "No session JSONL found for token 'bogus'. Check the token." },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "anything", { session: "bogus" });

    expect(result.session!.found).toBe(false);
    expect(result.guidance).toMatch(/token/i);
    expect(result.insufficient).toBe(true);
  });
});
