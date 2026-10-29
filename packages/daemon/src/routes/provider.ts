import { OCCUPANT_GENERATION_HEADER, runtimeSwitchCustodyRefusal } from "./runtime-switch-custody.js";
import { SeatStatusService } from "../domain/seat-status-service.js";
import fs from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { getSelfHostId, LOCAL_HOST_ID } from "../domain/hosts/fanout-contract.js";
import { loadHostRegistry } from "../domain/hosts/hosts-registry-reader.js";
import type { ClaudeSeatRelaunch, ProviderService, SeatRestart } from "../domain/provider/provider-service.js";
import type { RigRepository } from "../domain/rig-repository.js";
import type { SnapshotCapture } from "../domain/snapshot-capture.js";
import type { RestoreOrchestrator } from "../domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { snapshotLaunchOutcome } from "../domain/restore-orchestrator.js";
import { resolveActiveSnapshotSession } from "../domain/active-occupant.js";
import { readClaudeSeatTokenRef } from "../domain/claude-seat-token.js";
import type { ProviderKind } from "../domain/provider/provider-types.js";
import { checkMoveReport, credentialRefusal, findCredential, MOVE_REPORT_TAG, readMoveReport, renderMoveReport, type MoveReport } from "../domain/provider/subscription-move-report.js";
import { QueueRepositoryError, type QueueRepository } from "../domain/queue-repository.js";
import { requireSenderIdentity, resolveRecordedProvenance, transportSenderSession } from "./require-sender-identity.js";
import { seatLifecycleService, runtimeSwitchService } from "./seat.js";
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

/** The seat's in-place restart for this request, built only when used: precheck and switch act on the Codex home the
 *  running seat uses, and the restart keeps its conversation and launch settings. */
function seatRestartOf(c: Context): SeatRestart {
  return {
    plan: (seat) => seatLifecycleService(c).restartInPlace({ seatRef: seat, plan: true }),
    run: (seat, reason) => seatLifecycleService(c).restartInPlace({ seatRef: seat, reason }),
  };
}

/** A Claude seat's relaunch for this request, by restore's own resume path in the seat's own pane: a snapshot, then only
 *  that seat launched from it, its process ended in place and the pane kept, all under the seat's lifecycle lease. */
