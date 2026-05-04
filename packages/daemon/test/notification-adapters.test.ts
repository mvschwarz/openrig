import { describe, it, expect } from "vitest";
import { NtfyNotificationAdapter } from "../src/domain/mission-control/notification-adapter-ntfy.js";
import { WebhookNotificationAdapter } from "../src/domain/mission-control/notification-adapter-webhook.js";

describe("NtfyNotificationAdapter (PL-005 Phase B)", () => {
  it("POSTs to topic URL with title/click/tags headers + body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new NtfyNotificationAdapter({
      topicUrl: "https://ntfy.sh/test-topic",
      fetchImpl: fakeFetch,
    });
    const result = await adapter.send({
      title: "human-gate qitem arrived",
      body: "qitem-XXX arrived",
      qitemRef: "qitem-XXX",
      tags: ["openrig", "mission-control"],
    });
    expect(result.ok).toBe(true);
    expect(result.ack).toContain("200");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ntfy.sh/test-topic");
    expect(calls[0]!.init.method).toBe("POST");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Title).toBe("human-gate qitem arrived");
    expect(headers.Click).toBe("qitem-XXX");
    expect(headers.Tags).toBe("openrig,mission-control");
  });

  it("returns ok=false on non-2xx response", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const adapter = new NtfyNotificationAdapter({
      topicUrl: "https://ntfy.sh/x",
      fetchImpl: fakeFetch,
    });
    const result = await adapter.send({ title: "x", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });

  it("returns ok=false on fetch throw", async () => {
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const adapter = new NtfyNotificationAdapter({
      topicUrl: "https://ntfy.sh/x",
      fetchImpl: fakeFetch,
    });
    const result = await adapter.send({ title: "x", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("network down");
  });

  it("sanitizes title (no newlines + max length 250)", async () => {
    const calls: Array<Record<string, string>> = [];
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new NtfyNotificationAdapter({
      topicUrl: "https://ntfy.sh/x",
      fetchImpl: fakeFetch,
    });
    await adapter.send({ title: "line1\nline2\rline3", body: "x" });
    expect(calls[0]!.Title).not.toContain("\n");
    expect(calls[0]!.Title).not.toContain("\r");
    await adapter.send({ title: "a".repeat(500), body: "x" });
    expect(calls[1]!.Title.length).toBeLessThanOrEqual(250);
  });
});

describe("WebhookNotificationAdapter (PL-005 Phase B)", () => {
  it("POSTs JSON body to endpoint URL with stable schema", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new WebhookNotificationAdapter({
      endpointUrl: "https://example.com/webhook",
      fetchImpl: fakeFetch,
    });
    const result = await adapter.send({
      title: "test",
      body: "bodytext",
      qitemRef: "qitem-1",
      tags: ["a", "b"],
    });
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toBe("https://example.com/webhook");
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body.source).toBe("openrig.mission-control");
    expect(body.schema_version).toBe(1);
    expect(body.title).toBe("test");
    expect(body.body).toBe("bodytext");
    expect(body.qitem_ref).toBe("qitem-1");
    expect(body.tags).toEqual(["a", "b"]);
    expect(typeof body.emitted_at).toBe("string");
  });

  it("includes extra headers when configured", async () => {
    const calls: Array<Record<string, string>> = [];
    const fakeFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.headers as Record<string, string>);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = new WebhookNotificationAdapter({
      endpointUrl: "https://example.com/webhook",
      fetchImpl: fakeFetch,
      extraHeaders: { "X-Webhook-Signature": "secret" },
    });
    await adapter.send({ title: "x", body: "x" });
    expect(calls[0]!["X-Webhook-Signature"]).toBe("secret");
    expect(calls[0]!["Content-Type"]).toBe("application/json");
  });

  it("returns ok=false on non-2xx", async () => {
    const fakeFetch = (async () => new Response("err", { status: 502 })) as unknown as typeof fetch;
    const adapter = new WebhookNotificationAdapter({
      endpointUrl: "https://example.com/webhook",
      fetchImpl: fakeFetch,
    });
    const result = await adapter.send({ title: "x", body: "x" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("502");
  });
});
