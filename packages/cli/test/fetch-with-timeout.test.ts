import { getEventListeners } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { fetchWithTimeout, FetchTimeoutError } from "../src/fetch-with-timeout.js";

describe("fetchWithTimeout", () => {
  it("releases the caller's abort listener after each settled request", async () => {
    const signal = new AbortController().signal;
    const options = { timeoutMs: 1_000, timeoutMessage: "request timed out" };
    const fetchImpl: typeof fetch = async () => new Response("ok");

    for (let i = 0; i < 12; i++) {
      await fetchWithTimeout(fetchImpl, "http://localhost:7433/read", { signal }, options);
    }
    expect(getEventListeners(signal, "abort")).toHaveLength(0);

    const failingFetch: typeof fetch = async () => {
      throw new Error("network failed");
    };
    await expect(fetchWithTimeout(failingFetch, "http://localhost:7433/read", { signal }, options))
      .rejects.toThrow("network failed");
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  });

  it("still forwards a caller abort while the request is pending", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });

    const request = fetchWithTimeout(fetchImpl, "http://localhost:7433/read", { signal: controller.signal }, {
      timeoutMs: 1_000,
      timeoutMessage: "request timed out",
    });
    controller.abort(reason);

    await expect(request).rejects.toBe(reason);
  });

  it("still forwards caller aborts after headers settle for streaming callers", async () => {
    const controller = new AbortController();
    const reason = new Error("stop streaming");
    let requestSignal: AbortSignal | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Response("stream headers");
    };

    await fetchWithTimeout(fetchImpl, "http://localhost:7433/stream", { signal: controller.signal }, {
      timeoutMs: 1_000,
      timeoutMessage: "stream connection timed out",
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    controller.abort(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  it("normalizes a non-Error caller abort reason", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const request = fetchWithTimeout(fetchImpl, "http://localhost:7433/read", { signal: controller.signal }, {
      timeoutMs: 1_000,
      timeoutMessage: "request timed out",
    });

    controller.abort("caller cancelled");
    await expect(request).rejects.toThrow("caller cancelled");
  });

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
});
