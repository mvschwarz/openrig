// Slice 28 Checkpoint C — Detail page docs-browser layout (HG-6 + HG-7 + HG-8).
//
// Pre-slice-28 PluginDetailPage rendered a grid of sections (manifest +
// skills + hooks + MCP + used-by) and SkillDetailPage rendered just the
// FileViewer. Founder-walk feedback: docs-browser pattern — left tree of
// entries + right content viewer — on both detail pages, mirroring
// FilesWorkspace's two-pane shape.
//
// SkillDetailPage (HG-7): in-page tree of skill files; SKILL.md
// auto-selected; clicking another file navigates via fileToken route.
//
// PluginDetailPage (HG-6): virtual tree built from PluginDetail's
// structured data (manifest / skills/ / hooks/ / mcp servers / used by).
// Click switches the right viewer panel. Full file-content browsing of
// the plugin path is a separate scope question surfaced to orch;
// docs-browser SHELL is the v0 deliverable.
//
// HG-8 (folder navigation): the plugin docs-browser supports expanding
// the skills/ + hooks/ + mcp roots to reveal child entries. Skill detail
// docs-browser is flat (skills are typically SKILL.md only); folder
// navigation gate is tested via the plugin tree's expand-on-select shape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SkillDetailPage } from "../src/components/specs/SkillDetailPage.js";
import { PluginDetailPage } from "../src/components/specs/PluginDetailPage.js";
import { librarySkillToken } from "../src/lib/library-skills-routing.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  Object.defineProperty(window, "scrollTo", { configurable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function fileList(entries: Array<{ name: string; type: "dir" | "file" }>) {
  return {
    root: "workspace",
    path: "",
    entries: entries.map((entry) => ({
      ...entry,
      size: entry.type === "file" ? 42 : null,
      mtime: "2026-05-12T00:00:00.000Z",
    })),
  };
}

const NOT_FOUND = { status: 404, ok: false, json: async () => ({ error: "not_found" }) };

function renderSkillDetail(skillToken: string, fileToken?: string) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <SkillDetailPage skillToken={skillToken} fileToken={fileToken} />,
    }),
  );
}

function renderPluginDetail(pluginId: string) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <PluginDetailPage pluginId={pluginId} />,
    }),
  );
}

describe("SkillDetailPage — slice 28 HG-7 docs-browser layout", () => {
  function mockOneSkill(files: Array<{ name: string; type: "file" }>) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user") {
        return { ok: true, json: async () => fileList(files) };
      }
      if (url === "/api/files/read?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user%2FSKILL.md") {
        return {
          ok: true,
          json: async () => ({
            root: "workspace",
            path: "packages/daemon/specs/agents/shared/skills/openrig-user/SKILL.md",
            absolutePath: "/workspace/packages/daemon/specs/agents/shared/skills/openrig-user/SKILL.md",
            content: "# OpenRig User Skill body",
            mtime: "2026-05-12T00:00:00.000Z",
            contentHash: "hash",
            size: 30,
            truncated: false,
            truncatedAtBytes: null,
            totalBytes: 30,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  const skillId = "openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/openrig-user";

  it("renders the docs-browser shell (testid `skill-detail-docs-browser` with tree + viewer)", async () => {
    mockOneSkill([{ name: "SKILL.md", type: "file" }]);
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-docs-browser")).toBeTruthy();
    });
    expect(screen.getByTestId("skill-detail-tree")).toBeTruthy();
    expect(screen.getByTestId("skill-detail-viewer")).toBeTruthy();
  });

  it("tree lists each skill file as a navigable entry", async () => {
    mockOneSkill([
      { name: "SKILL.md", type: "file" },
      { name: "DETAILS.md", type: "file" },
    ]);
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-file-SKILL.md")).toBeTruthy();
    });
    expect(screen.getByTestId("skill-detail-tree-file-DETAILS.md")).toBeTruthy();
  });

  it("SKILL.md is auto-selected (active state) on entry when no fileToken given", async () => {
    mockOneSkill([
      { name: "SKILL.md", type: "file" },
      { name: "DETAILS.md", type: "file" },
    ]);
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-file-SKILL.md")).toBeTruthy();
    });
    expect(screen.getByTestId("skill-detail-tree-file-SKILL.md").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("skill-detail-tree-file-DETAILS.md").getAttribute("data-active")).toBe("false");
  });

  it("clicking a non-default file navigates to the file route (anchor href shape)", async () => {
    mockOneSkill([
      { name: "SKILL.md", type: "file" },
      { name: "DETAILS.md", type: "file" },
    ]);
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-file-DETAILS.md")).toBeTruthy();
    });
    const detailsLink = screen.getByTestId("skill-detail-tree-file-DETAILS.md") as HTMLAnchorElement;
    expect(detailsLink.tagName).toBe("A");
    expect(detailsLink.getAttribute("href")).toMatch(/^\/specs\/skills\/.+\/file\/.+$/);
  });

  it("renders SKILL.md content in the viewer pane (markdown body visible)", async () => {
    mockOneSkill([{ name: "SKILL.md", type: "file" }]);
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByText(/OpenRig User Skill body/)).toBeTruthy();
    });
  });
});

