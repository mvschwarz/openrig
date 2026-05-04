// Token / Context Usage Surface v0 (PL-012) — ContextWorkspace tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { ContextWorkspace } from "../src/components/context/ContextWorkspace.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockReset();
});

afterEach(() => cleanup());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  }) as unknown as Response;
}

function fixtureFleet() {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/ps") {
      return jsonResponse([
        { rigId: "rig-a", name: "alpha-rig" },
        { rigId: "rig-b", name: "beta-rig" },
      ]);
    }
    if (url.includes("/api/rigs/rig-a/nodes")) {
      return jsonResponse([
        { rigId: "rig-a", rigName: "alpha-rig", logicalId: "core.lead", canonicalSessionName: "lead@alpha", runtime: "claude-code", contextUsage: { availability: "known", usedPercentage: 92, fresh: true, sampledAt: "2026-05-04T12:00:00Z" } },
        { rigId: "rig-a", rigName: "alpha-rig", logicalId: "core.qa", canonicalSessionName: "qa@alpha", runtime: "codex", contextUsage: { availability: "known", usedPercentage: 65, fresh: true, sampledAt: "2026-05-04T12:00:00Z" } },
      ]);
    }
    if (url.includes("/api/rigs/rig-b/nodes")) {
      return jsonResponse([
        { rigId: "rig-b", rigName: "beta-rig", logicalId: "dev.impl", canonicalSessionName: "impl@beta", runtime: "claude-code", contextUsage: { availability: "known", usedPercentage: 30, fresh: true, sampledAt: "2026-05-04T12:00:00Z" } },
        { rigId: "rig-b", rigName: "beta-rig", logicalId: "dev.unknown", canonicalSessionName: null, runtime: "terminal", contextUsage: { availability: "unknown", usedPercentage: null, fresh: false, sampledAt: null } },
      ]);
    }
    return jsonResponse({});
  });
}

describe("ContextWorkspace — PL-012", () => {
  it("renders header summary with correct tier counts", async () => {
    fixtureFleet();
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-workspace")).toBeDefined());
    expect(screen.getByTestId("context-stat-total").textContent).toContain("4");
    expect(screen.getByTestId("context-stat-critical").textContent).toContain("1"); // 92%
    expect(screen.getByTestId("context-stat-warning").textContent).toContain("1"); // 65%
    expect(screen.getByTestId("context-stat-ok").textContent).toContain("1"); // 30%
    expect(screen.getByTestId("context-stat-unknown").textContent).toContain("1");
  });

  it("renders per-seat list sorted by usedPercentage descending", async () => {
    fixtureFleet();
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-seat-list")).toBeDefined());
    // Query the <li> elements directly (children of context-seat-list)
    const list = screen.getByTestId("context-seat-list");
    const items = Array.from(list.querySelectorAll<HTMLElement>("li[data-tier]"));
    expect(items.map((el) => el.getAttribute("data-tier"))).toEqual(["critical", "warning", "low", "unknown"]);
  });

  it("tier filter narrows to matching seats", async () => {
    fixtureFleet();
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-filter-tier-critical")).toBeDefined());
    fireEvent.click(screen.getByTestId("context-filter-tier-critical"));
    await waitFor(() => {
      expect(screen.getByTestId("context-seat-core.lead")).toBeDefined();
      expect(screen.queryByTestId("context-seat-core.qa")).toBeNull();
    });
  });

  it("runtime filter narrows by runtime", async () => {
    fixtureFleet();
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-filter-runtime-codex")).toBeDefined());
    fireEvent.click(screen.getByTestId("context-filter-runtime-codex"));
    await waitFor(() => {
      expect(screen.getByTestId("context-seat-core.qa")).toBeDefined();
      expect(screen.queryByTestId("context-seat-core.lead")).toBeNull();
    });
  });

  it("Compact button copies the rig compact-plan command for the seat's rig", async () => {
    fixtureFleet();
    let copiedText = "";
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn(async (text: string) => { copiedText = text; }) },
      writable: true,
      configurable: true,
    });
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-seat-core.lead-compact")).toBeDefined());
    fireEvent.click(screen.getByTestId("context-seat-core.lead-compact"));
    await waitFor(() => expect(copiedText).toBe("rig compact-plan --rig alpha-rig"));
  });

  it("renders honest fallback when /api/ps errors (cross-CLI-version drift)", async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ error: "ps_unavailable" }, 503));
    render(createTestRouter({ component: () => <ContextWorkspace />, path: "/context" }));
    await waitFor(() => expect(screen.getByTestId("context-workspace-error")).toBeDefined());
    expect(screen.getByTestId("context-workspace-error").textContent).toContain("rig context --json");
  });
});
