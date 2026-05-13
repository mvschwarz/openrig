// Slice 28 Checkpoint C — Detail pages docs-browser (real file tree).
//
// Checkpoint C-1 added daemon endpoints
//   GET /api/plugins/:id/files/list?path=<rel>
//   GET /api/plugins/:id/files/read?path=<rel>
// + PluginEntry.skillCount enrichment. SC-29 EXCEPTION #11.
//
// Checkpoint C-2 (this file) rewires the UI:
//   SkillDetailPage: in-page file tree using existing /api/files/list +
//     /read, rooted at skill.directoryPath under the discovered allowlist
//     root. SKILL.md auto-selected; subfolder navigation supported via
//     currentPath + entry-click.
//   PluginDetailPage: in-page file tree using new usePluginFiles hook
//     (wrapping the new daemon endpoints). README.md auto-selected at
//     plugin root; subfolder navigation supported.
// Both pages preserve the header strip with structured metadata (manifest
// version + runtimes + source + skill-count + used-by-count for plugins;
// source + name for skills).

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

describe("SkillDetailPage — slice 28 HG-7 + HG-8 docs-browser (daemon skill-library API)", () => {
  // C-4: mocks /api/skills/library + /api/skills/:id/files/{list,read}
  // (daemon-owned skill discovery; SC-29 #11 cumulative).
  function mockOneSkill(opts: {
    rootFiles?: Array<{ name: string; type: "file" | "dir" }>;
    subFolders?: Record<string, Array<{ name: string; type: "file" | "dir" }>>;
    fileContent?: Record<string, string>;
  }) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-managed:core/openrig-user",
              name: "openrig-user",
              source: "openrig-managed",
              files: [{ name: "SKILL.md", path: "SKILL.md", size: 42, mtime: "2026-05-12T00:00:00.000Z" }],
            },
          ],
        };
      }
      if (url === "/api/skills/openrig-managed%3Acore%2Fopenrig-user/files/list?path=") {
        return {
          ok: true,
          json: async () => ({
            skillId: "openrig-managed:core/openrig-user",
            path: "",
            ...fileList(opts.rootFiles ?? [{ name: "SKILL.md", type: "file" }]),
          }),
        };
      }
      for (const [subPath, entries] of Object.entries(opts.subFolders ?? {})) {
        if (url === `/api/skills/openrig-managed%3Acore%2Fopenrig-user/files/list?path=${encodeURIComponent(subPath)}`) {
          return {
            ok: true,
            json: async () => ({
              skillId: "openrig-managed:core/openrig-user",
              path: subPath,
              ...fileList(entries),
            }),
          };
        }
      }
      for (const [filePath, content] of Object.entries(opts.fileContent ?? {})) {
        if (url === `/api/skills/openrig-managed%3Acore%2Fopenrig-user/files/read?path=${encodeURIComponent(filePath)}`) {
          return {
            ok: true,
            json: async () => ({
              skillId: "openrig-managed:core/openrig-user",
              path: filePath,
              absolutePath: `/abs/${filePath}`,
              content,
              mtime: "2026-05-12T00:00:00.000Z",
              contentHash: "hash",
              size: content.length,
              truncated: false,
              truncatedAtBytes: null,
              totalBytes: content.length,
            }),
          };
        }
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  const skillId = "openrig-managed:core/openrig-user";

  it("renders the docs-browser shell (tree + viewer testids)", async () => {
    mockOneSkill({
      rootFiles: [{ name: "SKILL.md", type: "file" }],
      fileContent: { "SKILL.md": "# OpenRig User Skill body" },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-docs-browser")).toBeTruthy();
    });
    expect(screen.getByTestId("skill-detail-tree")).toBeTruthy();
    expect(screen.getByTestId("skill-detail-viewer")).toBeTruthy();
  });

  it("tree lists each skill file/dir entry (HG-7 surface — ALL files, not just markdown)", async () => {
    mockOneSkill({
      rootFiles: [
        { name: "SKILL.md", type: "file" },
        { name: "examples", type: "dir" },
        { name: "config.json", type: "file" },
        { name: "fixture.yaml", type: "file" },
      ],
      fileContent: { "SKILL.md": "# body" },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-entry-SKILL.md")).toBeTruthy();
    });
    // HG-7 DISCRIMINATOR: non-markdown files appear in the tree (pre-C2
    // useLibrarySkills filtered to .md/.mdx only; the new in-page tree
    // uses /api/files/list which returns ALL entries).
    expect(screen.getByTestId("skill-detail-tree-entry-config.json")).toBeTruthy();
    expect(screen.getByTestId("skill-detail-tree-entry-fixture.yaml")).toBeTruthy();
    expect(screen.getByTestId("skill-detail-tree-entry-examples")).toBeTruthy();
  });

  it("SKILL.md auto-selected on entry (HG-7 default)", async () => {
    mockOneSkill({
      rootFiles: [
        { name: "SKILL.md", type: "file" },
        { name: "DETAILS.md", type: "file" },
      ],
      fileContent: { "SKILL.md": "# default body", "DETAILS.md": "# secondary" },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByText(/default body/)).toBeTruthy();
    });
  });

  it("HG-8 folder navigation: clicking a dir enters it; tree updates to subfolder contents", async () => {
    mockOneSkill({
      rootFiles: [
        { name: "SKILL.md", type: "file" },
        { name: "examples", type: "dir" },
      ],
      subFolders: {
        examples: [
          { name: "basic.md", type: "file" },
          { name: "advanced.md", type: "file" },
        ],
      },
      fileContent: {
        "SKILL.md": "# root",
        "examples/basic.md": "# basic example",
      },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-entry-examples")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("skill-detail-tree-entry-examples"));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-entry-examples/basic.md")).toBeTruthy();
    });
    expect(screen.getByTestId("skill-detail-tree-entry-examples/advanced.md")).toBeTruthy();
    // 'up' (..) entry visible when not at the skill root.
    expect(screen.getByTestId("skill-detail-tree-up")).toBeTruthy();
  });

  it("HG-8 folder navigation: clicking '..' returns to parent folder", async () => {
    mockOneSkill({
      rootFiles: [
        { name: "SKILL.md", type: "file" },
        { name: "examples", type: "dir" },
      ],
      subFolders: { examples: [{ name: "basic.md", type: "file" }] },
      fileContent: { "SKILL.md": "# root" },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-entry-examples")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("skill-detail-tree-entry-examples"));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-up")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("skill-detail-tree-up"));
    await waitFor(() => {
      expect(screen.getByTestId("skill-detail-tree-entry-SKILL.md")).toBeTruthy();
    });
  });

  it("clicking a non-default file in the tree switches the viewer content", async () => {
    mockOneSkill({
      rootFiles: [
        { name: "SKILL.md", type: "file" },
        { name: "DETAILS.md", type: "file" },
      ],
      fileContent: { "SKILL.md": "# root body", "DETAILS.md": "# details body" },
    });
    renderSkillDetail(librarySkillToken(skillId));
    await waitFor(() => {
      expect(screen.getByText(/root body/)).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("skill-detail-tree-entry-DETAILS.md"));
    await waitFor(() => {
      expect(screen.getByText(/details body/)).toBeTruthy();
    });
  });
});

