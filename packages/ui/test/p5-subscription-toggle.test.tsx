// V1 attempt-3 Phase 5 P5-3 — Subscription toggle wiring (SC-29 allowlist
// exception same scope as Phase 4).
//
// Coverage:
//   - SubscriptionToggleList renders 5 rows; action_required is forced ON
//     (no toggle button; "forced ON" label).
//   - Toggle click → useSetSetting POSTs to /api/config/<key> with the
//     correct value.
//   - Feed filters cards by subscription state (audit_log OFF → no
//     observation cards rendered; turning audit_log ON surfaces them).
//   - Settings unavailable (legacy daemon) → defaults rendered + CLI hint.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  isCardKindSubscribed,
  type FeedSubscriptionState,
} from "../src/hooks/useFeedSubscriptions.js";
import { SubscriptionToggleList } from "../src/components/for-you/SubscriptionToggleList.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function settingsResponse(values: Partial<Record<string, string | boolean>>) {
  return {
    settings: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [
        k,
        { value: v, source: "default", defaultValue: v },
      ]),
    ),
  };
}

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

describe("isCardKindSubscribed (P5-3 filter contract)", () => {
  const state: FeedSubscriptionState = {
    actionRequired: true,
    approvals: true,
    shipped: false,
    progress: true,
    auditLog: false,
  };
  it("action-required cards always pass (forced ON)", () => {
    expect(isCardKindSubscribed("action-required", state)).toBe(true);
  });
  it("observation cards pass only when auditLog is ON", () => {
    expect(isCardKindSubscribed("observation", state)).toBe(false);
    expect(
      isCardKindSubscribed("observation", { ...state, auditLog: true }),
    ).toBe(true);
  });
  it("shipped cards pass only when shipped is ON", () => {
    expect(isCardKindSubscribed("shipped", state)).toBe(false);
    expect(isCardKindSubscribed("shipped", { ...state, shipped: true })).toBe(
      true,
    );
  });
});

describe("SubscriptionToggleList P5-3 wiring", () => {
  it("renders all 5 rows with action-required FORCED ON (no interactive button)", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/config")) {
        return new Response(
          JSON.stringify(
            settingsResponse({
              "feed.subscriptions.action_required": true,
              "feed.subscriptions.approvals": true,
              "feed.subscriptions.shipped": true,
              "feed.subscriptions.progress": true,
              "feed.subscriptions.audit_log": false,
            }),
          ),
        );
      }
      return new Response("[]");
    });
    const { findByTestId, queryByTestId, container } = withQueryClient(
      <SubscriptionToggleList />,
    );
    expect(await findByTestId("subscription-toggle-list")).toBeTruthy();
    // All 5 rows.
    expect(container.querySelector("[data-testid='subscription-toggle-action-required']")).toBeTruthy();
    expect(container.querySelector("[data-testid='subscription-toggle-approvals']")).toBeTruthy();
    expect(container.querySelector("[data-testid='subscription-toggle-shipped']")).toBeTruthy();
    expect(container.querySelector("[data-testid='subscription-toggle-progress']")).toBeTruthy();
    expect(container.querySelector("[data-testid='subscription-toggle-audit-log']")).toBeTruthy();
    // action-required is FORCED ON — no button.
    expect(queryByTestId("subscription-toggle-action-required-button")).toBeNull();
    // Other 4 are interactive (have buttons).
    expect(container.querySelector("[data-testid='subscription-toggle-approvals-button']")).toBeTruthy();
  });

  it("toggle click POSTs to /api/config/<key> with flipped value", async () => {
    let postedKey = "";
    let postedBody = "";
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      // POST to /api/config/<key> takes precedence over GET /api/config.
      const postMatch = url.match(/\/api\/config\/(.+)/);
      if (postMatch && init?.method === "POST") {
        postedKey = decodeURIComponent(postMatch[1]!);
        postedBody = (init?.body as string) ?? "";
        return new Response(
          JSON.stringify({ ok: true, resolved: { value: true, source: "file", defaultValue: false } }),
        );
      }
      if (url.endsWith("/api/config")) {
        return new Response(
          JSON.stringify(
            settingsResponse({
              "feed.subscriptions.audit_log": false,
            }),
          ),
        );
      }
      return new Response("[]");
    });
    const { findByTestId } = withQueryClient(<SubscriptionToggleList />);
    // Wait for the button to be enabled (settings resolved → unavailable=false).
    const auditButton = await waitFor(async () => {
      const btn = await findByTestId("subscription-toggle-audit-log-button");
      if ((btn as HTMLButtonElement).disabled) {
        throw new Error("button still disabled");
      }
      return btn;
    });
    fireEvent.click(auditButton);
    await waitFor(() => {
      expect(postedKey).toBe("feed.subscriptions.audit_log");
    });
    // Was off → toggling sets to "true".
    expect(postedBody).toContain("true");
  });

  it("settings unavailable (legacy daemon) renders defaults + CLI hint", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/config")) {
        return new Response("not implemented", { status: 404 });
      }
      return new Response("[]");
    });
    const { findByTestId } = withQueryClient(<SubscriptionToggleList />);
    expect(await findByTestId("subscription-toggle-unavailable")).toBeTruthy();
    // Defaults visible: action_required ON, audit_log OFF.
    expect(
      (await findByTestId("subscription-toggle-action-required")).getAttribute(
        "data-on",
      ),
    ).toBe("true");
    expect(
      (await findByTestId("subscription-toggle-audit-log")).getAttribute(
        "data-on",
      ),
    ).toBe("false");
  });
});
