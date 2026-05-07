import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SpecsLibraryPage } from "../src/components/specs/SpecsLibraryPage.js";
import { createTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();

beforeEach(() => {
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderLibraryPage() {
  return render(
    createTestRouter({
      path: "/specs",
      component: () => <SpecsLibraryPage />,
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
            { id: "workflow:rsi:1", kind: "workflow", name: "rsi-loop", version: "1", sourceType: "builtin", sourcePath: "/pkg/workflow.yaml", relativePath: "workflow.yaml" },
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
    });

    expect(screen.getByText("implementer")).toBeDefined();
    expect(screen.getByText("driver-image")).toBeDefined();
    expect(screen.getByTestId("library-skill-operator-skill")).toBeDefined();
    expect(screen.getByTestId("library-skill-openrig-user")).toBeDefined();
    expect(await screen.findByText(/Skill body/)).toBeDefined();
  });
});
