import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { SkillDetailPage } from "../src/components/specs/SkillDetailPage.js";
import { SpecsTreeView } from "../src/components/specs/SpecsTreeView.js";
import { librarySkillFileToken, librarySkillHref, librarySkillToken } from "../src/lib/library-skills-routing.js";
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

function renderLibraryPage() {
  return render(
    createTestRouter({
      path: "/specs",
      component: () => <SpecsLibraryPage />,
    }),
  );
}

function renderSkillDetail(skillToken: string, fileToken?: string) {
  return render(
    createTestRouter({
      path: "/",
      component: () => <SkillDetailPage skillToken={skillToken} fileToken={fileToken} />,
    }),
  );
}

function renderSpecsTree(initialPath = "/specs") {
  return render(
    createTestRouter({
      path: "/specs/skills/$skillToken",
      initialPath,
      component: () => <SpecsTreeView />,
    }),
  );
}

function fileList(entries: Array<{ name: string; type: "dir" | "file" }>) {
  return {
    root: "workspace",
    path: "",
    entries: entries.map((entry) => ({
      ...entry,
      size: entry.type === "file" ? 42 : null,
      mtime: "2026-05-07T00:00:00.000Z",
    })),
  };
}

describe("Library page taxonomy", () => {
  it("renders Library labels, split sections, and skills from existing file routes", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library") {
        return {
          ok: true,
          json: async () => [
            { id: "rig-1", kind: "rig", name: "openrig-build", version: "1", sourceType: "builtin", sourcePath: "/pkg/rig.yaml", relativePath: "rigs/build/rig.yaml" },
            { id: "agent-1", kind: "agent", name: "implementer", version: "1", sourceType: "builtin", sourcePath: "/pkg/agent.yaml", relativePath: "agents/impl/agent.yaml" },
            { id: "workflow:conveyor:1", kind: "workflow", name: "conveyor", version: "1", sourceType: "builtin", sourcePath: "/pkg/workflow.yaml", relativePath: "workflow.yaml" },
            { id: "app-1", kind: "rig", name: "vault-app", version: "1", sourceType: "builtin", sourcePath: "/pkg/app/rig.yaml", relativePath: "apps/vault/rig.yaml", hasServices: true },
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
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/files/roots") {
        return {
          ok: true,
          json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }),
        };
      }
      // C-4: daemon-owned skill discovery via /api/skills/library.
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "workspace:workspace:operator-skill",
              name: "operator-skill",
              source: "workspace",
              files: [{ name: "SKILL.md", path: "SKILL.md", size: 28, mtime: "2026-05-07T00:00:00.000Z" }],
            },
            {
              id: "openrig-managed:openrig-user",
              name: "openrig-user",
              source: "openrig-managed",
              files: [{ name: "SKILL.md", path: "SKILL.md", size: 32, mtime: "2026-05-07T00:00:00.000Z" }],
            },
          ],
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderLibraryPage();

    expect(await screen.findByRole("heading", { name: "Library" })).toBeDefined();
    await waitFor(() => {
      expect(screen.getByTestId("library-section-rig-specs")).toBeDefined();
      expect(screen.getByTestId("library-section-workspace-specs")).toBeDefined();
      expect(screen.getByTestId("library-section-workflow-specs")).toBeDefined();
      expect(screen.getByTestId("library-section-context-packs")).toBeDefined();
      expect(screen.getByTestId("library-section-agent-specs")).toBeDefined();
      expect(screen.getByTestId("library-section-agent-images")).toBeDefined();
      expect(screen.getByTestId("library-section-applications")).toBeDefined();
      expect(screen.getByTestId("library-section-skills")).toBeDefined();
      // Phase 3a slice 3.3 — Plugins category alongside Skills.
      expect(screen.getByTestId("library-section-plugins")).toBeDefined();
    });

    expect(screen.getByText("implementer")).toBeDefined();
    expect(screen.getByText("driver-image")).toBeDefined();
    const rigRow = screen.getByTestId("library-row-rig-specs-rig-1");
    expect(rigRow.textContent).toContain("openrig-build");
    expect(rigRow.textContent).not.toContain("builtin");
    expect(rigRow.textContent).not.toContain("1");
    const contextPackRow = screen.getByTestId("library-row-context-packs-context-pack:demo:1");
    expect(contextPackRow.textContent).toBe("demo-pack");
    const imageRow = screen.getByTestId("library-row-agent-images-agent-image:driver:1");
    expect(imageRow.textContent).toBe("driver-image");
    const skillLink = screen.getByTestId("library-skill-operator-skill") as HTMLAnchorElement;
    expect(skillLink).toBeDefined();
    // C-4: ID format is now source:rootName:skillName (no .openrig/skills/ prefix).
    expect(skillLink.getAttribute("href")).toBe(librarySkillHref("workspace:workspace:operator-skill"));
    expect(screen.queryByRole("img", { name: "operator-skill skill" })).toBeNull();
    expect(screen.getAllByTestId("library-skill-openrig-user")).toHaveLength(1);
    expect(screen.queryByText("workspace")).toBeNull();
    expect(screen.queryByTestId("library-skill-file-panel")).toBeNull();
    expect(screen.queryByTestId("library-skill-document-panel")).toBeNull();
    expect(screen.queryByText(/Skill body/)).toBeNull();
  });

  it("opens a skill as its own viewer and defaults to SKILL.md", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library" || url === "/api/context-packs/library" || url === "/api/agent-images/library") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-managed:openrig-user",
              name: "openrig-user",
              source: "openrig-managed",
              files: [{ name: "SKILL.md", path: "SKILL.md", size: 32, mtime: "2026-05-07T00:00:00.000Z" }],
            },
          ],
        };
      }
      if (url === "/api/skills/openrig-managed%3Aopenrig-user/files/list?path=") {
        return {
          ok: true,
          json: async () => ({
            skillId: "openrig-managed:openrig-user",
            path: "",
            ...fileList([{ name: "SKILL.md", type: "file" }]),
          }),
        };
      }
      if (url === "/api/skills/openrig-managed%3Aopenrig-user/files/read?path=SKILL.md") {
        return {
          ok: true,
          json: async () => ({
            skillId: "openrig-managed:openrig-user",
            path: "SKILL.md",
            absolutePath: "/abs/SKILL.md",
            content: "# OpenRig User\nPackaged skill.",
            mtime: "2026-05-07T00:00:00.000Z",
            contentHash: "hash",
            size: 32,
            truncated: false,
            truncatedAtBytes: null,
            totalBytes: 32,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const packagedSkillId = "openrig-managed:openrig-user";
    renderSkillDetail(librarySkillToken(packagedSkillId));

    expect(await screen.findByTestId("skill-detail-page")).toBeDefined();
    expect(await screen.findByText(/Packaged skill/)).toBeDefined();
  });

  it("opens a selected skill file from the route token", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "workspace:workspace:operator-skill",
              name: "operator-skill",
              source: "workspace",
              files: [
                { name: "SKILL.md", path: "SKILL.md", size: 28, mtime: "2026-05-07T00:00:00.000Z" },
                { name: "DETAILS.md", path: "DETAILS.md", size: 28, mtime: "2026-05-07T00:00:00.000Z" },
              ],
            },
          ],
        };
      }
      if (url === "/api/skills/workspace%3Aworkspace%3Aoperator-skill/files/list?path=") {
        return {
          ok: true,
          json: async () => ({
            skillId: "workspace:workspace:operator-skill",
            path: "",
            ...fileList([
              { name: "SKILL.md", type: "file" },
              { name: "DETAILS.md", type: "file" },
            ]),
          }),
        };
      }
      if (url === "/api/skills/workspace%3Aworkspace%3Aoperator-skill/files/read?path=DETAILS.md") {
        return {
          ok: true,
          json: async () => ({
            skillId: "workspace:workspace:operator-skill",
            path: "DETAILS.md",
            absolutePath: "/abs/DETAILS.md",
            content: "# Details\nSecondary file.",
            mtime: "2026-05-07T00:00:00.000Z",
            contentHash: "hash",
            size: 28,
            truncated: false,
            truncatedAtBytes: null,
            totalBytes: 28,
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const skillId = "workspace:workspace:operator-skill";
    renderSkillDetail(librarySkillToken(skillId), librarySkillFileToken("DETAILS.md"));

    expect(await screen.findByText(/Secondary file/)).toBeDefined();
  });

  it("renders Plugins section with discovered plugins (Phase 3a slice 3.3)", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library" || url === "/api/context-packs/library" || url === "/api/agent-images/library") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/plugins") {
        return {
          ok: true,
          json: async () => [
            {
              id: "openrig-core",
              name: "openrig-core",
              version: "0.1.0",
              description: "Canonical OpenRig content",
              source: "vendored",
              sourceLabel: "vendored:openrig-core",
              runtimes: ["claude", "codex"],
              path: "/x/openrig-core",
              lastSeenAt: null,
            },
            {
              id: "claude-cache:anthropics/github/1.0.0",
              name: "github",
              version: "1.0.0",
              description: "GitHub integration",
              source: "claude-cache",
              sourceLabel: "claude-cache:anthropics/github/1.0.0",
              runtimes: ["claude"],
              path: "/y/github",
              lastSeenAt: null,
            },
          ],
        };
      }
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      // Skill scans return empty so the Skills section doesn't add noise here.
      if (url.startsWith("/api/files/list")) {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    renderLibraryPage();

    // Section renders with both plugins listed, but list rows stay name-only.
    await waitFor(() => {
      expect(screen.getByTestId("library-section-plugins")).toBeDefined();
    });
    const openrigPlugin = await screen.findByTestId("library-plugin-openrig-core");
    const githubPlugin = await screen.findByTestId("library-plugin-claude-cache:anthropics/github/1.0.0");
    expect(openrigPlugin).toBeDefined();
    expect(githubPlugin).toBeDefined();

    expect(within(openrigPlugin).getByText("openrig-core")).toBeDefined();
    expect(openrigPlugin.textContent).not.toContain("0.1.0");
    expect(openrigPlugin.textContent).not.toContain("vendored:openrig-core");
    expect(githubPlugin.textContent).not.toContain("1.0.0");
    expect(githubPlugin.textContent).not.toContain("claude-cache:anthropics/github/1.0.0");
  });

  it("auto-expands the skills explorer on skill detail routes", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library" || url === "/api/context-packs/library" || url === "/api/agent-images/library") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/plugins") {
        return { ok: true, json: async () => [] };
      }
      if (url === "/api/skills/library") {
        return {
          ok: true,
          json: async () => [
            {
              id: "workspace:workspace:operator-skill",
              name: "operator-skill",
              source: "workspace",
              files: [
                { name: "SKILL.md", path: "SKILL.md", size: 28, mtime: "2026-05-07T00:00:00.000Z" },
                { name: "DETAILS.md", path: "DETAILS.md", size: 28, mtime: "2026-05-07T00:00:00.000Z" },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const skillId = "workspace:workspace:operator-skill";
    renderSpecsTree(`/specs/skills/${librarySkillToken(skillId)}`);

    expect(await screen.findByTestId("specs-section-skills")).toBeDefined();
    // Slice 29 HG-3: skills sidebar is category-folder grouped. Workspace
    // skills bucket under category "workspace"; click expands category;
    // skill row is a single non-expandable Link (file drill-in removed
    // — that's the detail page's job per HG-3).
    expect(await screen.findByTestId("skills-category-workspace")).toBeDefined();
    expect(await screen.findByTestId("specs-leaf-workspace:workspace:operator-skill")).toBeDefined();
    // No more in-tree file drill-down (HG-3 anti-pattern); skill detail
    // page surfaces files via the docs-browser.
    expect(screen.queryByTestId("specs-skill-file-SKILL.md")).toBeNull();
  });
});
