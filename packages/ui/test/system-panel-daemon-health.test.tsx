import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// OPR.0.4.3.21 forward-fix — the System panel's daemon status is derived from
// isSuccess AND the event-loop verdict: a process-present daemon whose
// eventLoop.healthy===false must render UNHEALTHY-with-evidence, NOT connected.

function mockHealth(body: unknown): void {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/healthz")) {
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (u.includes("/api/adapters/cmux/status")) {
      return new Response(JSON.stringify({ available: true }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchImpl);
}

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SystemPanel daemon health verdict", () => {
  it("eventLoop.healthy=false + query success -> UNHEALTHY with evidence, NOT connected", async () => {
    mockHealth({
      status: "ok",
      eventLoop: { lagMeanMs: 900, lagP99Ms: 1200, utilization: 0.99, lastTickAgeMs: 1500, healthy: false },
    });
    const { SystemPanel } = await import("../src/components/SystemPanel.js");
    const { getByTestId } = withQueryClient(
      <SystemPanel onClose={() => {}} events={[]} initialTab="status" />,
    );

    await waitFor(() => {
      expect(getByTestId("system-daemon-status").textContent).toContain("process present, unhealthy");
    });
    const status = getByTestId("system-daemon-status");
    expect(status.textContent).not.toContain("connected");
    expect(status.className).toContain("text-amber-600");

    const evidence = getByTestId("system-daemon-evidence");
    expect(evidence.textContent).toContain("event loop starved");
    expect(evidence.textContent).toContain("1500ms");
  });

  it("eventLoop.healthy=true + query success -> connected (unchanged), no evidence line", async () => {
    mockHealth({
      status: "ok",
      eventLoop: { lagMeanMs: 2, lagP99Ms: 5, utilization: 0.1, lastTickAgeMs: 20, healthy: true },
    });
    const { SystemPanel } = await import("../src/components/SystemPanel.js");
    const { getByTestId, queryByTestId } = withQueryClient(
      <SystemPanel onClose={() => {}} events={[]} initialTab="status" />,
    );

    await waitFor(() => {
      expect(getByTestId("system-daemon-status").textContent).toContain("connected");
    });
    expect(getByTestId("system-daemon-status").className).toContain("text-green-600");
    expect(queryByTestId("system-daemon-evidence")).toBeNull();
  });

  it("monitor-less daemon (plain {status:ok}, no eventLoop) -> connected (unchanged)", async () => {
    mockHealth({ status: "ok" });
    const { SystemPanel } = await import("../src/components/SystemPanel.js");
    const { getByTestId, queryByTestId } = withQueryClient(
      <SystemPanel onClose={() => {}} events={[]} initialTab="status" />,
    );

    await waitFor(() => {
      expect(getByTestId("system-daemon-status").textContent).toContain("connected");
    });
    expect(queryByTestId("system-daemon-evidence")).toBeNull();
  });
});
