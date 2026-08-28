// S10 — gateway subsystem admin routes. The relay's enable/disable semantics survive the
// cutover with their locked rules intact, re-homed to the daemon (which owns the queue and the
// durable seen-state now):
//   POST /api/gateway/slack/enable  — seed the CURRENT alert backlog as history (slice-11 item
//     9: enabling over a backlog replays NOTHING; only alerts created after this point deliver),
//     flip config enabled=true, then RESTART the subsystem so the wire rebuilds from the new
//     config. Returns the honest online-status line.
//   POST /api/gateway/slack/disable — flip enabled=false and restart (the wire becomes inert).

import { Hono } from "hono";
import path from "node:path";
import type { QueueRepository } from "../domain/queue-repository.js";
import { loadConfig, saveConfig } from "../domain/gateway/slack/config.js";
import { SeenStore } from "../domain/gateway/slack/state-store.js";
import { makeQueuePorts, seedBacklogAsHistory } from "../domain/gateway/slack/queue-access.js";
import { OPENRIG_HOME } from "../openrig-compat.js";

interface SubsystemHandle {
  restart: () => void;
  status: () => Record<string, unknown>;
}

export function gatewayRoutes(): Hono {
  const app = new Hono();

  app.post("/slack/enable", async (c) => {
    const queueRepo = c.get("queueRepo" as never) as QueueRepository | undefined;
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    if (!queueRepo || !subsystem) return c.json({ error: "gateway_admin_unavailable" }, 503);
    const home = OPENRIG_HOME;
    const cfg = loadConfig(home);
    // Item 9 — seed the pre-existing backlog as history BEFORE the wire goes live.
    const seen = new SeenStore(path.join(home, "state", "slack-outbound-seen.jsonl"));
    const { seeded, onlineStatus } = await seedBacklogAsHistory({
      queue: makeQueuePorts(queueRepo),
      seen,
      filter: { minimumLevel: cfg.minimumLevelThatPosts },
    });
    saveConfig({ ...cfg, enabled: true }, home);
    subsystem.restart();
    return c.json({ ok: true, seeded, onlineStatus, subsystem: subsystem.status() });
  });

  app.post("/slack/disable", (c) => {
    const subsystem = c.get("gatewaySubsystem" as never) as SubsystemHandle | undefined;
    if (!subsystem) return c.json({ error: "gateway_admin_unavailable" }, 503);
    const home = OPENRIG_HOME;
    saveConfig({ ...loadConfig(home), enabled: false }, home);
    subsystem.restart();
    return c.json({ ok: true, subsystem: subsystem.status() });
  });

  return app;
}
