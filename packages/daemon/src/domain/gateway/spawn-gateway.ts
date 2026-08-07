// M1 A4a — the daemon-side SPAWN WRAPPER: launches the gateway as a separate OS process
// (arch a8343a38: a daemon-spawned process, not an in-daemon thread). Thin — it resolves the
// compiled entry sibling, sets the socket path in the child env, and returns the ChildProcess
// handle for the daemon's lifecycle to supervise. The child's liveness/reconnect is its own
// concern (gateway-process.ts heartbeat); this wrapper only starts it.

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { GATEWAY_SOCKET_ENV } from "./gateway-process-main.js";

export interface SpawnGatewayOpts {
  socketPath: string;
  home?: string;
  /** Override the compiled entry file (tests point at the built dist entry). */
  entryPath?: string;
  env?: NodeJS.ProcessEnv;
}

/** The compiled entry the daemon spawns: the sibling gateway-process-main.js in dist. Resolved
 *  via import.meta.url so it is correct wherever the daemon's dist is installed. */
export function gatewayProcessEntry(): string {
  return fileURLToPath(new URL("./gateway-process-main.js", import.meta.url));
}

/** Spawn the gateway OS process, out-dialling `socketPath`. Returns the ChildProcess so the
 *  daemon can supervise/kill it. stdout/stderr are piped for the daemon to fold into its logs. */
export function spawnGatewayProcess(opts: SpawnGatewayOpts): ChildProcess {
  const entry = opts.entryPath ?? gatewayProcessEntry();
  const env: NodeJS.ProcessEnv = {
    ...(opts.env ?? process.env),
    [GATEWAY_SOCKET_ENV]: opts.socketPath,
  };
  if (opts.home) env.OPENRIG_HOME = opts.home;
  return spawn(process.execPath, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
}
