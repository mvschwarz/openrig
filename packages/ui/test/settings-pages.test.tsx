// Slice 26 Checkpoint B — Settings sub-route page tests.
// Covers PoliciesPage (empty scaffold) + LogPage + StatusPage +
// SettingsCenter refactor verification (HG-7: top-row tabs removed).

import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { PoliciesPage } from "../src/components/system/PoliciesPage.js";
import { SettingsCenter } from "../src/components/system/SettingsCenter.js";

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
});

// useActivityFeed + useSettings have hook surfaces we don't want to
// wire up for these focused page-render tests. Stub them.
vi.mock("../src/hooks/useActivityFeed.js", () => ({
  useActivityFeed: () => ({ events: [] }),
}));
vi.mock("../src/hooks/useSettings.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useSettings: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock("../src/hooks/useConfig.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    useConfig: () => ({ data: { keys: [] }, isLoading: false }),
  };
});

describe("PoliciesPage (HG-5: empty-state placeholder)", () => {
  it("renders Policies title chrome", () => {
    render(<PoliciesPage />);
    expect(screen.getByTestId("settings-page-policies")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /policies/i })).toBeTruthy();
  });

  it("renders empty-state placeholder mentioning future slice 27 wire", () => {
    render(<PoliciesPage />);
    const empty = screen.getByTestId("policies-empty-state");
    expect(empty).toBeTruthy();
    // Empty-state copy mentions compaction policy (per dispatch + README §3.5)
    expect(empty.textContent?.toLowerCase()).toMatch(/compaction|policy|policies/i);
  });
});

describe("SettingsCenter refactor (HG-7: top-row tabs removed)", () => {
  it("renders Settings page chrome", () => {
    render(
      <Wrapper>
        <SettingsCenter />
      </Wrapper>,
    );
    expect(screen.getByTestId("settings-center")).toBeTruthy();
  });

  it("does NOT render the legacy top-row tab navigation (HG-7 discriminator)", () => {
    render(
      <Wrapper>
        <SettingsCenter />
      </Wrapper>,
    );
    // Top-row tab nav had testid="settings-tab-nav"; must be gone post
    // refactor.
    expect(screen.queryByTestId("settings-tab-nav")).toBeNull();
    // Per-tab testids must also be gone.
    expect(screen.queryByTestId("settings-tab-settings")).toBeNull();
    expect(screen.queryByTestId("settings-tab-log")).toBeNull();
    expect(screen.queryByTestId("settings-tab-status")).toBeNull();
    // role=tablist on the page-level chrome is also gone.
    const tablists = screen.queryAllByRole("tablist");
    // SettingsTab (the config keys form) may itself contain
    // sub-tablists; gate the assertion to "no tablist labeled
    // 'Settings sections'" which was the legacy top-row label.
    for (const tl of tablists) {
      expect(tl.getAttribute("aria-label")).not.toBe("Settings sections");
    }
  });
});
