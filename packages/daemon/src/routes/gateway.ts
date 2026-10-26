// S10 — gateway subsystem admin routes. The relay's enable/disable semantics survive the
// cutover with their locked rules intact, re-homed to the daemon (which owns the queue and the
// durable seen-state now):
//   POST /api/gateway/slack/enable  — seed the CURRENT alert backlog as history (slice-11 item
//     9: enabling over a backlog replays NOTHING; only alerts created after this point deliver),
//     flip config enabled=true, then RESTART the subsystem so the wire rebuilds from the new
//     config. Returns the honest online-status line.
//   POST /api/gateway/slack/disable — flip enabled=false and restart (the wire becomes inert).

import { connectionsProjection } from "../domain/gateway/connections-projection.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import path from "node:path";
import type { QueueRepository } from "../domain/queue-repository.js";
import { loadConfig, saveConfig } from "../domain/gateway/slack/config.js";
import { SeenStore } from "../domain/gateway/slack/state-store.js";
import { makeQueuePorts, seedBacklogAsHistory } from "../domain/gateway/slack/queue-access.js";
import { postOpenAsks } from "../domain/gateway/slack/open-asks.js";
import { DispatchBuffer } from "../domain/gateway/dispatch-buffer.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { loadHumanRegistry } from "../domain/gateway/human-registry.js";
import { resolveSecret } from "../domain/gateway/slack/secrets.js";
import { resolveHumanDeliveryReadiness, type HumanDeliveryReadiness } from "../domain/gateway/human-readiness.js";
import { requireSenderIdentity } from "./require-sender-identity.js";
import { runChannelOperation } from "../domain/gateway/channel-operations.js";
import { buildSlackAppManifest } from "../domain/gateway/slack/manifest.js";
import { authBearerTokenMiddleware } from "../middleware/auth-bearer-token.js";
import type Database from "better-sqlite3";
import { HumanQuietStore, QuietWindowError, parseDailyRule, resolveUntil } from "../domain/gateway/human-quiet-windows.js";
import { HumanModeService, ModeError, registryAvailability, type QuietRule } from "../domain/gateway/human-operating-modes.js";
import { modeAccount } from "../domain/gateway/human-mode-account.js";
import { WatchdogJobsRepository } from "../domain/watchdog-jobs-repository.js";
import { armModeScheduledEnd } from "../domain/policies/mode-scheduled-end.js";

interface SubsystemHandle {
  restart: () => void;
  status: () => Record<string, unknown>;
  dispatch?: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => { ok: true; decisionId: string } | { ok: false; error: string };
  connectorStatus?: () => Record<string, unknown>;
  acceptForwarded?: (env: unknown) => Promise<{ status: string; reason?: string } | null>;
}

