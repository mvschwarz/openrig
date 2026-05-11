// 0.3.1 slice 06 forward-fix #2 — integration test for the
// production wire that crosses the client → /api/files/read
// boundary. Exercises absolute-slicePath → relative-path conversion
// against /api/files/roots, then asserts /api/files/read is called
// with the relative path (rejecting absolute would 4xx on the
// daemon side).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  useSliceTimelineMarkdown,
  resolveSlicePathToAllowlist,
} from "../src/hooks/useSliceTimelineMarkdown.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("resolveSlicePathToAllowlist (pure)", () => {
  it("matches the deepest root that prefixes the absolute slice path", () => {
    const roots = [
      { name: "home",   path: "/Users/x" },
      { name: "substrate", path: "/Users/x/code/substrate" },
      { name: "workspace", path: "/Users/x/code/substrate/shared-docs/openrig-work" },
    ];
    const r = resolveSlicePathToAllowlist(
      roots,
      "/Users/x/code/substrate/shared-docs/openrig-work/missions/release-0.3.1/slices/06-storytelling-primitives",
    );
    expect(r).not.toBeNull();
    expect(r!.rootName).toBe("workspace");
    expect(r!.relPath).toBe("missions/release-0.3.1/slices/06-storytelling-primitives");
  });

  it("returns null when no allowlist root contains the absolute path", () => {
    const roots = [{ name: "workspace", path: "/Users/x/code/openrig-work" }];
    const r = resolveSlicePathToAllowlist(roots, "/somewhere/else/slice");
    expect(r).toBeNull();
  });

  it("treats an exact match as zero-length relative path", () => {
    const roots = [{ name: "ws", path: "/Users/x/work" }];
    const r = resolveSlicePathToAllowlist(roots, "/Users/x/work");
    expect(r).toEqual({ rootName: "ws", relPath: "" });
  });

  it("does NOT mistake `/work` as a prefix of `/workspace` (segment-boundary aware)", () => {
    const roots = [{ name: "ws", path: "/Users/x/work" }];
    const r = resolveSlicePathToAllowlist(roots, "/Users/x/workspace/slice");
    expect(r).toBeNull();
  });
});

describe("useSliceTimelineMarkdown — production wire calls /api/files/read with the relative path", () => {
  it("converts absolute slicePath to (root, relPath) via /api/files/roots and calls /api/files/read with the relative path", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [
            { name: "substrate", path: "/Users/example/code/substrate" },
            { name: "workspace", path: "/Users/example/code/substrate/shared-docs/openrig-work" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/files/read")) {
        return new Response(JSON.stringify({
          root: "workspace",
          path: "missions/release-0.3.1/slices/06-storytelling-primitives/timeline.md",
          absolutePath: "/Users/example/code/substrate/shared-docs/openrig-work/missions/release-0.3.1/slices/06-storytelling-primitives/timeline.md",
          content: "---\nkind: incident-timeline\n---\n\nBody.\n",
          mtime: "2026-05-10T00:00:00Z",
          contentHash: "abc",
          size: 50,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    const absoluteSlicePath = "/Users/example/code/substrate/shared-docs/openrig-work/missions/release-0.3.1/slices/06-storytelling-primitives";
    const { result } = renderHook(
      () => useSliceTimelineMarkdown(absoluteSlicePath),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toContain("kind: incident-timeline");
    expect(result.current.resolved).toEqual({
      rootName: "workspace",
      relPath: "missions/release-0.3.1/slices/06-storytelling-primitives",
    });

    // Assert the actual /api/files/read call shape — root + relPath
    // are properly URL-encoded; the path is RELATIVE not absolute.
    const readCall = fetchSpy.mock.calls.find((c) => String(c[0]).startsWith("/api/files/read"));
    expect(readCall).toBeDefined();
    const readUrl = new URL(`http://localhost${readCall![0]}`);
    expect(readUrl.searchParams.get("root")).toBe("workspace");
    expect(readUrl.searchParams.get("path")).toBe("missions/release-0.3.1/slices/06-storytelling-primitives/timeline.md");
    // Negative: must NOT be the absolute path that the daemon would reject.
    expect(readUrl.searchParams.get("path")).not.toMatch(/^\//);
  });

  it("returns unavailable=true when no allowlist root contains the absolute slice path", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "ws", path: "/Users/example/code/openrig-work" }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const { result } = renderHook(
      () => useSliceTimelineMarkdown("/somewhere/totally/different/slice"),
      { wrapper: makeWrapper() },
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
    expect(result.current.resolved).toBeNull();
    // /api/files/read was NOT called — no relative path could be
    // computed, so the hook short-circuits before issuing the read.
    const readCall = fetchSpy.mock.calls.find((c) => String(c[0]).startsWith("/api/files/read"));
    expect(readCall).toBeUndefined();
  });

  it("returns unavailable=true when /api/files/read returns 404 (timeline.md absent)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "workspace", path: "/Users/example/code/openrig-work" }],
        }), { status: 200 });
      }
      if (url.startsWith("/api/files/read")) {
        return new Response("file not found", { status: 404 });
      }
      return new Response("?", { status: 500 });
    });
    const { result } = renderHook(
      () => useSliceTimelineMarkdown("/Users/example/code/openrig-work/slices/some-slice"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
  });
});
