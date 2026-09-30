import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { ComposeServicesAdapter } from "../src/adapters/compose-services-adapter.js";
import { execCommand } from "../src/adapters/tmux-exec.js";
import { evaluateWaitTargets } from "../src/domain/services-readiness.js";

// Exercise production curl against an owned loopback server; no remote services.
describe.skipIf(process.platform === "win32")("HTTP service readiness", () => {
  it("requires a 2xx response, including when a login redirect responds successfully", async () => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.url!);
      const code = Number(req.url!.slice(1));
      if (code >= 300 && code < 400) res.setHeader("Location", "/200");
      res.writeHead(code);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const codes = [200, 204, 299, 302, 303, 307, 400, 500];
      const results = await evaluateWaitTargets(codes.map(code => ({ url: `${base}/${code}` })), new ComposeServicesAdapter(execCommand));
      expect(seen).toEqual(codes.map(code => `/${code}`));
      expect(results.map(result => result.status)).toEqual([
        "healthy", "healthy", "healthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy", "unhealthy",
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
