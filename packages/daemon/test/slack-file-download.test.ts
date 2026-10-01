import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { downloadPrivateFile } from "../src/domain/gateway/slack/slack-api.js";

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
    try {
      const small = await downloadPrivateFile(`${base}/small`, "fixture-only", fetch, 5_000, maxBytes);
      expect(small.ok).toBe(true);
      if (!small.ok) throw new Error(small.error);
      expect(Buffer.from(small.bytes)).toEqual(Buffer.alloc(maxBytes, 0x42));

      const large = await downloadPrivateFile(`${base}/large`, "fixture-only", fetch, 5_000, maxBytes);
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
