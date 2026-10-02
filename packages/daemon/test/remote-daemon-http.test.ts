// OPR.0.4.4.15 — the shared daemon→daemon transport core (arch cell 1).
//
// The bounded-abort discipline lives HERE now (one deadline through request
// AND body — the G-R2B1-1 class closed structurally for every consumer);
// remote-up-leaf's own tests keep pinning its shipped error strings, which
// proves the consumer formatting; these tests pin the structured result.

import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { Hono } from "hono";
import { remoteUpLeaf } from "../src/domain/topology/remote-up-leaf.js";
import { hostReadThrough } from "../src/domain/hosts/read-through.js";
import { remoteJsonRequest, remoteRawRequest } from "../src/domain/hosts/remote-daemon-http.js";
import { LOCAL_HOST_ID, hostsCovered } from "../src/domain/hosts/fanout-contract.js";
import type { AggregatedPayload } from "../src/domain/hosts/fanout-contract.js";
import type { HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const HOST: HttpHostEntry = { id: "vps-b", transport: "http", url: "http://vps-b:7433/", bearer_env: "T" };
const ENV = { T: "tok-1" };

function fetchStub(status: number, payload?: unknown, capture?: { url?: string; init?: RequestInit }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(payload === undefined ? "not-json" : JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("remoteJsonRequest — structured outcomes (never hangs, never throws)", () => {
  it("bearer failure short-circuits with kind=bearer; no request is sent", async () => {
    let called = false;
    const res = await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "bearer" });
    if (!res.ok) expect(res.detail).toContain("bearer env var T");
    expect(called).toBe(false);
  });

  it("GET carries the bearer, no Content-Type/body; trailing-slash url joins cleanly; 2xx returns the parsed payload", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteJsonRequest(HOST, "/api/queue/list?attention=1", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(200, { items: [1, 2] }, capture),
    });
    expect(res).toEqual({ ok: true, status: 200, payload: { items: [1, 2] } });
    expect(capture.url).toBe("http://vps-b:7433/api/queue/list?attention=1");
    expect(capture.init?.method).toBe("GET");
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
    expect(headers["Content-Type"]).toBeUndefined();
    expect(capture.init?.body).toBeUndefined();
    expect(capture.init?.signal).toBeInstanceOf(AbortSignal); // deadline wired to the request
  });

  it("POST serializes the body with Content-Type", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await remoteJsonRequest(HOST, "/api/up", {
      method: "POST",
      body: { sourceRef: "r" },
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(201, {}, capture),
    });
    expect((capture.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(capture.init?.body))).toEqual({ sourceRef: "r" });
  });

  it("never-settling request → kind=timeout phase=request within the caller's deadline", async () => {
    const neverSettling = ((_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_res, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch;
    const res = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 20, env: ENV, fetchImpl: neverSettling });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "request" });
  });

  it("headers-then-stalled-body → kind=timeout phase=body carrying the status (the G-R2B1-1 class, now structural)", async () => {
    const stalled = (async () =>
      new Response(new ReadableStream({ start() {} }), { status: 500, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    const res = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 20, env: ENV, fetchImpl: stalled });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "body", status: 500 });
  });

  it("non-2xx with a JSON error body → kind=http with the remote text; non-JSON body → empty detail (status is the honest fact)", async () => {
    const withText = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 1000, env: ENV, fetchImpl: fetchStub(409, { error: "conflict!" }) });
    expect(withText).toMatchObject({ ok: false, kind: "http", status: 409, detail: "conflict!" });
    const nonJson = await remoteJsonRequest(HOST, "/api/x", { method: "GET", timeoutMs: 1000, env: ENV, fetchImpl: fetchStub(500) });
    expect(nonJson).toMatchObject({ ok: false, kind: "http", status: 500, detail: "" });
  });

  it("network failure → kind=network with the error message", async () => {
    const res = await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, kind: "network", detail: "ECONNREFUSED" });
  });
});

describe("fanout-contract — the shared intra-P4 payload (arch adjudication: 15 defines, 21 imports)", () => {
  it("LOCAL_HOST_ID is the S11-matching literal, defined once", () => {
    expect(LOCAL_HOST_ID).toBe("local");
  });

  it("hostsCovered: true only when EVERY expected host appears exactly once (omission-proof, near the contract per arch pin B)", () => {
    const payload: AggregatedPayload<number> = {
      items: [1],
      hosts: [
        { hostId: LOCAL_HOST_ID, status: "ok" },
        { hostId: "vps-b", status: "unreachable", error: "timeout", failedStep: "remote-daemon-unreachable" },
        { hostId: "ssh-1", status: "unsupported-transport", error: "ssh transport cannot carry the read" },
      ],
    };
    expect(hostsCovered(payload, [LOCAL_HOST_ID, "vps-b", "ssh-1"])).toBe(true);
    expect(hostsCovered(payload, [LOCAL_HOST_ID, "vps-b", "ssh-1", "missing"])).toBe(false); // silent thinning caught
    expect(hostsCovered({ items: [], hosts: [...payload.hosts, { hostId: "vps-b", status: "ok" }] }, [LOCAL_HOST_ID, "vps-b", "ssh-1"])).toBe(false); // duplicates caught
  });
});