describe("PluginDetailPage — slice 28 HG-6 + HG-8 docs-browser (real file tree via daemon endpoints)", () => {
  function mockPluginDetail(opts: {
    pluginId: string;
    name: string;
    version: string;
    runtimes: ("claude" | "codex")[];
    skillCount?: number;
    rootFiles?: Array<{ name: string; type: "file" | "dir" }>;
    subFolders?: Record<string, Array<{ name: string; type: "file" | "dir" }>>;
    fileContent?: Record<string, string>;
    usedBy?: Array<{ agentName: string; sourcePath: string; profiles: string[] }>;
  }) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === `/api/plugins/${opts.pluginId}`) {
        return {
          ok: true,
          json: async () => ({
            entry: {
              id: opts.pluginId,
              name: opts.name,
              version: opts.version,
              description: null,
              source: "vendored",
              sourceLabel: `vendored:${opts.name}`,
              runtimes: opts.runtimes,
              path: `/plugins/${opts.pluginId}`,
              lastSeenAt: null,
              skillCount: opts.skillCount ?? 0,
            },
            claudeManifest: null,
            codexManifest: null,
            skills: [],
            hooks: [],
            mcpServers: [],
          }),
        };
      }
      if (url === `/api/plugins/${opts.pluginId}/used-by`) {
        return { ok: true, json: async () => opts.usedBy ?? [] };
      }
      if (url === `/api/plugins/${opts.pluginId}/files/list?path=`) {
        return {
          ok: true,
          json: async () => ({
            pluginId: opts.pluginId,
            path: "",
            ...fileList(opts.rootFiles ?? []),
          }),
        };
      }
      for (const [subPath, entries] of Object.entries(opts.subFolders ?? {})) {
        if (url === `/api/plugins/${opts.pluginId}/files/list?path=${encodeURIComponent(subPath)}`) {
          return {
            ok: true,
            json: async () => ({
              pluginId: opts.pluginId,
              path: subPath,
              ...fileList(entries),
            }),
          };
        }
      }
      for (const [filePath, content] of Object.entries(opts.fileContent ?? {})) {
        if (url === `/api/plugins/${opts.pluginId}/files/read?path=${encodeURIComponent(filePath)}`) {
          return {
            ok: true,
            json: async () => ({
              pluginId: opts.pluginId,
              path: filePath,
              absolutePath: `/plugins/${opts.pluginId}/${filePath}`,
              content,
              mtime: "2026-05-12T00:00:00.000Z",
              contentHash: "hash",
              size: content.length,
              truncated: false,
              truncatedAtBytes: null,
              totalBytes: content.length,
            }),
          };
        }
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders the docs-browser shell (tree + viewer testids)", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [{ name: "README.md", type: "file" }],
      fileContent: { "README.md": "# body" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-docs-browser")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-viewer")).toBeTruthy();
  });

  it("header strip preserves plugin metadata (name + version + runtimes + skill-count + used-by-count + source)", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude", "codex"],
      skillCount: 5,
      usedBy: [
        { agentName: "advisor", sourcePath: "/x", profiles: ["default"] },
        { agentName: "driver", sourcePath: "/y", profiles: ["default"] },
      ],
      rootFiles: [{ name: "README.md", type: "file" }],
      fileContent: { "README.md": "doc" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      // Heading + breadcrumbs both contain plugin name; pin to the h1 via role.
      expect(screen.getByRole("heading", { name: "openrig-core" })).toBeTruthy();
    });
    expect(screen.getByText("v0.1.0")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-runtime-claude")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-runtime-codex")).toBeTruthy();
    expect(screen.getByText("vendored:openrig-core")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-skill-count").textContent).toBe("5 skills");
    expect(screen.getByTestId("plugin-detail-used-by-count").textContent).toBe("used by 2 agents");
  });

  it("HG-6 tree lists plugin root entries from daemon /files/list endpoint", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [
        { name: ".claude-plugin", type: "dir" },
        { name: "hooks", type: "dir" },
        { name: "skills", type: "dir" },
        { name: "README.md", type: "file" },
      ],
      fileContent: { "README.md": "# body" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-README.md")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-tree-entry-hooks")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-tree-entry-.claude-plugin")).toBeTruthy();
  });

  it("HG-6 README.md auto-selected on entry (content visible in viewer)", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [{ name: "README.md", type: "file" }, { name: "LICENSE", type: "file" }],
      fileContent: { "README.md": "# Canonical OpenRig plugin", "LICENSE": "MIT" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByText(/Canonical OpenRig plugin/)).toBeTruthy();
    });
  });

  it("HG-8 folder navigation: clicking skills/ enters subfolder; child skill folders visible", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [{ name: "skills", type: "dir" }],
      subFolders: {
        skills: [
          { name: "openrig-user", type: "dir" },
          { name: "openrig-architect", type: "dir" },
        ],
      },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-entry-skills"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user")).toBeTruthy();
    });
    expect(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-architect")).toBeTruthy();
    expect(screen.getByTestId("plugin-detail-tree-up")).toBeTruthy();
  });

  it("HG-8 folder navigation: nested file content visible (skills/openrig-user/SKILL.md)", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [{ name: "skills", type: "dir" }],
      subFolders: {
        skills: [{ name: "openrig-user", type: "dir" }],
        "skills/openrig-user": [{ name: "SKILL.md", type: "file" }],
      },
      fileContent: { "skills/openrig-user/SKILL.md": "# OpenRig User skill body" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-entry-skills"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user"));
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user/SKILL.md")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("plugin-detail-tree-entry-skills/openrig-user/SKILL.md"));
    await waitFor(() => {
      expect(screen.getByText(/OpenRig User skill body/)).toBeTruthy();
    });
  });

  it("DISCRIMINATOR: virtual-tree testids from pre-C2 shell ABSENT", async () => {
    mockPluginDetail({
      pluginId: "openrig-core",
      name: "openrig-core",
      version: "0.1.0",
      runtimes: ["claude"],
      rootFiles: [{ name: "README.md", type: "file" }],
      fileContent: { "README.md": "doc" },
    });
    renderPluginDetail("openrig-core");
    await waitFor(() => {
      expect(screen.getByTestId("plugin-detail-tree")).toBeTruthy();
    });
    // The virtual-tree shape from the pre-C2 (HG-6 SHELL) approach used
    // these testids; the real-file-tree replaces them.
    expect(screen.queryByTestId("plugin-detail-tree-manifest")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-tree-skills-root")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-tree-hooks-root")).toBeNull();
    expect(screen.queryByTestId("plugin-detail-tree-used-by")).toBeNull();
  });
});
