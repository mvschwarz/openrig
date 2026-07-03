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

    const pane = await screen.findByTestId("terminal-test-pane");
    const content = await screen.findByTestId("terminal-test-content");
    expect(pane.className).toContain("bg-surface-lowest/[0.08]");
    expect(pane.className).not.toContain("bg-surface-lowest/8");
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
    expect(content.className).toContain("text-stone-50");
    // OPR.0.4.0.39 (founder spec): the compact static renders at the LIVE xterm
    // geometry (same font, fixed 90-col width) so static and live are the SAME
    // shape under the shared ScaleToFitTerminal. Font + width are inline (mirror the
    // live exactly), not utility classes.
    expect(content.style.fontSize).toBe("12px");
    expect(content.style.width).toBe("90ch");
    expect(content.style.fontFamily).toContain("ui-monospace");
    expect(content.className).not.toContain("text-[8px]");
    // OPR.0.4.0.39 FR-5: the tmux capture is already pane-width-wrapped, so the
    // static <pre> uses whitespace-pre (no re-wrap, mirroring the live fixed-
    // geometry xterm) - NOT whitespace-pre-wrap/break-words (which double-wrapped).
    expect(content.className).toContain("whitespace-pre");
    expect(content.className).not.toContain("whitespace-pre-wrap");
    expect(content.className).not.toContain("break-words");
    // OPR.0.4.0.39 FR-1 (founder spec-correction): the static content is translucent
    // smoked-GLASS (bg-transparent; the SMOKED_STATIC_PLATE_CLASS plate shows
    // through). Opaque #0c0a09 is the LIVE xterm only; the glass->opaque flip on
    // click-to-live is the static-vs-live activation affordance.
    expect(content.className).toContain("bg-transparent");
    expect(content.className).not.toContain("bg-[#0c0a09]");
    expect(content.className).toContain("scrollbar-none");
    expect(content.className).not.toContain("break-all");
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
