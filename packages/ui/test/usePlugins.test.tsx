// Phase 3a slice 3.3 — usePlugins / usePlugin / usePluginUsedBy tests
// (TDD red→green).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { usePlugins, usePlugin, usePluginUsedBy } from "../src/hooks/usePlugins.js";
import type { PluginEntry, PluginDetail, PluginAgentReference } from "../src/hooks/usePlugins.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

let qc: QueryClient;

beforeEach(() => {
  mockFetch.mockReset();
  qc = createTestQueryClient();
});

afterEach(() => { cleanup(); });

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function ListHarness({ runtime }: { runtime?: "claude" | "codex" }) {
  const { data, isPending, error } = usePlugins({ runtime });
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">plugins: {data?.length ?? 0}</div>;
}

function DetailHarness({ id }: { id: string | null }) {
  const { data, isPending, error } = usePlugin(id);
  if (id === null) return <div data-testid="state">null</div>;
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">name: {data?.entry.name ?? "n/a"}</div>;
}

function UsedByHarness({ id }: { id: string }) {
  const { data, isPending, error } = usePluginUsedBy(id);
  if (isPending) return <div data-testid="state">pending</div>;
  if (error) return <div data-testid="state">error: {error.message}</div>;
  return <div data-testid="state">used-by: {data?.length ?? 0}</div>;
}

describe("usePlugins (list)", () => {
  it("fetches /api/plugins and exposes the list", async () => {
    const sample: PluginEntry[] = [
      {
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        runtimes: ["claude", "codex"],
        path: "/x/openrig-core",
        lastSeenAt: null,
      },
    ];
    mockFetch.mockResolvedValue(new Response(JSON.stringify(sample), { status: 200 }));
    render(<Wrapper><ListHarness /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("plugins: 1");
    });
    const callUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(callUrl).toBe("/api/plugins");
  });

  it("appends ?runtime=claude when runtime filter provided", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    render(<Wrapper><ListHarness runtime="claude" /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("plugins: 0");
    });
    const callUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(callUrl).toBe("/api/plugins?runtime=claude");
  });

  it("surfaces HTTP errors", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ error: "x" }), { status: 503 }));
    render(<Wrapper><ListHarness /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toContain("error: HTTP 503");
    });
  });
});

describe("usePlugin (detail)", () => {
  it("returns null state when id is null (no fetch)", () => {
    render(<Wrapper><DetailHarness id={null} /></Wrapper>);
    expect(screen.getByTestId("state").textContent).toBe("null");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fetches /api/plugins/:id and exposes the detail", async () => {
    const sample: PluginDetail = {
      entry: {
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        description: "vendored",
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        runtimes: ["claude", "codex"],
        path: "/x",
        lastSeenAt: null,
      },
      claudeManifest: {
        raw: { name: "openrig-core" },
        name: "openrig-core",
        version: "0.1.0",
        description: null,
        homepage: null,
        repository: null,
        license: null,
      },
      codexManifest: null,
      skills: [{ name: "openrig-user", relativePath: "skills/openrig-user" }],
      hooks: [{ runtime: "claude", relativePath: "hooks/claude.json", events: ["SessionStart"] }],
    };
    mockFetch.mockResolvedValue(new Response(JSON.stringify(sample), { status: 200 }));
    render(<Wrapper><DetailHarness id="openrig-core" /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("name: openrig-core");
    });
    const callUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(callUrl).toBe("/api/plugins/openrig-core");
  });

  it("surfaces 404 as error", async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 404 }));
    render(<Wrapper><DetailHarness id="missing" /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toContain("error: HTTP 404");
    });
  });
});

describe("usePluginUsedBy", () => {
  it("fetches /api/plugins/:id/used-by", async () => {
    const sample: PluginAgentReference[] = [
      { agentName: "advisor-lead", sourcePath: "/x/agent.yaml", profiles: ["default"] },
    ];
    mockFetch.mockResolvedValue(new Response(JSON.stringify(sample), { status: 200 }));
    render(<Wrapper><UsedByHarness id="openrig-core" /></Wrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("state").textContent).toBe("used-by: 1");
    });
    const callUrl = mockFetch.mock.calls[0]?.[0] as string;
    expect(callUrl).toBe("/api/plugins/openrig-core/used-by");
  });
});
