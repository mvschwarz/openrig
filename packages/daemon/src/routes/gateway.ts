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
import { OPENRIG_HOME } from "../openrig-compat.js";
import { loadHumanRegistry } from "../domain/gateway/human-registry.js";
import { resolveSecret } from "../domain/gateway/slack/secrets.js";
import { resolveHumanDeliveryReadiness, type HumanDeliveryReadiness } from "../domain/gateway/human-readiness.js";
import { requireSenderIdentity } from "./require-sender-identity.js";
import { runChannelOperation } from "../domain/gateway/channel-operations.js";
import { buildSlackAppManifest } from "../domain/gateway/slack/manifest.js";

interface SubsystemHandle {
  restart: () => void;
  status: () => Record<string, unknown>;
  connectorStatus?: () => Record<string, unknown>;
}

export function gatewayRoutes(opts: {
  home?: string;
  readiness?: (entityId: string, gatewayState: string) => Promise<HumanDeliveryReadiness | null>;
} = {}): Hono {
  const app = new Hono();
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
