// AC-3: FocusedTerminal unavailable state surfaces honestly when
// the live terminal cannot connect (xterm import fails).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    open() { throw new Error("xterm unavailable in test"); }
    write() {}
    onData() {}
    onResize() {}
    dispose() {}
    loadAddon() {}
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class { fit() {} },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function withQueryClient(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("AC-3: FocusedTerminal unavailable in drill", () => {
  it("xterm init failure surfaces Terminal unavailable, no /preview fetch, no captured copy", async () => {
    const { FeedCardTerminalDrill } = await import("../src/components/for-you/FeedCardTerminalDrill.js");

    const { getByTestId } = withQueryClient(
      React.createElement(FeedCardTerminalDrill, { cardId: "ac3-1", sessionName: "dev-impl@my-rig" }),
    );

    fireEvent.click(getByTestId("feed-card-drill-ac3-1"));
    await waitFor(() => getByTestId("feed-card-drill-ac3-1-terminal-popover"));

    await waitFor(() => {
      const terminalEl = getByTestId("focused-terminal-dev-impl@my-rig");
      expect(terminalEl.textContent).toContain("Terminal unavailable");
    }, { timeout: 3000 });

    const previewCalls = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/preview"));
    expect(previewCalls).toHaveLength(0);

    const popover = getByTestId("feed-card-drill-ac3-1-terminal-popover");
    expect(popover.innerHTML).not.toContain("captured");
    expect(popover.innerHTML).not.toContain("snapshot");
  });
});
