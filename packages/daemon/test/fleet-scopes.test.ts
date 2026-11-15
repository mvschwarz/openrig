// #3093 first increment — the fleet Projects read-view aggregator.
//
// The maintainer's two named acceptance bars are load-bearing here:
//  * COLLIDING IDs — identical native mission/slice ids served by two hosts
//    are two rows, distinct by (hostId, native id); they never collapse.
//  * SLOW / UNAVAILABLE / STALE hosts — a host that hangs, refuses or
//    answers garbage is a structured per-host status beside intact local
//    rows, and a previously-good host that fails serves its last-known rows
//    marked stale with honest last-success times — never a fresh-looking
//    empty result.

import { describe, it, expect } from "vitest";
import { aggregateFleetScopes } from "../src/domain/hosts/fleet-scopes.js";
import type { FleetScopesDeps, FleetScopesPayload } from "../src/domain/hosts/fleet-scopes.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "host-a", transport: "http", url: "http://host-a:7433" },
    { id: "host-b", transport: "http", url: "http://host-b:7433" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

const SELF = "host-self";

function scopesCountsResponse(missions: unknown[], project: unknown = null): Response {
  return new Response(JSON.stringify({ missions, project }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deps(overrides: Partial<FleetScopesDeps> = {}): FleetScopesDeps {
  return {
    listLocalScopes: () => ({ project: null, missions: [{ mission: "local-m", slices: [{ dirName: "s1", id: "s1", displayName: "S1", status: null, stage: null, locks: { spec: null, delivery: null } }] }] }),
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    selfHostId: SELF,
    timeoutMs: 80,
    // The fleet view dials every http host in the registry; tests that do not
    // care provide a quiet default.
    fetchImpl: (async () => scopesCountsResponse([])) as typeof fetch,
    now: () => "2026-01-01T00:00:00.000Z",
    cache: new Map(),
    ...overrides,
  };
}

const okHost = (hostId: string) => (h: FleetScopesPayload["hosts"][number]) => h.hostId === hostId;
const missionOf = (p: FleetScopesPayload, hostId: string, mission: string) =>
  p.missions.filter(m => m.hostId === hostId && m.mission === mission);

describe("aggregateFleetScopes — local leg and identity", () => {
  it("local rows are always present, stamped with the self host id; the local projection is INVOKED", async () => {
    let invoked = 0;
    const p = await aggregateFleetScopes(deps({ listLocalScopes: () => { invoked += 1; return { project: null, missions: [] }; } }));
    expect(invoked).toBe(1);
    expect(p.hosts.find(okHost(SELF))).toMatchObject({ status: "ok", lastSuccessAt: "2026-01-01T00:00:00.000Z" });
  });

  it("COLLIDING IDs: identical native mission and slice ids on two hosts are two distinct rows", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async () => scopesCountsResponse([
        { mission: "alpha", slices: [{ dirName: "build-s1", id: "build-s1", displayName: "Build", status: "building", stage: "spec", locks: { spec: null, delivery: null } }] },
      ])) as typeof fetch,
    }));
    // Both hosts serve mission "alpha" with slice id "build-s1": two rows each.
    expect(missionOf(p, "host-a", "alpha")).toHaveLength(1);
    expect(missionOf(p, "host-b", "alpha")).toHaveLength(1);
    const a = missionOf(p, "host-a", "alpha")[0]!;
    const b = missionOf(p, "host-b", "alpha")[0]!;
    expect(a.slices[0]!.id).toBe("build-s1");
    expect(b.slices[0]!.id).toBe("build-s1");
    // Composite identity: the rows differ by origin host and stay distinct.
    expect(a.hostId).not.toBe(b.hostId);
    expect(p.missions.filter(m => m.mission === "alpha")).toHaveLength(2);
    expect(new Set(p.missions.map(m => `${m.hostId}/${m.mission}`)).has("host-a/alpha")).toBe(true);
    expect(new Set(p.missions.map(m => `${m.hostId}/${m.mission}`)).has("host-b/alpha")).toBe(true);
  });

  it("remote rows keep origin host, host label and project context beside the native ids", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async () => scopesCountsResponse([{ mission: "m1", slices: [] }], { id: "proj-x" })) as typeof fetch,
    }));
    const m = missionOf(p, "host-a", "m1")[0]!;
    expect(m).toMatchObject({ hostId: "host-a", hostLabel: "host-a", project: "proj-x", mission: "m1" });
  });
});

