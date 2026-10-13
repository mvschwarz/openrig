import { Hono, type Context } from "hono";
import type { ProviderService } from "../domain/provider/provider-service.js";

// Slice-04 (OPR.0.5.0.4) seam B — the `/api/provider` routes (packet 3ffa3c22 §3). Thin handlers
// over ONE service read model (filtered projections cannot diverge). Edge validation -> 400; an
// unsafe precheck is a 200 verdict; switch business outcomes are 200 payloads; an unwired service
// is a loud 503 (never an empty/fabricated four-block). No collection or policy logic lives here.

const VALID_PROVIDERS = new Set(["codex", "claude"]);

export function providerRoutes(): Hono {
  const router = new Hono();

  const svcOf = (c: Context): ProviderService | null =>
    (c.get("providerService" as never) as ProviderService | undefined) ?? null;
  const unavailable = 503 as const;
  const okProvider = (p: string | undefined): boolean => p === undefined || VALID_PROVIDERS.has(p);
  // When present, an account filter must be a non-empty, non-whitespace ref.
  const okAccount = (a: string | undefined): boolean => a === undefined || a.trim().length > 0;
  // A malformed filter (bad provider enum or empty account) is a 400; returns the message or null.
  const filterError = (provider: string | undefined, account: string | undefined): string | null => {
    if (!okProvider(provider)) return `invalid provider: ${provider}`;
    if (!okAccount(account)) return "account must be a non-empty ref";
    return null;
  };

  router.get("/status", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    return c.json(await svc.getReadModel(), 200);
  });

  // S-B (OPR.0.5.0.4-B) — the external status site's ENTIRE contract: GET /api/provider/usage
  // SERVES the S-A host-level rollup rows (model.hostUsage) verbatim from the one read model. No
  // derivation here — state/windows/resets_at/anomalies/provenance are built in S-A's rollupHostUsage
  // (and the rows carry NO account identity by construction, only (host, provider) + topology seats).
  // Absent block -> honest empty array (never a fabricated row); unwired service -> loud 503.
  router.get("/usage", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const model = await svc.getReadModel();
    return c.json({ hostUsage: model.hostUsage ?? [] }, 200);
  });

  // Slice 01 (OPR.0.7.0.1) — the ONLY route that starts a native usage read: one bounded Codex read (35 s),
  // or Claude's identity read (claude auth status, 10 s; Claude's windows come from the seats' status-line
  // samples), shared by matching overlapping requests. A failed read is a 200 outcome that keeps the
  // last reading; the switch off is a 409 naming the key. Synchronous because the read is local;
  // a cross-host refresh needs an asynchronous receipt (later change).
  router.post("/usage/refresh", async (c) => {
    const svc = svcOf(c);
    if (!svc || !svc.refreshUsage) return c.json({ error: "provider_service_unavailable" }, unavailable);
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const provider = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)["provider"] ?? "codex"
      : "codex";
    if (provider !== "codex" && provider !== "claude") {
      return c.json({ error: `usage windows can be refreshed for codex or claude (got ${String(provider)})` }, 400);
    }
    const result = await svc.refreshUsage(provider);
    if ("disabled" in result) {
      return c.json({
        error: "usage_windows_disabled",
        message: `${provider === "codex" ? "Codex" : "Claude"} usage windows are off. Turn them on with: rig config set provider.usage_windows true`,
      }, 409);
    }
    if ("unavailable" in result) return c.json({ error: `${provider} usage windows are not available on this daemon` }, 400);
    // The refreshed provider's rows only, so one provider's answer never carries another's.
    const model = await svc.getReadModel();
    return c.json({ ...result, usage: (model.usage ?? []).filter((row) => row.provider === provider) }, 200);
  });

  router.get("/accounts", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const accounts = model.accounts.filter(
      (a) => (provider === undefined || a.provider === provider) && (account === undefined || a.accountId === account),
    );
    return c.json({ accounts }, 200);
  });

  router.get("/bindings", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const providerOf = new Map(model.accounts.map((a) => [a.accountId, a.provider]));
    const bindings = model.bindings.filter(
      (b) =>
        (account === undefined || b.accountId === account) &&
        (provider === undefined || (b.accountId !== null && providerOf.get(b.accountId) === provider)),
    );
    return c.json({ bindings }, 200);
  });

  router.get("/signals", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const provider = c.req.query("provider");
    const account = c.req.query("account");
    const filterErr = filterError(provider, account);
    if (filterErr) return c.json({ error: filterErr }, 400);
    const model = await svc.getReadModel();
    const signals = model.signals.filter(
      (s) => (provider === undefined || s.provider === provider) && (account === undefined || s.accountRef === account),
    );
    return c.json({ signals }, 200);
  });

  router.get("/precheck", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const seat = c.req.query("seat");
    const toAccount = c.req.query("toAccount");
    // Trim for VALIDATION only — the opaque refs are passed through unrewritten.
    if (!seat || !seat.trim() || !toAccount || !toAccount.trim()) {
      return c.json({ error: "seat and toAccount are required" }, 400);
    }
    // An unsafe verdict is a valid 200 response, not an error.
    return c.json(await svc.precheck({ seat, toAccount }), 200);
  });

  router.post("/switch", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    // JSON null/array/primitive is malformed (400), not a 500 from reading a field off null.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return c.json({ error: "body must be a JSON object" }, 400);
    }
    const body = raw as Record<string, unknown>;
    const seat = body["seat"];
    const toAccount = body["toAccount"];
    const forceUnsafe = body["forceUnsafe"] ?? false;
    if (typeof seat !== "string" || seat.trim() === "" || typeof toAccount !== "string" || toAccount.trim() === "") {
      return c.json({ error: "seat and toAccount are required" }, 400);
    }
    if (typeof forceUnsafe !== "boolean") {
      return c.json({ error: "forceUnsafe must be a boolean" }, 400);
    }
    // Business outcome (incl. failed_safely / rebind_in_progress) is an explicit 200 payload.
    return c.json(await svc.switchAccount({ seat, toAccount, forceUnsafe }), 200);
  });

  return router;
}
