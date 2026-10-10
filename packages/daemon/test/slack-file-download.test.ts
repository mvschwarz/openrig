import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { downloadPrivateFile } from "../src/domain/gateway/slack/slack-api.js";

describe("Slack private-file download host gate", () => {
  it("refuses a non-Slack host before any request, so the Bearer token never leaves", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("body", { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as unknown as typeof fetch;
    const r = await downloadPrivateFile(
      "https://evilslack.com/files-pri/T1-FX/steal.png",
      "xoxb-test-token",
      spyFetch,
      5_000,
      32_768,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected a host refusal");
    expect(r.error).toContain("non-Slack");
    expect(calls, "no request may leave with the token").toBe(0);
  });

  it("refuses a plain-http URL even when its hostname looks like Slack", async () => {
    let calls = 0;
    const spyFetch = (async () => {
      calls += 1;
      return new Response("body", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await downloadPrivateFile("http://files.slack.com/files-pri/T1/x", "xoxb-test-token", spyFetch, 5_000, 32_768);
    expect(r.ok).toBe(false);
    expect(calls).toBe(0);
  });
});

describe("Slack private-file download size bound", () => {
  it("preserves an exact-limit file and cancels an oversized chunked HTTP response before its end", async () => {
    const maxBytes = 32_768;
    const chunkBytes = 8_192;
    let oversizedSent = 0;
    let oversizedFinished = false;
    let recordClosed!: () => void;
    const oversizedClosed = new Promise<void>((resolve) => { recordClosed = resolve; });
    const server = http.createServer((req, res) => {
      const oversized = req.url === "/large";
      const total = oversized ? maxBytes * 16 : maxBytes;
      let sent = 0;
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const timer = setInterval(() => {
        if (sent >= total) { clearInterval(timer); res.end(); return; }
        sent += chunkBytes;
        res.write(Buffer.alloc(chunkBytes, 0x42));
      }, 2);
      res.on("close", () => {
        clearInterval(timer);
        if (oversized) {
          oversizedSent = sent;
          oversizedFinished = res.writableFinished;
          recordClosed();
        }
      });
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Slack-shaped URL for the host gate; the injected fetchImpl is the seam
    // that forwards to the local fixture server, keeping the real streaming
    // boundary under test.
    const toLocalFixture = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw);
      return fetch(`${base}${u.pathname}`, init);
    }) as typeof fetch;
    try {
      const small = await downloadPrivateFile(`https://files.slack.com/small`, "fixture-only", toLocalFixture, 5_000, maxBytes);
      expect(small.ok).toBe(true);
      if (!small.ok) throw new Error(small.error);
      expect(Buffer.from(small.bytes)).toEqual(Buffer.alloc(maxBytes, 0x42));

      const large = await downloadPrivateFile(`https://files.slack.com/large`, "fixture-only", toLocalFixture, 5_000, maxBytes);
      expect(large.ok).toBe(false);
      if (large.ok) throw new Error("oversized download was accepted");
      expect(large.error).toContain("exceeds size bound");
      await oversizedClosed;
      expect(oversizedSent).toBeLessThan(maxBytes * 16);
      expect(oversizedFinished).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); });
    }
  });
});
