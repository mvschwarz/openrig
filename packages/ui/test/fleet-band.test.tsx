// OPR.0.4.6.MH5 C5 — the FLEET band (placement option B) twin-state smokes
// + the FS-1 FETCH-GATE pin: a single-host operator's page issues ZERO new
// fleet reads (not just zero new pixels — the leg-7 zero-regression class,
// enforced at the request layer).

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FleetBand } from "../src/components/review/FleetBand.js";
import type { ComposedFleet } from "../src/hooks/useFleet.js";
import type { HostsResponse } from "../src/hooks/useHosts.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const HOSTS_EMPTY: HostsResponse = { ownName: "studio", selected: "local", hosts: [] };
const HOSTS_ONE_REMOTE: HostsResponse = {
  ownName: "studio",
  selected: "local",
  hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", bearer_env: "A", selected: false, status: "reachable" }],
};

function fleetFixture(over: Partial<ComposedFleet> = {}): ComposedFleet {
  return {
    rollup: {
      needsYouCount: 1,
      exceptionCount: 1,
      exceptionsByKind: [{ kind: "stuck", count: 1 }],
      hostCount: 2,
      unreachableCount: 0,
    },
    needsYou: {
      items: [
        {
          source: "derived",
          identity: "qi-a|stuck|t0",
          fleetKey: "vps-a|qi-a|stuck|t0",
          hostId: "vps-a",
          seenFrom: ["rig"],
          summary: "packer2 idle 47m with work",
          leg: "stuck",
          where: "rig",
          ageIso: null,
          priority: null,
          tier: null,
          evidenceRef: null,
          unblocks: null,
          qitemId: null,
          destinationSession: null,
          derived: { kind: "stuck", evidence: "idle 47m >= 30m", threshold: "stuck >= 30m idle" },
        },
        {
          source: "agent",
          identity: "qi-l1",
          fleetKey: "local|qi-l1",
          hostId: "local",
          seenFrom: ["rig"],
          summary: "sign-off needed",
          leg: "human-gate",
          where: "rig",
          ageIso: null,
          priority: "urgent",
          tier: "human-gate",
          evidenceRef: null,
          unblocks: null,
          qitemId: "qi-l1",
          destinationSession: "human@host",
          derived: null,
        },
      ],
      provenance: "fleet union · counted once per identity+host · 2/2 hosts composing",
    },
    hosts: [
      { hostId: "local", kind: "local", status: { hostId: "local", status: "ok" }, needsYouCount: 1, exceptionsByKind: [], seatCount: 1, rigCount: 1, topLine: "● sign-off needed" },
      { hostId: "vps-a", kind: "remote", status: { hostId: "vps-a", status: "ok" }, needsYouCount: 0, exceptionsByKind: [{ kind: "stuck", count: 1 }], seatCount: 2, rigCount: 1, topLine: "▲ stuck — packer2 idle 47m with work" },
    ],
    settled: [],
    settledProvenance: "0 settled handoffs across 2 composing hosts",
    composedAt: "2026-07-08T14:00:00.000Z",
    ...over,
  };
}

