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

interface SubsystemHandle {
  restart: () => void;
  status: () => Record<string, unknown>;
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
          if (cfg.enabled === enabled) return { value, after: state(), effect: "no-op" };
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
