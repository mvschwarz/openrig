// OPR.0.4.4.15 FR-1 — the daemon-side attention aggregator.
//
// The honesty legs are load-bearing: every subscribed host appears in
// hosts[] every call (asserted through the CONTRACT's hostsCovered — arch
// pin B), failures are per-host structured statuses (never all-or-nothing,
// never silent thinning), the registry is lazy, and the local leg INVOKES
// the injected query (reuse, not reimplementation).

import { describe, it, expect } from "vitest";
import { aggregateAttention, ATTENTION_READ_TIMEOUT_MS } from "../src/domain/feed/attention-aggregator.js";
import type { AttentionAggregatorDeps } from "../src/domain/feed/attention-aggregator.js";
import { LOCAL_HOST_ID, hostsCovered } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";

const REGISTRY: HostRegistry = {
  hosts: [
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
    { id: "vps-c", transport: "http", url: "http://vps-c:7433", bearer_env: "C" },
    { id: "ssh-1", transport: "ssh", target: "x.local" },
  ],
};

function attentionResponse(items: unknown[]): Response {
  return new Response(JSON.stringify(items), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deps(overrides: Partial<AttentionAggregatorDeps> = {}): AttentionAggregatorDeps {
  return {
    listLocalAttention: () => [{ qitemId: "local-1" }],
    listSubscriptions: () => [],
    loadRegistry: () => ({ ok: true, registry: REGISTRY }),
    env: { B: "tb", C: "tc" },
    ...overrides,
  };
}

describe("aggregateAttention — zero-config + local leg", () => {
  it("no enabled subscriptions: local items stamped LOCAL_HOST_ID, registry NEVER read", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [{ hostId: "vps-b", enabled: false }],
        loadRegistry: () => {
          throw new Error("registry must not be read without an enabled remote subscription");
        },
      }),
    );
    expect(res.items).toEqual([{ qitemId: "local-1", hostId: LOCAL_HOST_ID }]);
    expect(res.hosts).toEqual([{ hostId: LOCAL_HOST_ID, status: "ok" }]);
  });

  it("local items come from the INJECTED query (the same repo query the route runs)", async () => {
    let invoked = 0;
    await aggregateAttention(
      deps({
        listLocalAttention: () => {
          invoked += 1;
          return [];
        },
      }),
    );
    expect(invoked).toBe(1);
  });
});

describe("aggregateAttention — fan-out + per-host honesty (FR-1/R15-2)", () => {
  it("merges multi-host items with origin stamping; hosts[] complete per the CONTRACT predicate", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async (url: string | URL | Request) =>
          String(url).includes("vps-b")
            ? attentionResponse([{ qitemId: "b-1" }, { qitemId: "b-2" }])
            : attentionResponse([{ qitemId: "c-1" }])) as typeof fetch,
      }),
    );
    expect(res.items).toEqual([
      { qitemId: "local-1", hostId: LOCAL_HOST_ID },
      { qitemId: "b-1", hostId: "vps-b" },
      { qitemId: "b-2", hostId: "vps-b" },
      { qitemId: "c-1", hostId: "vps-c" },
    ]);
    expect(hostsCovered(res, [LOCAL_HOST_ID, "vps-b", "vps-c"])).toBe(true); // arch pin B — at the contract
  });

  it("one unreachable host degrades to a structured status; the other hosts' items still return (never all-or-nothing)", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async (url: string | URL | Request) => {
          if (String(url).includes("vps-b")) throw new Error("ECONNREFUSED");
          return attentionResponse([{ qitemId: "c-1" }]);
        }) as typeof fetch,
      }),
    );
    expect(res.hosts).toEqual([
      { hostId: LOCAL_HOST_ID, status: "ok" },
      { hostId: "vps-b", status: "unreachable", error: "ECONNREFUSED", failedStep: "remote-daemon-unreachable" },
      { hostId: "vps-c", status: "ok" },
    ]);
    expect(res.items.map((i) => i["qitemId"])).toEqual(["local-1", "c-1"]);
  });

  it("SSH-declared host → unsupported-transport (R15-2); unknown host id and registry failure → per-host unreachable with the reader's error", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "ssh-1", enabled: true },
          { hostId: "ghost", enabled: true },
        ],
        fetchImpl: (async () => attentionResponse([])) as typeof fetch,
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "ssh-1", status: "unsupported-transport" });
    expect(res.hosts[1]!.error).toContain("http-transport");
    expect(res.hosts[2]!.status).toBe("unreachable");
    expect(res.hosts[2]!.error).toContain("unknown host id 'ghost'");
    expect(hostsCovered(res, [LOCAL_HOST_ID, "ssh-1", "ghost"])).toBe(true);
  });

  it("auth failures classify auth-failed (bearer missing AND remote 401), with the FailedStep detail riding additively", async () => {
    const res = await aggregateAttention(
      deps({
        env: { C: "tc" }, // B missing → bearer failure for vps-b
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        fetchImpl: (async () => new Response("{}", { status: 401 })) as typeof fetch, // vps-c reaches the wire → 401
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "vps-b", status: "auth-failed", failedStep: "permission-gate" });
    expect(res.hosts[1]!.error).toContain("bearer env var B");
    expect(res.hosts[2]).toMatchObject({ hostId: "vps-c", status: "auth-failed", failedStep: "permission-gate" });
  });

  it("a stalled remote read times out within the READ deadline class and reports unreachable (the walk never hangs)", async () => {
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [{ hostId: "vps-b", enabled: true }],
        timeoutMs: 20,
        fetchImpl: ((_u: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_r, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          })) as typeof fetch,
      }),
    );
    expect(res.hosts[1]).toMatchObject({ hostId: "vps-b", status: "unreachable", failedStep: "remote-daemon-unreachable" });
    expect(res.hosts[1]!.error).toContain("timed out");
  });

  it("the read deadline class is the 5s poll bound, not the up-leaf budget", () => {
    expect(ATTENTION_READ_TIMEOUT_MS).toBe(5_000);
  });

  it("fan-out cap: at most `concurrency` remote reads in flight; subscription order preserved in the payload", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const res = await aggregateAttention(
      deps({
        listSubscriptions: () => [
          { hostId: "vps-b", enabled: true },
          { hostId: "vps-c", enabled: true },
        ],
        concurrency: 1,
        fetchImpl: (async (url: string | URL | Request) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((r) => setTimeout(r, 5));
          inFlight -= 1;
          return attentionResponse([{ qitemId: String(url).includes("vps-b") ? "b-1" : "c-1" }]);
        }) as typeof fetch,
      }),
    );
    expect(maxInFlight).toBe(1);
    expect(res.hosts.map((h) => h.hostId)).toEqual([LOCAL_HOST_ID, "vps-b", "vps-c"]);
    expect(res.items.map((i) => i["qitemId"])).toEqual(["local-1", "b-1", "c-1"]);
  });
});


