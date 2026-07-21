// Real-HTTP child fixture for the D2 event-loop regression (slice-04,
// qitem-20260721000001-ps-stall-driver).
//
// buildStallApp(db) is the SHARED wiring used both in-process (D1/D3 via
// app.request) and by the child `main()` (D2 via a real localhost listener).
// PsProjectionService is wired WITH AgentActivityStore (createTestApp omits it),
// so the attention fold is exercised. SeatActivityService is intentionally ABSENT
// (copied-state environmental caveat) — never synthesized.
//
// Run as a child: `node --import tsx ps-stall-http-child.ts` — it seeds a
// host-shaped synthetic DB (27/198, exactly 219,541 events), serves on an
// ephemeral loopback port, and prints EXACTLY one readiness line `READY <port>`.
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type Database from "better-sqlite3";
import { RigRepository } from "../../src/domain/rig-repository.js";
import { EventBus } from "../../src/domain/event-bus.js";
import { AgentActivityStore } from "../../src/domain/agent-activity-store.js";
import { PsProjectionService } from "../../src/domain/ps-projection.js";
import { psRoutes } from "../../src/routes/ps.js";
import { rigsRoutes } from "../../src/routes/rigs.js";
import { createMigratedDb, seedHostShaped } from "../helpers/seed-host-shaped.js";

export function buildStallApp(db: Database.Database): Hono {
  const repo = new RigRepository(db);
  const eventBus = new EventBus(db);
  const agentActivity = new AgentActivityStore({ db, eventBus });
  const psService = new PsProjectionService({ db, agentActivity }); // agentActivity REQUIRED; seatActivity ABSENT

  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("psProjectionService" as never, psService as never);
    c.set("rigRepo" as never, repo as never);
    c.set("eventBus" as never, eventBus as never);
    c.set("agentActivityStore" as never, agentActivity as never);
    await next();
  });
  app.route("/api/ps", psRoutes);
  app.route("/api/rigs", rigsRoutes);
  // Trivial diagnostic /healthz — NOT daemon health semantics; it measures pure
  // event-loop availability (a synchronous ps/summary handler blocks even this).
  app.get("/healthz", (c) => c.json({ ok: true, diagnostic_stub: true }));
  return app;
}

// ---- child entrypoint ----
const runAsChild = Boolean(process.argv[1] && process.argv[1].includes("ps-stall-http-child"));
if (runAsChild) {
  // The child OWNS both the server and the db: every exit path — setup throw,
  // signal, or uncaught error — closes both before exiting, so no listener or
  // sqlite handle is ever leaked.
  let db: Database.Database | null = null;
  let server: { close: (cb?: () => void) => void } | null = null;
  let closing = false;
  const closeAll = (code: number) => {
    if (closing) return; // idempotent: duplicate signal/error paths cannot close/exit twice
    closing = true;
    const done = () => { try { db?.close(); } catch { /* noop */ } process.exit(code); };
    try { if (server) server.close(done); else done(); } catch { done(); }
  };
  process.on("SIGTERM", () => closeAll(0));
  process.on("SIGINT", () => closeAll(0));
  process.on("uncaughtException", (e) => { process.stderr.write(`child uncaught: ${(e as Error).message}\n`); closeAll(1); });
  try {
    db = createMigratedDb();
    seedHostShaped(db);
    const app = buildStallApp(db);
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      process.stdout.write(`READY ${info.port}\n`);
    });
  } catch (e) {
    process.stderr.write(`child setup failed: ${(e as Error).message}\n`);
    closeAll(1); // setup failure still closes the db
  }
}