function claudeSeatOf(c: Context): ClaudeSeatRelaunch {
  const rigRepo = c.get("rigRepo" as never) as RigRepository;
  return {
    seat: (seat) => {
      if (!rigRepo) return null;
      const row = rigRepo.db.prepare(`SELECT n.id, n.rig_id, n.logical_id, n.runtime, r.name, s.status, b.tmux_pane FROM sessions s
        JOIN nodes n ON n.id = s.node_id JOIN rigs r ON r.id = n.rig_id LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`)
        .get(seat) as { id: string; rig_id: string; logical_id: string; runtime: string | null; name: string; status: string; tmux_pane: string | null } | undefined;
      return row?.runtime === "claude-code"
        ? { nodeId: row.id, rigId: row.rig_id, rigName: row.name, logicalId: row.logical_id, running: row.status === "running", pane: row.tmux_pane ?? null } : null;
    },
    tokenRef: (nodeId) => readClaudeSeatTokenRef(rigRepo.db, nodeId),
    setTokenRef: (nodeId, ref) => { rigRepo.setNodeClaudeTokenRef(nodeId, ref); },
    snapshot: (rigId, nodeId) => {
      const capture = c.get("snapshotCapture" as never) as SnapshotCapture | undefined;
      if (!capture) return { snapshotId: "(none)", resumes: false, why: "can't be taken: this daemon has no snapshot capture" };
      const snapshot = capture.captureSnapshot(rigId, "provider-switch");
      const outcome = snapshotLaunchOutcome(snapshot.data, nodeId, "claude-code", "claude-code");
      if (outcome.kind !== "resume") return { snapshotId: snapshot.id, resumes: false, why: outcome.why };
      const occupant = resolveActiveSnapshotSession(snapshot.data, nodeId);
      return { snapshotId: snapshot.id, resumes: true, conversation: occupant.kind === "resolved" ? occupant.session.resumeToken ?? null : null };
    },
    exclusive: (nodeId, fn) => {
      const guard = (c.get("tmuxAdapter" as never) as TmuxAdapter | undefined)?.deliveryGuard;
      return guard ? guard.lifecycle([nodeId], fn) : fn();
    },
    relaunchInPane: async (rigId, logicalId, snapshotId) => {
      const restore = c.get("restoreOrchestrator" as never) as RestoreOrchestrator | undefined;
      if (!restore) return { ok: false, effect: "none", code: "restore_unavailable", message: "This daemon has no restore orchestrator." };
      const adapters = (c.get("runtimeAdapters" as never) as Record<string, import("../domain/runtime-adapter.js").RuntimeAdapter> | undefined) ?? {};
      const result = await restore.launchSingleNode(rigId, logicalId, { snapshotId, adapters, fsOps: { exists: (p: string) => fs.existsSync(p) }, keepPane: true });
      // A refusal of the whole launch (no usable snapshot, no such seat) comes before anything is touched.
      if (!result.ok) return { ok: false, effect: "none", code: result.code ?? "launch_failed", message: result.message ?? "The seat wasn't launched from the snapshot." };
      const node = result.launched?.find((n) => n.logicalId === logicalId);
      if (node?.status === "resumed") return { ok: true, status: "resumed", warnings: result.warnings ?? [] };
      // Restore stops for a decision, or leaves an attached CLI alone, before it touches the seat.
      const untouched = !node?.launchStarted && (node?.status === "awaiting-decision" || node?.status === "left_attached");
      return { ok: false, effect: untouched ? "none" : "unknown", code: node?.status ?? "not_launched", message: node?.error ?? "The seat wasn't launched from the snapshot." };
    },
  };
}