describe("aggregateAttention — explicit host target", () => {
  const unrelatedRead = () => { throw new Error("unrelated read"); };

  it("explicit local target skips subscriptions, registry and remote reads", async () => {
    const res = await aggregateAttention(deps({
      listSubscriptions: unrelatedRead,
      loadRegistry: unrelatedRead,
      fetchImpl: unrelatedRead,
    }), "local");
    expect(res).toEqual({ items: [{ qitemId: "local-1", hostId: "local" }], hosts: [{ hostId: "local", status: "ok" }] });
  });

  it.each(["vps-b", "self-b"])("reads only the unsubscribed registered target %s", async (target) => {
    const urls: string[] = [];
    const res = await aggregateAttention(deps({
      listLocalAttention: unrelatedRead,
      listSubscriptions: unrelatedRead,
      loadRegistry: () => ({ ok: true, registry: { hosts: [
        { id: "vps-b", hostId: "self-b", transport: "http", url: "http://vps-b:7433", bearer_env: "B" },
        { id: "unrelated", transport: "http", url: "http://unrelated:7433" },
      ] } }),
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tb");
        return attentionResponse([{ qitemId: "remote-1" }]);
      }) as typeof fetch,
    }), target);
    expect(urls).toEqual(["http://vps-b:7433/api/queue/list?attention=1"]);
    expect(res).toEqual({ items: [{ qitemId: "remote-1", hostId: target }], hosts: [{ hostId: target, status: "ok" }] });
  });

  it("unknown target returns only its error and never falls back to subscriptions", async () => {
    const res = await aggregateAttention(deps({ listLocalAttention: unrelatedRead, listSubscriptions: unrelatedRead, fetchImpl: unrelatedRead }), "ghost");
    expect(res.items).toEqual([]);
    expect(res.hosts).toEqual([{ hostId: "ghost", status: "unreachable", error: expect.stringContaining("unknown host id 'ghost'") }]);
  });

  it("a silent selected target times out without reading any unrelated host", async () => {
    const urls: string[] = [];
    const res = await aggregateAttention(deps({
      listLocalAttention: unrelatedRead, listSubscriptions: unrelatedRead, timeoutMs: 20,
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => {
        urls.push(String(url));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }) as typeof fetch,
    }), "vps-b");
    expect(urls).toEqual(["http://vps-b:7433/api/queue/list?attention=1"]);
    expect(res.items).toEqual([]);
    expect(res.hosts).toEqual([{ hostId: "vps-b", status: "unreachable", error: "read timed out after 20ms", failedStep: "remote-daemon-unreachable" }]);
    expect(ATTENTION_READ_TIMEOUT_MS).toBe(5_000);
  });

  it("selected target retains auth-failed and unsupported-transport outcomes", async () => {
    for (const [host, status] of [["vps-b", "auth-failed"], ["ssh-1", "unsupported-transport"]]) {
      const res = await aggregateAttention(deps({ listLocalAttention: unrelatedRead, listSubscriptions: unrelatedRead, env: {}, fetchImpl: unrelatedRead }), host);
      expect(res.items).toEqual([]);
      expect(res.hosts).toHaveLength(1);
      expect(res.hosts[0]).toMatchObject({ hostId: host, status });
    }
  });
});
