import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MissionControlSurface } from "../src/components/mission-control/MissionControlSurface.js";
import { VerbActions } from "../src/components/mission-control/components/VerbActions.js";

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
});
