import { serve, type ServerType } from "@hono/node-server";
import { readOpenRigEnv } from "./openrig-compat.js";
import { createDaemon } from "./startup.js";
import {
  assertBindAuthInvariant,
  detectTailscaleInterface,
} from "./middleware/auth-bearer-token.js";

export async function startServer(port?: number) {
  const p = port ?? parseInt(readOpenRigEnv("OPENRIG_PORT", "RIGGED_PORT") ?? "7433", 10);
  const dbPath = readOpenRigEnv("OPENRIG_DB", "RIGGED_DB") ?? "openrig.sqlite";

  // bug-fix slice auth-bearer-tailscale-trust: distinguish "explicit
  // operator opt-in" from "default" by treating an undefined env as
  // default. When explicit, the operator takes responsibility (and the
  // bearer invariant applies to their chosen host). When default, the
  // daemon always binds loopback and ALSO binds the active tailscale
  // interface (if present) — both accepted paths in the invariant.
  const explicitHost = readOpenRigEnv("OPENRIG_HOST", "RIGGED_HOST");
  // PL-005 Phase B: bearer token for Mission Control write verbs.
  // No legacy alias (this env var is new in Phase B).
  const bearerToken = process.env.OPENRIG_AUTH_BEARER_TOKEN ?? null;

  let bindHosts: string[];
  if (explicitHost) {
    // Operator opt-in path — invariant enforces bearer requirement for
    // genuinely public/LAN binds; loopback/tailscale binds short-circuit.
    await assertBindAuthInvariant({ host: explicitHost, bearerToken });
    bindHosts = [explicitHost];
  } else {
    // Default path — loopback always, plus tailscale auto-add when active.
    const tailscaleIp = detectTailscaleInterface();
    bindHosts = tailscaleIp ? ["127.0.0.1", tailscaleIp] : ["127.0.0.1"];
  }

  const { app, contextMonitor, deps } = await createDaemon({ dbPath, bearerToken });

  // Multi-bind via N serve() instances sharing the same Hono app.
  // Hono's serve() targets a single host:port; for multi-bind we spawn
  // one per host. The contextMonitor + watchdog scheduler only start
  // once after the first successful bind callback fires.
  let monitorsStarted = false;
  const servers: ServerType[] = [];
  for (const host of bindHosts) {
    const srv = serve({ fetch: app.fetch, port: p, hostname: host }, (info) => {
      console.log(`OpenRig daemon listening on http://${host}:${info.port}`);
      if (!monitorsStarted) {
        monitorsStarted = true;
        contextMonitor.start();
        // PL-004 Phase C: start watchdog scheduler. Joins the supervision
        // tree post-bind so the HTTP surface is ready before the first
        // tick (matches contextMonitor pattern).
        deps.watchdogScheduler?.start();
      }
    });
    servers.push(srv);
  }

  // PL-004 Phase C: graceful shutdown — stop scheduler before process
  // exit so any in-flight policy evaluation completes (or is awaited).
  // Multi-bind: close every serve() instance in parallel.
  const shutdown = async (sig: string) => {
    console.log(`OpenRig daemon received ${sig}; shutting down`);
    try {
      await deps.watchdogScheduler?.stop();
    } catch (err) {
      console.error("[watchdog] shutdown error", err);
    }
    await Promise.all(
      servers.map(
        (srv) =>
          new Promise<void>((resolve) => {
            try {
              srv.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  // Backward-compatible single-server return (callers that just need a
  // handle reference; multi-bind shutdown is wired via signal handlers).
  return servers[0]!;
}

// Only start the server when this file is executed directly (not imported).
const isDirectRun =
  process.argv[1] &&
  import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  startServer();
}
