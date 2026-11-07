import { vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createMockEventSourceClass } from "../../helpers/mock-event-source.js";
import { createAppTestRouter } from "../../helpers/test-router.js";
import { AppShell } from "../../../src/components/AppShell.js";
import type { ReactNode } from "react";

export const MOCK_RIGS = [
  {
    id: "rig_alpha",
    name: "acme-build",
    nodeCount: 3,
    hasServices: true,
    latestSnapshotAt: "2026-11-06T12:00:00Z",
    latestSnapshotId: "snap-001",
    lifecycleState: "running",
  },
  {
    id: "rig_beta",
    name: "data-pipeline",
    nodeCount: 2,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "stopped",
  },
  {
    id: "rig_gamma",
    name: "review-bot",
    nodeCount: 1,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "failed",
  },
];

export const MOCK_PS_ENTRIES = [
  {
    rigId: "rig_alpha",
    rigName: "acme-build",
    nodeName: "builder",
    logicalId: "dev.builder",
    role: "builder",
    status: "running",
    agentActivity: { state: "running", reason: "compiling", evidence: "running" },
    activeQitems: 1,
  },
  {
    rigId: "rig_alpha",
    rigName: "acme-build",
    nodeName: "tester",
    logicalId: "dev.tester",
    role: "tester",
    status: "running",
    agentActivity: { state: "idle", reason: "waiting", evidence: "idle" },
    activeQitems: 0,
  },
];

export const MOCK_ATTENTION_ITEMS = [
  {
    qitemId: "qitem-101",
    hostId: "local",
    summary: "Approve deployment to staging environment",
    sourceSession: "operator@local",
    createdAt: "2026-11-06T14:00:00Z",
    urgency: "high",
  },
  {
    qitemId: "qitem-102",
    hostId: "local",
    summary: "Permission requested: access database snapshot",
    sourceSession: "builder@local",
    createdAt: "2026-11-06T13:30:00Z",
    urgency: "medium",
  },
];

export const MOCK_AGENT_DETAIL = {
  rigId: "rig_alpha",
  rigName: "acme-build",
  logicalId: "dev.builder",
  podId: "dev",
  canonicalSessionName: "builder@acme-build",
  nodeKind: "agent",
  runtime: "claude-code",
  sessionStatus: "running",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t builder@acme-build",
  resumeCommand: null,
  recoveryGuidance: null,
  latestError: null,
  model: "claude-3-7-sonnet",
  agentRef: "local:agents/builder",
  profile: "default",
  resolvedSpecName: "builder",
  resolvedSpecVersion: "2.1.0",
  cwd: "/workspace/acme-build",
  startupFiles: [],
  startupActions: [],
  recentEvents: [],
  infrastructureStartupCommand: null,
  peers: [],
  edges: { outgoing: [], incoming: [] },
  transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: "builder", version: "2.1.0", profile: "default", skillCount: 4, guidanceCount: 2 },
  agentActivity: {
    state: "running",
    reason: "compiling",
    evidenceSource: "runtime_hook",
    sampledAt: "2026-11-06T14:05:00Z",
    evidence: "compiling",
  },
  currentQitems: [
    {
      qitemId: "qitem-101",
      bodyExcerpt: "Compile release package for production audit.",
      tier: "mode-2",
    },
  ],
  contextUsage: {
    availability: "known",
    usedPercentage: 64,
    remainingPercentage: 36,
    contextWindowSize: 200000,
    sampledAt: "2026-11-06T14:05:00Z",
    fresh: true,
    totalInputTokens: 110000,
    totalOutputTokens: 18000,
  },
};

export const mockFetch = vi.fn();
let OriginalEventSource: typeof EventSource | undefined;

export function setupE2EEnv() {
  beforeEach(async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/rigs/summary")) {
        return new Response(JSON.stringify(MOCK_RIGS), { headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/rigs/ps")) {
        return new Response(JSON.stringify(MOCK_PS_ENTRIES), { headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/queue/attention-aggregate")) {
        return new Response(JSON.stringify({ items: MOCK_ATTENTION_ITEMS, hosts: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/queue/list") || url.includes("/api/attention")) {
        return new Response(JSON.stringify(MOCK_ATTENTION_ITEMS), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/specs/library")) {
        return new Response(JSON.stringify([{ kind: "rig", name: "default-rig" }]), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/hosts")) {
        return new Response(JSON.stringify({ selected: "local", hosts: [{ id: "local", name: "Local Host" }] }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/node/")) {
        return new Response(JSON.stringify(MOCK_AGENT_DETAIL), { headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/healthz") || url.includes("/healthz")) {
        return new Response(JSON.stringify({ status: "healthy", version: "0.7.1" }), {
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });

    globalThis.fetch = mockFetch;
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;

    const { queryClient } = await import("../../../src/lib/query-client.js");
    queryClient.clear();
  });

  afterEach(() => {
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
    window.localStorage.clear();
    cleanup();
    setViewportWidth(1440);
  });
}

export function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width, writable: true });
  window.dispatchEvent(new Event("resize"));
}

export async function renderE2EAppAt(
  initialPath: string,
  opts: {
    innerWidth?: number;
    extraRoutes?: Array<{ path: string; component: () => ReactNode }>;
    mockRigs?: typeof MOCK_RIGS;
  } = {},
) {
  setViewportWidth(opts.innerWidth ?? 1440);

  const defaultRoutes = [
    { path: "/", component: () => <div data-testid="page-dashboard">Dashboard Page</div> },
    { path: "/for-you", component: () => <div data-testid="page-inbox">Inbox Page</div> },
    { path: "/topology", component: () => <div data-testid="page-topology">Topology Rigs Page</div> },
    { path: "/topology/rig/$rigId", component: () => <div data-testid="page-rig-detail">Rig Detail Page</div> },
    { path: "/topology/seat/$rigId/$logicalId", component: () => <div data-testid="page-seat-detail">Seat Detail Page</div> },
    { path: "/agents", component: () => <div data-testid="page-agents">Agents Page</div> },
    { path: "/fleet", component: () => <div data-testid="page-fleet">Fleet Hosts Page</div> },
    { path: "/project", component: () => <div data-testid="page-project">Project Page</div> },
    { path: "/workflows", component: () => <div data-testid="page-workflows">Workflows Page</div> },
    { path: "/files", component: () => <div data-testid="page-files">Files Page</div> },
    { path: "/specs", component: () => <div data-testid="page-specs">Specs Library Page</div> },
    { path: "/specs/skills", component: () => <div data-testid="page-specs-skills">Skills Page</div> },
    { path: "/settings", component: () => <div data-testid="page-settings">Settings Page</div> },
    { path: "/settings/status", component: () => <div data-testid="page-settings-status">System Status Page</div> },
    ...(opts.extraRoutes ?? []),
  ];

  const result = render(
    createAppTestRouter({
      routes: defaultRoutes,
      initialPath,
      rootComponent: ({ children }) => AppShell({ children }) as ReactNode,
    }),
  );

  // Wait for shell chrome to land
  const isMobile = (opts.innerWidth ?? 1440) < 1024;
  await waitFor(
    () => {
      if (isMobile) {
        if (!result.container.querySelector("[data-testid='mobile-bottom-nav']")) {
          throw new Error("no mobile-bottom-nav rendered");
        }
      } else {
        if (!result.container.querySelector("[data-testid='app-rail']")) {
          throw new Error("no app-rail rendered");
        }
      }
    },
    { timeout: 5000 },
  );

  return result;
}
