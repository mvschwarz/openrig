// R1 (release-0.4.7) — C4c req-5 (+ v1.2 gate fix): the mission PROGRESS panel's
// remote-gate. A KNOWN-remote selection shows the honest "LOCAL FILES NOT SHOWN"
// notice instead of masquerading as a local absence; an UNKNOWN selection (the
// local cold-start window) must NOT flash that notice — it falls through to the
// loading/absence treatment. Gate = `hostSelectionKnown && !hostIsLocal`.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { MissionScopePage } from "../src/components/project/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// hosts: "local" | "remote-host" | "unknown" (unknown ⇒ /api/hosts errors ⇒
// useHosts data undefined ⇒ hostSelectionKnown=false).
function install(hostMode: "local" | "remote-host" | "unknown") {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/hosts")) {
      if (hostMode === "unknown") return json({ error: "down" }, 500);
      return json({ ownName: "localhost", selected: hostMode, hosts: [] });
    }
    if (url.includes("/api/slices")) return json({ slices: [], totalCount: 0, filter: "all" });
    const m = url.match(/\/api\/missions\/([^/?]+)/);
    if (m) return json({ missionId: decodeURIComponent(m[1]!), missionPath: "/ws/missions/m", slices: [], workflow_spec: null, topology: null });
    if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
    if (url.includes("/api/files/read")) return json({ error: "not found" }, 404); // genuine local absence
    return json({}, 404); // scope-audit + everything else ⇒ data undefined (skips rail branch)
  });
}

function renderMissionProgress() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: () => <MissionScopePage /> });
  const router = createRouter({
    routeTree: rootRoute.addChildren([missionRoute]),
    history: createMemoryHistory({ initialEntries: ["/project/mission/m"] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

async function openProgressTab() {
  renderMissionProgress();
  const tab = await screen.findByTestId("project-tab-progress");
  fireEvent.click(tab);
  await waitFor(() => expect(screen.getByTestId("mission-progress-panel")).toBeTruthy());
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4c — mission PROGRESS remote-gate (req-5, v1.2 known-remote-only)", () => {
  it("KNOWN-remote → LOCAL FILES NOT SHOWN, NOT 'NO PROGRESS YET', and zero /api/files/read", async () => {
    install("remote-host");
    await openProgressTab();
    const el = await screen.findByTestId("mission-progress-remote-gated");
    expect(el.textContent).toContain("Local files not shown");
    expect(screen.queryByTestId("mission-progress-empty")).toBeNull();
    // remote gates the local read at the data level (null path) ⇒ no read fires
    const reads = mockFetch.mock.calls.filter(([u]) => String(u).includes("/api/files/read"));
    expect(reads).toEqual([]);
  });

  it("UNKNOWN selection (cold-start) → does NOT flash the gated notice (v1.2 fix)", async () => {
    install("unknown");
    await openProgressTab();
    // the misleading gated flash must never appear during the unknown window
    await waitFor(() =>
      expect(screen.queryByTestId("mission-progress-empty") ?? screen.queryByTestId("mission-progress-panel")).toBeTruthy(),
    );
    expect(screen.queryByTestId("mission-progress-remote-gated")).toBeNull();
  });

  it("LOCAL + genuinely-absent PROGRESS.md → NO PROGRESS YET, never the gated notice", async () => {
    install("local");
    await openProgressTab();
    const el = await screen.findByTestId("mission-progress-empty");
    expect(el.textContent).toContain("NO PROGRESS YET");
    expect(screen.queryByTestId("mission-progress-remote-gated")).toBeNull();
  });
});
