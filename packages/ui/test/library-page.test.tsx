import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "operator-skill", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills%2Foperator-skill") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/read?root=workspace&path=.openrig%2Fskills%2Foperator-skill%2FSKILL.md") {
        return {
          ok: true,
          json: async () => ({
            root: "workspace",
            path: ".openrig/skills/operator-skill/SKILL.md",
            absolutePath: "/workspace/.openrig/skills/operator-skill/SKILL.md",
            content: "# Operator Skill\nSkill body.",
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
    const skillLink = screen.getByTestId("library-skill-operator-skill") as HTMLAnchorElement;
    expect(skillLink).toBeDefined();
    expect(skillLink.getAttribute("href")).toBe(librarySkillHref("workspace:workspace:.openrig/skills/operator-skill"));
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
      if (url === "/api/files/roots") {
        return {
          ok: true,
          json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }),
        };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "operator-skill", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills%2Foperator-skill") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      if (url === "/api/files/read?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fopenrig-user%2FSKILL.md") {
        return {
          ok: true,
          json: async () => ({
            root: "workspace",
            path: "packages/daemon/specs/agents/shared/skills/openrig-user/SKILL.md",
            absolutePath: "/workspace/packages/daemon/specs/agents/shared/skills/openrig-user/SKILL.md",
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

    const packagedSkillId = "openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/openrig-user";
    renderSkillDetail(librarySkillToken(packagedSkillId));

    expect(await screen.findByTestId("skill-detail-page")).toBeDefined();
    expect(await screen.findByText(/Packaged skill/)).toBeDefined();
  });

  it("opens a selected skill file from the route token", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return {
          ok: true,
          json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }),
        };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "operator-skill", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills%2Foperator-skill") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }, { name: "DETAILS.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      if (url === "/api/files/read?root=workspace&path=.openrig%2Fskills%2Foperator-skill%2FDETAILS.md") {
        return {
          ok: true,
          json: async () => ({
            root: "workspace",
            path: ".openrig/skills/operator-skill/DETAILS.md",
            absolutePath: "/workspace/.openrig/skills/operator-skill/DETAILS.md",
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

    const skillId = "workspace:workspace:.openrig/skills/operator-skill";
    renderSkillDetail(librarySkillToken(skillId), librarySkillFileToken(".openrig/skills/operator-skill/DETAILS.md"));

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

    // Section renders with both plugins listed; source labels distinguish layers.
    await waitFor(() => {
      expect(screen.getByTestId("library-section-plugins")).toBeDefined();
    });
    expect(await screen.findByTestId("library-plugin-openrig-core")).toBeDefined();
    expect(await screen.findByTestId("library-plugin-claude-cache:anthropics/github/1.0.0")).toBeDefined();

    // Source labels visible (distinct per source kind — drift discriminator).
    expect(screen.getByText("vendored:openrig-core")).toBeDefined();
    expect(screen.getByText("claude-cache:anthropics/github/1.0.0")).toBeDefined();
  });

  it("auto-expands the skills explorer on skill detail routes", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/specs/library" || url === "/api/context-packs/library" || url === "/api/agent-images/library") {
        return { ok: true, json: async () => [] };
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
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "operator-skill", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills%2Foperator-skill") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }, { name: "DETAILS.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { status: 404, ok: false, json: async () => ({ error: "not_found" }) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const skillId = "workspace:workspace:.openrig/skills/operator-skill";
    renderSpecsTree(`/specs/skills/${librarySkillToken(skillId)}`);

    expect(await screen.findByTestId("specs-section-skills")).toBeDefined();
    expect(await screen.findByTestId("specs-leaf-workspace:workspace:.openrig/skills/operator-skill")).toBeDefined();
    expect(await screen.findByTestId("specs-skill-file-SKILL.md")).toBeDefined();
    expect(screen.queryByRole("img", { name: "SKILL.md" })).toBeNull();
  });
});
