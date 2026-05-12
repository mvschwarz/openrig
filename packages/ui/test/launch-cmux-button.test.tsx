// Slice 24 Checkpoint D — LaunchCmuxButton component tests.
// Verifies: button renders with "Launch in CMUX" label; click triggers
// POST + sets loading state; success surfaces a status message;
// error surfaces honest 3-part error; button hidden on mobile via
// responsive class.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode } from "react";
import { LaunchCmuxButton } from "../src/components/topology/LaunchCmuxButton.js";

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = vi.fn() as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("LaunchCmuxButton", () => {
  it("renders button with 'Launch in CMUX' label", () => {
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    const button = screen.getByTestId("launch-cmux-button");
    expect(button).toBeTruthy();
    expect(button.textContent?.toLowerCase()).toMatch(/launch in cmux/i);
  });

  it("button has lg:inline + hidden classes (visible on desktop, hidden on mobile)", () => {
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    const wrapper = screen.getByTestId("launch-cmux-wrapper");
    expect(wrapper.className).toMatch(/hidden/);
    expect(wrapper.className).toMatch(/lg:/);
  });

  it("click POSTs to /api/rigs/:rigId/cmux/launch", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, workspaces: [{ name: "my-rig", agents: ["a", "b"], blanks: 0 }] }),
    });
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/rigs/my-rig/cmux/launch",
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("shows loading state during in-flight request", async () => {
    let resolveFetch!: (v: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockReturnValue(fetchPromise);

    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const button = screen.getByTestId("launch-cmux-button") as HTMLButtonElement;
      expect(button.disabled).toBe(true);
    });
    expect(screen.getByTestId("launch-cmux-button").textContent?.toLowerCase()).toMatch(/launching|loading/);

    // Resolve to clean up
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, workspaces: [] }),
    });
    await waitFor(() => {
      const button = screen.getByTestId("launch-cmux-button") as HTMLButtonElement;
      expect(button.disabled).toBe(false);
    });
  });

  it("shows success toast with workspace count + agent count after success", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        workspaces: [{ name: "my-rig", agents: ["a", "b", "c"], blanks: 1 }],
      }),
    });
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent?.toLowerCase()).toMatch(/launched/);
      expect(toast.textContent).toContain("my-rig");
      expect(toast.textContent).toMatch(/3/); // 3 agents
    });
  });

  it("shows honest 3-part error toast on 4xx response", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 412,
      json: async () => ({
        error: "rig_not_running",
        message: "Rig 'my-rig' has no running tmux sessions — can't attach to anything — run: rig up my-rig",
      }),
    });
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent?.toLowerCase()).toMatch(/no running tmux|rig_not_running/);
    });
  });

  it("error toast contains rig name + actionable hint (honest 3-part check)", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        error: "cmux_unavailable",
        message: "cmux is not available on this host — can't launch workspace — install cmux from https://cmux.io and run: cmux ping",
      }),
    });
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent?.toLowerCase()).toMatch(/cmux|install|ping/);
    });
  });
});
