import { vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createMockEventSourceClass } from "./mock-event-source.js";
import { createAppTestRouter } from "./test-router.js";
import type { ReactNode } from "react";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

/** Renders AppShell chrome at a path and waits for the sidebar to land. */
export async function renderAppShellAt(
  RootShell: (props: { children: ReactNode }) => ReactNode,
  initialPath: string,
  opts: { innerWidth?: number } = {},
) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: opts.innerWidth ?? 1440, writable: true });
  window.dispatchEvent(new Event("resize"));
  const result = render(
    createAppTestRouter({
      routes: [{ path: "$", component: () => null }],
      rootComponent: ({ children }) => RootShell({ children }) as ReactNode,
      initialPath,
    }),
  );
  // TanStack Router resolves route component async; wait for chrome to land.
  await waitFor(() => {
    if (!result.container.querySelector("[data-testid='app-rail']")) throw new Error("no app-rail yet");
  }, { timeout: 5000 });
  return result;
}
export function setupAppShellTestEnv() {
  beforeEach(async () => {
    mockFetch.mockReset();
    // Default rig/ps mocks return empty so chrome can render.
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
      if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
      if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
      return new Response("[]");
    });
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
    const { queryClient } = await import("../../src/lib/query-client.js");
    queryClient.clear();
  });

  afterEach(() => {
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
    window.localStorage.clear();
    cleanup();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    });
    window.dispatchEvent(new Event("resize"));
  });
}
