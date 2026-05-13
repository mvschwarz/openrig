// Slice 28 Checkpoint C — Index page rolled-up-rows regression (HG-9 + HG-10).
//
// Pre-slice-28 the index pages grouped entries by source via
// LibraryTopLevelEntry (workspace / openrig-managed buckets for skills;
// vendored / claude-cache / codex-cache for plugins). Founder-walk
// feedback: rolled-up flat rows surface ALL entries at a glance + per-row
// metadata (source / file-count for skills; version / runtimes / source
// for plugins) + click → detail.
//
// Discriminators: rolled-up testids exist (`skills-index-row-<id>`,
// `plugins-index-row-<id>`); legacy LibraryTopLevelEntry testids
// (`library-top-level-skills`, `library-folder-<source>`,
// `library-item-<id>`) are ABSENT in DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SkillsIndexPage } from "../src/components/specs/SkillsIndexPage.js";
import { PluginsIndexPage } from "../src/components/specs/PluginsIndexPage.js";
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

function renderSkillsIndex() {
  return render(
    createTestRouter({
      path: "/specs/skills",
      initialPath: "/specs/skills",
      component: () => <SkillsIndexPage />,
    }),
  );
}

function renderPluginsIndex() {
  return render(
    createTestRouter({
      path: "/specs/plugins",
      initialPath: "/specs/plugins",
      component: () => <PluginsIndexPage />,
    }),
  );
}

describe("SkillsIndexPage — slice 28 HG-9 (rolled-up flat rows)", () => {
  function mockSkillsFetch(skillNames: string[]) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList(skillNames.map((name) => ({ name, type: "dir" as const }))) };
      }
      for (const name of skillNames) {
        const skillPath = `packages/daemon/specs/agents/shared/skills/${name}`;
        if (url === `/api/files/list?root=workspace&path=${encodeURIComponent(skillPath)}`) {
          return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
        }
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders each skill as a flat row with stable testid", async () => {
    mockSkillsFetch(["alpha-skill", "beta-skill"]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-rows")).toBeTruthy();
    });
    expect(
      screen.getByTestId(`skills-index-row-openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/alpha-skill`),
    ).toBeTruthy();
    expect(
      screen.getByTestId(`skills-index-row-openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/beta-skill`),
    ).toBeTruthy();
  });

  it("each row navigates to /specs/skills/$skillToken (anchor with correct href)", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    const id = "openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/alpha-skill";
    await waitFor(() => {
      expect(screen.getByTestId(`skills-index-row-${id}`)).toBeTruthy();
    });
    const row = screen.getByTestId(`skills-index-row-${id}`) as HTMLAnchorElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toMatch(/^\/specs\/skills\//);
  });

  it("each row includes source label + file-count columns", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    const id = "openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/alpha-skill";
    await waitFor(() => {
      expect(screen.getByTestId(`skills-index-row-${id}-source`)).toBeTruthy();
    });
    expect(screen.getByTestId(`skills-index-row-${id}-source`).textContent).toContain("OpenRig managed");
    expect(screen.getByTestId(`skills-index-row-${id}-filecount`).textContent).toMatch(/1 file/);
  });

  it("DISCRIMINATOR: legacy LibraryTopLevelEntry testids ABSENT in DOM", async () => {
    mockSkillsFetch(["alpha-skill"]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-rows")).toBeTruthy();
    });
    // Pre-slice-28 testids must be gone (the grouped-folder shape is removed).
    expect(screen.queryByTestId("library-top-level-skills")).toBeNull();
    expect(screen.queryByTestId("library-folder-workspace")).toBeNull();
    expect(screen.queryByTestId("library-folder-openrig-managed")).toBeNull();
  });

  it("empty state renders when no skills present", async () => {
    mockSkillsFetch([]);
    renderSkillsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("skills-index-empty")).toBeTruthy();
    });
  });
});

