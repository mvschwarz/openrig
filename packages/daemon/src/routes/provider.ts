import { Hono, type Context } from "hono";
import { getSelfHostId, LOCAL_HOST_ID } from "../domain/hosts/fanout-contract.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { ProviderService } from "../domain/provider/provider-service.js";
import type { ProviderKind } from "../domain/provider/provider-types.js";
import { checkMoveReport, credentialRefusal, findCredential, MOVE_REPORT_TAG, readMoveReport, renderMoveReport, type MoveReport } from "../domain/provider/subscription-move-report.js";
import { QueueRepositoryError, type QueueRepository } from "../domain/queue-repository.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";
import {
  readUsageAcrossHosts,
  selectUsageHosts,
  UsageRefreshLegs,
  type UsageHostsDeps,
} from "../domain/provider/usage-across-hosts.js";

// Slice-04 (OPR.0.5.0.4) seam B — the `/api/provider` routes (packet 3ffa3c22 §3). Thin handlers
// over ONE service read model (filtered projections cannot diverge). Edge validation -> 400; an
// unsafe precheck is a 200 verdict; switch business outcomes are 200 payloads; an unwired service
// is a loud 503 (never an empty/fabricated four-block). No collection or policy logic lives here.

const VALID_PROVIDERS = new Set(["codex", "claude"]);

export interface ProviderRoutesOptions {
  /** Tests shorten the deadlines and pin the clock; production uses the named defaults. */
  usageAcrossHosts?: {
    readTimeoutMs?: number;
    viewDeadlineMs?: number;
    refreshDeadlineMs?: Partial<Record<ProviderKind, number>>;
    now?: () => string;
  };
}

