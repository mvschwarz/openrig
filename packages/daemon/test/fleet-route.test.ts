// OPR.0.4.6.MH5 C2 — GET /api/review/fleet (the sibling aggregate route).
//
// Fan-out depth is owned by fleet-compose.test.ts; this file pins the ROUTE
// wiring + payload contract: the gatherer-unavailable 503, the registry DI
// (same style as /api/queue/attention-aggregate), registry-absent = clean
// local-only fleet, per-host honesty THROUGH the route with zero network
// (ssh + unset-bearer legs), no bearer material in the response body (the
// full browser-bound SENTINEL proof rides the VM leg-7 per the QA2 binding
// check), and the sibling-purity zero-regression pin (/rig and /agents are
// byte-untouched by the fleet addition).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { reviewRoutes } from "../src/routes/review.js";
import { LOCAL_HOST_ID } from "../src/domain/hosts/fanout-contract.js";
import type { PerHostStatusKind } from "../src/domain/hosts/fanout-contract.js";
import type { HostRegistry } from "../src/domain/hosts/hosts-registry-reader.js";
import type { ComposedFleet, ComposedRigAgents, NeedsYouItem } from "../src/domain/review/types.js";

// TYPE-LEVEL PIN (§0.4): PerHostStatusKind stays the CLOSED 4-value enum.
// A union GAIN breaks this literal (missing key); a union LOSS breaks it
// (excess key) — MH-5 aggregates the reachability axis, never extends it.
const CLOSED_PER_HOST_KINDS: Record<PerHostStatusKind, true> = {
  ok: true,
  unreachable: true,
  "unsupported-transport": true,
  "auth-failed": true,
};

const NOW = "2026-07-08T14:00:00.000Z";

const LOCAL_ITEM: NeedsYouItem = {
  source: "agent",
  identity: "qi-local-1",
  summary: "Sign-off needed",
  leg: "human-gate",
  where: "rig",
  ageIso: "2026-07-08T13:00:00.000Z",
  priority: "urgent",
  tier: "human-gate",
  evidenceRef: null,
  unblocks: null,
  qitemId: "qi-local-1",
  destinationSession: "human@host",
  derived: null,
};

const LOCAL_COMPOSED: ComposedRigAgents = {
  scope: "rig",
  needsYou: { items: [LOCAL_ITEM], provenance: "composed from the rig read root" },
  agents: {
    scope: "rig",
    rows: [
      { agentName: "lead", runtime: "claude-code", stateGlyph: "active", doing: null, holdsCount: 1, lastTransitionIso: null, exception: null, sessionName: "lead@acme-build", slices: [] },
    ],
    provenance: "seats",
    coordinationHealth: null,
  },
  settled: [],
  settledProvenance: "today's closed handoffs",
  composedAt: NOW,
};

function makeApp(opts: {
  withGatherer?: boolean;
  registry?: HostRegistry;
  registryExists?: boolean;
} = {}) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const set = c.set.bind(c) as (key: string, value: unknown) => void;
    if (opts.withGatherer !== false) {
      set("reviewGatherer", { composeRig: () => LOCAL_COMPOSED });
    }
    set("hostRegistryExists", () => opts.registryExists ?? opts.registry !== undefined);
    if (opts.registry) set("hostRegistryLoader", () => ({ ok: true, registry: opts.registry }));
    await next();
  });
  app.route("/api/review", reviewRoutes());
  return app;
}