describe("PluginsIndexPage — slice 28 HG-10 (rolled-up flat rows)", () => {
  function mockPluginsFetch(plugins: Array<{ id: string; name: string; version: string; runtimes: ("claude" | "codex")[]; source?: string; sourceLabel?: string; skillCount?: number }>) {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () =>
            plugins.map((p) => ({
              id: p.id,
              name: p.name,
              version: p.version,
              description: null,
              source: p.source ?? "vendored",
              sourceLabel: p.sourceLabel ?? `vendored:${p.name}`,
              runtimes: p.runtimes,
              path: `/plugins/${p.id}`,
              lastSeenAt: null,
              skillCount: p.skillCount ?? 0,
            })),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  it("renders each plugin as a flat row with stable testid", async () => {
    mockPluginsFetch([
      { id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude", "codex"] },
      { id: "gstack", name: "gstack", version: "0.5.0", runtimes: ["claude"] },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-rows")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-openrig-core")).toBeTruthy();
    expect(screen.getByTestId("plugins-index-row-gstack")).toBeTruthy();
  });

  it("each row navigates to /plugins/$pluginId (anchor with correct href)", async () => {
    mockPluginsFetch([{ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] }]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-openrig-core")).toBeTruthy();
    });
    const row = screen.getByTestId("plugins-index-row-openrig-core") as HTMLAnchorElement;
    expect(row.tagName).toBe("A");
    expect(row.getAttribute("href")).toBe("/plugins/openrig-core");
  });

  it("each row includes version + runtimes + skill-count + source columns (HG-10)", async () => {
    mockPluginsFetch([
      {
        id: "openrig-core",
        name: "openrig-core",
        version: "0.1.0",
        runtimes: ["claude", "codex"],
        source: "vendored",
        sourceLabel: "vendored:openrig-core",
        skillCount: 5,
      },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-openrig-core-version")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-openrig-core-version").textContent).toBe("v0.1.0");
    const runtimesEl = screen.getByTestId("plugins-index-row-openrig-core-runtimes");
    expect(runtimesEl.textContent).toContain("claude");
    expect(runtimesEl.textContent).toContain("codex");
    expect(screen.getByTestId("plugins-index-row-openrig-core-skillcount").textContent).toBe("5 skills");
    expect(screen.getByTestId("plugins-index-row-openrig-core-source").textContent).toContain("vendored");
  });

  it("HG-10 skill-count column singular/plural pluralization", async () => {
    mockPluginsFetch([
      { id: "single", name: "single", version: "1.0.0", runtimes: ["claude"], skillCount: 1 },
      { id: "zero", name: "zero", version: "1.0.0", runtimes: ["claude"], skillCount: 0 },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-row-single-skillcount")).toBeTruthy();
    });
    expect(screen.getByTestId("plugins-index-row-single-skillcount").textContent).toBe("1 skill");
    expect(screen.getByTestId("plugins-index-row-zero-skillcount").textContent).toBe("0 skills");
  });

  it("DISCRIMINATOR: legacy LibraryTopLevelEntry testids ABSENT in DOM", async () => {
    mockPluginsFetch([{ id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] }]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-rows")).toBeTruthy();
    });
    expect(screen.queryByTestId("library-top-level-plugins")).toBeNull();
    expect(screen.queryByTestId("library-folder-vendored")).toBeNull();
    expect(screen.queryByTestId("library-folder-claude-cache")).toBeNull();
  });

  it("empty state renders when no plugins present", async () => {
    mockPluginsFetch([]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-empty")).toBeTruthy();
    });
  });

  it("count badge reflects number of plugins", async () => {
    mockPluginsFetch([
      { id: "openrig-core", name: "openrig-core", version: "0.1.0", runtimes: ["claude"] },
      { id: "gstack", name: "gstack", version: "0.5.0", runtimes: ["claude"] },
      { id: "obra-superpowers", name: "obra-superpowers", version: "1.0.0", runtimes: ["claude"] },
    ]);
    renderPluginsIndex();
    await waitFor(() => {
      expect(screen.getByTestId("plugins-index-count").textContent).toBe("3 plugins");
    });
  });
});
