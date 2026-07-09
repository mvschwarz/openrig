// OPR.0.4.6.WF4 (C3) — the workflow SSE feed's binding contract:
// Q5-P1 the subscription is UNSCOPED (never `?rigId=` — a scoped subscription
// silently drops the workflow spine since workflow.* events persist
// rig_id=NULL), and a workflow.* event invalidates the ["workflow"] family.

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useWorkflowSse, WORKFLOW_SSE_URL, __test_internals } from "../src/hooks/useWorkflowSse.js";

let constructedUrls: string[] = [];
let messageHandlers: Array<(event: { data: string }) => void> = [];

vi.stubGlobal(
  "EventSource",
  class MockEventSource {
    constructor(url: string) {
      constructedUrls.push(url);
    }
    addEventListener = vi.fn((event: string, handler: (e: { data: string }) => void) => {
      if (event === "message") messageHandlers.push(handler);
    });
    close = vi.fn();
  },
);

function wrapperWith(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
}

afterEach(() => {
  constructedUrls = [];
  messageHandlers = [];
  __test_internals.reset();
  cleanup();
});

describe("useWorkflowSse — Q5-P1 rig-unscoped primary feed", () => {
  it("subscribes to /api/workflow/sse with NO rigId scoping (unscoped by contract)", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    expect(constructedUrls).toContain("/api/workflow/sse");
    // The named negative: no subscription carrying workflow kinds ever scopes by rig.
    for (const url of constructedUrls) {
      expect(url).not.toContain("rigId");
      expect(url).not.toContain("?");
    }
    // The single source of the URL is the exported constant — unscoped, no query string.
    expect(WORKFLOW_SSE_URL).toBe("/api/workflow/sse");
    expect(WORKFLOW_SSE_URL).not.toContain("rigId");
  });

  it("invalidates the ['workflow'] query family on a workflow.* event", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: JSON.stringify({ type: "workflow.step_closed", instanceId: "01WFX" }) });
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["workflow"] });
  });

  it("ignores non-JSON heartbeats (no invalidation)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    renderHook(() => useWorkflowSse(), { wrapper: wrapperWith(qc) });

    act(() => {
      for (const handler of messageHandlers) {
        handler({ data: ": keep-alive heartbeat" });
      }
    });
    await new Promise((r) => setTimeout(r, 200));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
