// Slice 28 Checkpoint B — useLibrarySkills nested-discovery regression.
//
// HG-5 root cause: useLibrarySkills pre-slice-28 listed each candidate
// skills base path (e.g. `packages/daemon/specs/agents/shared/skills`),
// treated every top-level dir as a candidate skill folder, and dropped
// any dir that didn't have markdown files at its immediate level. The
// real shared-skills tree mixes flat skill folders (depth 1, e.g.
// `claude-compact-in-place/SKILL.md`) with category folders that
// contain skill folders one level deeper (depth 2, e.g.
// `core/openrig-user/SKILL.md`). Categories were skipped, so every
// nested skill was missing — "No skills yet" on the VM.
//
// Checkpoint B fix: useLibrarySkills now recurses ONE level when a
// candidate folder has no markdown but has subdirs. MAX_NESTING_DEPTH=1
// caps the recursion at the observed-on-disk structure.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useLibrarySkills } from "../src/hooks/useLibrarySkills.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

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

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("useLibrarySkills — nested-category discovery (slice 28 HG-5)", () => {
  it("discovers a skill at depth-1 (flat: skills/<skill>/SKILL.md)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "claude-compact-in-place", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fclaude-compact-in-place") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const names = (result.current.data ?? []).map((s) => s.name);
    expect(names).toContain("claude-compact-in-place");
  });

  it("HG-5 ROOT CAUSE FIX: discovers a skill at depth-2 (nested: skills/<category>/<skill>/SKILL.md)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        // Top level under skills base: a single category dir (no markdown).
        return { ok: true, json: async () => fileList([{ name: "core", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore") {
        // Category dir contents: skill subdirs (no markdown files here).
        return {
          ok: true,
          json: async () =>
            fileList([
              { name: "openrig-user", type: "dir" },
              { name: "openrig-architect", type: "dir" },
            ]),
        };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore%2Fopenrig-architect") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const names = (result.current.data ?? []).map((s) => s.name);

    // Discriminator: pre-slice-28 the hook would have returned [] for this fixture
    // because `core/` has no .md files at its immediate level. Slice 28 recurses
    // into category folders to find nested skill leaves.
    expect(names).toContain("openrig-user");
    expect(names).toContain("openrig-architect");
  });

  it("MIXED LAYOUT: discovers both flat and nested skills in the same base path", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return {
          ok: true,
          json: async () =>
            fileList([
              { name: "claude-compact-in-place", type: "dir" }, // flat skill
              { name: "core", type: "dir" }, // category
            ]),
        };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fclaude-compact-in-place") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const names = (result.current.data ?? []).map((s) => s.name);
    expect(names).toContain("claude-compact-in-place"); // flat
    expect(names).toContain("openrig-user"); // nested
    // Category folder name itself ("core") should NOT appear as a skill —
    // it has no markdown at its level.
    expect(names).not.toContain("core");
  });

  it("DEPTH-CAP: does not recurse beyond depth-1 (skills/<cat>/<sub-cat>/<skill> is NOT discovered)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "outer-cat", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fouter-cat") {
        // depth-1 listing: only a subdir (no markdown). Per MAX_NESTING_DEPTH=1
        // we MAY recurse into it (this is depth 1 → next would be depth 2,
        // depth < MAX_NESTING_DEPTH is false → stop).
        return { ok: true, json: async () => fileList([{ name: "inner-cat", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fouter-cat%2Finner-cat") {
        return { ok: true, json: async () => fileList([{ name: "deep-skill", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fouter-cat%2Finner-cat%2Fdeep-skill") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const names = (result.current.data ?? []).map((s) => s.name);
    // depth-3 skill should NOT be discovered with MAX_NESTING_DEPTH=1.
    // (depth 0 = outer-cat probed; depth 1 = inner-cat probed; depth 2 would be
    // deep-skill — not reached.)
    expect(names).not.toContain("deep-skill");
  });

  it("OPENRIG-MANAGED SOURCE: nested skill resolves with the correct source label", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([{ name: "core", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore") {
        return { ok: true, json: async () => fileList([{ name: "openrig-user", type: "dir" }]) };
      }
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills%2Fcore%2Fopenrig-user") {
        return { ok: true, json: async () => fileList([{ name: "SKILL.md", type: "file" }]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const skill = (result.current.data ?? []).find((s) => s.name === "openrig-user");
    expect(skill).toBeDefined();
    expect(skill!.source).toBe("openrig-managed");
    expect(skill!.directoryPath).toBe(
      "packages/daemon/specs/agents/shared/skills/core/openrig-user",
    );
    expect(skill!.id).toBe(
      "openrig-managed:workspace:packages/daemon/specs/agents/shared/skills/core/openrig-user",
    );
    // SKILL.md is the only md file under the leaf folder.
    expect(skill!.files.map((f) => f.name)).toEqual(["SKILL.md"]);
  });

  it("EMPTY DIRECTORY: returns no skills when base path has no entries", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url === "/api/files/roots") {
        return { ok: true, json: async () => ({ roots: [{ name: "workspace", path: "/workspace" }] }) };
      }
      if (url === "/api/files/list?root=workspace&path=.openrig%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=node_modules%2F%40openrig%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") return NOT_FOUND;
      if (url === "/api/files/list?root=workspace&path=packages%2Fdaemon%2Fspecs%2Fagents%2Fshared%2Fskills") {
        return { ok: true, json: async () => fileList([]) };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { result } = renderHook(() => useLibrarySkills(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data ?? []).toHaveLength(0);
  });
});
