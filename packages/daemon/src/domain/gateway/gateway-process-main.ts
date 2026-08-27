// ── RETIRED IN PLACE (S10, OPR.0.5.5.10) ────────────────────────────────────────────────
// The process-split gateway shape retired under the amended M1 §3 (desk head-amendment,
// founder R2): the gateway runs as an IN-DAEMON SUBSYSTEM (gateway-subsystem.ts) — no spawned
// gateway process, no gateway↔connector socket wire. This module keeps compiling and its
// tests keep passing as a historical component, but it MUST NOT gain a production caller:
// the second-deployable ABSENCE proof pins that (any spawned gateway process or open
// connector wire is the red). Kept in place rather than deleted per the spec-level ruling
// (delete-or-mark is builder discretion).
// ─────────────────────────────────────────────────────────────────────────────────────────
// M1 A4a — the gateway process ENTRY POINT: the file the daemon spawns as a separate OS process
// (`node dist/domain/gateway/gateway-process-main.js`). Thin by design — it reads its config from
// the environment the spawn wrapper sets, starts the long-lived runGatewayProcess brain, and wires
// clean SIGTERM/SIGINT shutdown. All behavior lives in gateway-process.ts (unit-tested in-process);
// this file only exists to be an executable node entry.

import { pathToFileURL } from "node:url";
import { runGatewayProcess, type GatewayProcessHandle } from "./gateway-process.js";

export const GATEWAY_SOCKET_ENV = "OPENRIG_GATEWAY_SOCKET";
export const GATEWAY_RECONNECT_MS_ENV = "OPENRIG_GATEWAY_RECONNECT_MS";

/** Start the gateway process from environment config. Returns the handle (undefined if the
 *  required socket path is missing — the entry sets a non-zero exit code and returns). */
export function mainFromEnv(env: NodeJS.ProcessEnv = process.env): GatewayProcessHandle | undefined {
  const socketPath = env[GATEWAY_SOCKET_ENV];
  if (!socketPath) {
    process.stderr.write(`[gateway] ${GATEWAY_SOCKET_ENV} is required\n`);
    process.exitCode = 2;
    return undefined;
  }
  const reconnectRaw = env[GATEWAY_RECONNECT_MS_ENV];
  const reconnectMs = reconnectRaw !== undefined && Number.isFinite(Number(reconnectRaw)) && Number(reconnectRaw) > 0
    ? Number(reconnectRaw) : undefined;
  const handle = runGatewayProcess({
    socketPath,
    home: env.OPENRIG_HOME,
    reconnectMs,
    onError: (e) => process.stderr.write(`[gateway] socket error: ${e.message}\n`),
    onProtocolError: (m) => process.stderr.write(`[gateway] protocol refuse: ${m}\n`),
  });
  const shutdown = (): void => { handle.stop(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdout.write(`[gateway] up on ${socketPath}\n`);
  return handle;
}

// Self-run guard: only auto-start when executed directly as `node gateway-process-main.js`,
// never when imported (the daemon/tests import mainFromEnv without side effects).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mainFromEnv();
}
