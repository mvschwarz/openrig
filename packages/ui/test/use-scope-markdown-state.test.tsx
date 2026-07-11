// R1 (release-0.4.7) — C2: useScopeMarkdown discriminated `state` matrix.
//
// The shared read hook stops collapsing three different truths into one
// `{content:null, unavailable:true}`. It now exposes a discriminated `state`
// (idle | unresolved | absent | read_error | content) while keeping
// `unavailable` as a DERIVED back-compat field. This file pins the full state
// matrix AND asserts the derived `unavailable` equals its 8250d702 value at
// every settled state (the byte-compat leg). The two pre-R1 canary tests live
// UNMODIFIED in use-scope-markdown.test.tsx.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useScopeMarkdown } from "../src/hooks/useScopeMarkdown.js";

const originalFetch = globalThis.fetch;
let fetchSpy: ReturnType<typeof vi.fn>;

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
}

const WS = { name: "ws", path: "/Users/example/.openrig/shared-docs/internal-docs" };
const SCOPE = "/Users/example/.openrig/shared-docs/internal-docs/missions/m";

function rootsOk(roots = [WS]) {
  return new Response(JSON.stringify({ roots }), { status: 200 });
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

async function settle(scope: string | null) {
  const { result } = renderHook(() => useScopeMarkdown(scope, "PROGRESS.md"), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(result.current.isLoading).toBe(false));
  return result;
}

describe("useScopeMarkdown — discriminated state matrix (R1)", () => {
  it("read 404 → state 'absent' (genuine absence), unavailable=true", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return rootsOk();
      return new Response("missing", { status: 404 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("absent");
    expect(r.current.unavailable).toBe(true);
    expect(r.current.content).toBeNull();
  });

  it("read 500 → state 'read_error' (infra, not absence), unavailable=true", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return rootsOk();
      return new Response("boom", { status: 500 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("read_error");
    expect(r.current.unavailable).toBe(true);
  });

  it("read 400 → state 'unresolved' (bad-path groups into the config class)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return rootsOk();
      return new Response("bad", { status: 400 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("unresolved");
    expect(r.current.unavailable).toBe(true);
  });

  it("roots loaded but no containing root → state 'unresolved', unavailable=true", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots"))
        return rootsOk([{ name: "other", path: "/somewhere/else" }]);
      return new Response("?", { status: 404 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("unresolved");
    expect(r.current.unavailable).toBe(true);
    // no containing root ⇒ the read never fires
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/files/read"))).toEqual([]);
  });

  it("roots [] → state 'unresolved'", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return rootsOk([]);
      return new Response("?", { status: 404 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("unresolved");
  });

  it("roots-fetch 500 → state 'read_error' (G7: infra must not masquerade as config)", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return new Response("down", { status: 500 });
      return new Response("?", { status: 404 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("read_error");
    expect(r.current.unavailable).toBe(true);
  });

  it("null scope path → state 'idle' + ZERO /api/files/* requests, unavailable=true", async () => {
    fetchSpy.mockImplementation(async () => rootsOk([]));
    const r = await settle(null);
    expect(r.current.state).toBe("idle");
    expect(r.current.unavailable).toBe(true);
    expect(r.current.resolved).toBeNull();
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"))).toEqual([]);
  });

  it("read 200 + content → state 'content', unavailable=false", async () => {
    fetchSpy.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/files/roots")) return rootsOk();
      return new Response(JSON.stringify({
        root: "ws",
        path: "missions/m/PROGRESS.md",
        absolutePath: `${SCOPE}/PROGRESS.md`,
        content: "# Progress\n",
        mtime: "2026-07-10T00:00:00Z",
        contentHash: "h",
        size: 11,
      }), { status: 200 });
    });
    const r = await settle(SCOPE);
    expect(r.current.state).toBe("content");
    expect(r.current.unavailable).toBe(false);
    expect(r.current.content).toContain("# Progress");
  });
});
