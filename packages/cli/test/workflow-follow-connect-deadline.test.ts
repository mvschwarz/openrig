import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { followInstance } from "../src/commands/workflow-follow.js";
import { DaemonClient } from "../src/client.js";

it.each(["initial-stall", "retry-stall", "healthy-idle"] as const)(
  "bounds SSE header waits while preserving %s",
  async (mode) => {
    let streams = 0;
    let traces = 0;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const server = createServer((req, res) => {
      if (req.url === "/api/workflow/sse") {
        streams++;
        if (mode === "initial-stall" || (mode === "retry-stall" && streams > 1)) {
          timers.push(setTimeout(() => {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.end();
          }, 600));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders();
        if (mode === "retry-stall") res.end();
        else timers.push(setTimeout(() => res.end(`data: ${JSON.stringify({
          type: "workflow.completed", instanceId: "instance",
        })}\n\n`), 300));
        return;
      }
      traces++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        instance: {
          instanceId: "instance",
          status: mode === "initial-stall" || (mode === "retry-stall" && traces > 1) ? "completed" : "active",
        },
        trail: [],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const out: string[] = [];
    const err: string[] = [];
    const started = performance.now();
    try {
      const exit = await followInstance(new DaemonClient(`http://127.0.0.1:${address.port}`), "instance", {
        json: true, maxReconnects: 1, pollIntervalMs: 1, streamConnectTimeoutMs: 100,
        io: { out: (line) => out.push(line), err: (line) => err.push(line), sleep: async () => {}, fetchImpl: fetch },
      });
      expect(exit).toBe(0);
      const elapsed = performance.now() - started;
      if (mode !== "healthy-idle") expect(elapsed).toBeLessThan(450);
      else {
        expect(elapsed).toBeGreaterThanOrEqual(250);
        expect(streams).toBe(1);
        expect(err).toEqual([]);
        expect(out.some((line) => line.includes("workflow.completed"))).toBe(true);
      }
    } finally {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  },
);