describe("aggregateFleetScopes — slow, unavailable and stale hosts", () => {
  it("SLOW host: a read that never completes is bounded and degrades to unreachable; local and other hosts stay fresh", async () => {
    const started = Date.now();
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) =>
        String(url).includes("host-a")
          ? new Promise<Response>((_, reject) => {
              // A real fetch honours the transport's abort signal; this one only resolves by aborting.
              init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })
          : scopesCountsResponse([{ mission: "m-b", slices: [] }])) as typeof fetch,
    }));
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(p.hosts.find(okHost("host-a"))?.status).toBe("unreachable");
    expect(p.hosts.find(okHost("host-b"))?.status).toBe("ok");
    expect(p.hosts.find(okHost(SELF))?.status).toBe("ok");
    expect(missionOf(p, SELF, "local-m")).toHaveLength(1);
    expect(missionOf(p, "host-b", "m-b")).toHaveLength(1);
    expect(missionOf(p, "host-a", "m-b")).toHaveLength(0);
  });

  it("UNAVAILABLE host: a network failure is a structured status, never a fresh empty success", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).includes("host-a")) throw new Error("connect ECONNREFUSED");
        return scopesCountsResponse([]);
      }) as typeof fetch,
    }));
    const a = p.hosts.find(okHost("host-a"))!;
    expect(a.status).toBe("unreachable");
    expect(a.error).toContain("ECONNREFUSED");
    expect(a.lastSuccessAt).toBeNull();
    expect(p.missions.some(m => m.hostId === "host-a")).toBe(false);
  });

  it("STALE host: a previously-good host that fails serves its last-known rows marked stale with last-success", async () => {
    const cache = new Map<string, { at: string; missions: FleetScopesPayload["missions"]; project: string | null }>();
    let at = "2026-01-02T00:00:00.000Z";
    const good = (async () => scopesCountsResponse([{ mission: "known", slices: [{ dirName: "d", id: "d", displayName: "D", status: null, stage: null, locks: { spec: null, delivery: null } }] }])) as typeof fetch;
    const first = await aggregateFleetScopes(deps({ fetchImpl: good, cache, now: () => at }));
    expect(first.hosts.find(okHost("host-a"))?.status).toBe("ok");
    at = "2026-01-02T00:00:01.000Z";
    const second = await aggregateFleetScopes(deps({
      fetchImpl: (async (url: string | URL | Request) => {
        if (String(url).includes("host-a")) throw new Error("host-a down");
        return scopesCountsResponse([]);
      }) as typeof fetch,
      cache,
      now: () => at,
    }));
    const a = second.hosts.find(okHost("host-a"))!;
    expect(a.status).toBe("stale");
    expect(a.lastSuccessAt).toBe("2026-01-02T00:00:00.000Z");
    expect(a.observedAt).toBe("2026-01-02T00:00:01.000Z");
    expect(a.error).toContain("host-a down");
    // The last-known rows ride along, attributed and marked by the host status.
    const known = missionOf(second, "host-a", "known");
    expect(known).toHaveLength(1);
    expect(known[0]!.slices[0]!.id).toBe("d");
  });

  it("unsupported: HTTP 404 says the remote daemon does not serve the scopes read", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async () => new Response("no route", { status: 404 })) as typeof fetch,
    }));
    expect(p.hosts.find(okHost("host-a"))?.status).toBe("unsupported");
  });

  it("auth-failed: HTTP 401 is its own class, distinct from unreachable", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async () => new Response("no", { status: 401 })) as typeof fetch,
    }));
    expect(p.hosts.find(okHost("host-a"))?.status).toBe("auth-failed");
  });

  it("unsupported-transport: an SSH-declared host is reported, never dialed", async () => {
    const dialed: string[] = [];
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async (url: string | URL | Request) => { dialed.push(String(url)); return scopesCountsResponse([]); }) as typeof fetch,
    }));
    const ssh = p.hosts.find(okHost("ssh-1"))!;
    expect(ssh.status).toBe("unsupported-transport");
    expect(ssh.error).toContain("SSH-declared");
    expect(dialed.every(u => !u.includes("ssh-1"))).toBe(true);
  });

  it("a 200 with a garbage body is unreachable with the reason, never half-parsed rows", async () => {
    const p = await aggregateFleetScopes(deps({
      fetchImpl: (async () => new Response(JSON.stringify({ nope: true }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch,
    }));
    const a = p.hosts.find(okHost("host-a"))!;
    expect(a.status).toBe("unreachable");
    expect(a.error).toContain("missions");
  });

  it("every http host appears in hosts[] on every call, whatever its status", async () => {
    const p = await aggregateFleetScopes(deps());
    for (const id of [SELF, "host-a", "host-b", "ssh-1"]) expect(p.hosts.filter(h => h.hostId === id)).toHaveLength(1);
  });
});

describe("aggregateFleetScopes — registry honesty", () => {
  it("an unreadable registry keeps the local rows complete and says why nothing else is shown", async () => {
    const p = await aggregateFleetScopes(deps({ loadRegistry: () => ({ ok: false, error: "hosts.yaml unreadable" }) }));
    expect(p.registry).toEqual({ state: "unreadable", error: "hosts.yaml unreadable" });
    expect(p.missions.every(m => m.hostId === SELF)).toBe(true);
    expect(p.hosts).toHaveLength(1);
  });

  it("an entry that names this daemon is skipped, not dialed", async () => {
    const dialed: string[] = [];
    const p = await aggregateFleetScopes(deps({
      loadRegistry: () => ({ ok: true, registry: { hosts: [{ id: "my-laptop", hostId: SELF, transport: "http", url: "http://127.0.0.1:7433" }, { id: "host-a", transport: "http", url: "http://host-a:7433" }] } }),
      fetchImpl: (async (url: string | URL | Request) => { dialed.push(String(url)); return scopesCountsResponse([]); }) as typeof fetch,
    }));
    expect(p.skipped).toEqual([{ hostId: "my-laptop", reason: expect.stringContaining("read once as local") }]);
    expect(p.hosts.find(okHost("my-laptop"))).toBeUndefined();
    expect(dialed.every(u => !u.includes("127.0.0.1"))).toBe(true);
  });
});

describe("the cache follows the resolved address, not the registry alias", () => {
  const mission = (hostId: string) => ({ hostId, hostLabel: hostId, project: null, mission: "m-old", slices: [] as unknown[] });
  const URL_A = "http://host-a:7433";

  it("stale rows from a renamed entry re-stamp with the entry's current id", async () => {
    const cache = new Map([[URL_A, { at: "2026-01-01T00:00:00.000Z", missions: [mission("old-name")], project: null }]] as never);
    // The registry renamed the entry but it points at the same address; the read now fails.
    const renamed = { hosts: [{ id: "new-name", transport: "http" as const, url: URL_A }] } as HostRegistry;
    const failing = (async () => { throw new Error("connect ECONNREFUSED"); }) as typeof fetch;
    const payload = await aggregateFleetScopes(deps({ loadRegistry: () => ({ ok: true, registry: renamed }), fetchImpl: failing, cache }));
    const host = payload.hosts.find((h) => h.hostId === "new-name")!;
    expect(host.status).toBe("stale");
    // The served rows carry the CURRENT id, so the view still groups them.
    expect(payload.missions.filter((m) => m.mission === "m-old").map((m) => m.hostId)).toEqual(["new-name"]);
    expect(payload.missions.filter((m) => m.mission === "m-old")[0]!.hostLabel).toBe("new-name");
  });

  it("a deadline-skipped host finds its warm entry under the resolved address and re-stamps it", async () => {
    const cache = new Map([[URL_A, { at: "2026-01-01T00:00:00.000Z", missions: [mission("old-name")], project: null }]] as never);
    const renamed = { hosts: [{ id: "new-name", transport: "http" as const, url: URL_A }] } as HostRegistry;
    const payload = await aggregateFleetScopes(deps({
      loadRegistry: () => ({ ok: true, registry: renamed }),
      fetchImpl: (async () => scopesCountsResponse([])) as typeof fetch,
      cache,
      viewDeadlineMs: -1, // every leg starts past the deadline
    }));
    const host = payload.hosts.find((h) => h.hostId === "new-name")!;
    expect(host.status).toBe("stale");
    expect(host.error).toContain("deadline exceeded");
    expect(payload.missions.filter((m) => m.mission === "m-old").map((m) => m.hostId)).toEqual(["new-name"]);
  });
});