export function gatewayRoutes(opts: {
  home?: string;
  readiness?: (entityId: string, gatewayState: string) => Promise<HumanDeliveryReadiness | null>;
  /** The daemon's auth bearer (OPENRIG_AUTH_BEARER_TOKEN, the one `rig host pair` issues); a relay from a
   *  shared app's hub must carry it. Null: no bearer configured, so the route trusts the bind (loopback or tailnet). */
  relayBearerToken?: string | null;
  /** The clock quiet hours are resolved against (tests inject one). */
  now?: () => Date;
} = {}): Hono {
  const app = new Hono();

  // A shared Slack app across machines: the hub relays an event or click for a channel this machine
  // owns, and it runs through this machine's own inbound router. 503 keeps it in the hub's retry.
  // Registered before /slack/:operation, which would otherwise answer it with 404.
  app.post("/slack/forwarded", authBearerTokenMiddleware({ expectedToken: opts.relayBearerToken ?? null }), async (c) => {
    const body = await c.req.json<{ envelope?: unknown }>().catch(() => null);
    const envelope = body?.envelope;
    if (!envelope || typeof envelope !== "object") return c.json({ error: "envelope_required" }, 400);
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    const result = await subsystem?.acceptForwarded?.(envelope);
    if (!result) return c.json({ error: "slack_inbound_unavailable", message: "This machine's Slack connector isn't enabled with a token, so it can't take relayed events yet." }, 503);
    return c.json({ ok: true, ...result });
  });
  let adminTail: Promise<unknown> = Promise.resolve();

  app.get("/connections", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    let status: Record<string, unknown> | null = null;
    try { status = subsystem?.status() ?? null; } catch { /* unavailable is preserved */ }
    return c.json(connectionsProjection(opts.home ?? OPENRIG_HOME, status,
      c.get("settingsStore" as never) as SettingsStore | undefined));
  });

  // OPR.0.6.0.5 — read-only: the same manifest `rig slack manifest` prints. No config, no secrets.
  app.get("/slack/status", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    const snapshot = subsystem?.connectorStatus?.();
    return c.json({ observedAt: new Date().toISOString(), ...(snapshot ?? { state: "unavailable", connector: null }) });
  });

  app.get("/slack/manifest", (c) => c.json(buildSlackAppManifest()));

  app.get("/human/:entityId/readiness", async (c) => {
    const entityId = c.req.param("entityId");
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    const gatewayState = String(subsystem?.status().state ?? "unavailable");
    if (opts.readiness) {
      const readiness = await opts.readiness(entityId, gatewayState);
      return readiness ? c.json({ ok: true, readiness }) : c.json({ error: "human_not_found", entityId }, 404);
    }
    const home = opts.home ?? OPENRIG_HOME;
    const registry = loadHumanRegistry(home);
    if (!registry.ok) return c.json({ error: "human_registry_unavailable", message: registry.error }, 503);
    const human = registry.entities.find((candidate) => candidate.entityId === entityId);
    if (!human) return c.json({ error: "human_not_found", entityId }, 404);
    const cfg = loadConfig(home);
    const botToken = resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined });
    const readiness = await resolveHumanDeliveryReadiness({ human, config: cfg, gatewayState, botToken });
    return c.json({ ok: true, readiness });
  });

  // Quiet hours for a person: one read, plus set, end ("I'm back") and clear. These store and show the window; no
  // delivery decision reads it yet.
  const now = opts.now ?? (() => new Date());
  const quietRoute = (verb: string, handler: (input: { quiet: HumanQuietStore; entityId: string; actor: string; body: Record<string, unknown>; at: Date }) => unknown) =>
    async (c: import("hono").Context) => {
      const entityId = c.req.param("entityId") ?? "";
      const db = c.get("db" as never) as Database.Database | undefined;
      if (!db) return c.json({ error: "quiet_hours_unavailable", message: "The daemon's database isn't available to this route." }, 503);
      const registry = loadHumanRegistry(opts.home ?? OPENRIG_HOME);
      if (!registry.ok) return c.json({ error: "human_registry_unavailable", message: registry.error }, 503);
      if (!registry.entities.some((candidate) => candidate.entityId === entityId)) return c.json({ error: "human_not_found", entityId }, 404);
      const body = c.req.method === "GET" ? {} : ((await c.req.json<Record<string, unknown>>().catch(() => ({}))) ?? {});
      let actor = "";
      if (c.req.method !== "GET") {
        const identity = requireSenderIdentity(c, { verb, bodyClaim: typeof body.actor === "string" ? body.actor : null });
        if (!identity.ok) return identity.response;
        actor = identity.session;
      }
      const quiet = new HumanQuietStore(db);
      const at = now();
      try {
        const result = handler({ quiet, entityId, actor, body, at });
        return c.json({ ok: true, entityId, ...(result ?? {}), window: quiet.show(entityId), state: quiet.quietStateFor(entityId, at) });
      } catch (error) {
        if (!(error instanceof QuietWindowError)) throw error;
        const status = error.code === "not_quiet" || error.code === "no_window" ? 409 : 400;
        return c.json({ error: error.code, message: error.message }, status);
      }
    };
  app.get("/human/:entityId/quiet", quietRoute("reading quiet hours", () => undefined));
  app.put("/human/:entityId/quiet", quietRoute("setting quiet hours", ({ quiet, entityId, actor, body, at }) => {
    const timezone = typeof body.timezone === "string" ? body.timezone : "";
    const daily = typeof body.daily === "string" ? body.daily : undefined;
    const until = typeof body.until === "string" ? body.until : undefined;
    if ((daily === undefined) === (until === undefined)) {
      throw new QuietWindowError("invalid_time", "Give either a daily window (HH:MM-HH:MM) or an until-time, not both and not neither.");
    }
    if (daily !== undefined) quiet.setDaily(entityId, { ...parseDailyRule(daily), timezone, setBy: actor, now: at });
    else quiet.setUntil(entityId, { until: resolveUntil(until!, timezone, at), timezone, setBy: actor, now: at });
    return undefined;
  }));
  app.post("/human/:entityId/quiet/end", quietRoute("ending quiet hours", ({ quiet, entityId, actor, at }) =>
    ({ ended: quiet.end(entityId, { endedBy: actor, now: at }) })));
  app.post("/human/:entityId/quiet/clear", quietRoute("clearing quiet hours", ({ quiet, entityId, actor, at }) =>
    ({ cleared: quiet.clear(entityId, { clearedBy: actor, now: at }) })));

  // Operating modes for a person: saved modes and the record of applying one. Same person check and actor as quiet
  // hours; applying or ending touches only the person's availability, their quiet window and the modes' own records.
  const modeRoute = (verb: string, handler: (input: { modes: HumanModeService; entityId: string; name: string; actor: string;
    body: Record<string, unknown>; at: Date }) => unknown) =>
    async (c: import("hono").Context) => {
      const entityId = c.req.param("entityId") ?? "";
      const db = c.get("db" as never) as Database.Database | undefined;
      if (!db) return c.json({ error: "modes_unavailable", message: "The daemon's database isn't available to this route." }, 503);
      const home = opts.home ?? OPENRIG_HOME;
      const registry = loadHumanRegistry(home);
      if (!registry.ok) return c.json({ error: "human_registry_unavailable", message: registry.error }, 503);
      if (!registry.entities.some((candidate) => candidate.entityId === entityId)) return c.json({ error: "human_not_found", entityId }, 404);
      const body = c.req.method === "GET" ? {} : ((await c.req.json<Record<string, unknown>>().catch(() => ({}))) ?? {});
      let actor = "";
      if (c.req.method !== "GET") {
        const identity = requireSenderIdentity(c, { verb, bodyClaim: typeof body.actor === "string" ? body.actor : null });
        if (!identity.ok) return identity.response;
        actor = identity.session;
      }
      const at = now();
      const jobsRepo = new WatchdogJobsRepository(db);
      const modes = new HumanModeService({ db, availability: registryAvailability(home), now: () => at,
        armScheduledEnd: (application) => armModeScheduledEnd({ jobsRepo, ...application }) });
      try {
        return c.json({ ok: true, entityId, ...(handler({ modes, entityId, name: c.req.param("name") ?? "", actor, body, at }) as Record<string, unknown>) });
      } catch (error) {
        if (error instanceof ModeError) return c.json({ error: error.code, message: error.message }, error.code === "mode_not_found" ? 404 : 400);
        if (error instanceof QuietWindowError) return c.json({ error: error.code, message: error.message }, 400);
        throw error;
      }
    };
  const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  app.get("/human/:entityId/modes", modeRoute("reading modes", ({ modes, entityId }) =>
    ({ modes: modes.list(entityId), current: modes.current(entityId) })));
  app.get("/human/:entityId/modes/:name", modeRoute("reading a mode", ({ modes, entityId, name }) => {
    const mode = modes.saved(entityId, name);
    if (!mode) throw new ModeError("mode_not_found", `${entityId} has no saved mode "${name}"`);
    return { mode };
  }));
  app.put("/human/:entityId/modes/:name", modeRoute("saving a mode", ({ modes, entityId, name, actor, body }) => {
    const quietText = text(body.quiet);
    const timezone = text(body.timezone) ?? "";
    let quiet: QuietRule | null = null;
    if (quietText === "until-end") quiet = { kind: "until-end", timezone };
    else if (quietText) quiet = { kind: "daily", ...parseDailyRule(quietText), timezone };
    const exclusions = Array.isArray(body.exclusions) ? body.exclusions.filter((e): e is string => typeof e === "string" && e.trim() !== "").map((e) => e.trim()) : [];
    return { mode: modes.save(entityId, {
      name,
      availability: { value: text(body.availability), expectedBack: text(body.expectedBack) },
      decisionRoom: { words: text(body.decisionRoom), exclusions },
      delivery: { quiet, account: text(body.account) },
    }, actor) };
  }));
  app.post("/human/:entityId/modes/:name/apply", modeRoute("applying a mode", ({ modes, entityId, name, actor, body, at }) => {
    const until = text(body.until);
    const saved = modes.saved(entityId, name);
    // The CLI always sends a zone with an end time (this machine's, unless --tz). An API caller that sends none gets the
    // mode's quiet-hours zone, else UTC.
    const timezone = text(body.timezone) ?? (saved?.delivery.quiet?.timezone || "UTC");
    const result = modes.apply(entityId, name, { scheduledEnd: until ? resolveUntil(until, timezone, at) : null }, actor);
    return { application: result.application, ended: result.ended, atDesk: result.application === null, unresolved: modes.unresolved(entityId) };
  }));
  // `unresolved`: restorations from earlier modes still pending or failed, owed in the coming-back report until resolved.
  app.get("/human/:entityId/mode", modeRoute("reading the current mode", ({ modes, entityId }) => {
    const current = modes.current(entityId);
    return { current, atDesk: current === null, unresolved: modes.unresolved(entityId) };
  }));
  // For an agent about to ask this person: the decision room of the mode they have on, in their own words, or none. The
  // agent judges whether its decision falls inside it; with none, nothing is decided for them.
  app.get("/human/:entityId/decision-room", modeRoute("reading the decision room", ({ modes, entityId }) => {
    const current = modes.current(entityId);
    if (!current) return { decisionRoom: null, why: "at desk: no mode is on, so ask them" };
    if (!current.settings.decisionRoom) return { decisionRoom: null, why: `${current.modeName} has no decision room, so nothing is decided for them`, modeName: current.modeName };
    return { decisionRoom: { applicationId: current.applicationId, modeName: current.modeName, ...current.settings.decisionRoom } };
  }));
  // The decisions made on this person's behalf under one application, for the account when they're back.
  app.get("/human/:entityId/mode/applications/:applicationId/decisions", (c) => {
    const entityId = c.req.param("entityId");
    const applicationId = c.req.param("applicationId");
    const db = c.get("db" as never) as Database.Database | undefined;
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    if (!db || !queueRepo) return c.json({ error: "modes_unavailable", message: "The daemon's database isn't available to this route." }, 503);
    const application = new HumanModeService({ db }).get(applicationId);
    if (!application || application.entityId !== entityId) return c.json({ error: "application_not_found", entityId, applicationId }, 404);
    const decisions = queueRepo.delegatedDecisionsFor(applicationId).map((item) => ({ qitemId: item.qitemId, summary: item.summary,
      sourceSession: item.sourceSession, decision: item.delegatedDecision }));
    return c.json({ ok: true, entityId, applicationId, modeName: application.modeName, decisions });
  });
  // The facts for the person's "back" account, for one ended application: made from the records only, never composed here.
  app.get("/human/:entityId/mode/applications/:applicationId/account", async (c) => {
    const entityId = c.req.param("entityId");
    const applicationId = c.req.param("applicationId");
    const db = c.get("db" as never) as Database.Database | undefined;
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    if (!db || !queueRepo) return c.json({ error: "modes_unavailable", message: "The daemon's database isn't available to this route." }, 503);
    const home = opts.home ?? OPENRIG_HOME;
    const result = await modeAccount({ modes: new HumanModeService({ db, now }), queueRepo, home, registry: { loadHumanRegistry },
      entityId, applicationId, now: now() });
    if (result.status === "not-found") return c.json({ error: "application_not_found", entityId, applicationId }, 404);
    if (result.status === "still-on") {
      return c.json({ error: "still_on", message: `${result.application.modeName} is still on: end it first (current shows it while it's on)` }, 409);
    }
    return c.json({ ok: true, entityId, account: result.account });
  });
  app.post("/human/:entityId/mode/end", modeRoute("ending a mode", ({ modes, entityId, actor, body }) => {
    const reason = body.reason === "scheduled" ? "scheduled" : "back";
    const ended = modes.end(entityId, reason, actor);
    return { ended, atDesk: modes.current(entityId) === null, unresolved: modes.unresolved(entityId) };
  }));

  // Slack slice 05 (#1679): show the asks still open that enable seeded as history, through ordinary delivery, and say
  // what became of each. Run after enable; enable itself is unchanged. Recorded like enable, with its actor and reason.
  // Registered before /slack/:operation, which answers any other operation with 404.
  app.post("/slack/post-open-asks", async (c) => {
    const body = (await c.req.json<{ actor?: string; reason?: string; waitSeconds?: number }>().catch(() => ({} as { actor?: string; reason?: string; waitSeconds?: number }))) ?? {};
    const actor = requireSenderIdentity(c, { verb: "slack post-open-asks", bodyClaim: typeof body.actor === "string" ? body.actor : null });
    if (!actor.ok) return actor.response;
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    if (!subsystem?.dispatch || !queueRepo) return c.json({ error: "gateway_admin_unavailable" }, 503);
    const home = opts.home ?? OPENRIG_HOME;
    const status = subsystem.status();
    const outboundReady = (status.connector as { outboundReady?: unknown } | undefined)?.outboundReady === true;
    if (!loadConfig(home).enabled || status.state !== "active" || !outboundReady) {
      return c.json({ error: "slack_not_posting", message: loadConfig(home).enabled
        ? "Slack is enabled here but can't post yet (rig slack status says why), so no ask was shown."
        : "Slack isn't enabled on this machine, so no ask was shown. Run rig slack enable first, then this." }, 409);
    }
    const registry = loadHumanRegistry(home);
    if (!registry.ok) return c.json({ error: "human_registry_unavailable", message: `Can't tell whose asks are open: ${registry.error}` }, 503);
    const waitSeconds = typeof body.waitSeconds === "number" && body.waitSeconds >= 0 ? Math.min(body.waitSeconds, 60) : 10;
    const pending = adminTail.then(() => runChannelOperation({
      action: "post-open-asks", subject: "slack", actor: actor.session, provenance: actor.provenance,
      reason: (typeof body.reason === "string" && body.reason.trim()) || "show the asks still open after enable",
      before: { enabled: true, active: true },
      run: async () => {
        const value = await postOpenAsks({
          queueRepo, home, loadHumanRegistry: () => registry, minimumLevelThatPosts: loadConfig(home).minimumLevelThatPosts,
          dispatch: (op, ref, payload, o) => subsystem.dispatch!(op, ref, payload, o), actor: actor.session, waitMs: waitSeconds * 1000,
        });
        return { value, after: { enabled: loadConfig(home).enabled, active: subsystem.status().state === "active" },
          effect: value.asks.some((a) => a.reshown) ? "applied" as const : "no-op" as const };
      },
    }, home));
    adminTail = pending.catch(() => undefined);
    const result = await pending;
    return c.json({ ok: true, ...result.value, receipt: result.receipt });
  });

  app.post("/slack/:operation", async (c) => {
    const operation = c.req.param("operation");
    if (operation !== "enable" && operation !== "disable") return c.notFound();
    const body = (await c.req.json<{ actor?: string; reason?: string }>().catch(() => ({} as { actor?: string; reason?: string }))) ?? {};
    const actor = requireSenderIdentity(c, { verb: `slack ${operation}`, bodyClaim: typeof body.actor === "string" ? body.actor : null });
    if (!actor.ok) return actor.response;
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (operation === "disable" && !reason) return c.json({ error: "reason_required", message: "Disabling human delivery requires --reason describing the shutdown." }, 400);
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    if (!subsystem || (operation === "enable" && !queueRepo)) return c.json({ error: "gateway_admin_unavailable" }, 503);
    const home = opts.home ?? OPENRIG_HOME;
    const pending = adminTail.then(async () => {
      const cfg = loadConfig(home);
      const enabled = operation === "enable";
      const state = () => ({ enabled: loadConfig(home).enabled, active: subsystem.status().state === "active" });
      return runChannelOperation({
        action: operation, subject: "slack", actor: actor.session, provenance: actor.provenance,
        reason: reason || "enable human delivery", before: state(),
        run: async () => {
          let value = { seeded: 0, onlineStatus: `slack connector already ${enabled ? "enabled" : "disabled"}; no change` };
          if (cfg.enabled === enabled) {
            if (enabled) value.onlineStatus += ". This call did not reload configuration or tokens. To reload, run rig daemon stop, then rig daemon start; environment token overrides still take precedence.";
            return { value, after: state(), effect: "no-op" };
          }
          if (enabled) {
            const registry = loadHumanRegistry(home);
            if (!registry.ok) throw new HTTPException(503, { res: c.json({
              error: "human_registry_unavailable",
              message: `Cannot seed the existing delivery backlog: ${registry.error}. ` +
                "Register a human with rig gateway human add, or repair and re-project the existing human registry before enabling delivery.",
            }, 503) });
            const seen = new SeenStore(path.join(home, "state", "slack-outbound-seen.jsonl"));
            value = await seedBacklogAsHistory({
              queue: makeQueuePorts(queueRepo!, { loadHumanRegistry: () => registry }), seen,
              filter: { minimumLevel: cfg.minimumLevelThatPosts },
              buffer: new DispatchBuffer(home),
            });
          } else value.onlineStatus = "slack connector disabled";
          saveConfig({ ...cfg, enabled }, home);
          subsystem.restart();
          return { value, after: state(), effect: "applied" };
        },
      }, home);
    });
    adminTail = pending.catch(() => undefined);
    const result = await pending;
    return c.json({ ok: true, ...result.value, receipt: result.receipt, subsystem: subsystem.status() });
  });

  return app;
}
