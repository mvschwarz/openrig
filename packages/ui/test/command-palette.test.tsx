// ui-redesign C08: command palette + g-then-key shortcuts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor, cleanup } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { AppShell } from "../src/components/AppShell.js";
import type { ReactNode } from "react";

const SEARCH_PLACEHOLDER = "Search pages, rigs, actions…";

const RIGS = [
  {
    id: "rig_alpha",
    name: "acme-build",
    nodeCount: 2,
    hasServices: false,
    latestSnapshotAt: null,
    latestSnapshotId: null,
    lifecycleState: "running",
  },
];

let OriginalEventSource: typeof EventSource | undefined;

function installFetch() {
  const mockFetch = vi.fn();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify(RIGS));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    return new Response("[]");
  });
  globalThis.fetch = mockFetch;
}

function renderAt(initialPath: string, homeExtra?: ReactNode) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [
        {
          path: "/",
          component: () => (
            <div data-testid="page-home">
              home
              {homeExtra}
            </div>
          ),
        },
        { path: "/topology", component: () => <div data-testid="page-topology">topology</div> },
        { path: "/for-you", component: () => <div data-testid="page-for-you">for-you</div> },
      ],
      initialPath,
      rootComponent: ({ children }) => (AppShell({ children }) as ReactNode),
    }),
  );
  return result;
}

beforeEach(async () => {
  installFetch();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024, writable: true });
  window.dispatchEvent(new Event("resize"));
});

async function openPalette() {
  const { container } = renderAt("/");
  await waitFor(
    () => {
      if (!container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail yet");
    },
    { timeout: 5000 },
  );
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  const input = await screen.findByPlaceholderText(SEARCH_PLACEHOLDER);
  return { container, input: input as HTMLInputElement };
}

describe("Command palette (C08)", () => {
  it("⌘K opens the palette with the search input", async () => {
    await openPalette();
    expect(screen.getByTestId("command-palette")).toBeTruthy();
    expect(screen.getByPlaceholderText(SEARCH_PLACEHOLDER)).toBeTruthy();
  });

  // F8 (#2417): the cmdk dialog overlay + content carry theme classes
  // (cmdk ships unstyled — without these the palette is unpositioned).
  // NOTE: cmdk Dialog portals to document.body, outside the RTL container.
  it("palette dialog renders themed overlay and content classes", async () => {
    await openPalette();
    const palette = screen.getByTestId("command-palette");
    const content = palette.closest("[role='dialog']") as HTMLElement | null;
    expect(content?.className).toContain("cmdk-content");
    const overlay = document.body.querySelector(".cmdk-overlay");
    expect(overlay).toBeTruthy();
    // Inner command elements carry their theme classes too.
    expect(palette.querySelector(".cmdk-input")).toBeTruthy();
    expect(palette.querySelector(".cmdk-list")).toBeTruthy();
    expect(palette.querySelectorAll(".cmdk-item").length).toBeGreaterThan(0);
  });

  it("typing topology shows Rigs in the Go to group", async () => {
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: "topology" } });
    const palette = screen.getByTestId("command-palette");
    expect(within(palette).getByText("Go to")).toBeTruthy();
    expect(within(palette).getAllByText("Rigs").length).toBeGreaterThanOrEqual(1);
    expect(within(palette).queryByText("Inbox")).toBeNull();
  });

  it("Enter on the filtered Rigs item navigates to /topology", async () => {
    const { input } = await openPalette();
    fireEvent.change(input, { target: { value: "topology" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(await screen.findByTestId("page-topology", undefined, { timeout: 5000 })).toBeTruthy();
  });

  it("Escape closes the palette", async () => {
    await openPalette();
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).not.toBeNull();
    fireEvent.keyDown(screen.getByTestId("command-palette"), { key: "Escape" });
    await waitFor(() => {
      if (screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)) throw new Error("still open");
    });
  });

  it("openrig:open-palette event opens the palette", async () => {
    const { container } = renderAt("/");
    await waitFor(
      () => {
        if (!container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail yet");
      },
      { timeout: 5000 },
    );
    window.dispatchEvent(new CustomEvent("openrig:open-palette"));
    expect(await screen.findByPlaceholderText(SEARCH_PLACEHOLDER)).toBeTruthy();
  });

  it("g then i navigates to /for-you", async () => {
    const { container } = renderAt("/");
    await waitFor(
      () => {
        if (!container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail yet");
      },
      { timeout: 5000 },
    );
    fireEvent.keyDown(window, { key: "g" });
    fireEvent.keyDown(window, { key: "i" });
    expect(await screen.findByTestId("page-for-you", undefined, { timeout: 5000 })).toBeTruthy();
  });

  it("g then i while focus is in an input does nothing", async () => {
    const { container } = renderAt(
      "/",
      <input data-testid="probe-input" defaultValue="" />,
    );
    await waitFor(
      () => {
        if (!container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail yet");
      },
      { timeout: 5000 },
    );
    const probe = screen.getByTestId("probe-input") as HTMLInputElement;
    probe.focus();
    fireEvent.keyDown(probe, { key: "g" });
    fireEvent.keyDown(probe, { key: "i" });
    expect(screen.getByTestId("page-home")).toBeTruthy();
    expect(screen.queryByTestId("page-for-you")).toBeNull();
    expect(screen.queryByPlaceholderText(SEARCH_PLACEHOLDER)).toBeNull();
  });
});
