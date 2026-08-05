// 51-09 increment 2 — self-host resolution convention (local leg).
//
// The daemon's minted self-host id (increment 1) must resolve HOME exactly like
// the "local" positional sentinel, WITHOUT overloading it: selfId and 'local'
// are two DISTINCT accepted spellings that route to the same place. This is the
// convention the queue-destination validator (increment 4) consumes so a
// destination qualified with THIS host's own id validates locally instead of
// failing as unknown_destination_rig (the E1 / 389ec01d class).
//
// NOTE: the registry-alignment assert-on-boot (plan increment 2 leg b) is NOT
// implemented here — see the driver report: the hosts registry has no self-row
// marking to compare against (routed to arch, no registry migration per fence).

import { describe, it, expect, afterEach } from "vitest";
import { Hono } from "hono";
import {
  LOCAL_HOST_ID,
  getSelfHostId,
  setSelfHostId,
  resolvesToLocalHost,
} from "../src/domain/hosts/fanout-contract.js";
import { hostReadThrough } from "../src/domain/hosts/read-through.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

// vps-a is TOKENLESS (bearer optional) so the remote leg dials without needing
// an env-provided bearer — we only need to prove a non-self host forwards.
const REGISTRY: HostRegistry = {
  hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433" }],
};

function makeApp() {
  const fetchCalls: string[] = [];
  const localHits: string[] = [];
  const fakeFetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    return new Response(JSON.stringify({ rigs: ["remote-rig"] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    set("hostRegistryLoader", () => ({ ok: true, registry: REGISTRY }));
    set("remoteFetchImpl", fakeFetch);
    await next();
  });
  app.use("/api/*", hostReadThrough());
  app.get("/api/rigs/summary", (c) => { localHits.push(c.req.path); return c.json({ rigs: ["local-rig"] }); });
  return { app, fetchCalls, localHits };
}

afterEach(() => setSelfHostId(null)); // reset the boot-populated module accessor between tests

describe("51-09 increment 2 — self-host local resolution", () => {
  it("resolvesToLocalHost: absent, empty, the 'local' sentinel, and the self-id all route home", () => {
    const selfId = "mars-01";
    expect(resolvesToLocalHost(undefined, selfId)).toBe(true);
    expect(resolvesToLocalHost("", selfId)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, selfId)).toBe(true); // 'local'
    expect(resolvesToLocalHost(selfId, selfId)).toBe(true);        // the self-id
  });

  it("the self-id is a DISTINCT spelling from the 'local' sentinel (not overloaded)", () => {
    expect("mars-01").not.toBe(LOCAL_HOST_ID);
    // both route home, but they are different tokens — selfId does not BECOME 'local'
    expect(resolvesToLocalHost("mars-01", "mars-01")).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, "mars-01")).toBe(true);
  });

  it("a different host, and the self-id under a different case, do NOT route home", () => {
    expect(resolvesToLocalHost("vps-a", "mars-01")).toBe(false);
    expect(resolvesToLocalHost("Mars-01", "mars-01")).toBe(false); // case-SENSITIVE (matches incr-1 candidate-vs-stored)
  });

  it("with no self-id resolved yet, only absent/empty/'local' are home (self-id null is not a wildcard)", () => {
    expect(resolvesToLocalHost(undefined, null)).toBe(true);
    expect(resolvesToLocalHost(LOCAL_HOST_ID, null)).toBe(true);
    expect(resolvesToLocalHost("mars-01", null)).toBe(false);
  });

  it("getSelfHostId round-trips what boot set", () => {
    expect(getSelfHostId()).toBeNull();
    setSelfHostId("mars-01");
    expect(getSelfHostId()).toBe("mars-01");
  });

  it("E1: read-through routes a ?host==selfId read HOME (no remote dial), like ?host=local", async () => {
    setSelfHostId("mars-01");
    const { app, fetchCalls, localHits } = makeApp();

    // self-id qualified read → LOCAL handler, NO dial (the E1 unknown_destination_rig killer at the read seam)
    const selfRes = await app.request("/api/rigs/summary?host=mars-01");
    expect(selfRes.status).toBe(200);
    expect(await selfRes.json()).toEqual({ rigs: ["local-rig"] });

    // 'local' sentinel → also local
    await app.request("/api/rigs/summary?host=local");

    expect(localHits).toEqual(["/api/rigs/summary", "/api/rigs/summary"]);
    expect(fetchCalls).toEqual([]); // neither self-id nor 'local' dialed out

    // a genuinely remote host still forwards (unchanged)
    await app.request("/api/rigs/summary?host=vps-a");
    expect(fetchCalls.length).toBe(1);
  });
});