/** Expose provider views and switches, delegating isolated account homes to the successor-first runtime switch service. */
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
    const token = (raw as Record<string, unknown> | null)?.["claudeToken"];
    if (token !== undefined) {
      const t = token as Record<string, unknown> | null;
      if (provider !== "claude" || !t || typeof t !== "object" || Array.isArray(t) ||
        Object.keys(t).some(key => key !== "label" && key !== "tokenFile") ||
        typeof t.label !== "string" || !t.label.trim() || t.label.length > 120 || /[\x00-\x1f\x7f]/.test(t.label) ||
        typeof t.tokenFile !== "string" || !path.isAbsolute(t.tokenFile) || t.tokenFile.length > 4096 || /[\x00-\x1f\x7f]/.test(t.tokenFile) || findCredential(t)) {
        return c.json({ error: "invalid_claude_token_selection", message: "select Claude with a non-secret label and absolute token-file reference; never send token contents" }, 400);
      }
    }
    const result = await svc.refreshUsage(provider, token === undefined ? undefined : { label: String((token as Record<string, unknown>).label), tokenFile: path.normalize(String((token as Record<string, unknown>).tokenFile)) });
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
    // A Claude seat's own token file, or `storedLogin=1` for its config dir's stored login.
    const tokenFile = c.req.query("storedLogin") === "1" ? null : c.req.query("tokenFile");
    // An unsafe verdict is a valid 200 response, not an error.
    return c.json(await svc.precheck({ seat, toAccount, ...(tokenFile !== undefined ? { tokenFile } : {}), ...(c.req.query("apiKeyFile") !== undefined ? { apiKeyFile: c.req.query("apiKeyFile") } : {}) }, seatRestartOf(c), claudeSeatOf(c)), 200);
  });

  router.post("/switch", async (c) => {
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
    if (body["apiKeyFile"] !== undefined && (body["accountHome"] !== undefined || body["clearAccountHome"] === true)) {
      return c.json({ error: "apiKeyFile cannot be combined with accountHome or clearAccountHome; switch credentials in place separately" }, 400);
    }
    const seat = body["seat"];
    const clearAccountHome = body["clearAccountHome"] === true;
    if (body["clearAccountHome"] !== undefined && typeof body["clearAccountHome"] !== "boolean") return c.json({ error: "clearAccountHome must be true or false" }, 400);
    if (clearAccountHome && (body["toAccount"] !== undefined || body["accountHome"] !== undefined || body["tokenFile"] !== undefined)) {
      return c.json({ error: "clearAccountHome cannot select an account or token" }, 400);
    }
    const toAccount = body["toAccount"] ?? (clearAccountHome ? "default" : undefined);
    const forceUnsafe = body["forceUnsafe"] ?? false;
    if (typeof seat !== "string" || seat.trim() === "" || typeof toAccount !== "string" || toAccount.trim() === "") {
      return c.json({ error: "seat and toAccount are required" }, 400);
    }
    if (typeof forceUnsafe !== "boolean") {
      return c.json({ error: "forceUnsafe must be a boolean" }, 400);
    }
    if (body["accountHome"] !== undefined || clearAccountHome) {
      if ((body["tokenFile"] !== undefined && typeof body["tokenFile"] !== "string") || (!clearAccountHome && typeof body["accountHome"] !== "string") || typeof body["reason"] !== "string" ||
          (body["model"] !== undefined && typeof body["model"] !== "string") ||
          (body["codexConfigProfile"] !== undefined && typeof body["codexConfigProfile"] !== "string") ||
          (body["dryRun"] !== undefined && typeof body["dryRun"] !== "boolean")) {
        return c.json({ ok: false, code: "invalid_runtime_settings", message: "Account-home switching needs a path and reason, with optional model/profile and a Claude token-file reference." }, 400);
      }
      const rigRepo = c.get("rigRepo" as never) as RigRepository;
      const custody = runtimeSwitchCustodyRefusal(rigRepo.db, transportSenderSession(c), c.req.header(OCCUPANT_GENERATION_HEADER));
      if (custody) return c.json(custody.body, custody.status);
      const resolved = new SeatStatusService({ rigRepo }).getStatus(seat);
      if (!resolved.ok) return c.json(resolved, 404);
      const result = await runtimeSwitchService(c).setRuntime({ seatRef: seat, runtime: resolved.status.runtime ?? "",
        ...(clearAccountHome ? { clearAccountHome: true } : { accountHome: body["accountHome"] as string }), reason: body["reason"], dryRun: body["dryRun"] === true,
        ...(typeof body["tokenFile"] === "string" ? { accountToken: { label: toAccount, tokenFile: body["tokenFile"] } } : {}),
        requestedBy: transportSenderSession(c) ?? null,
        ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
        ...(typeof body["codexConfigProfile"] === "string" ? { codexConfigProfile: body["codexConfigProfile"] } : {}),
      });
      return c.json(result, result.ok ? "recoveryPending" in result && result.recoveryPending ? 202 : 200
        : result.code === "invalid_runtime_settings" ? 400 : 409);
    }
    const tokenFile = body["tokenFile"];
    if (tokenFile !== undefined && tokenFile !== null && typeof tokenFile !== "string") {
      return c.json({ error: "tokenFile must be a path, or null for the stored login" }, 400);
    }
    const svc = svcOf(c);
    if (!svc) return c.json({ error: "provider_service_unavailable" }, unavailable);
    const apiKeyFile = body["apiKeyFile"];
    if (apiKeyFile !== undefined && (typeof apiKeyFile !== "string" || tokenFile !== undefined)) {
      return c.json({ error: "apiKeyFile must be a path and cannot be combined with tokenFile" }, 400);
    }
    // Business outcome (incl. failed_safely / rebind_in_progress) is an explicit 200 payload.
    return c.json(await svc.switchAccount({ seat, toAccount, forceUnsafe, ...(tokenFile !== undefined ? { tokenFile } : {}), ...(typeof apiKeyFile === "string" ? { apiKeyFile } : {}) },
      seatRestartOf(c), claudeSeatOf(c)), 200);
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
