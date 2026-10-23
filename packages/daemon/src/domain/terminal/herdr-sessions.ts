import path from "node:path";
import { HerdrAdapter } from "./herdr-adapter.js";
import { createHerdrSocketRpc, createHerdrSocketTransport, resolveHerdrSocketPath } from "./herdr-transport.js";
import type { ProviderStatus } from "./terminal-provider.js";

/** Keep the daemon's configured endpoint while selecting explicit sessions per
 * request. No request mutates process.env or another request's transport.
 */
export function createHerdrProviders(env: NodeJS.ProcessEnv = process.env) {
  const defaultSocket = resolveHerdrSocketPath(env);
  const base = path.dirname(resolveHerdrSocketPath({}));
  let launch = 0;
  const make = (endpoint: NonNullable<ProviderStatus["launch"]>) => new HerdrAdapter({
    transportFactory: createHerdrSocketTransport(createHerdrSocketRpc(endpoint.socketPath)),
    launch: endpoint,
    newLaunchToken: () => `l${++launch}`,
  });
  return {
    defaultProvider: make({ socketPath: defaultSocket, ...(env.HERDR_SESSION ? { session: env.HERDR_SESSION } : {}) }),
    // TerminalService validates this as one session name, not a filesystem path.
    sessionProvider: (session: string) => make({ session, socketPath: session === "default"
      ? path.join(base, "herdr.sock") : path.join(base, "sessions", session, "herdr.sock") }),
  };
}
