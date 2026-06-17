import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ForkNowAction } from "../src/components/agent-images/ForkNowAction.js";
import type { AgentImageEntry } from "../src/hooks/useAgentImageLibrary.js";

function makeEntry(overrides?: Partial<AgentImageEntry>): AgentImageEntry {
  return {
    id: "img-1",
    kind: "agent-image",
    name: "my-image",
    version: "1",
    runtime: "claude-code",
    sourceSeat: "dev.impl@test-rig",
    sourceSessionId: "sess-1",
    sourceCwd: "/project",
    notes: null,
    createdAt: "2026-06-15T00:00:00Z",
    sourceType: "user_file",
    sourcePath: "/images/my-image",
    relativePath: "my-image",
    updatedAt: "2026-06-15T00:00:00Z",
    manifestEstimatedTokens: null,
    derivedEstimatedTokens: 1000,
    files: [],
    sourceResumeToken: "(redacted)",
    stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 5000, lineage: [] },
    lineage: [],
    pinned: false,
    ...overrides,
  };
}

function renderWithQuery(ui: React.ReactElement, fetchOverride?: typeof fetch) {
  if (fetchOverride) {
    vi.stubGlobal("fetch", fetchOverride);
  } else if (!globalThis.fetch || !(globalThis.fetch as ReturnType<typeof vi.fn>).mock) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("ForkNowAction", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders Fork now button for image with sourceCwd", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    expect(screen.getByTestId("fork-now-button")).toBeDefined();
  });

  it("disables Fork now for image with null sourceCwd (no-fallback invariant)", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry({ sourceCwd: null })} />);
    expect(screen.getByTestId("fork-now-disabled-no-cwd")).toBeDefined();
    expect(screen.queryByTestId("fork-now-button")).toBeNull();
  });

  it("disables Fork now for image with empty string sourceCwd", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry({ sourceCwd: "" })} />);
    expect(screen.getByTestId("fork-now-disabled-no-cwd")).toBeDefined();
  });

  it("opens modal on button click", async () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    fireEvent.click(screen.getByTestId("fork-now-button"));
    expect(screen.getByTestId("fork-now-modal")).toBeDefined();
    expect(screen.getByTestId("fork-now-rig-select")).toBeDefined();
  });

  it("confirm button is disabled without required fields", () => {
    renderWithQuery(<ForkNowAction entry={makeEntry()} />);
    fireEvent.click(screen.getByTestId("fork-now-button"));
    const confirm = screen.getByTestId("fork-now-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("shows failed/attention_required launch as red error, not green success", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/ps") return new Response(JSON.stringify([{ rigId: "r1", name: "rig-1", nodeCount: 1, runningCount: 1, status: "running" }]));
      if (url.includes("/api/rigs/r1/nodes")) return new Response(JSON.stringify([
        { logicalId: "dev.impl", podId: "p1", podNamespace: "dev", runtime: "claude-code", agentRef: "local:agents/impl", profile: "default" },
      ]));
      if (url.includes("/members") && init?.method === "POST") {
        return new Response(JSON.stringify({
          ok: true,
          result: { node: { logicalId: "forked-seat", status: "attention_required", error: "Codex auth expired" } },
        }), { status: 201 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    });
    await act(async () => {
      renderWithQuery(<ForkNowAction entry={makeEntry()} />, fetchMock as typeof fetch);
    });
    await act(async () => { fireEvent.click(screen.getByTestId("fork-now-button")); });

    await waitFor(() => screen.getByTestId("fork-now-rig-select"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-rig-select"), { target: { value: "r1" } }); });
    await waitFor(() => screen.getByTestId("fork-now-pod-select"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-pod-select"), { target: { value: "dev" } }); });
    await waitFor(() => screen.getByTestId("fork-now-sibling-select"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-sibling-select"), { target: { value: "dev.impl" } }); });
    await waitFor(() => screen.getByTestId("fork-now-member-id"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-member-id"), { target: { value: "forked-seat" } }); });
    await act(async () => { fireEvent.click(screen.getByTestId("fork-now-confirm")); });

    await waitFor(() => {
      const result = screen.getByTestId("fork-now-result");
      expect(result.textContent).toContain("Fork failed");
      expect(result.textContent).toContain("attention_required");
      expect(result.className).toContain("text-red");
    }, { timeout: 3000 });
  });

  it("excludes runtime-matched siblings with null agentRef from picker", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ps") return new Response(JSON.stringify([{ rigId: "r1", name: "rig-1", nodeCount: 2, runningCount: 2, status: "running" }]));
      if (url.includes("/api/rigs/r1/nodes")) return new Response(JSON.stringify([
        { logicalId: "dev.impl", podId: "p1", podNamespace: "dev", runtime: "claude-code", agentRef: null, profile: null },
        { logicalId: "dev.guard", podId: "p1", podNamespace: "dev", runtime: "codex", agentRef: "local:agents/guard", profile: "default" },
      ]));
      return new Response(JSON.stringify([]), { status: 200 });
    });

    await act(async () => {
      renderWithQuery(<ForkNowAction entry={makeEntry({ runtime: "claude-code" })} />, fetchMock as typeof fetch);
    });
    await act(async () => { fireEvent.click(screen.getByTestId("fork-now-button")); });

    await waitFor(() => screen.getByTestId("fork-now-rig-select"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-rig-select"), { target: { value: "r1" } }); });
    await waitFor(() => screen.getByTestId("fork-now-pod-select"), { timeout: 3000 });
    await act(async () => { fireEvent.change(screen.getByTestId("fork-now-pod-select"), { target: { value: "dev" } }); });

    await waitFor(() => screen.getByTestId("fork-now-no-sibling"), { timeout: 3000 });
    expect(screen.queryByTestId("fork-now-sibling-select")).toBeNull();
  });
});
