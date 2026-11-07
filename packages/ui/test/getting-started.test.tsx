// C15: Getting started card — shows with empty ps; hidden with one ps entry;
// Dismiss hides it and persists across remount. Cache seeded via setQueryData
// using the hooks' exact keys (no fetch mocking).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { renderDashboard as renderWithClient } from "./helpers/dashboard-harness.js";
import { GETTING_STARTED_DISMISSED_KEY } from "../src/components/dashboard/GettingStarted.js";

const PS_ONE = [
  { rigId: "rig_alpha", name: "acme-build", nodeCount: 11, runningCount: 11, activeCount: 6, hasWorkCount: 3, status: "running", uptime: "4h 12m", latestSnapshot: "2025-09-01T01:40:00Z" },
];

const RIG_SPECS = [
  { id: "spec-1", kind: "rig", name: "acme-build", version: "1", sourceType: "builtin", sourcePath: "/x", relativePath: "x", updatedAt: "2026-01-01T00:00:00Z" },
];

const EMPTY_ATTENTION = { items: [], hosts: [] };

function seed(qc: QueryClient, ps: unknown, library: unknown) {
  const entries: Array<[unknown[], unknown]> = [
    [["hosts"], { ownName: "localhost", selected: "local", hosts: [] }],
    [["ps", "local"], ps],
    [["attention-items", 50, false], EMPTY_ATTENTION],
    [["settings", "all"], { settings: {} }],
    [["kernel", "status"], { state: "skipped" }],
    [["daemon", "health"], { status: "ok" }],
    [["spec-library", "all", "local"], library],
  ];
  for (const [key, value] of entries) {
    qc.setQueryData(key, value);
  }
}

vi.mock("../src/components/mission-control/components/VerbActions.js", () => ({
  VerbActions: ({ qitemId }: { qitemId: string }) => <button type="button">Approve {qitemId}</button>,
}));

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).includes("/healthz")) {
        return { ok: true, json: async () => ({ status: "ok" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
});

describe("Getting started (C15)", () => {
  it("shows with empty ps, with the title and all four steps", async () => {
    renderWithClient((qc) => seed(qc, [], []));
    const card = await screen.findByTestId("getting-started");
    expect(card.textContent).toContain("Get started with OpenRig");
    expect(card.textContent).toContain("Connect to the daemon");
    expect(card.textContent).toContain("Add a rig spec");
    expect(card.textContent).toContain("Launch your first rig");
    expect(card.textContent).toContain("Check your inbox");
    expect(card.textContent).toContain("Open library");
    expect(card.textContent).toContain("New rig");
    expect(card.textContent).toContain("Open inbox");
    expect(card.textContent).toContain("Dismiss");
  });

  it("hidden with one ps entry", async () => {
    renderWithClient((qc) => seed(qc, PS_ONE, RIG_SPECS));
    // Let the dashboard settle, then assert the card is absent.
    await screen.findByText("What's running, and what needs you.");
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("Dismiss hides it and persists across remount", async () => {
    const seedEmpty = (qc: QueryClient) => seed(qc, [], []);
    const { unmount } = renderWithClient(seedEmpty);
    const card = await screen.findByTestId("getting-started");
    expect(card).toBeTruthy();
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByTestId("getting-started")).toBeNull();
    expect(window.localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe("1");
    unmount();
    cleanup();
    renderWithClient(seedEmpty);
    await screen.findByText("What's running, and what needs you.");
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("marks the daemon step done when health is Healthy", async () => {
    renderWithClient((qc) => seed(qc, [], []));
    const card = await screen.findByTestId("getting-started");
    // The /healthz stub returns ok with no eventLoop evidence → isSuccess →
    // daemonStatus label "Healthy" once the query settles.
    await screen.findByText("Connect to the daemon");
    // Library and ps are empty in this fixture, so the daemon step is the
    // only one that can show the done glyph.
    await waitFor(() => expect(card.textContent).toContain("✓"));
  });
});
