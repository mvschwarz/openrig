// R1 (release-0.4.7) — C4b: SteeringTab BriefPanel copy mapping per useScopeMarkdown state.
//
// The BriefPanel keeps its remote-gate FIRST (unchanged) and its `NO BRIEF YET`
// absent copy byte-identical; a read failure and a mis-rooted mission path now
// get honest copies inserted between the loading and absent branches.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SteeringTab } from "../src/components/project/SteeringTab.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// options: host = "local" | "remote", roots contain the mission path or not,
// briefStatus = read status for MISSION_BRIEF.md
function install(opts: { host?: string; rootPath?: string; briefStatus?: number }) {
  const host = opts.host ?? "local";
  const rootPath = opts.rootPath ?? "/ws";
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/hosts")) return json({ ownName: "localhost", selected: host, hosts: [] });
    const m = url.match(/\/api\/missions\/([^/?]+)/);
    if (m) return json({ missionId: decodeURIComponent(m[1]!), missionPath: "/ws/missions/m", slices: [], workflow_spec: null, topology: null });
    if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: rootPath }] });
    if (url.includes("/api/files/read")) return json({ error: "x" }, opts.briefStatus ?? 404);
    return json([]);
  });
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4b — SteeringTab BriefPanel honest copy", () => {
  it("read_error → BRIEF READ FAILED (local, read 500)", async () => {
    install({ host: "local", briefStatus: 500 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-read-error-state");
    expect(el.textContent).toContain("BRIEF READ FAILED");
    expect(el.textContent).toContain("this is a read failure, not a missing brief");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
  });

  it("unresolved → BRIEF OUTSIDE FILE ROOTS (local, mission path outside roots)", async () => {
    install({ host: "local", rootPath: "/elsewhere" });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-unresolved-state");
    expect(el.textContent).toContain("BRIEF OUTSIDE FILE ROOTS");
    expect(el.textContent).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
  });

  it("absent (404) → NO BRIEF YET, BYTE-IDENTICAL to 8250d702", async () => {
    install({ host: "local", briefStatus: 404 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-empty-state");
    expect(el.textContent).toContain("NO BRIEF YET");
    expect(el.textContent).toContain(
      "No MISSION_BRIEF.md at the mission root. The human-facing brief (what we're building · how far · what's proven · what needs you) projects here once the mission is briefed.",
    );
  });

  it("known-remote → remote gate fires FIRST (LOCAL FILES NOT SHOWN), never the absent copy", async () => {
    install({ host: "remote-host", briefStatus: 404 });
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><SteeringTab missionId="m" /></QueryClientProvider>);
    const el = await screen.findByTestId("brief-panel-remote-gated-state");
    expect(el.textContent).toContain("LOCAL FILES NOT SHOWN");
    expect(screen.queryByTestId("brief-panel-empty-state")).toBeNull();
    expect(screen.queryByTestId("brief-panel-read-error-state")).toBeNull();
  });
});
