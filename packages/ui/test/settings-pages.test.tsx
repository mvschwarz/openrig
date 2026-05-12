// Slice 26 Checkpoint B — Settings page tests.
// Covers PoliciesPage (HG-5 empty-state) + SettingsCenter refactor
// (HG-7 top-row tabs removed discriminator). LogPage + StatusPage
// route mounts are verified by static route registration in routes.tsx
// + structural inspection; their component-level rendering is QA
// walk scope (operator clicks /settings/log + /settings/status on the
// founder-walk VM).

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

describe("PoliciesPage (Claude auto-compaction form)", () => {
  it("renders Policies title chrome", () => {
    render(
      <Wrapper>
        <PoliciesPage />
      </Wrapper>,
    );
    expect(screen.getByTestId("settings-page-policies")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /policies/i })).toBeTruthy();
  });

  it("renders operator-facing intro copy (no slice/release internals)", () => {
    render(
      <Wrapper>
        <PoliciesPage />
      </Wrapper>,
    );
    const page = screen.getByTestId("settings-page-policies");
    // Intro paragraph mentions policy/policies + opt-in default-off framing
    expect(page.textContent?.toLowerCase()).toMatch(/policy|policies/i);
    // No internal-release references in user-facing UI copy (per
    // velocity-guard 26.B carry-forward concern: slice-number tokens
    // are implementation detail; should not leak into product UI).
    expect(page.textContent).not.toMatch(/slice\s*\d+/i);
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
