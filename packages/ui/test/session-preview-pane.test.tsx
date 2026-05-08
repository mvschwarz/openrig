import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import { SessionPreviewPane } from "../src/components/preview/SessionPreviewPane.js";

const mockFetch = vi.fn();
let scrollHeightDescriptor: PropertyDescriptor | undefined;
let clientHeightDescriptor: PropertyDescriptor | undefined;

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function settingsResponse() {
  return {
    settings: {
      "ui.preview.refresh_interval_seconds": { value: 60, source: "default", defaultValue: 3 },
      "ui.preview.default_lines": { value: 50, source: "default", defaultValue: 50 },
    },
  };
}

describe("SessionPreviewPane", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 240 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 80 });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (scrollHeightDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", scrollHeightDescriptor);
    else delete (HTMLElement.prototype as { scrollHeight?: number }).scrollHeight;
    if (clientHeightDescriptor) Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeightDescriptor);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
  });

  it("scrolls terminal preview content to the bottom on mount", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config") return new Response(JSON.stringify(settingsResponse()));
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({
          sessionName: "driver@test-rig",
          content: "line 1\nline 2\nline 3\nline 4",
          lines: 4,
          capturedAt: "2026-05-07T08:00:00Z",
        }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    withQueryClient(<SessionPreviewPane sessionName="driver@test-rig" testIdPrefix="terminal-test" />);

    const content = await screen.findByTestId("terminal-test-content");
    await waitFor(() => {
      expect(content.scrollTop).toBe(240);
    });
  });

  it("renders compact terminal variant without metadata chrome", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config") return new Response(JSON.stringify(settingsResponse()));
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({
          sessionName: "driver@test-rig",
          content: "tail line",
          lines: 1,
          capturedAt: "2026-05-07T08:00:00Z",
        }));
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    withQueryClient(
      <SessionPreviewPane
        sessionName="driver@test-rig"
        testIdPrefix="compact-terminal-test"
        variant="compact-terminal"
      />,
    );

    const pane = await screen.findByTestId("compact-terminal-test-pane");
    const content = await screen.findByTestId("compact-terminal-test-content");

    expect(pane.getAttribute("data-variant")).toBe("compact-terminal");
    expect(content.className).toContain("text-[8px]");
    expect(content.className).toContain("text-stone-50");
    expect(screen.queryByText(/live preview/i)).toBeNull();
    expect(screen.queryByText(/captured/i)).toBeNull();
    expect(screen.queryByText(/1 lines/i)).toBeNull();
  });

  it("renders compact unavailable state without machine labels or fallback chrome", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config") return new Response(JSON.stringify(settingsResponse()));
      if (url.includes("/api/sessions/")) {
        return new Response(JSON.stringify({ error: "preview_unavailable" }), { status: 404 });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });

    withQueryClient(
      <SessionPreviewPane
        sessionName="driver@test-rig"
        testIdPrefix="compact-terminal-test"
        variant="compact-terminal"
      />,
    );

    const unavailable = await screen.findByTestId("compact-terminal-test-unavailable");

    expect(unavailable.className).toContain("text-stone-50");
    expect(unavailable.textContent).toContain("Preview unavailable.");
    expect(unavailable.textContent).toContain("$ waiting for terminal output");
    expect(unavailable.textContent).not.toContain("preview_unavailable");
    expect(unavailable.textContent).not.toContain("rig capture");
  });
});
