import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DaemonClient, DaemonTimeoutError } from "../src/client.js";

let server: http.Server | undefined;
afterEach(async () => {
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function slowBodyServer(delayMs: number) {
  let requests = 0;
  let closedBeforeEnd = 0;
  server = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the actual request body */ }
    requests++;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":'); // fetch resolves headers, while body remains incomplete
    const timer = setTimeout(() => res.end("true}"), delayMs);
    res.on("close", () => {
      if (!res.writableEnded) closedBeforeEnd++;
      clearTimeout(timer);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests: () => requests, closedBeforeEnd: () => closedBeforeEnd };
}

describe("DaemonClient response body deadline", () => {
  it.each(["json", "text", "write"])("bounds %s body reads after headers arrive", async (kind) => {
    const endpoint = await slowBodyServer(250);
    const client = new DaemonClient(endpoint.url, { timeoutMs: 40 });
    const request = kind === "json" ? client.get("/read") : kind === "text" ? client.getText("/read") : client.post("/write", { action: "once" });
    await expect(request).rejects.toBeInstanceOf(DaemonTimeoutError);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(endpoint.requests()).toBe(1); // no automatic retry of an accepted write
    expect(endpoint.closedBeforeEnd()).toBe(1); // cancel the body/socket, not just the caller promise
  });

  it("uses the per-request deadline through the complete body", async () => {
    const endpoint = await slowBodyServer(60);
    const client = new DaemonClient(endpoint.url, { timeoutMs: 20 });
    await expect(client.get("/read", { timeoutMs: 200 })).resolves.toEqual({ status: 200, data: { ok: true } });
    expect(endpoint.requests()).toBe(1);
    expect(endpoint.closedBeforeEnd()).toBe(0);
  });
});
