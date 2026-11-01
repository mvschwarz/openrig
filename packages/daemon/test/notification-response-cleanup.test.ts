import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { NtfyNotificationAdapter } from "../src/domain/mission-control/notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "../src/domain/mission-control/notification-adapter-webhook.js";

const adapters = [
  { name: "ntfy", create: (url: string, fetchImpl?: typeof fetch) => new NtfyNotificationAdapter({ topicUrl: url, fetchImpl }) },
  { name: "webhook", create: (url: string, fetchImpl?: typeof fetch) => new WebhookNotificationAdapter({ endpointUrl: url, fetchImpl }) },
];

describe.each(adapters)("$name response cleanup", ({ name, create }) => {
  it.each([200, 503])("releases an unfinished HTTP %i response after reading its status", async (status) => {
    let responseClosed = false;
    const server = createServer((req, res) => {
      req.resume();
      res.on("close", () => { responseClosed = true; });
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.write("notification response");
      // A slow endpoint has sent its status but has not finished its body.
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing listener address");
    try {
      const adapter = create(`http://127.0.0.1:${address.port}/notifications`);
      const result = await adapter.send({ title: "test", body: "fixture notification" });
      expect(result).toEqual(status === 200
        ? { ok: true, ack: `${name} 200` }
        : { ok: false, error: `${name} POST 503` });
      await vi.waitFor(() => expect(responseClosed).toBe(true), { timeout: 1_000, interval: 10 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it.each([200, 503])("keeps the HTTP %i result when body cleanup rejects", async (status) => {
    const cancel = vi.fn(async () => { throw new Error("cleanup failed"); });
    const fetchImpl: typeof fetch = async () => new Response(new ReadableStream({ cancel }), { status });
    const result = await create("http://localhost/notifications", fetchImpl).send({ title: "test", body: "fixture" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(result).toEqual(status === 200
      ? { ok: true, ack: `${name} 200` }
      : { ok: false, error: `${name} POST 503` });
  });
});
