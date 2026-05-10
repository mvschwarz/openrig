// Phase 3a slice 3.3 — PluginDetailPage tests (TDD red→green).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

  it("renders manifest summary, skills, hooks, runtime badges, and source label", async () => {
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
            hooks: [
              { runtime: "claude", relativePath: "hooks/claude.json", events: ["SessionStart", "Stop"] },
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
    // Manifest summary visible
    expect(screen.getByText("openrig-core")).toBeDefined();
    expect(screen.getByText("v0.1.0")).toBeDefined();
    expect(screen.getByText("Canonical OpenRig content")).toBeDefined();

    // Runtime badges (drift discriminator: each runtime renders own badge).
    expect(screen.getByTestId("plugin-detail-runtime-claude")).toBeDefined();
    expect(screen.getByTestId("plugin-detail-runtime-codex")).toBeDefined();

    // Source label visible.
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();

    // Skills list — both skills shown.
    await waitFor(() => {
      expect(screen.getByTestId("plugin-skill-openrig-user")).toBeDefined();
      expect(screen.getByTestId("plugin-skill-queue-handoff")).toBeDefined();
    });

    // Hooks list — claude hook visible with events.
    expect(screen.getByTestId("plugin-hook-claude")).toBeDefined();
    expect(screen.getByText(/SessionStart/)).toBeDefined();
    expect(screen.getByText(/Stop/)).toBeDefined();

    // Used-by list — both agents visible.
    await waitFor(() => {
      expect(screen.getByTestId("plugin-used-by-advisor-lead")).toBeDefined();
      expect(screen.getByTestId("plugin-used-by-velocity-driver")).toBeDefined();
    });
  });

  it("renders empty Skills section when plugin ships no skills", async () => {
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
    expect(screen.getByTestId("plugin-skills-empty")).toBeDefined();
    expect(screen.getByTestId("plugin-hooks-empty")).toBeDefined();
    expect(screen.getByTestId("plugin-used-by-empty")).toBeDefined();
  });
});
