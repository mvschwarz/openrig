import { describe, it, expect, vi } from "vitest";
import { fetchWithTimeout, FetchTimeoutError } from "../src/fetch-with-timeout.js";

describe("fetchWithTimeout", () => {
  it("shares one deadline across waiting for headers and reading the body", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      let headersReceived = false;
      const fetchImpl: typeof fetch = async (_url, init) => {
        signal = init?.signal ?? undefined;
        await new Promise((resolve) => setTimeout(resolve, 600));
        headersReceived = true;
        return new Response("body");
      };
      const result = fetchWithTimeout(fetchImpl, "http://localhost:7433/read", {}, {
        timeoutMs: 1_000,
        timeoutMessage: "complete request timed out",
        consumeResponse: async () => {
          await new Promise<void>((resolve, reject) => {
            setTimeout(resolve, 600);
            signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          });
        },
      }).then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(600);
      expect(headersReceived).toBe(true);
      expect(signal!.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(400);
      expect(signal!.aborted).toBe(true);
      expect(await result).toBeInstanceOf(FetchTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects with FetchTimeoutError when fetch blackholes", async () => {
    const fetchImpl: typeof fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    })) as typeof fetch;

    await expect(
      fetchWithTimeout(fetchImpl, "http://localhost:7433/healthz", {}, {
        timeoutMs: 20,
        timeoutMessage: "probe timed out",
      }),
    ).rejects.toThrow(FetchTimeoutError);
  });

  it("removes the abort listener from externalSignal once the request completes or fails", async () => {
    const { getEventListeners } = await import("node:events");
    const parent = new AbortController();
    const fakeFetch: typeof fetch = async () => new Response("ok");

    for (let i = 0; i < 5; i++) {
      await fetchWithTimeout(fakeFetch, "https://example.test/", { signal: parent.signal }, {
        timeoutMs: 1000,
        timeoutMessage: "timed out",
        consumeResponse: async (response) => {
          await response.text();
        },
      });
      expect(getEventListeners(parent.signal, "abort").length).toBe(0);
    }

    const failingFetch: typeof fetch = async () => {
      throw new Error("network error");
    };

    await expect(
      fetchWithTimeout(failingFetch, "https://example.test/", { signal: parent.signal }, {
        timeoutMs: 1000,
        timeoutMessage: "timed out",
      }),
    ).rejects.toThrow("network error");

    expect(getEventListeners(parent.signal, "abort").length).toBe(0);
  });

  it("handles pre-aborted external signal without leaking listeners", async () => {
    const { getEventListeners } = await import("node:events");
    const parent = new AbortController();
    parent.abort(new Error("pre-aborted"));

    await expect(
      fetchWithTimeout(async () => new Response("ok"), "https://example.test/", { signal: parent.signal }, {
        timeoutMs: 1000,
        timeoutMessage: "timed out",
      }),
    ).rejects.toThrow("pre-aborted");

    expect(getEventListeners(parent.signal, "abort").length).toBe(0);
  });
});