describe("PluginDetailPage — slice 28 HG-6 docs-browser layout", () => {
  function mockPluginDetail(detail: {
    id: string;
    name: string;
    version: string;
    runtimes: ("claude" | "codex")[];
    skills?: Array<{ name: string; relativePath: string }>;
    hooks?: Array<{ runtime: "claude" | "codex"; relativePath: string; events: string[] }>;
    mcpServers?: Array<{ runtime: "claude" | "codex"; name: string; command: string | null; transport: string | null }>;
  }) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === `/api/plugins/${detail.id}`) {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: detail.id,
              name: detail.name,
              version: detail.version,
              description: null,
              source: "vendored",
              sourceLabel: `vendored:${detail.name}`,
              runtimes: detail.runtimes,
              path: `/plugins/${detail.id}`,
              lastSeenAt: null,
            },
            claudeManifest: detail.runtimes.includes("claude")
              ? { raw: {}, name: detail.name, version: detail.version, description: null, homepage: null, repository: null, license: null }
              : null,
            codexManifest: detail.runtimes.includes("codex")
              ? { raw: {}, name: detail.name, version: detail.version, description: null, homepage: null, repository: null, license: null }
              : null,
            skills: detail.skills ?? [],
            hooks: detail.hooks ?? [],
            mcpServers: detail.mcpServers ?? [],
          }),
        };
      }
      if (url === `/api/plugins/${detail.id}/used-by`) {
        return { ok: true, json: async () => [] };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders the docs-browser shell (testid `plugin-detail-docs-browser` with tree + viewer)", async () => {
    mockPluginDetail({ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-docs-browser")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-viewer")).toBeTruthy();
  });

  it("tree lists manifest + skills/ + hooks/ + used-by entries", async () => {
    mockPluginDetail({
      id: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude", "codex"],
      skills: [{ name: "openrig-user", relativePath: "skills/openrig-user" }],
      hooks: [{ runtime: "claude", relativePath: "hooks/claude.json", events: ["pre-commit"] }],
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-manifest")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree-skills-root")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-tree-hooks-root")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-tree-used-by")).toBeTruthy();
  });

  it("default selection is `manifest` — viewer renders manifest panel", async () => {
    mockPluginDetail({ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-manifest")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree-manifest").getAttribute("data-active")).toBe("true");
  });

  it("HG-8 folder navigation: clicking skills/ root expands child skills + switches viewer to skills root", async () => {
    mockPluginDetail({
      id: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      skills: [
        { name: "openrig-user", relativePath: "skills/openrig-user" },
        { name: "openrig-architect", relativePath: "skills/openrig-architect" },
      ],
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skills-root")).toBeTruthy();
    });
    // Pre-click: skills root is collapsed, sub-entries absent in DOM.
    expect(screen.queryByTestId("plugin-detail-tree-skill:openrig-user")).toBeNull();
    fireEvent.click(screen.getByTestId("plugin-detail-tree-skills-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skill:openrig-user")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree-skill:openrig-architect")).toBeTruthy();
    expect(screen.getByTestId("plugin-viewer-skills-root")).toBeTruthy();
  });

  it("HG-8 folder navigation: clicking a child skill switches viewer to that skill panel", async () => {
    mockPluginDetail({
      id: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      skills: [{ name: "openrig-user", relativePath: "skills/openrig-user" }],
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skills-root")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-skills-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-skill:openrig-user")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-skill:openrig-user"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-skill-openrig-user")).toBeTruthy();
    });
  });

  it("clicking hooks/ root + child reveals hook config events panel", async () => {
    mockPluginDetail({
      id: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude", "codex"],
      hooks: [
        { runtime: "claude", relativePath: "hooks/claude.json", events: ["pre-commit", "post-merge"] },
        { runtime: "codex", relativePath: "hooks/codex.json", events: [] },
      ],
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-hooks-root")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-hooks-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-hook:claude")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-hook:claude"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-viewer-hook-claude")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-viewer-hook-claude").textContent).toContain("pre-commit");
  });

  it("MCP server tree renders only when servers are declared", async () => {
    mockPluginDetail({
      id: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      mcpServers: [{ runtime: "claude", name: "github", command: "github-mcp", transport: "stdio" }],
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-mcp-root")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-mcp-root"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-mcp:claude:github")).toBeTruthy();
    });
  });

  it("MCP server tree ABSENT when no servers declared (no empty branch in tree)", async () => {
    mockPluginDetail({ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree")).toBeTruthy();
    });
    expect(screen.queryByTestId("plugin-detail-tree-mcp-root")).toBeNull();
  });

  it("DISCRIMINATOR: pre-slice-28 grid-section testids ABSENT", async () => {
    mockPluginDetail({ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-docs-browser")).toBeTruthy();
    });
    // Pre-slice-28 had separate section cards laid out in a grid; those testids are gone
    expect(screen.queryByTestId("plugin-detail-manifest")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-skills")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-hooks")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-used-by")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-mcp-servers")).toBeNull();
  });
});
