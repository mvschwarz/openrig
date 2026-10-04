import { expect, it } from "vitest";
import http from "node:http";
import { getEventListeners } from "node:events";
import { fetchWithTimeout } from "../src/fetch-with-timeout.js";

it("does not retain per-request listeners on a reusable caller signal after native requests", async () => {
  const server = http.createServer((_req, res) => res.end("owned response"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const caller = new AbortController();
  try {
    for (let i = 0; i < 12; i++) {
      await fetchWithTimeout(fetch, url, { signal: caller.signal }, {
        timeoutMs: 1000,
        timeoutMessage: "owned request timeout",
        consumeResponse: async (response) => { await response.text(); },
      });
    }
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    expect(caller.signal.aborted).toBe(false);
  } finally {
    caller.abort();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("still forwards caller cancellation after native streaming response headers", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("owned first chunk");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const caller = new AbortController();
  try {
    const response = await fetchWithTimeout(fetch,
      `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      { signal: caller.signal }, { timeoutMs: 1000, timeoutMessage: "owned header timeout" });
    const reader = response.body!.getReader();
    await reader.read();
    caller.abort(new Error("owned stream cancellation"));
    await expect(reader.read()).rejects.toThrow();
    reader.releaseLock();
  } finally {
    caller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("keeps string cancellation reasons as Error messages during a native request", async () => {
  const caller = new AbortController();
  const server = http.createServer(() => caller.abort("owned canceled request"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(fetchWithTimeout(fetch,
      `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
      { signal: caller.signal }, { timeoutMs: 1000, timeoutMessage: "owned timeout" }))
      .rejects.toThrow("owned canceled request");
  } finally {
    caller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
