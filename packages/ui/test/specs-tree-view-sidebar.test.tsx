import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SpecsTreeView } from "../src/components/specs/SpecsTreeView.js";
import { createTestRouter } from "./helpers/test-router.js";

// velocity-guard 18.C BLOCKING-CONCERN repair (Blocker 2):
// Top-level "Skills" sidebar link must both navigate to /specs/skills
// AND expand the Skills section below (per IMPL-PRD §3.3 + T7).

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  // All Library endpoints return empty so the Section renders its
  // "No skills yet." placeholder when expanded — visible expansion
  // proof without needing real Library data.
  mockFetch.mockImplementation(async () => ({
    ok: true,
    json: async () => [],
  }));
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function renderTree() {
  return render(
    createTestRouter({
      path: "/specs",
      initialPath: "/specs",
      component: () => <SpecsTreeView />,
    }),
  );
}

describe("SpecsTreeView — top-level sidebar Skills link", () => {
  it("renders a Skills top-level link in the sidebar", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-skills-top-level")).toBeTruthy();
    });
  });

  it("Skills section is collapsed by default (chevron right; no placeholder visible)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-skills")).toBeTruthy();
    });
    // Default expanded state for "skills" is false; placeholder not rendered.
    expect(screen.queryByText(/no skills yet/i)).toBeNull();
  });

  it("clicking the sidebar Skills top-level link expands the Skills section below", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-skills-top-level")).toBeTruthy();
    });
    expect(screen.queryByText(/no skills yet/i)).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-skills-top-level"));

    await waitFor(() => {
      // After the click, the section's expanded body renders. Because
      // useLibrarySkills mock returns [], the Section shows its
      // "No skills yet." placeholder — proof of expansion.
      expect(screen.getByText(/no skills yet/i)).toBeTruthy();
    });
  });
});

describe("SpecsTreeView — top-level sidebar Plugins link (slice 18 Checkpoint D)", () => {
  it("renders a Plugins top-level link in the sidebar", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugins-top-level")).toBeTruthy();
    });
  });

  it("Plugins section is collapsed by default (placeholder absent)", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("specs-section-plugins")).toBeTruthy();
    });
    expect(screen.queryByText(/no plugins yet/i)).toBeNull();
  });

  it("clicking the sidebar Plugins top-level link expands the Plugins section below", async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-plugins-top-level")).toBeTruthy();
    });
    expect(screen.queryByText(/no plugins yet/i)).toBeNull();

    fireEvent.click(screen.getByTestId("sidebar-plugins-top-level"));

    await waitFor(() => {
      expect(screen.getByText(/no plugins yet/i)).toBeTruthy();
    });
  });
});

describe("SpecsTreeView — slice 19 sidebar density follow-up", () => {
  it("renders Library Explorer spec/plugin entries as single-row leaves with inline meta + a11y labels", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library") {
        return {
          ok: true,
          json: async () => [
            { id: "rig:adversarial-review:0.2", kind: "rig", name: "adversarial-review", version: "0.2", sourceType: "builtin", sourcePath: "/pkg/rig.yaml", relativePath: "rig.yaml" },
            { id: "workflow:conveyor:1", kind: "workflow", name: "conveyor", version: "1", sourceType: "builtin", sourcePath: "/pkg/workflow.yaml", relativePath: "workflow.yaml" },
            { id: "agent:driver:1", kind: "agent", name: "driver", version: "1", sourceType: "builtin", sourcePath: "/pkg/agent.yaml", relativePath: "agent.yaml" },
            { id: "app:vault:3", kind: "rig", name: "vault-app", version: "3", sourceType: "builtin", sourcePath: "/pkg/app/rig.yaml", relativePath: "apps/vault/rig.yaml", hasServices: true },
          ],
        };
      }
      if (url === "/api/context-packs/library") {
        return {
          ok: true,
          json: async () => [
            { id: "context-pack:demo:1", kind: "context-pack", name: "demo-pack", version: "1", sourceType: "workspace", sourcePath: "/workspace/.openrig/context-packs/demo", relativePath: "demo", updatedAt: "2026-05-07T00:00:00.000Z", manifestEstimatedTokens: null, derivedEstimatedTokens: 120, files: [] },
          ],
        };
      }
      if (url === "/api/agent-images/library") {
        return {
          ok: true,
          json: async () => [
            { id: "agent-image:driver:1", kind: "agent-image", name: "driver-image", version: "1", runtime: "claude-code", sourceSeat: "driver", sourceSessionId: "s", sourceCwd: null, notes: null, createdAt: "2026-05-07T00:00:00.000Z", sourceType: "workspace", sourcePath: "/workspace/.openrig/agent-images/driver", relativePath: "driver", updatedAt: "2026-05-07T00:00:00.000Z", manifestEstimatedTokens: null, derivedEstimatedTokens: 200, files: [], sourceResumeToken: "(redacted)", stats: { forkCount: 0, lastUsedAt: null, estimatedSizeBytes: 0, lineage: [] }, lineage: [], pinned: false },
          ],
        };
      }
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            { id: "openrig-core", name: "openrig-core", version: "0.1.0", description: "Core plugin", source: "vendored", sourceLabel: "vendored:openrig-core", runtimes: ["claude", "codex"], path: "/plugins/openrig-core", lastSeenAt: null },
          ],
        };
      }
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [] }) };
      }
      if (url.startsWith("/api/files/list?")) {
        return { ok: true, json: async () => ({ root: "workspace", path: "", entries: [] }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderTree();

    const entries = [
      { section: "rig-specs", leaf: "rig:adversarial-review:0.2", meta: "0.2" },
      { section: "workflow-specs", leaf: "workflow:conveyor:1", meta: "1" },
      { section: "context-packs", leaf: "context-pack:demo:1", meta: "1 · workspace" },
      { section: "agent-specs", leaf: "agent:driver:1", meta: "1" },
      { section: "agent-images", leaf: "agent-image:driver:1", meta: "1" },
      { section: "applications", leaf: "app:vault:3", meta: "3" },
      { section: "plugins", leaf: "openrig-core", meta: "0.1.0" },
    ];

    for (const entry of entries) {
      const section = await screen.findByTestId(`specs-section-${entry.section}`);
      const leafAlreadyVisible = within(section).queryByTestId(`specs-leaf-${entry.leaf}`);
      if (!leafAlreadyVisible) {
        fireEvent.click(await screen.findByTestId(`specs-section-toggle-${entry.section}`));
      }
      const leaf = await within(section).findByTestId(`specs-leaf-${entry.leaf}`);
      const meta = await within(section).findByTestId(`specs-leaf-${entry.leaf}-meta`);

      expect(leaf.parentElement?.children).toHaveLength(1);
      expect(leaf.className).toMatch(/\bflex\b/);
      expect(leaf.className).not.toMatch(/\bblock\b/);
      expect(meta.className).toMatch(/\bshrink-0\b/);
      expect(meta.className).not.toMatch(/\bblock\b/);
      expect(meta.textContent).toContain(entry.meta);
      expect(leaf.getAttribute("title")).toContain(entry.meta);
      expect(leaf.getAttribute("aria-label")).toContain(entry.meta);
    }
  });
});
