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

  // velocity-guard 24.D BLOCKING-CONCERN repair (primary):
  // honest 3-part error must NOT be visually truncated. Operators
  // need to see the action phrase (e.g., "cmux ping", "rig up <name>")
  // to recover. Truncation would only show the FACT but hide the
  // ACTION guidance, violating HG-10/HG-13 honest-error contract.

  it("error status does NOT have truncate class (full message visible) — DISCRIMINATING", async () => {
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
      expect(toast.className).not.toMatch(/\btruncate\b/);
      expect(toast.className).not.toMatch(/\boverflow-hidden\b/);
      expect(toast.className).toMatch(/\bwhitespace-normal\b|\bwhitespace-pre-line\b/);
    });
  });

  it("error status text content includes the daemon's full action phrase ('cmux ping')", async () => {
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
      // Full 3-part message in DOM text: fact + consequence + action.
      // The action phrase 'cmux ping' must be present, not just the
      // opening fact 'cmux is not available...'.
      expect(toast.textContent).toContain("cmux ping");
    });
  });

  it("error status text content includes 'rig up' action phrase for rig_not_running", async () => {
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
      expect(toast.textContent).toContain("rig up my-rig");
    });
  });

  // OPR.0.3.4.8 — open-missing button recovery + exact target set.

  it("partial launch shows open-missing button; clicking it POSTs to exactly the missing logicalIds' /open-cmux", async () => {
    const fetchCalls: string[] = [];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, opts?: RequestInit) => {
      fetchCalls.push(`${opts?.method ?? "GET"} ${url}`);
      if (url.includes("/cmux/launch")) {
        return new Response(
          JSON.stringify({
            ok: true,
            workspaces: [{ name: "w1", agents: ["a@rig"], blanks: 0 }],
            missing: [
              { logicalId: "b", reason: "still-booting" },
              { logicalId: "c", reason: "session-missing" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/open-cmux")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );

    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent).toContain("Missing");
    });

    const openMissing = screen.getByTestId("open-missing-button");
    expect(openMissing).not.toBeNull();
    expect((openMissing as HTMLButtonElement).hidden).toBe(false);

    fireEvent.click(openMissing);
    await waitFor(() => {
      const openCmuxCalls = fetchCalls.filter((c) => c.includes("/open-cmux"));
      expect(openCmuxCalls).toHaveLength(2);
      expect(openCmuxCalls.some((c) => c.includes("/nodes/b/open-cmux"))).toBe(true);
      expect(openCmuxCalls.some((c) => c.includes("/nodes/c/open-cmux"))).toBe(true);
      expect(openCmuxCalls.every((c) => !c.includes("/nodes/a/open-cmux"))).toBe(true);
    });
  });

  it("open-missing treats /open-cmux HTTP 200 {ok:false} as failed (no false success)", async () => {
    const fetchCalls: string[] = [];
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string, opts?: RequestInit) => {
      fetchCalls.push(`${opts?.method ?? "GET"} ${url}`);
      if (url.includes("/cmux/launch")) {
        return new Response(
          JSON.stringify({
            ok: true,
            workspaces: [{ name: "w1", agents: ["a@rig"], blanks: 0 }],
            missing: [{ logicalId: "b", reason: "session-missing" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/open-cmux")) {
        return new Response(
          JSON.stringify({ ok: false, error: "session_not_found", message: "tmux session not found" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      expect(screen.getByTestId("launch-cmux-status").textContent).toContain("Missing");
    });

    fireEvent.click(screen.getByTestId("open-missing-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent).toContain("still unavailable");
      expect(toast.textContent).not.toContain("Opened 1 missing seat");
    });
  });

  it("partial launch shows missing seat names in status message", async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          workspaces: [{ name: "w1", agents: ["a@rig"], blanks: 0 }],
          missing: [{ logicalId: "b", reason: "session-missing" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(
      <Wrapper>
        <LaunchCmuxButton rigId="my-rig" />
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("launch-cmux-button"));
    await waitFor(() => {
      const toast = screen.getByTestId("launch-cmux-status");
      expect(toast.textContent).toContain("1 of 2");
      expect(toast.textContent).toContain("b (session-missing)");
    });
  });
});
