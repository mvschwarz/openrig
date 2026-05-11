// V0.3.1 slice 12 walk-item 1 — useScopeMarkdown generalization tests.
//
// useScopeMarkdown(scopePath, filename) generalizes the slice-06 era
// useSliceTimelineMarkdown to read any markdown file under any project
// scope (mission, slice, workspace). The backward-compat shim at
// useSliceTimelineMarkdown.ts is exercised separately; this file
// exercises the generalized hook directly with the README.md and
// PROGRESS.md filenames the Mission tabs consume.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  useScopeMarkdown,
  resolveScopePathToAllowlist,
} from "../src/hooks/useScopeMarkdown.js";

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

describe("resolveScopePathToAllowlist (pure)", () => {
  it("matches the deepest root that prefixes the absolute scope path", () => {
    const roots = [
      { name: "home", path: "/Users/x" },
      { name: "substrate", path: "/Users/x/code/substrate" },
      { name: "workspace", path: "/Users/x/code/substrate/shared-docs/openrig-work" },
    ];
    const r = resolveScopePathToAllowlist(
      roots,
      "/Users/x/code/substrate/shared-docs/openrig-work/missions/release-0.3.1",
    );
    expect(r).not.toBeNull();
    expect(r!.rootName).toBe("workspace");
    expect(r!.relPath).toBe("missions/release-0.3.1");
  });

  it("returns null when no allowlist root contains the absolute path", () => {
    const roots = [{ name: "ws", path: "/Users/x/code/openrig-work" }];
    expect(resolveScopePathToAllowlist(roots, "/somewhere/else")).toBeNull();
  });
});

describe("useScopeMarkdown — production wire honors arbitrary filename", () => {
  it("fetches <scopePath>/README.md when filename='README.md' (mission Overview tab path)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [
            { name: "workspace", path: "/Users/example/code/openrig-work" },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.startsWith("/api/files/read")) {
        return new Response(JSON.stringify({
          root: "workspace",
          path: "missions/getting-started/README.md",
          absolutePath: "/Users/example/code/openrig-work/missions/getting-started/README.md",
          content: "---\nstatus: active\n---\n# Getting Started\n",
          mtime: "2026-05-11T00:00:00Z",
          contentHash: "rdme",
          size: 50,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });

    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/code/openrig-work/missions/getting-started",
        "README.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toContain("# Getting Started");
    const readCall = fetchSpy.mock.calls.find((c) => String(c[0]).startsWith("/api/files/read"));
    expect(readCall).toBeDefined();
    const url = new URL(`http://localhost${readCall![0]}`);
    expect(url.searchParams.get("root")).toBe("workspace");
    expect(url.searchParams.get("path")).toBe("missions/getting-started/README.md");
  });

  it("fetches <scopePath>/PROGRESS.md when filename='PROGRESS.md' (mission Progress tab path)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "ws", path: "/Users/example/code/openrig-work" }],
        }), { status: 200 });
      }
      if (url.startsWith("/api/files/read")) {
        const reqUrl = new URL(`http://localhost${url}`);
        expect(reqUrl.searchParams.get("path")).toBe("missions/getting-started/PROGRESS.md");
        return new Response(JSON.stringify({
          root: "ws",
          path: "missions/getting-started/PROGRESS.md",
          absolutePath: "/Users/example/code/openrig-work/missions/getting-started/PROGRESS.md",
          content: "# Progress\n\n## Done\n- thing 1\n",
          mtime: "2026-05-11T00:00:00Z",
          contentHash: "prog",
          size: 25,
        }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    });

    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/code/openrig-work/missions/getting-started",
        "PROGRESS.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.content).toContain("## Done");
  });

  it("returns unavailable=true when scopePath is null (no scope selected)", async () => {
    fetchSpy.mockImplementation(async () => new Response(JSON.stringify({ roots: [] }), { status: 200 }));
    const { result } = renderHook(
      () => useScopeMarkdown(null, "README.md"),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
    expect(result.current.resolved).toBeNull();
  });

  it("returns unavailable=true when file is missing on disk (404 from /api/files/read)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) {
        return new Response(JSON.stringify({
          roots: [{ name: "ws", path: "/Users/example/code/openrig-work" }],
        }), { status: 200 });
      }
      if (url.startsWith("/api/files/read")) return new Response("missing", { status: 404 });
      return new Response("?", { status: 500 });
    });
    const { result } = renderHook(
      () => useScopeMarkdown(
        "/Users/example/code/openrig-work/missions/empty",
        "PROGRESS.md",
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(true);
    expect(result.current.content).toBeNull();
  });
});
