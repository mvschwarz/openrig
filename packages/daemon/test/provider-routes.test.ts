import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { providerRoutes } from "../src/routes/provider.js";
import type { ProviderService } from "../src/domain/provider/provider-service.js";
import type { FourBlockReadModel } from "../src/domain/provider/provider-types.js";

// Slice-04 (OPR.0.5.0.4) seam B — the daemon provider routes (packet 3ffa3c22 §3). Thin handlers
// over ONE service read model: filtered projections cannot diverge; edge validation -> 400; unsafe
// precheck stays a 200 verdict; switch outcomes are 200 payloads; unwired service -> loud 503.

const MODEL: FourBlockReadModel = {
  accounts: [
    { accountId: "cdx-a", label: "Codex A", provider: "codex", authState: "active", profileRef: "p-a", asOf: "2026-08-03T12:00:00.000Z" },
    { accountId: "cla-x", label: "Claude X", provider: "claude", authState: "active", profileRef: null, asOf: "2026-08-03T12:00:00.000Z" },
  ],
  bindings: [
    { accountId: "cdx-a", seatSession: "seat-1", rigName: "r1", boundAt: "2026-08-03T12:00:00.000Z", bindingSource: "adopt", anomalies: [] },
  ],
  signals: [
    { provider: "codex", accountRef: "cdx-a", sourceClass: "provider_structured_read", authority: "account_cross_device", window: "primary", usedPercent: 40, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: true, automationUse: "allow_switch_decision" },
    { provider: "claude", accountRef: "cla-x", sourceClass: "provider_statusline", authority: "account_cross_device", window: "five_hour", usedPercent: 10, asOf: "2026-08-03T12:00:00.000Z", staleAfter: "2026-08-03T12:05:00.000Z", supportsNotification: false, automationUse: "allow_switch_decision" },
  ],
  asOf: "2026-08-03T12:00:00.000Z",
};

const stubService: ProviderService = {
  getReadModel: async () => MODEL,
  precheck: async ({ toAccount }) => (toAccount === "cdx-a" ? { safe: true } : { safe: false, reasons: ["target_needs_reauth"] }),
  switchAccount: async ({ toAccount }) =>
    toAccount === "cla-x"
      ? { outcome: "failed_safely", reasons: ["rebind_unsupported_for_runtime"] as [string, ...string[]] }
      : { outcome: "succeeded" },
};

function appWith(svc: ProviderService | null): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    if (svc) c.set("providerService" as never, svc);
    await next();
  });
  app.route("/api/provider", providerRoutes());
  return app;
}

describe("provider routes", () => {
  it("GET /status returns the whole four-block model", async () => {
    const res = await appWith(stubService).request("/api/provider/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MODEL);
  });

  it("accounts/bindings/signals are FILTERED projections of the one model (cannot diverge)", async () => {
    const app = appWith(stubService);
    const acc = await (await app.request("/api/provider/accounts?provider=codex")).json();
    expect(acc.accounts.map((a: { accountId: string }) => a.accountId)).toEqual(["cdx-a"]);
    const sig = await (await app.request("/api/provider/signals?provider=claude")).json();
    expect(sig.signals.map((s: { accountRef: string }) => s.accountRef)).toEqual(["cla-x"]);
    const bnd = await (await app.request("/api/provider/bindings?account=cdx-a")).json();
    expect(bnd.bindings).toHaveLength(1);
    expect(bnd.bindings[0].seatSession).toBe("seat-1");
  });

  it("rejects a malformed provider enum at the edge (400)", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?provider=bad");
    expect(res.status).toBe(400);
  });

  it("rejects an empty/whitespace account filter at the edge (400)", async () => {
    const res = await appWith(stubService).request("/api/provider/accounts?account=");
    expect(res.status).toBe(400);
  });

  it("a JSON null switch body is malformed (400), never an accidental 500", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    expect(res.status).toBe(400);
  });

  it("precheck returns a 200 VERDICT even when unsafe (safe:false is not an error)", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1&toAccount=cla-x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.safe).toBe(false);
    expect(body.reasons).toContain("target_needs_reauth");
  });

  it("precheck requires seat and toAccount (400 when missing)", async () => {
    const res = await appWith(stubService).request("/api/provider/precheck?seat=s1");
    expect(res.status).toBe(400);
  });

  it("switch business outcomes are 200 payloads, not transport errors (failed_safely = 200)", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", toAccount: "cla-x", forceUnsafe: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe("failed_safely");
    // BR-1: a failed_safely outcome MUST carry fail-visible reasons (type-enforced + asserted).
    expect(Array.isArray(body.reasons)).toBe(true);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("rejects whitespace-only seat/toAccount at the edge (precheck query AND switch body) -> 400", async () => {
    const app = appWith(stubService);
    const pre = await app.request("/api/provider/precheck?seat=%20%20&toAccount=cdx-a");
    expect(pre.status).toBe(400);
    const sw = await app.request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "  ", toAccount: "cdx-a", forceUnsafe: false }),
    });
    expect(sw.status).toBe(400);
  });

  it("switch validates seat/toAccount/forceUnsafe at the edge (400 on malformed)", async () => {
    const res = await appWith(stubService).request("/api/provider/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "s1", forceUnsafe: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("an UNWIRED service returns a loud 503 provider_service_unavailable (never a fabricated stub)", async () => {
    const res = await appWith(null).request("/api/provider/status");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("provider_service_unavailable");
  });
});
