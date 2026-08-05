// Slice-04 (OPR.0.5.0.4) S-B — GET /api/provider/usage: the external status site's ENTIRE contract.
// A THIN route over the S-A host rollup: it SERVES model.hostUsage (rollupHostUsage rows) verbatim —
// no derivation lives here (state/windows/resets_at/conflict-anomaly/provenance are all built in S-A).
// Route-level pins: contract shape, anomaly rendering (both-facts-visible), the no-account-id BELT at
// the route altitude, explicit_unknown passthrough, and the loud 503 on an unwired service.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import type { ProviderService } from "../src/domain/provider/provider-service.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";
import type { HostUsageRow } from "../src/domain/provider/host-usage-rollup.js";

const AS_OF = "2026-08-03T12:00:00.000Z";
const PROVENANCE = {
  basis: "one_account_per_host_deployment_invariant" as const,
  note: "host==account deployment invariant declared by the operator; no account identity is read or emitted.",
};

const HOST_USAGE: HostUsageRow[] = [
  // ok
  { host: "local", provider: "claude", state: "ok", windows: [{ window: "five_hour", usedPercent: 10, asOf: AS_OF, seatSession: "review-r1@rig" }], provenance: PROVENANCE, anomalies: [], evidenceSeats: ["review-r1@rig"], asOf: AS_OF },
  // limited + resets_at
  { host: "local", provider: "codex", state: "limited", resetsAt: "2026-08-03T13:00:00.000Z", windows: [{ window: "primary", usedPercent: 100, resetsAt: "2026-08-03T13:00:00.000Z", asOf: AS_OF, seatSession: "dev-qa@rig" }], provenance: PROVENANCE, anomalies: [], evidenceSeats: ["dev-qa@rig"], asOf: AS_OF },
  // explicit_unknown + reason (passthrough)
  { host: "local", provider: "codex", state: "explicit_unknown", unknownReason: "codex profile present but no usage meter", windows: [], provenance: PROVENANCE, anomalies: [], evidenceSeats: [], asOf: AS_OF },
];

// a row carrying a first-class conflict anomaly (both-facts-visible)
const HOST_USAGE_CONFLICT: HostUsageRow[] = [
  { host: "local", provider: "claude", state: "explicit_unknown", unknownReason: "conflicting seat windows falsify the one-account-per-host invariant", windows: [], provenance: PROVENANCE, anomalies: [{ kind: "conflicting_seat_windows", window: "five_hour", seats: ["a@rig", "b@rig"], evidence: "a=20% vs b=90% at same asOf", asOf: AS_OF }], evidenceSeats: ["a@rig", "b@rig"], asOf: AS_OF },
];

function modelWith(hostUsage: HostUsageRow[] | undefined): FourBlockReadModel {
  return {
    // accounts intentionally carry account identifiers — the belt proves /usage never leaks them.
    accounts: [{ accountId: "cdx-secret-acct", label: "Codex", provider: "codex", authState: "active", profileRef: "p", asOf: AS_OF }],
    bindings: [],
    signals: [],
    ...(hostUsage !== undefined ? { hostUsage } : {}),
    asOf: AS_OF,
  };
}

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

const svc = (hostUsage: HostUsageRow[] | undefined): ProviderService => ({
  getReadModel: async () => modelWith(hostUsage),
  precheck: async () => ({ safe: true }),
  switchAccount: async () => ({ outcome: "succeeded" }),
});

describe("GET /api/provider/usage — S-B external status contract", () => {
  it("serves the host rollup rows verbatim (provider, state, windows, resets_at, asOf, evidence, provenance)", async () => {
    const res = await appWith(svc(HOST_USAGE)).request("/api/provider/usage");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hostUsage).toEqual(HOST_USAGE); // SERVED verbatim — no derivation, no re-shape
    const codexLimited = body.hostUsage.find((r: HostUsageRow) => r.provider === "codex" && r.state === "limited");
    expect(codexLimited.resetsAt).toBe("2026-08-03T13:00:00.000Z");
    expect(codexLimited.windows[0].usedPercent).toBe(100);
    expect(body.hostUsage[0].provenance.basis).toBe("one_account_per_host_deployment_invariant");
  });

  it("renders the conflict anomaly (both-facts-visible), never a silent merge", async () => {
    const body = await (await appWith(svc(HOST_USAGE_CONFLICT)).request("/api/provider/usage")).json();
    const row = body.hostUsage[0];
    expect(row.state).toBe("explicit_unknown");
    expect(row.anomalies).toHaveLength(1);
    expect(row.anomalies[0].kind).toBe("conflicting_seat_windows");
    expect(row.anomalies[0].seats).toEqual(["a@rig", "b@rig"]);
  });

  it("passes an explicit_unknown row through unchanged (state + unknownReason)", async () => {
    const body = await (await appWith(svc(HOST_USAGE)).request("/api/provider/usage")).json();
    const unknown = body.hostUsage.find((r: HostUsageRow) => r.state === "explicit_unknown");
    expect(unknown.unknownReason).toBe("codex profile present but no usage meter");
    expect(unknown.windows).toEqual([]);
  });

  it("BELT: the /usage response emits NO account identifier at the route altitude", async () => {
    const res = await appWith(svc(HOST_USAGE)).request("/api/provider/usage");
    const raw = await res.text();
    expect(raw).not.toContain("cdx-secret-acct"); // the accounts-block id never crosses into /usage
    expect(raw).not.toContain("accountId");
    expect(raw).not.toContain("accountRef");
  });

  it("empty rollup → an empty hostUsage array (honest, not a fabricated row)", async () => {
    const body = await (await appWith(svc([])).request("/api/provider/usage")).json();
    expect(body.hostUsage).toEqual([]);
  });

  it("unwired service → loud 503 (never an empty/fabricated payload)", async () => {
    const res = await appWith(null).request("/api/provider/usage");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("provider_service_unavailable");
  });
});
