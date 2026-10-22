import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { NtfyNotificationAdapter } from "../src/domain/mission-control/notification-adapter-ntfy.js";

describe("ntfy native transport", () => {
  it("delivers a truncated long ASCII title through native fetch", async () => {
    const received: { title: string | undefined; body: string }[] = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk.toString();
      received.push({ title: req.headers.title as string | undefined, body });
      res.writeHead(200);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const adapter = new NtfyNotificationAdapter({ topicUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/owned-topic` });
      const result = await adapter.send({ title: "a".repeat(500), body: "offline fixture" });
      expect(received, result.error).toHaveLength(1);
      expect(result).toMatchObject({ ok: true });
      expect(received[0]!.title!.length).toBeLessThanOrEqual(250);
      expect(received[0]!.title).toMatch(/^a+\.\.\.$/);
      expect(received[0]!.body).toBe("offline fixture");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("delivers a title with non-Latin-1 characters as an RFC 2047 encoded word", async () => {
    const received: { title: string | undefined }[] = [];
    const server = http.createServer((req, res) => {
      received.push({ title: req.headers.title as string | undefined });
      res.writeHead(200);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const adapter = new NtfyNotificationAdapter({ topicUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/owned-topic` });
      const title = "Release \u2014 shipped \u{1F680}";
      const result = await adapter.send({ title, body: "offline fixture" });
      expect(result, result.error).toMatchObject({ ok: true });
      expect(received).toHaveLength(1);
      const match = /^=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(received[0]!.title ?? "");
      expect(match, received[0]!.title).not.toBeNull();
      expect(Buffer.from(match![1]!, "base64").toString("utf-8")).toBe(title);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("keeps a plain ASCII title as is", async () => {
    const received: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      received.push(req.headers.title as string | undefined);
      res.writeHead(200);
      res.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const adapter = new NtfyNotificationAdapter({ topicUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/owned-topic` });
      await adapter.send({ title: "Needs review: qitem 42", body: "x" });
      expect(received).toEqual(["Needs review: qitem 42"]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