export function providerRoutes(opts: ProviderRoutesOptions = {}): Hono {
  const router = new Hono();
  // Refresh legs across hosts live as long as these routes: overlapping requests join a running leg, and the last
  // leg per host and provider is shown beside that host's kept observations.
  const legs = new UsageRefreshLegs({
    ...(opts.usageAcrossHosts?.refreshDeadlineMs ? { deadlineMs: opts.usageAcrossHosts.refreshDeadlineMs } : {}),
    ...(opts.usageAcrossHosts?.now ? { now: opts.usageAcrossHosts.now } : {}),
  });

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
  // last reading; the switch off is a 409 naming the key. Synchronous: the read is bounded. Across hosts, see
  // /usage/hosts/refresh, whose legs call this route on each host.
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

  // Slice 01 — usage windows across registered hosts (provider.usage_windows on here). Hosts come from the host
  // registry (every entry; ssh ones are listed, not read), narrowed by ?hosts=a,b; this daemon is always included.
  const off = (what: string) => ({
    error: "usage_windows_disabled",
    message: `${what} needs usage windows on this daemon. Turn them on with: rig config set provider.usage_windows true`,
  });
  const hostsDeps = (c: Context, only: string[] | undefined): UsageHostsDeps => ({
    loadRegistry: (c.get("hostRegistryLoader" as never) as (() => ReturnType<typeof loadHostRegistry>) | undefined) ?? (() => loadHostRegistry()),
    selfHostId: getSelfHostId(),
    ...(only ? { only } : {}),
    lastRefresh: (hostId) => legs.lastFor(hostId),
    fetchImpl: c.get("remoteFetchImpl" as never) as typeof fetch | undefined,
    ...(opts.usageAcrossHosts?.readTimeoutMs !== undefined ? { readTimeoutMs: opts.usageAcrossHosts.readTimeoutMs } : {}),
    ...(opts.usageAcrossHosts?.viewDeadlineMs !== undefined ? { viewDeadlineMs: opts.usageAcrossHosts.viewDeadlineMs } : {}),
    ...(opts.usageAcrossHosts?.now ? { now: opts.usageAcrossHosts.now } : {}),
  });
  const hostList = (raw: string | undefined): string[] | undefined => {
    const ids = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return ids.length > 0 ? ids : undefined;
  };

  // Memory only, here and on every host: it GETs each host's served status and never starts a native read.
  router.get("/usage/hosts", async (c) => {
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const local = await svc.getReadModel();
    if (!Array.isArray(local.usage)) return c.json(off("Usage across hosts"), 409);
    const deps = hostsDeps(c, hostList(c.req.query("hosts")));
    const selection = selectUsageHosts(deps);
    if (!selection.ok) return c.json({ error: selection.error }, 400);
    return c.json(await readUsageAcrossHosts(local, selection, deps), 200);
  });

  // The explicit refresh across hosts: one bounded leg per (host, provider) to that host's own refresh route (Codex 50 s,
  // Claude 20 s), all at once, which starts a native usage read on that host. Overlapping requests join a running leg;
  // each host also joins overlapping reads of its own. A failed leg is recorded here and shown beside the host's kept
  // observations. The answer carries every leg and one view (by its own deadline), so it arrives within the slowest leg
  // plus the view's deadline: 50 s + 15 s.
  router.post("/usage/hosts/refresh", async (c) => {
    const svc = svcOf(c);
    if (!svc || !svc.refreshUsage) return c.json({ error: "provider_service_unavailable" }, unavailable);
    let raw: unknown = {};
    try {
      raw = await c.req.json();
    } catch {
      raw = {};
    }
    const body = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    // `providers: ["codex", "claude"]`, or one `provider` (codex when neither is given); never both, and a `providers`
    // that isn't a list is refused, not read as "codex".
    if (body["providers"] !== undefined && (!Array.isArray(body["providers"]) || body["provider"] !== undefined)) {
      return c.json({ error: "give either providers (a list) or provider, not both" }, 400);
    }
    const asked = Array.isArray(body["providers"]) ? body["providers"] : [body["provider"] ?? "codex"];
    const bad = asked.find((p) => p !== "codex" && p !== "claude");
    if (asked.length === 0 || bad !== undefined) {
      return c.json({ error: `usage windows can be refreshed for codex or claude (got ${asked.length === 0 ? "none" : String(bad)})` }, 400);
    }
    const providers = [...new Set(asked as ProviderKind[])];
    const hosts = body["hosts"];
    if (hosts !== undefined && (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every((h) => typeof h === "string" && h.trim() !== ""))) {
      return c.json({ error: "hosts must be a non-empty array of host ids" }, 400);
    }
    if (!Array.isArray((await svc.getReadModel()).usage)) return c.json(off("A refresh across hosts"), 409);
    const deps = hostsDeps(c, (hosts as string[] | undefined)?.map((h) => h.trim()));
    const selection = selectUsageHosts(deps);
    if (!selection.ok) return c.json({ error: selection.error }, 400);
    const refreshLocal = svc.refreshUsage.bind(svc);
    const refresh = await Promise.all(providers.flatMap((provider) => [
      legs.run(LOCAL_HOST_ID, provider, async () => {
        const result = await refreshLocal(provider);
        if ("disabled" in result) return { at: new Date().toISOString(), outcome: "failed", reason: "usage_windows_off", detail: "usage windows are off on this host" };
        if ("unavailable" in result) return { at: new Date().toISOString(), outcome: "failed", reason: "not_available", detail: `${provider} usage windows are not available on this host` };
        return result.refresh;
      }),
      ...selection.remotes.map((host) => legs.remote(host, provider, deps)),
    ]));
    return c.json({ refresh, view: await readUsageAcrossHosts(await svc.getReadModel(), selection, deps) }, 200);
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

  // Slice 18 — subscription move reports: queue items tagged subscription-move, filed by the agent that moved a Codex
  // home and read back by it (and by the Fleet app, once its page is connected). Filing one checks and keeps the report;
  // it never switches or restarts.
  const NOTHING_RECORDED = "Nothing was recorded, and the move itself is unchanged. Correct the report and file it again; don't repeat the switch or restart.";
  const queueOf = (c: Context): QueueRepository | null => (c.get("queueRepo" as never) as QueueRepository | undefined) ?? null;

  router.get("/moves", (c) => {
    const queue = queueOf(c);
    if (!queue) return c.json({ error: "queue_unavailable" }, unavailable);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return c.json({ error: "limit_invalid", message: "limit must be an integer from 1 to 200" }, 400);
    const seat = c.req.query("seat") || undefined;
    const items = queue.list({ tag: MOVE_REPORT_TAG, limit });
    const moves: Array<{ qitemId: string; reportedAt: string; reportedBy: string; reportedTo: string; state: string; report: MoveReport; followedBy: string[] }> = [];
    const unreadable: Array<{ qitemId: string; reason: string }> = [];
    for (const item of items) {
      const read = readMoveReport(item.body);
      if (!read.ok) { unreadable.push({ qitemId: item.qitemId, reason: read.errors.join("; ") }); continue; }
      moves.push({ qitemId: item.qitemId, reportedAt: item.tsCreated, reportedBy: item.sourceSession, reportedTo: item.destinationSession, state: item.state, report: read.report, followedBy: [] });
    }
    for (const move of moves) move.followedBy = moves.filter((later) => later.report.follows === move.qitemId).map((later) => later.qitemId);
    const shown = seat ? moves.filter((move) => [...move.report.seats, ...(move.report.peers ?? [])].some((entry) => entry.seat === seat)) : moves;
    // A bounded recent window: the newest `limit` tagged items, before the seat filter. `truncated` says the window was
    // full, so older reports may exist; it isn't a seat's complete history.
    return c.json({ moves: shown, unreadable, truncated: items.length === limit }, 200);
  });

  router.post("/moves", async (c) => {
    const queue = queueOf(c);
    if (!queue) return c.json({ error: "queue_unavailable" }, unavailable);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as { to?: unknown; report?: unknown; evidenceRef?: unknown };
    // Before anything else, and over everything the queue would keep or echo: nothing in a recognized credential format
    // is persisted or repeated back, in a value or a key.
    const credential = findCredential(body.to, "to") ?? findCredential(body.evidenceRef, "evidenceRef") ?? findCredential(body.report);
    if (credential) {
      return c.json({ error: "move_report_invalid", errors: [credentialRefusal(credential)], message: NOTHING_RECORDED }, 400);
    }
    if (typeof body.to !== "string" || body.to.trim() === "") {
      return c.json({ error: "to_required", message: "to must name the seat the report goes to: whoever asked for the move, or the person" }, 400);
    }
    const check = checkMoveReport(body.report);
    if (!check.ok) {
      return c.json({
        error: "move_report_invalid",
        errors: check.errors,
        message: NOTHING_RECORDED,
      }, 400);
    }
    const identity = requireSenderIdentity(c, { verb: "a subscription move report" });
    if (!identity.ok) return identity.response;
    const { summary, body: text } = renderMoveReport(check.report);
    try {
      const item = await queue.create({
        sourceSession: identity.session,
        destinationSession: body.to.trim(),
        body: text,
        summary,
        tags: [MOVE_REPORT_TAG],
        // A report to a person's seat follows the queue's rule for human-routed items: it names its evidence.
        ...(typeof body.evidenceRef === "string" && body.evidenceRef.trim() ? { evidenceRef: body.evidenceRef.trim() } : {}),
        identityProvenance: resolveRecordedProvenance(c, identity),
      });
      return c.json({ qitemId: item.qitemId, report: check.report }, 201);
    } catch (error) {
      if (!(error instanceof QueueRepositoryError)) throw error;
      return c.json({ error: error.code, message: `${error.message} ${NOTHING_RECORDED}` }, 400);
    }
  });

  return router;
}