function stubFetch(hosts: HostsResponse | "hosts-500", fleet: ComposedFleet | null) {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.includes("/api/hosts")) {
      if (hosts === "hosts-500") {
        // The shipped route's unreadable-registry shape (routes/hosts.ts).
        return Promise.resolve(new Response(JSON.stringify({ error: "invalid_registry", message: "failed to parse host registry YAML" }), { status: 500 }));
      }
      return Promise.resolve(new Response(JSON.stringify(hosts), { status: 200 }));
    }
    if (url.includes("/api/review/fleet")) {
      if (!fleet) return Promise.resolve(new Response("{}", { status: 500 }));
      return Promise.resolve(new Response(JSON.stringify(fleet), { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
  return urls;
}

function renderBand() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <FleetBand />
    </QueryClientProvider>,
  );
}

describe("FleetBand — the FS-1 fetch gate + no-fleet behavior (rev1 note #3, explicit)", () => {
  it("NO registered remote host: renders NOTHING and the fleet read is NEVER fetched", async () => {
    const urls = stubFetch(HOSTS_EMPTY, fleetFixture());
    const { container } = renderBand();
    // Let the hosts query settle, then hold: no band, no fleet request.
    await waitFor(() => expect(urls.some((u) => u.includes("/api/hosts"))).toBe(true));
    expect(container.querySelector('[data-testid="fleet-band"]')).toBeNull();
    expect(urls.some((u) => u.includes("/api/review/fleet"))).toBe(false);
  });

  it("a registered remote host enables the ONE shared fleet read and renders the band", async () => {
    const urls = stubFetch(HOSTS_ONE_REMOTE, fleetFixture());
    const { getByTestId } = renderBand();
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(urls.some((u) => u.includes("/api/review/fleet"))).toBe(true);
  });
});

describe("FleetBand — rollup + worst line (the LOCKED band twin's anatomy)", () => {
  it("renders the DAEMON rollup + the first ▲ as the worst line (host-chipped) + OPEN FLEET → to the route", async () => {
    stubFetch(HOSTS_ONE_REMOTE, fleetFixture());
    const { getByTestId } = renderBand();
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(getByTestId("fleet-band-rollup").textContent).toContain("● 1");
    expect(getByTestId("fleet-band-rollup").textContent).toContain("▲ 1");
    expect(getByTestId("fleet-band-rollup").textContent).toContain("2 hosts");
    const worst = getByTestId("fleet-band-worst");
    expect(worst.textContent).toContain("packer2 idle 47m with work"); // the ▲ wins over the ●
    expect(worst.textContent).toContain("vps-a");
    expect(getByTestId("fleet-band-open").getAttribute("href")).toBe("/fleet");
  });

  it("a quiet fleet (rows empty) renders 'quiet' — never an invented worst line", async () => {
    stubFetch(
      HOSTS_ONE_REMOTE,
      fleetFixture({
        needsYou: { items: [], provenance: "0 items" },
        rollup: { needsYouCount: 0, exceptionCount: 0, exceptionsByKind: [], hostCount: 2, unreachableCount: 0 },
      }),
    );
    const { getByTestId } = renderBand();
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(getByTestId("fleet-band").textContent).toContain("quiet");
  });

  it("unreachable members surface in the band rollup (ambient honesty)", async () => {
    stubFetch(
      HOSTS_ONE_REMOTE,
      fleetFixture({
        rollup: { needsYouCount: 1, exceptionCount: 1, exceptionsByKind: [{ kind: "stuck", count: 1 }], hostCount: 3, unreachableCount: 1 },
      }),
    );
    const { getByTestId } = renderBand();
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(getByTestId("fleet-band-rollup").textContent).toContain("1 unreachable");
  });
});

describe("FleetBand — guard B1 regression: an unreadable registry is NEVER hidden behind a failing /api/hosts", () => {
  it("/api/hosts 500 (invalid_registry) → the fleet read still FIRES and the band surfaces registryError visibly", async () => {
    const urls = stubFetch(
      "hosts-500",
      fleetFixture({
        // What the daemon composer actually returns in this state: an
        // existing-but-unreadable registry → local-only + registryError.
        registryError: "failed to parse host registry YAML at ~/.openrig/hosts.yaml",
        hosts: [{ hostId: "local", kind: "local", status: { hostId: "local", status: "ok" }, needsYouCount: 0, exceptionsByKind: [], seatCount: 1, rigCount: 1, topLine: "quiet" }],
        needsYou: { items: [], provenance: "0 items" },
        rollup: { needsYouCount: 0, exceptionCount: 0, exceptionsByKind: [], hostCount: 1, unreachableCount: 0 },
      }),
    );
    const { getByTestId } = renderBand();
    // The fetch-gate must OPEN on hosts failure (the daemon composer is the
    // SSOT), and the honest ambient line must render.
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(urls.some((u) => u.includes("/api/review/fleet"))).toBe(true);
    expect(getByTestId("fleet-band").textContent).toContain("host registry unreadable — local-only glance");
  });

  it("a KNOWN-empty registry (hosts 200 with zero rows) stays fetch-gated — the FS-1 discipline is preserved", async () => {
    const urls = stubFetch(HOSTS_EMPTY, fleetFixture());
    const { container } = renderBand();
    await waitFor(() => expect(urls.some((u) => u.includes("/api/hosts"))).toBe(true));
    expect(container.querySelector('[data-testid="fleet-band"]')).toBeNull();
    expect(urls.some((u) => u.includes("/api/review/fleet"))).toBe(false);
  });
});

describe("FleetBand — inspection-only (guard binding note #1)", () => {
  it("renders no mutation affordance: the only interactive element is the OPEN FLEET navigation anchor", async () => {
    stubFetch(HOSTS_ONE_REMOTE, fleetFixture());
    const { getByTestId, container } = renderBand();
    await waitFor(() => expect(getByTestId("fleet-band")).toBeTruthy());
    expect(container.querySelectorAll("button")).toHaveLength(0);
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.getAttribute("href")).toBe("/fleet");
  });
});
