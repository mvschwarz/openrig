// OPR.0.4.6.MH2 FR-2 + FR-7 — the single-host read-through edge.
//
// Pins the three arch rulings on the seam: P1 the NAMED closed allowlist +
// both refusal classes structured and NEVER forwarded; P2 strip-is-total +
// registry-validated-before-dial; P3 verbatim passthrough = status +
// content-type + body (the origin's own 404 IS the answer). Plus the FR-2
// zero-regression negative: absent/local host param reaches the existing
// handler with no forward attempted.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  READ_THROUGH_ALLOWLIST,
  READ_THROUGH_TIMEOUT_MS,
  hostReadThrough,
  isReadThroughPath,
} from "../src/domain/hosts/read-through.js";
import { remoteRawRequest } from "../src/domain/hosts/remote-daemon-http.js";
import type { HostRegistry, HttpHostEntry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "VPS_A_TOKEN" },
    { id: "vm-ssh", transport: "ssh", target: "vm.local" },
  ],
};

interface FetchCall {
  url: string;
  method: string;
  authorization: string | null;
}

function makeApp(opts: { fetchResponse?: () => Response; env?: Record<string, string> } = {}) {
  const fetchCalls: FetchCall[] = [];
  const localHits: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    fetchCalls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("authorization"),
    });
    return opts.fetchResponse
      ? opts.fetchResponse()
      : new Response(JSON.stringify({ rigs: ["remote-rig"] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  }) as typeof fetch;

  // The bearer resolves from process.env inside the transport; the tests
  // that reach a dial set the env var themselves (and restore after).
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", fakeFetch);
    await next();
  });
  app.use("/api/*", hostReadThrough());
  app.get("/api/rigs/summary", (c) => {
    localHits.push(c.req.path);
    return c.json({ rigs: ["local-rig"] });
  });
  app.get("/api/slices", (c) => {
    localHits.push(`${c.req.path}?${new URL(c.req.url).searchParams.toString()}`);
    return c.json({ slices: [] });
  });
  app.post("/api/slices/refresh", (c) => {
    localHits.push(c.req.path);
    return c.json({ refreshed: true });
  });
  app.get("/api/config", (c) => {
    localHits.push(c.req.path);
    return c.json({ config: true });
  });
  return { app, fetchCalls, localHits };
}

function withBearerEnv<T>(fn: () => Promise<T>): Promise<T> {
  process.env["VPS_A_TOKEN"] = "test-token";
  return fn().finally(() => {
    delete process.env["VPS_A_TOKEN"];
  });
}

describe("READ_THROUGH_ALLOWLIST matcher (arch P1 — the named closed set)", () => {
  it("matches every allowlisted screen read", () => {
    const positives = [
      "/api/rigs/summary",
      "/api/rigs/factory-fleet/graph",
      "/api/rigs/factory-fleet/nodes",
      "/api/rigs/factory-fleet/nodes/orch-lead", // rev1-r2 B2 + arch Option A: the seat-detail leaf
      "/api/ps",
      "/api/slices",
      "/api/slices/mh2-view-remote-workspace",
      "/api/slices/mh2-view-remote-workspace/doc/PLAN.md",
      "/api/slices/mh2-view-remote-workspace/doc/proof/nested.md",
      "/api/missions/release-0.4.6",
      "/api/specs/library",
      "/api/specs/library/rig-spec-1/review",
    ];
    for (const p of positives) expect(isReadThroughPath(p), p).toBe(true);
  });

  it("rejects the deliberate exclusions and everything else", () => {
    const negatives = [
      "/api/queue/qitem-123", // queue = the MH-3 lane
      "/api/files/roots", // local FS discovery
      "/api/slices/x/proof-asset/img.png", // binary — text transport only
      "/api/specs/library/active-lens/review/extra", // shape mismatch
      "/api/config",
      "/api/hosts",
      "/api/mission-control/action",
      "/api/rigs", // bare collection is not a screen read today
      "/api/rigs/x/graph/extra",
      // THE ARCH TOOTH on the first parameterized seat-detail entry: strict
      // segment-shape only — the deeper ACTION routes under the same prefix
      // stay refused (these are exactly rev1-r2 B1's local action endpoints).
      "/api/rigs/x/nodes/y/focus",
      "/api/rigs/x/nodes/y/open-cmux",
      "/api/rigs/x/nodes/y/anything/deeper",
    ];
    for (const p of negatives) expect(isReadThroughPath(p), p).toBe(false);
  });

  it("nuance pinned: GET /api/slices/refresh matches :name — harmless by construction", () => {
    // ":name" swallows the literal "refresh", so a GET here IS allowlisted.
    // No mutation can ride it: the refresh WRITE is POST-only and every
    // non-GET with a remote envelope is refused at the method tooth (proven
    // above, on exactly this path); the origin resolves the forwarded GET
    // as a slice-detail lookup for a slice literally named "refresh" → its
    // own 404, passed through verbatim.
    expect(isReadThroughPath("/api/slices/refresh")).toBe(true);
  });

  it("the constant itself is the closed set (additions are deliberate extensions)", () => {
    expect([...READ_THROUGH_ALLOWLIST]).toEqual([
      "/api/rigs/summary",
      "/api/rigs/:rigId/graph",
      "/api/rigs/:rigId/nodes",
      "/api/rigs/:rigId/nodes/:logicalId", // rev1-r2 B2, arch-ruled Option A
      "/api/ps",
      "/api/slices",
      "/api/slices/:name",
      "/api/slices/:name/doc/*",
      "/api/missions/:missionId",
      "/api/specs/library",
      "/api/specs/library/:id/review",
    ]);
  });
});

