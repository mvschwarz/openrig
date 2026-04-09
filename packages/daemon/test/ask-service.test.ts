import { describe, it, expect, vi } from "vitest";
import { AskService, type AskDeps } from "../src/domain/ask-service.js";
import type { PsEntry } from "../src/domain/ps-projection.js";
import type { Rig } from "../src/domain/types.js";
import type { SearchResult } from "../src/domain/history-query.js";

function makeDeps(overrides?: Partial<AskDeps>): AskDeps {
  return {
    psProjectionService: {
      getEntries: vi.fn((): PsEntry[] => [
        { rigId: "rig-1", name: "my-rig", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h 30m", latestSnapshot: "5m ago" },
      ]),
    },
    rigRepo: {
      findRigsByName: vi.fn((_name: string): Rig[] => [
        { id: "rig-1", name: "my-rig", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      ]),
      getRig: vi.fn(() => null),
    },
    historyQuery: {
      search: vi.fn(async (): Promise<SearchResult> => ({
        backend: "rg",
        excerpts: ["deployment started", "deployment finished"],
        insufficient: false,
      })),
      searchChat: vi.fn(() => []),
    },
    transcriptsEnabled: true,
    ...overrides,
  };
}

describe("AskService", () => {
  it("assembles evidence pack with question, topology, and excerpts", async () => {
    const deps = makeDeps();
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "what about deployment?");

    expect(result.question).toBe("what about deployment?");
    expect(result.rig).toBeDefined();
    expect(result.rig!.name).toBe("my-rig");
    expect(result.rig!.status).toBe("running");
    expect(result.evidence.excerpts).toEqual(["deployment started", "deployment finished"]);
    expect(result.evidence.backend).toBe("rg");
    expect(result.insufficient).toBe(false);
  });

  it("returns guidance when rig is not found", async () => {
    const deps = makeDeps({
      rigRepo: {
        findRigsByName: vi.fn(() => []),
      },
      psProjectionService: {
        getEntries: vi.fn(() => []),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("nonexistent", "any question");

    expect(result.rig).toBeNull();
    expect(result.guidance).toContain("not found");
  });

  it("returns guidance when rig is ambiguous", async () => {
    const deps = makeDeps({
      rigRepo: {
        findRigsByName: vi.fn(() => [
          { id: "rig-1", name: "my-rig", createdAt: "2026-01-01", updatedAt: "2026-01-01" },
          { id: "rig-2", name: "my-rig", createdAt: "2026-01-02", updatedAt: "2026-01-02" },
        ]),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "any question");

    expect(result.guidance).toContain("ambiguous");
  });

  it("returns guidance when transcripts are disabled", async () => {
    const deps = makeDeps({ transcriptsEnabled: false });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "any question");

    expect(result.insufficient).toBe(true);
    expect(result.guidance).toContain("disabled");
  });

  it("surfaces insufficient flag from history query", async () => {
    const deps = makeDeps({
      historyQuery: {
        search: vi.fn(async (): Promise<SearchResult> => ({
          backend: "rg",
          excerpts: [],
          insufficient: true,
        })),
        searchChat: vi.fn(() => []),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "what is the");

    expect(result.insufficient).toBe(true);
  });

  it("merges chat evidence into result via shared history-query seam", async () => {
    const deps = makeDeps({
      historyQuery: {
        search: vi.fn(async (): Promise<SearchResult> => ({
          backend: "rg",
          excerpts: ["some transcript match"],
          insufficient: false,
        })),
        searchChat: vi.fn(() => [
          { sender: "alice", body: "deployment started in chat", createdAt: "2026-01-01T00:00:00Z" },
        ]),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "what about deployment?");

    expect(result.evidence.chatExcerpts).toBeDefined();
    expect(result.evidence.chatExcerpts!.length).toBe(1);
    expect(result.evidence.chatExcerpts![0]).toContain("[alice] deployment started in chat");
    // When chat has evidence, insufficient should be false even if transcript has results
    expect(result.insufficient).toBe(false);
  });

  it("chat evidence prevents insufficient when transcripts have no matches", async () => {
    const deps = makeDeps({
      historyQuery: {
        search: vi.fn(async (): Promise<SearchResult> => ({
          backend: "rg",
          excerpts: [],
          insufficient: true,
        })),
        searchChat: vi.fn(() => [
          { sender: "bob", body: "deployment completed", createdAt: "2026-01-01T00:00:00Z" },
        ]),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "what about deployment?");

    expect(result.insufficient).toBe(false);
    expect(result.evidence.chatExcerpts!.length).toBe(1);
  });

  it("handles no transcript directory", async () => {
    const deps = makeDeps({
      historyQuery: {
        search: vi.fn(async (): Promise<SearchResult> => ({
          backend: "rg",
          excerpts: [],
          insufficient: true,
          noTranscriptDir: true,
        })),
        searchChat: vi.fn(() => []),
      },
    });
    const svc = new AskService(deps);
    const result = await svc.ask("my-rig", "deployment question");

    expect(result.insufficient).toBe(true);
    expect(result.guidance).toContain("transcript");
  });

  it("answers peer questions from structured whoami context without transcript search", async () => {
    const searchSpy = vi.fn(async (): Promise<SearchResult> => ({
      backend: "rg",
      excerpts: [],
      insufficient: true,
    }));
    const deps = makeDeps({
      historyQuery: {
        search: searchSpy,
        searchChat: vi.fn(() => []),
      },
      whoamiService: {
        resolve: vi.fn(() => ({
          resolvedBy: "session_name",
          identity: {
            rigId: "rig-1",
            rigName: "my-rig",
            nodeId: "node-1",
            logicalId: "dev.impl",
            attachmentType: "tmux",
            podId: "pod-dev",
            podNamespace: "dev",
            podLabel: "Development",
            memberId: "impl",
            memberLabel: "Implementer",
            sessionName: "dev.impl@my-rig",
            runtime: "claude-code",
            cwd: "/tmp",
            agentRef: null,
            profile: null,
            resolvedSpecName: null,
            resolvedSpecVersion: null,
          },
          peers: [
            {
              logicalId: "dev.qa",
              sessionName: "dev.qa@my-rig",
              runtime: "codex",
              podId: "pod-dev",
              podNamespace: "dev",
              memberId: "qa",
            },
          ],
          edges: { outgoing: [], incoming: [] },
          transcript: { enabled: true, path: null, tailCommand: null, grepCommand: null },
          commands: { sendExamples: [], captureExamples: [] },
        })),
      },
    });
    const svc = new AskService(deps);

    const result = await svc.ask("my-rig", "who are my peers?", { sessionName: "dev.impl@my-rig" });

    expect(result.evidence.backend).toBe("structured");
    expect(result.evidence.excerpts[0]).toContain("dev.qa");
    expect(result.evidence.excerpts[0]).toContain("dev.qa@my-rig");
    expect(result.evidence.excerpts.join("\n")).not.toContain("dev.impl");
    expect(result.insufficient).toBe(false);
    expect(searchSpy).not.toHaveBeenCalled();
  });

  it("returns insufficient guidance for peer questions when current identity is unknown", async () => {
    const searchSpy = vi.fn(async (): Promise<SearchResult> => ({
      backend: "rg",
      excerpts: [],
      insufficient: true,
    }));
    const deps = makeDeps({
      historyQuery: {
        search: searchSpy,
        searchChat: vi.fn(() => []),
      },
      rigRepo: {
        findRigsByName: vi.fn((_name: string): Rig[] => [
          { id: "rig-1", name: "my-rig", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
        ]),
        getRig: vi.fn(() => ({
          rig: { id: "rig-1", name: "my-rig", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
          nodes: [
            { id: "node-1", logicalId: "dev.impl", runtime: "claude-code", podId: "pod-dev", binding: { tmuxSession: "dev.impl@my-rig" } },
            { id: "node-2", logicalId: "dev.qa", runtime: "codex", podId: "pod-dev", binding: { tmuxSession: "dev.qa@my-rig" } },
          ],
          edges: [],
        }) as never),
      },
      whoamiService: {
        resolve: vi.fn(() => null),
      },
    });
    const svc = new AskService(deps);

    const result = await svc.ask("my-rig", "who are my peers?");

    expect(result.insufficient).toBe(true);
    expect(result.evidence.excerpts).toEqual([]);
    expect(result.guidance).toContain("identity");
    expect(searchSpy).not.toHaveBeenCalled();
  });
});
