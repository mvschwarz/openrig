// OPR.0.4.4.15 S15-3 — GET /api/queue/attention-aggregate (FR-1 route leg).
//
// The zero-config negative is the load-bearing pin here (arch ruling 3):
// the aggregate lives on a NEW sibling endpoint and the existing
// /list?attention=1 wire is byte-preserved — same repo query, same bare
// array, no hostId, no hosts[]. Fan-out depth is owned by the aggregator
// unit tests; this file pins the route wiring + payload contract shape.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { queueRoutes } from "../src/routes/queue.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-b", transport: "ssh", target: "b.local" }], // ssh → unsupported-transport, no network needed
};

const LOCAL_ATTENTION_ROW = { qitemId: "q-1", priority: "urgent", tier: "human-gate", destinationSession: "human-founder@external" };

function makeApp(opts: { subscriptions?: Array<{ hostId: string; enabled: boolean }>; withStore?: boolean } = {}) {
  const attentionCalls: unknown[] = [];
  let registryCalls = 0;
  let subscriptionCalls = 0;
  const repo = {
    listAttention: (query: unknown) => {
      attentionCalls.push(query);
      return [LOCAL_ATTENTION_ROW];
    },
  };
  const store = {
    listFeedHostSubscriptions: () => { subscriptionCalls += 1; return opts.subscriptions ?? []; },
  };
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("queueRepo", repo);
    if (opts.withStore !== false) set("settingsStore", store);
    set("hostRegistryLoader", () => { registryCalls += 1; return { ok: true, registry: REGISTRY }; });
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return { app, attentionCalls, reads: () => ({ registryCalls, subscriptionCalls }) };
}

describe("GET /api/queue/attention-aggregate", () => {
  it("zero-config: local items stamped + [local ok] hosts row; the SAME repo query + open-state default as /list", async () => {
    const { app, attentionCalls } = makeApp({ subscriptions: [] });
    const res = await app.request("/api/queue/attention-aggregate");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ ...LOCAL_ATTENTION_ROW, hostId: LOCAL_HOST_ID }],
      hosts: [{ hostId: LOCAL_HOST_ID, status: "ok" }],
    });
    expect(attentionCalls).toEqual([{ state: ["pending", "in-progress", "blocked"] }]);
  });

  it("missing settings store degrades to zero-config (no throw, local-only payload)", async () => {
    const { app } = makeApp({ withStore: false });
    const res = await app.request("/api/queue/attention-aggregate");
    expect(res.status).toBe(200);
    const data = (await res.json()) as { hosts: unknown[] };
    expect(data.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
  });

  it("a subscribed host flows through the aggregator (ssh entry → structured unsupported-transport, local intact)", async () => {
    const { app } = makeApp({ subscriptions: [{ hostId: "vps-b", enabled: true }] });
    const res = await app.request("/api/queue/attention-aggregate");
    const data = (await res.json()) as { items: Array<Record<string, unknown>>; hosts: Array<Record<string, unknown>> };
    expect(data.items.map((i) => i["qitemId"])).toEqual(["q-1"]);
    expect(data.hosts).toHaveLength(2);
    expect(data.hosts[1]).toMatchObject({ hostId: "vps-b", status: "unsupported-transport" });
  });

  it("ZERO-CONFIG WIRE PARITY: /list?attention=1 stays the bare array — no hostId, no hosts[] (byte-preserved route)", async () => {
    const { app } = makeApp({ subscriptions: [] });
    const res = await app.request("/api/queue/list?attention=1");
    expect(res.status).toBe(200);
    const data = (await res.json()) as unknown;
    expect(data).toEqual([LOCAL_ATTENTION_ROW]); // exactly the repo rows, unwrapped, unstamped
  });
});


describe("GET /api/queue/attention-aggregate?host=", () => {
  it("explicit local target does not read subscriptions or registry", async () => {
    const { app, attentionCalls, reads } = makeApp({ subscriptions: [{ hostId: "vps-b", enabled: true }] });
    const res = await app.request("/api/queue/attention-aggregate?host=local");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [{ ...LOCAL_ATTENTION_ROW, hostId: "local" }], hosts: [{ hostId: "local", status: "ok" }] });
    expect(attentionCalls).toHaveLength(1);
    expect(reads()).toEqual({ registryCalls: 0, subscriptionCalls: 0 });
  });

  it("registered unsubscribed target excludes local and subscribed hosts", async () => {
    const { app, attentionCalls, reads } = makeApp({ subscriptions: [{ hostId: "unrelated", enabled: true }] });
    const res = await app.request("/api/queue/attention-aggregate?host=vps-b");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.items).toEqual([]);
    expect(data.hosts).toEqual([{ hostId: "vps-b", status: "unsupported-transport", error: expect.any(String) }]);
    expect(attentionCalls).toEqual([]);
    expect(reads()).toEqual({ registryCalls: 1, subscriptionCalls: 0 });
  });

  it("unknown target returns one unreachable status with no fallback", async () => {
    const { app, attentionCalls, reads } = makeApp({ subscriptions: [{ hostId: "vps-b", enabled: true }] });
    const res = await app.request("/api/queue/attention-aggregate?host=ghost");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], hosts: [{ hostId: "ghost", status: "unreachable", error: expect.stringContaining("ghost") }] });
    expect(attentionCalls).toEqual([]);
    expect(reads()).toEqual({ registryCalls: 1, subscriptionCalls: 0 });
  });
});
