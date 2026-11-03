// C10: useAllAgents merges per-rig node inventory, filtering infrastructure.
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useAllAgents } from "../src/hooks/useAllAgents.js";

const ALPHA = [
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "lead.coordinator", podId: "pod_lead", canonicalSessionName: "coordinator@acme-build", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: null, resumeCommand: null, latestError: null },
  { rigId: "rig_alpha", rigName: "acme-build", logicalId: "infra.lb", podId: "pod_infra", canonicalSessionName: null, nodeKind: "infrastructure", runtime: null, sessionStatus: null, startupStatus: null, restoreOutcome: "clean", tmuxAttachCommand: null, resumeCommand: null, latestError: null },
];
const BRAVO = [
  { rigId: "rig_bravo", rigName: "acme-comms", logicalId: "comms.writer", podId: "pod_c", canonicalSessionName: "writer@acme-comms", nodeKind: "agent", runtime: "codex", sessionStatus: "running", startupStatus: "ready", restoreOutcome: "clean", tmuxAttachCommand: null, resumeCommand: null, latestError: null },
];

function mockFetch() {
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    const json = async () => {
      if (u.includes("/api/ps")) {
        return [
          { rigId: "rig_alpha", name: "acme-build", nodeCount: 2, runningCount: 1, activeCount: 1, hasWorkCount: 0, status: "running", uptime: "1h", latestSnapshot: null },
          { rigId: "rig_bravo", name: "acme-comms", nodeCount: 1, runningCount: 1, activeCount: 1, hasWorkCount: 0, status: "running", uptime: "2h", latestSnapshot: null },
        ];
      }
      if (u.includes("/api/rigs/rig_alpha/nodes")) return ALPHA;
      if (u.includes("/api/rigs/rig_bravo/nodes")) return BRAVO;
      if (u.includes("/api/hosts")) return { ownName: "localhost", selected: "local", hosts: [] };
      throw new Error(`unexpected fetch ${u}`);
    };
    return { ok: true, json } as Response;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
  return function W({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  };
}

describe("useAllAgents (C10)", () => {
  it("merges agent rows across rigs and filters out infrastructure", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const { result } = renderHook(() => useAllAgents(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.agents.map((a) => a.logicalId).sort()).toEqual([
      "comms.writer",
      "lead.coordinator",
    ]);
  });
});
