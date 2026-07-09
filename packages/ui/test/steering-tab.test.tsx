// OPR.0.4.1.17 — Mission Steering tab. Panel 1 = STEERING.md projection via /api/steering;
// Panel 2 = MISSION_BRIEF.md projection (slice-16 pinned schema). Read-only. TDD against the
// 8 ACs incl. the projection rules (exact-header match, unknown-after-known, missing→dash).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SteeringTab } from "../src/components/project/SteeringTab.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const STEERING_PAYLOAD = {
  priorityStack: {
    content: "# Steering\n\nMode: observability-overhaul. LOCAL main only — no push.",
    absolutePath: "/Users/x/code/substrate/shared-docs/openrig-work/STEERING.md",
    mtime: "2026-06-23T08:00:00.000Z",
    byteCount: 84,
  },
  roadmapRail: null,
  laneRails: [],
  unavailableSources: [],
};

// Populated brief: 5 of 6 canonical sections (omits "## Pointers" → missing→dash) + an
// unknown "## Risks" (→ render AFTER the known sections, never dropped).
const BRIEF_MD = [
  "# release-0.4.1 — Brief",
  "_The workspace observability overhaul._",
  "",
  "## What & why",
  "Reshape the workspace UI around altitude + observability.",
  "",
  "## Building",
  "The Steering tab + Story DAG + Workflow viz.",
  "",
  "## Progress",
  "Wave A shipped; Wave B in flight.",
  "",
  "## Proven",
  "Twin renders 6 surfaces 1:1.",
  "",
  "## Needs you",
  "Review the design mockups.",
  "",
  "## Risks",
  "Creative-rig DAG timing.",
].join("\n");

interface RouteOpts {
  steering?: unknown;
  steeringStatus?: number;
  briefContent?: string | null;
}
function routeFetch(opts: RouteOpts = {}) {
  const { steering = STEERING_PAYLOAD, steeringStatus = 200, briefContent = BRIEF_MD } = opts;
  return (input: unknown) => {
    const url = String(input);
    // MH-2: the selection-known files gate needs the hosts payload (local).
    if (url.includes("/api/hosts")) {
      return Promise.resolve(jsonResponse({ ownName: "localhost", selected: "local", hosts: [] }));
    }
    if (url.includes("/api/steering")) {
      return Promise.resolve(
        jsonResponse(
          steeringStatus === 503 ? { error: "steering_workspace_not_configured", hint: "Set workspace.steering_path" } : steering,
          steeringStatus,
        ),
      );
    }
    if (url.includes("/api/missions/")) {
      return Promise.resolve(jsonResponse({ missionId: "release-0.4.1", missionPath: "/root/missions/release-0.4.1", slices: [] }));
    }
    if (url.includes("/api/files/roots")) {
      return Promise.resolve(jsonResponse({ roots: [{ name: "substrate", path: "/root" }] }));
    }
    if (url.includes("/api/files/read")) {
      if (briefContent === null) return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
      return Promise.resolve(jsonResponse({ content: briefContent, mtime: "2026-06-23T08:30:00.000Z", contentHash: "abc" }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  };
}

function renderTab(missionId: string | null = "release-0.4.1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <SteeringTab missionId={missionId} />
    </QueryClientProvider>,
  );
}

describe("OPR.0.4.1.17 — Steering tab", () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => cleanup());

  // --- Panel 1: STEERING.md ---
  it("AC-1: Panel 1 renders the STEERING.md content from /api/steering", async () => {
    mockFetch.mockImplementation(routeFetch());
    renderTab();
    await waitFor(() => expect(screen.getByTestId("steering-panel-content")).toBeTruthy());
    expect(screen.getByTestId("steering-panel-content").textContent).toContain("observability-overhaul");
  });

  it("AC-2: Panel 1 surfaces the source path + mtime (traceable-to-source)", async () => {
    mockFetch.mockImplementation(routeFetch());
    renderTab();
    await waitFor(() => expect(screen.getByTestId("steering-panel-source")).toBeTruthy());
    expect(screen.getByTestId("steering-panel-source").textContent).toContain("STEERING.md");
  });

  it("AC-3: the unavailable 503 sentinel renders a self-explanatory setup hint (no crash)", async () => {
    mockFetch.mockImplementation(routeFetch({ steeringStatus: 503 }));
    renderTab();
    await waitFor(() => expect(screen.getByTestId("steering-panel-unavailable")).toBeTruthy());
    expect(screen.getByTestId("steering-panel-unavailable").textContent).toContain("workspace.steering_path");
  });

  it("empty: priorityStack null renders the no-STEERING.md empty-state", async () => {
    mockFetch.mockImplementation(routeFetch({ steering: { ...STEERING_PAYLOAD, priorityStack: null } }));
    renderTab();
    await waitFor(() => expect(screen.getByTestId("steering-panel-empty")).toBeTruthy());
  });

  // --- Panel 2: MISSION_BRIEF.md (slice-16 contract) ---
  it("AC-4: Panel 2 renders the canonical brief sections with content", async () => {
    mockFetch.mockImplementation(routeFetch());
    renderTab();
    await waitFor(() => expect(screen.getByTestId("brief-panel-content")).toBeTruthy());
    const panel = screen.getByTestId("brief-panel-content");
    expect(panel.textContent).toContain("What & why");
    expect(panel.textContent).toContain("Reshape the workspace UI");
    expect(panel.textContent).toContain("Building");
    expect(panel.textContent).toContain("Needs you");
    expect(panel.textContent).toContain("Review the design mockups");
  });

  it("projection: a MISSING canonical section renders the header with a muted dash", async () => {
    mockFetch.mockImplementation(routeFetch()); // BRIEF_MD omits "## Pointers"
    renderTab();
    await waitFor(() => expect(screen.getByTestId("brief-panel-content")).toBeTruthy());
    expect(screen.getByTestId("brief-section-Pointers-dash")).toBeTruthy();
  });

  it("projection: an UNKNOWN section is preserved and rendered AFTER the known sections", async () => {
    mockFetch.mockImplementation(routeFetch());
    renderTab();
    await waitFor(() => expect(screen.getByTestId("brief-panel-content")).toBeTruthy());
    const html = screen.getByTestId("brief-panel-content").innerHTML;
    expect(html).toContain("Risks"); // unknown section not dropped
    expect(html.indexOf("Needs you")).toBeLessThan(html.indexOf("Risks")); // after the known ones
  });

  it("AC-5: with no MISSION_BRIEF.md, Panel 2 shows a self-explanatory empty-state", async () => {
    mockFetch.mockImplementation(routeFetch({ briefContent: null }));
    renderTab();
    await waitFor(() => expect(screen.getByTestId("brief-panel-empty")).toBeTruthy());
  });

  // --- layout ---
  it("AC-6: panels stack Steering ABOVE Brief", async () => {
    mockFetch.mockImplementation(routeFetch());
    renderTab();
    await waitFor(() => expect(screen.getByTestId("steering-panel-content")).toBeTruthy());
    const html = screen.getByTestId("steering-tab").innerHTML;
    expect(html.indexOf("steering-panel")).toBeLessThan(html.indexOf("brief-panel"));
  });
});
