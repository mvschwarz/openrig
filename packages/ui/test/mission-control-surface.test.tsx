import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissionControlSurface } from "../src/components/mission-control/MissionControlSurface.js";

globalThis.fetch = vi.fn(async () => ({
  ok: true,
  json: async () => ({
    viewName: "my-queue",
    rows: [],
    meta: { rowCount: 0 },
  }),
})) as unknown as typeof fetch;

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

describe("MissionControlSurface", () => {
  it("accounts for AppShell explorer offsets so tabs stay clickable", () => {
    renderSurface();

    const surface = screen.getByTestId("mc-surface");
    expect(surface.className).toContain("lg:pl-[var(--workspace-left-offset,0px)]");
    expect(surface.className).toContain("lg:pr-[var(--workspace-right-offset,0px)]");
    expect((screen.getByTestId("mc-tab-human-gate") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("mc-tab-fleet") as HTMLButtonElement).disabled).toBe(false);
  });
});
