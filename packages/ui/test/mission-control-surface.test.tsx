import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionControlSurface } from "../src/components/mission-control/MissionControlSurface.js";
import { CompactStatusRow } from "../src/components/mission-control/components/CompactStatusRow.js";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";
import { AuditHistoryView } from "../src/components/mission-control/views/AuditHistoryView.js";

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function renderSurface() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MissionControlSurface />
    </QueryClientProvider>,
  );
}

function renderWithQueryClient(element: React.ReactNode) {
  render(
    <QueryClientProvider client={queryClient()}>
      {element}
    </QueryClientProvider>,
  );
}

describe("MissionControlSurface", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        viewName: "my-queue",
        rows: [],
        meta: { rowCount: 0 },
      }),
    });
    window.localStorage.clear();
    window.history.replaceState(null, "", "/mission-control");
  });

  it("accounts for AppShell explorer offsets so tabs stay clickable", () => {
    renderSurface();

    const surface = screen.getByTestId("mc-surface");
    expect(surface.className).toContain("lg:pl-[var(--workspace-left-offset,0px)]");
    expect(surface.className).toContain("lg:pr-[var(--workspace-right-offset,0px)]");
    expect((screen.getByTestId("mc-tab-human-gate") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("mc-tab-fleet") as HTMLButtonElement).disabled).toBe(false);
  });

  it("stores mcToken from the URL for mobile write verbs and removes it from the address bar", async () => {
    window.history.replaceState(null, "", "/mission-control?mcToken=phone-token&view=human-gate&qitem=qitem-1");

    renderSurface();

    await waitFor(() => {
      expect(window.localStorage.getItem("openrig.missionControlBearerToken")).toBe("phone-token");
    });
    expect(window.location.search).not.toContain("mcToken");
    expect(window.location.search).toContain("view=human-gate");
    expect(window.location.search).toContain("qitem=qitem-1");
  });

  it("sends the stored bearer token on Mission Control write verbs", async () => {
    window.localStorage.setItem("openrig.missionControlBearerToken", "phone-token");
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        actionId: "action-1",
        verb: "approve",
        qitemId: "qitem-1",
        closedQitem: {},
        createdQitemId: null,
        notifyAttempted: false,
        notifyResult: null,
        auditedAt: "2026-05-04T00:00:00.000Z",
      }),
    });

    renderWithQueryClient(
      <VerbActions qitemId="qitem-1" actorSession="human-wrandom@kernel" enabledVerbs={["approve"]} />,
    );

    fireEvent.click(screen.getByTestId("mc-verb-approve"));
    fireEvent.click(screen.getByTestId("mc-verb-submit"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mission-control/action",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer phone-token",
          }),
        }),
      );
    });
  });

  it("shows qitem context and expands full details when a phone row is tapped", () => {
    render(
      <CompactStatusRow
        row={{
          rigOrMissionName: "human-wrandom@kernel",
          currentPhase: "human-gate",
          state: "idle",
          nextAction: null,
          pendingHumanDecision: "urgent human-gate item",
          readCost: "skim/approve",
          lastUpdate: "2026-05-04T06:43:48.863Z",
          confidenceFreshness: "urgent",
          evidenceLink: null,
          qitemId: "qitem-phone",
          rawSourceRef: "velocity.qa@openrig-velocity",
          qitemSummary: "Approve the release candidate",
          qitemBody: "Approve the release candidate after checking the phone notification path.",
        }}
      />,
    );

    expect(screen.getByTestId("mc-qitem-summary").textContent).toContain("Approve the release candidate");
    expect(screen.queryByTestId("mc-qitem-body")).toBeNull();

    fireEvent.click(screen.getByTestId("mc-status-row"));

    expect(screen.getByTestId("mc-qitem-body").textContent).toContain(
      "Approve the release candidate after checking the phone notification path.",
    );
    expect(screen.getByTestId("mc-qitem-id").textContent).toContain("qitem-phone");
    expect((screen.getByTestId("mc-qitem-audit-link") as HTMLAnchorElement).href).toContain(
      "/mission-control?view=audit-history&qitem_id=qitem-phone",
    );
  });

  it("prefills audit filters from URL params for phone deep links", async () => {
    window.history.replaceState(
      null,
      "",
      "/mission-control?view=audit-history&qitem_id=qitem-phone&action_verb=approve",
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        rows: [],
        hasMore: false,
        nextBeforeId: null,
      }),
    });

    renderWithQueryClient(<AuditHistoryView />);

    expect(screen.getByTestId("mc-audit-filter-qitem-id")).toHaveProperty("value", "qitem-phone");
    expect(screen.getByTestId("mc-audit-filter-action-verb")).toHaveProperty("value", "approve");
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/mission-control/audit?qitem_id=qitem-phone&action_verb=approve&limit=50",
      );
    });
  });
});
