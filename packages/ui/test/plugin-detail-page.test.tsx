// PluginDetailPage state + content tests.
//
// Slice 3.3 originally landed a grid-section layout (Manifest / Skills /
// Hooks / MCP / Used-by cards). Slice 28 refactored to a docs-browser
// two-pane layout (left virtual tree + right viewer). Loading + not-
// found states + per-section content reachable via tree are still core
// contract; updated here for the new shape. Comprehensive docs-browser
// coverage (folder navigation, tree expansion, view switching) lives in
// slice-28-detail-pages.test.tsx.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PluginDetailPage } from "../src/components/specs/PluginDetailPage.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderPluginDetail(pluginId: string) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <PluginDetailPage pluginId={pluginId} />,
    }),
  );
}

describe("PluginDetailPage", () => {
  it("shows loading state while plugin detail is fetching", async () => {
    mockFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { ok: true, json: async () => null };
    });
    renderPluginDetail("openrig-core");
    expect(await screen.findByTestId("plugin-detail-loading")).toBeDefined();
  });

  it("shows not-found state when plugin id missing", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/plugins/missing")) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("missing");
    expect(await screen.findByTestId("plugin-detail-not-found")).toBeDefined();
  });

  it("renders header (name + version + runtime badges + source) and surfaces manifest + skills + hooks + MCP + used-by via the docs-browser tree", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins/openrig-core") {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: "Canonical OpenRig content",
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude", "codex"],
              path: "/x/openrig-core",
              lastSeenAt: "2026-05-10T00:00:00.000Z",
            },
            claudeManifest: {
              raw: { name: "openrig-core" },
              name: "openrig-core",
              version: "0.1.0",
              description: "Canonical content",
              homepage: "https://github.com/mvschwarz/openrig-plugins",
              repository: null,
              license: "MIT",
            },
            codexManifest: null,
            skills: [
              { name: "openrig-user", relativePath: "skills/openrig-user" },
              { name: "queue-handoff", relativePath: "skills/queue-handoff" },
            ],
            hooks: [{ runtime: "claude", relativePath: "hooks/claude.json", events: ["SessionStart", "Stop"] }],
            mcpServers: [
              { runtime: "claude", name: "github-mcp", command: "node", transport: "stdio" },
              { runtime: "claude", name: "linear-mcp", command: "linear-mcp", transport: "http" },
            ],
          }),
        };
      }
      if (url === "/api/plugins/openrig-core/used-by") {
        return {
          ok: true,
          json: async () => [
            { agentName: "advisor-lead", sourcePath: "/x/agent.yaml", profiles: ["default"] },
            { agentName: "velocity-driver", sourcePath: "/y/agent.yaml", profiles: ["default", "review"] },
          ],
        };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("openrig-core");

    expect(await screen.findByTestId("plugin-detail-page")).toBeDefined();
    // Header content preserved across the docs-browser refactor.
    expect(screen.getByText("openrig-core")).toBeDefined();
    expect(screen.getByText("v0.1.0")).toBeDefined();
    expect(screen.getByText("Canonical OpenRig content")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-runtime-claude")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-runtime-codex")).toBeDefined();
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();

    // Tree exposes all expected roots/leaves.
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skills-root")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-tree-hooks-root")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-tree-mcp-root")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-tree-used-by")).toBeDefined();

    // Default viewer panel is manifest; runtime fields visible.
    expect(screen.getByTestId("plugin-viewer-manifest")).toBeDefined();
    // claude manifest summary line "openrig-core v0.1.0" is rendered.
    expect(screen.getByText(/openrig-core v0\.1\.0/)).toBeDefined();

    // Expand skills + verify both child rows.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-skills-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skill:openrig-user")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-tree-skill:queue-handoff")).toBeDefined();

    // Expand hooks + verify claude child.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-hooks-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-hook:claude")).toBeDefined();
    });
    // Click claude hook → events visible in viewer.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-hook:claude"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-hook-claude")).toBeDefined();
    });
    expect(screen.getByText(/SessionStart/)).toBeDefined();
    expect(screen.getByText(/Stop/)).toBeDefined();

    // Expand MCP + verify both servers.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-mcp-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-mcp:claude:github-mcp")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-detail-tree-mcp:claude:linear-mcp")).toBeDefined();

    // Click Used-by → both agents visible.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-used-by"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-used-by-advisor-lead")).toBeDefined();
    });
    expect(screen.getByTestId("plugin-viewer-used-by-velocity-driver")).toBeDefined();
  });

  it("renders empty sections gracefully when plugin ships no skills/hooks/MCP/used-by", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins/skinny") {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: "skinny",
              name: "skinny",
              version: "0.0.1",
              description: null,
              source: "claude-cache",
              sourceLabel: "claude-cache:other/skinny/0.0.1",
              runtimes: ["claude"],
              path: "/x/skinny",
              lastSeenAt: null,
            },
            claudeManifest: { raw: {}, name: "skinny", version: "0.0.1", description: null, homepage: null, repository: null, license: null },
            codexManifest: null,
            skills: [],
            hooks: [],
            mcpServers: [],
          }),
        };
      }
      if (url === "/api/plugins/skinny/used-by") {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected ${url}`);
    });
    renderPluginDetail("skinny");
    expect(await screen.findByTestId("plugin-detail-page")).toBeDefined();
    // Tree still has manifest + skills/ + hooks/ + used-by, all with 0 counts.
    expect(screen.getByTestId("plugin-detail-tree-skills-root").textContent).toContain("0");
    expect(screen.getByTestId("plugin-detail-tree-hooks-root").textContent).toContain("0");
    // MCP root not rendered when no servers declared (the slice 28 tree
    // intentionally omits the empty branch — cleaner than a 0-count placeholder).
    expect(screen.queryByTestId("plugin-detail-tree-mcp-root")).toBeNull();
    expect(screen.getByTestId("plugin-detail-tree-used-by").textContent).toContain("0");

    // Empty-state copy reachable via Skills-root + Hooks-root selection.
    fireEvent.click(screen.getByTestId("plugin-detail-tree-skills-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-skills-root")).toBeDefined();
    });
    expect(screen.getByText(/does not ship any skills/i)).toBeDefined();

    fireEvent.click(screen.getByTestId("plugin-detail-tree-hooks-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-hooks-root")).toBeDefined();
    });
    expect(screen.getByText(/does not ship hook configurations/i)).toBeDefined();
  });
});
