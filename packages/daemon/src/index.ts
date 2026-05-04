import { serve } from "@hono/node-server";
import { readOpenRigEnv } from "./openrig-compat.js";
import { createDaemon } from "./startup.js";
import { assertBindAuthInvariant } from "./middleware/auth-bearer-token.js";

export async function startServer(port?: number) {
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  const dbPath = readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") ?? "openrig.sqlite";

  const h = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST") ?? "127.0.0.1";
  // PL-005 Phase B: bearer token for Mission Control write verbs.
  // No legacy alias (this env var is new in Phase B).
  const bearerToken = process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null;

  // PL-005 Phase B HARD-GATE (audit row 8): refuse non-loopback bind
  // when no bearer token is configured. Prevents shipping a tailnet-
  // bound daemon with no auth on Mission Control write verbs.
  // Throws AuthBearerTokenStartupError before any DB or HTTP work.
  assertBindAuthInvariant({ host: h, bearerToken });

  const { app, contextMonitor, deps } = await createDaemon({ dbPath, bearerToken });

  const server = serve({ fetch: app.fetch, port: p, hostname: h }, (info) => {
    console.log(`OpenRig daemon listening on http://localhost:${info.port}`);
    // Start context monitor polling only after successful server bind
    contextMonitor.start();
    // PL-004 Phase C: start watchdog scheduler. Joins the supervision
    // tree post-bind so the HTTP surface is ready before the first
    // tick (matches contextMonitor pattern).
    deps.watchdogScheduler?.start();
  });

  // PL-004 Phase C: graceful shutdown — stop scheduler before process
  // exit so any in-flight policy evaluation completes (or is awaited).
  const shutdown = async (sig: string) => {
    console.log(`OpenRig daemon received ${sig}; shutting down`);
    try {
      await deps.watchdogScheduler?.stop();
    } catch (err) {
      console.error("[watchdog] shutdown error", err);
    }
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  return server;
}

// Only start the server when this file is executed directly (not imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