describe("anonymous (URL-only) http host — no Authorization header, no request short-circuit", () => {
  const ANON: HttpHostEntry = { id: "anon-b", transport: "http", url: "http://anon-b:7433/" };

  it("remoteJsonRequest: URL-only host sends NO Authorization header; 2xx still returns payload", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteJsonRequest(ANON, "/api/queue/list", {
      method: "GET",
      timeoutMs: 1000,
      env: {},
      fetchImpl: fetchStub(200, { items: [] }, capture),
    });
    expect(res).toMatchObject({ ok: true, status: 200 });
    const headers = capture.init?.headers as Record<string, string>;
    expect("Authorization" in headers).toBe(false);
  });

  it("remoteRawRequest: URL-only host sends NO Authorization header; origin answer is ok:true", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const res = await remoteRawRequest(ANON, "/api/ps", {
      timeoutMs: 1000,
      env: {},
      fetchImpl: fetchStub(200, { rigs: [] }, capture),
    });
    expect(res).toMatchObject({ ok: true, status: 200 });
    const headers = capture.init?.headers as Record<string, string>;
    expect("Authorization" in headers).toBe(false);
  });

  it("configured bearer_env host still carries Authorization (fail-closed path unchanged)", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    await remoteJsonRequest(HOST, "/api/x", {
      method: "GET",
      timeoutMs: 1000,
      env: ENV,
      fetchImpl: fetchStub(200, {}, capture),
    });
    const headers = capture.init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-1");
  });
});


describe("remote response body transport — native HTTP consumers", () => {
  it.each(["truncated", "complete", "plain-error", "non-json"] as const)(
    "%s response preserves truthful outcomes without retries or local fallback", async (mode) => {
      const requests: string[] = [];
      const server = createServer(async (req, res) => {
        for await (const _chunk of req) { /* consume the single mutation request */ }
        requests.push(`${req.method} ${req.url}`);
        if (mode === "truncated") {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "200" });
          res.flushHeaders();
          res.write('{"ok":');
          setTimeout(() => res.destroy(), 30);
        } else if (mode === "plain-error") {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("fixture unavailable");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(mode === "non-json" ? "not-json" : '{"ok":true}');
        }
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing fixture port");
      const host: HttpHostEntry = { id: "fixture-edge", transport: "http", url: `http://127.0.0.1:${address.port}` };
      const app = new Hono();
      app.use("*", async (c, next) => {
        const set = c.set.bind(c) as (key: string, value: unknown) => void;
        set("hostRegistryLoader", () => ({ ok: true, registry: { hosts: [host] } }));
        await next();
      });
      app.use("/api/*", hostReadThrough());
      let localHits = 0;
      app.get("/api/rigs/summary", c => { localHits++; return c.json({ local: true }); });
      try {
        const up = await remoteUpLeaf({ sourceRef: "fixture" }, host, { timeoutMs: 2000, env: {} });
        const json = await remoteJsonRequest(host, "/api/rigs/summary", { method: "GET", timeoutMs: 2000, env: {} });
        const raw = await remoteRawRequest(host, "/api/rigs/summary", { timeoutMs: 2000, env: {} });
        const edge = await app.request("/api/rigs/summary?host=fixture-edge");
        const edgeBody = await edge.text();
        expect(requests).toEqual(["POST /api/up", "GET /api/rigs/summary", "GET /api/rigs/summary", "GET /api/rigs/summary"]);
        expect(localHits).toBe(0);
        if (mode === "truncated") {
          expect(up.ok).toBe(false);
          expect(up.error).toContain("operation outcome is unknown");
          for (const result of [json, raw]) {
            expect(result).toMatchObject({ ok: false, kind: "network", status: 200 });
            if (!result.ok) expect(result.detail).toContain("operation outcome is unknown");
          }
          expect(edge.status).toBe(502);
          expect(JSON.parse(edgeBody)).toMatchObject({ failureClass: "unreachable" });
          expect(edgeBody).toContain("operation outcome is unknown");
        } else if (mode === "plain-error") {
          expect(up.ok).toBe(false);
          expect(json).toEqual({ ok: false, kind: "http", status: 503, detail: "" });
          expect(raw).toEqual({ ok: true, status: 503, contentType: "text/plain", bodyText: "fixture unavailable" });
          expect(edge.status).toBe(503);
          expect(edgeBody).toBe("fixture unavailable");
        } else {
          expect(up).toEqual({ ok: true });
          expect(json).toEqual({ ok: true, status: 200, payload: mode === "non-json" ? undefined : { ok: true } });
          expect(raw.ok).toBe(true);
          expect(edge.status).toBe(200);
          expect(edgeBody).toBe(mode === "non-json" ? "not-json" : '{"ok":true}');
        }
      } finally {
        server.close();
        server.closeAllConnections();
        await once(server, "close");
      }
    },
  );
});