describe("hostReadThrough — local path untouched (FR-2 zero-regression)", () => {
  it("absent host param falls through to the existing handler; no forward", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/rigs/summary");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rigs: ["local-rig"] });
    expect(localHits).toEqual(["/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]);
  });

  it("host=local falls through identically; no forward", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/rigs/summary?host=local");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rigs: ["local-rig"] });
    expect(localHits).toEqual(["/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]);
  });
});

describe("hostReadThrough — the FR-7 boundary teeth (refused, NEVER forwarded)", () => {
  it("non-GET with a remote envelope → structured MH-3 refusal, zero forwards, local handler untouched", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/slices/refresh?host=vps-a", { method: "POST" });
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({
      error: "cross_host_write_refused",
      boundary: "MH-3",
      hostId: "vps-a",
      method: "POST",
    });
    expect(fetchCalls).toEqual([]);
    expect(localHits).toEqual([]);
  });

  it("non-GET refusal fires even on an allowlisted READ path", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vps-a", { method: "DELETE" });
    expect(res.status).toBe(405);
    expect(await res.json()).toMatchObject({ error: "cross_host_write_refused", boundary: "MH-3" });
    expect(fetchCalls).toEqual([]);
  });

  it("a GET outside the allowlist with a remote envelope → structured MH-3 refusal, zero forwards", async () => {
    const { app, fetchCalls, localHits } = makeApp();
    const res = await app.request("/api/config?host=vps-a");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: "read_through_path_not_allowed",
      boundary: "MH-3",
      hostId: "vps-a",
      path: "/api/config",
    });
    expect(fetchCalls).toEqual([]);
    expect(localHits).toEqual([]);
  });
});

describe("hostReadThrough — registry validated BEFORE any dial (arch P2)", () => {
  it("unknown host id → structured unknown-host error, zero forwards", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=nope");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "nope", failureClass: "unknown-host" });
    expect(fetchCalls).toEqual([]);
  });

  it("ssh-transport host → structured unsupported-transport, zero forwards", async () => {
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vm-ssh");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "vm-ssh", failureClass: "unsupported-transport" });
    expect(fetchCalls).toEqual([]);
  });
});

describe("hostReadThrough — forward mechanics (arch P2 strip-is-total + P3 verbatim)", () => {
  it("happy path: same path forwarded, host param GONE, other params intact, bearer server-side, origin body verbatim", () =>
    withBearerEnv(async () => {
      const { app, fetchCalls, localHits } = makeApp();
      const res = await app.request("/api/slices?filter=current&refresh=1&host=vps-a");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rigs: ["remote-rig"] });
      expect(localHits).toEqual([]); // the local handler never ran
      expect(fetchCalls).toHaveLength(1);
      const call = fetchCalls[0]!;
      // strip-is-total: no host param in ANY form; the rest of the query rides through.
      expect(call.url).toBe("http://vps-a:7433/api/slices?filter=current&refresh=1");
      expect(call.url).not.toContain("host");
      expect(call.method).toBe("GET");
      expect(call.authorization).toBe("Bearer test-token");
    }));

  it("origin 404 passes through VERBATIM — status, content-type, body; never re-wrapped", () =>
    withBearerEnv(async () => {
      const originBody = JSON.stringify({ error: "mission_not_found", missionId: "nope" });
      const { app } = makeApp({
        fetchResponse: () => new Response(originBody, { status: 404, headers: { "Content-Type": "application/json; charset=utf-8" } }),
      });
      const res = await app.request("/api/missions/nope?host=vps-a");
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.text()).toBe(originBody); // byte-verbatim, not re-shaped
    }));

  it("missing bearer env → structured auth-failed (edge taxonomy is for the FORWARD failing only)", async () => {
    // VPS_A_TOKEN deliberately unset.
    const { app, fetchCalls } = makeApp();
    const res = await app.request("/api/rigs/summary?host=vps-a");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "remote_read_failed", hostId: "vps-a", failureClass: "auth-failed" });
    expect(fetchCalls).toEqual([]); // bearer resolution precedes the dial
  });

  it("network failure → structured unreachable", () =>
    withBearerEnv(async () => {
      const { app } = makeApp({
        fetchResponse: () => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        },
      });
      const res = await app.request("/api/rigs/summary?host=vps-a");
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: "remote_read_failed", failureClass: "unreachable" });
    }));
});

describe("remoteRawRequest — the transport leg's own discipline", () => {
  const HOST: HttpHostEntry = { id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "RAW_TOKEN" };

  it("deadline is required + armed: a hanging origin yields a structured timeout, never a hang", async () => {
    const hangingFetch = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as typeof fetch;
    const res = await remoteRawRequest(HOST, "/api/ps", {
      timeoutMs: 25,
      fetchImpl: hangingFetch,
      env: { RAW_TOKEN: "tok" },
    });
    expect(res).toMatchObject({ ok: false, kind: "timeout", phase: "request" });
  });

  it("non-2xx origin statuses are ok:true passthrough results (P3), with content-type + body text", async () => {
    const fakeFetch = (async () =>
      new Response("<h1>origin 500</h1>", { status: 500, headers: { "Content-Type": "text/html" } })) as typeof fetch;
    const res = await remoteRawRequest(HOST, "/api/ps", { timeoutMs: 1000, fetchImpl: fakeFetch, env: { RAW_TOKEN: "tok" } });
    expect(res).toEqual({ ok: true, status: 500, contentType: "text/html", bodyText: "<h1>origin 500</h1>" });
  });
});