describe("GET /api/review/fleet — route wiring + payload contract", () => {
  it("gatherer unavailable → the family's 503 vocabulary", async () => {
    const app = makeApp({ withGatherer: false });
    const res = await app.request("/api/review/fleet");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "review_composer_unavailable" });
  });

  it("no registry = a clean LOCAL-ONLY fleet (single-host operator; no registryError)", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/fleet");
    expect(res.status).toBe(200);
    const fleet = (await res.json()) as ComposedFleet;
    expect(fleet.hosts).toHaveLength(1);
    expect(fleet.hosts[0]).toMatchObject({ hostId: LOCAL_HOST_ID, kind: "local", status: { hostId: LOCAL_HOST_ID, status: "ok" } });
    expect("registryError" in fleet).toBe(false);
    // The local composed set flowed through the IN-PROCESS gatherer (D-1).
    expect(fleet.needsYou.items).toHaveLength(1);
    expect(fleet.needsYou.items[0]).toMatchObject({ fleetKey: `${LOCAL_HOST_ID}|qi-local-1`, hostId: LOCAL_HOST_ID, seenFrom: ["rig"] });
    expect(fleet.rollup).toEqual({ needsYouCount: 1, exceptionCount: 0, exceptionsByKind: [], hostCount: 1, unreachableCount: 0 });
  });

  it("an ssh-declared host degrades to unsupported-transport THROUGH the route (zero network); counts ABSENT on its row", async () => {
    const app = makeApp({ registry: { hosts: [{ id: "vps-b", transport: "ssh", target: "b.local" }] } });
    const res = await app.request("/api/review/fleet");
    const fleet = (await res.json()) as ComposedFleet;
    expect(fleet.hosts.map((h) => [h.hostId, h.status.status])).toEqual([
      [LOCAL_HOST_ID, "ok"],
      ["vps-b", "unsupported-transport"],
    ]);
    const b = fleet.hosts[1]!;
    expect("needsYouCount" in b).toBe(false);
    expect("seatCount" in b).toBe(false);
    expect(fleet.rollup.unreachableCount).toBe(1);
    expect(fleet.needsYou.provenance).toContain("1/2 hosts composing");
  });

  it("an http host whose bearer env is UNSET → auth-failed with the env-var name; NO bearer/Authorization material in the body", async () => {
    const app = makeApp({
      registry: { hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a.invalid:7433", bearer_env: "MH5_ROUTE_TEST_BEARER_DELIBERATELY_UNSET" }] },
    });
    const res = await app.request("/api/review/fleet");
    const fleet = (await res.json()) as ComposedFleet;
    const a = fleet.hosts.find((h) => h.hostId === "vps-a")!;
    expect(a.status.status).toBe("auth-failed");
    expect(a.status.error).toContain("MH5_ROUTE_TEST_BEARER_DELIBERATELY_UNSET");
    // The response body carries the env-var NAME (the operator fix), never
    // header/token material. The browser-bound sentinel grep is VM leg 7.
    const body = JSON.stringify(fleet);
    expect(body).not.toContain("Authorization");
    expect(body).not.toContain("Bearer ");
  });

  it("the payload carries the full ComposedFleet contract members", async () => {
    const app = makeApp({ registryExists: false });
    const fleet = (await (await app.request("/api/review/fleet")).json()) as ComposedFleet;
    for (const key of ["rollup", "needsYou", "hosts", "settled", "settledProvenance", "composedAt"]) {
      expect(Object.keys(fleet)).toContain(key);
    }
    expect(typeof fleet.composedAt).toBe("string");
  });
});

describe("sibling purity — the existing family is untouched by the fleet addition (zero-regression pin)", () => {
  it("GET /rig still returns the gatherer's composeRig() verbatim", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/rig");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(JSON.stringify(LOCAL_COMPOSED)));
  });

  it("GET /agents scope grammar is still EXACTLY 3-valued (a 'fleet' scope is invalid — arch Q2)", async () => {
    const app = makeApp({ registryExists: false });
    const res = await app.request("/api/review/agents?scope=fleet");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toBe("scope_invalid");
    expect(body.hint).toContain("slice:<id> | mission:<id> | rig");
  });

  it("the per-host reachability enum stays closed (compile-time pin above)", () => {
    expect(Object.keys(CLOSED_PER_HOST_KINDS)).toHaveLength(4);
  });
});
