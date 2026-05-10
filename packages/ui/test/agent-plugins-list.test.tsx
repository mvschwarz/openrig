// Phase 3a slice 3.3 — AgentPluginsList enrichment component tests.
//
// Standalone helper that takes a list of plugin IDs (from agent.yaml's
// resources.plugins[].id field) and renders enriched chips with:
//   - plugin name + version
//   - runtime support badges (claude / codex)
//   - source label provenance
//   - view-in-library link to /plugins/:pluginId
//
// At slice 3.3 close this component is standalone (not wired into
// AgentSpecDisplay because batch 1 owns that file on the
// plugin-primitive-v0 branch). At merge-time into plugin-primitive-v0,
// the AgentSpecDisplay Plugins block (added by batch 1) will consume
// this component to upgrade from string-list-of-ids to enriched chips.
// Until then the component is testable and shippable in isolation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { AgentPluginsList } from "../src/components/specs/AgentPluginsList.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderList(pluginIds: string[]) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <AgentPluginsList pluginIds={pluginIds} />,
    }),
  );
}

describe("AgentPluginsList", () => {
  it("renders empty state when agent has no plugin references", async () => {
    renderList([]);
    expect(await screen.findByTestId("agent-plugins-empty")).toBeDefined();
  });

  it("renders one chip per plugin id with name + version + runtime badges", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: null,
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude", "codex"],
              path: "/x",
              lastSeenAt: null,
            },
            {
              id: "superpowers",
              name: "superpowers",
              version: "5.1.0",
              description: null,
              source: "claude-cache",
              sourceLabel: "claude-cache:obra/superpowers/5.1.0",
              runtimes: ["claude"],
              path: "/y",
              lastSeenAt: null,
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["openrig-core", "superpowers"]);

    // Wait for the resolved chips (they have version + source label that
    // unresolved chips lack). The testids alone aren't enough to discriminate
    // because the unresolved fallback uses the same testid.
    await waitFor(() => {
      expect(screen.getByText("vendored:openrig-core")).toBeDefined();
      expect(screen.getByText("claude-cache:obra/superpowers/5.1.0")).toBeDefined();
    });
    expect(screen.getByTestId("agent-plugin-chip-openrig-core")).toBeDefined();
    expect(screen.getByTestId("agent-plugin-chip-superpowers")).toBeDefined();

    // Plugin names visible.
    expect(screen.getByText("openrig-core")).toBeDefined();
    expect(screen.getByText("superpowers")).toBeDefined();
    // Versions visible (regex match across potential text-node splits).
    expect(screen.getByText(/v0\.1\.0/)).toBeDefined();
    expect(screen.getByText(/v5\.1\.0/)).toBeDefined();
    // Runtime support badges (drift discriminator: 2-runtime + 1-runtime).
    const claudeBadges = screen.getAllByText("claude");
    expect(claudeBadges.length).toBeGreaterThanOrEqual(2);
    const codexBadges = screen.getAllByText("codex");
    expect(codexBadges.length).toBeGreaterThanOrEqual(1);
    // Source labels visible.
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    expect(screen.getByText("claude-cache:obra/superpowers/5.1.0")).toBeDefined();
  });

  it("renders unresolved chip when plugin id not found in discovery", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["missing-plugin"]);
    await waitFor(() => {
      expect(screen.getByTestId("agent-plugin-chip-missing-plugin")).toBeDefined();
    });
    expect(screen.getByText("missing-plugin")).toBeDefined();
    expect(screen.getByTestId("agent-plugin-unresolved-missing-plugin")).toBeDefined();
  });

  it("each chip links to /plugins/:pluginId for viewer navigation", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: null,
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude"],
              path: "/x",
              lastSeenAt: null,
            },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderList(["openrig-core"]);
    // Wait for resolved chip (source label is resolved-only).
    await waitFor(() => {
      expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    });
    const chip = screen.getByTestId("agent-plugin-chip-openrig-core") as HTMLAnchorElement;
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toBe("/plugins/openrig-core");
  });
});
