// R1 (release-0.4.7) — C1: fetchRead surfaces a typed, discriminated failure.
//
// The shared file reader stops throwing an opaque `new Error("HTTP <status>")`
// and instead throws a `FilesReadError` that carries the daemon's status
// distinction as a `code` (absent | read_error | bad_path) while keeping the
// SAME `message` text ("HTTP <status>") — the message-compat pin (arch). We
// exercise it through the public `useFilesRead` hook (react-query surfaces the
// thrown error on `query.error`), so no internal export is added.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { useFilesRead, FilesReadError } from "../src/hooks/useFiles.js";

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

async function readErrorFor(status: number): Promise<unknown> {
  fetchSpy.mockImplementation(async () => new Response("x", { status }));
  const { result } = renderHook(() => useFilesRead("ws", "some/file.md"), {
    wrapper: makeWrapper(),
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  return result.current.error;
}

describe("fetchRead typed failure (FilesReadError)", () => {
  it("404 → FilesReadError{code:'absent'} with message byte-same 'HTTP 404'", async () => {
    const err = await readErrorFor(404);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("absent");
    expect((err as FilesReadError).status).toBe(404);
    // message-compat pin: identical text to the pre-split `new Error("HTTP 404")`
    expect((err as Error).message).toBe("HTTP 404");
    // name kept "Error" so any `${err}` / err.name render stays byte-identical
    expect((err as Error).name).toBe("Error");
  });

  it("500 → FilesReadError{code:'read_error'} (infra, not absence)", async () => {
    const err = await readErrorFor(500);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("read_error");
    expect((err as Error).message).toBe("HTTP 500");
  });

  it("400 → FilesReadError{code:'bad_path'} (the config/path-shape class)", async () => {
    const err = await readErrorFor(400);
    expect(err).toBeInstanceOf(FilesReadError);
    expect((err as FilesReadError).code).toBe("bad_path");
    expect((err as Error).message).toBe("HTTP 400");
  });

  it("a FilesReadError is still an Error (subclass — `read.error as Error` casts stay valid)", async () => {
    const err = await readErrorFor(404);
    expect(err).toBeInstanceOf(Error);
  });
});
