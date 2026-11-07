import { HerdrViewer, createHerdrViewerRun } from "./herdr-viewer.js";
import path from "node:path";
import { HerdrAdapter } from "./herdr-adapter.js";
import { createHerdrSocketRpc, createHerdrSocketTransport, resolveHerdrSocketPath } from "./herdr-transport.js";
import type { ProviderStatus } from "./terminal-provider.js";
import { HerdrFollowView, type ReadFollowInput } from "./herdr-follow-view.js";

/** Keep the daemon's configured endpoint while selecting explicit sessions per
 * request. No request mutates process.env or another request's transport.
 */
export function createHerdrProviders(env: NodeJS.ProcessEnv = process.env, input?: ReadFollowInput) {
  env = { ...env };
  if (env.XDG_CONFIG_HOME !== undefined) env.XDG_CONFIG_HOME = path.resolve(env.XDG_CONFIG_HOME);
  const defaultSocket = resolveHerdrSocketPath(env);
  let launch = 0;
  const viewers = new Map<string, HerdrViewer>();
  const viewer = (endpoint: NonNullable<ProviderStatus["launch"]>) => {
    let selected = viewers.get(endpoint.socketPath);
    if (!selected) { selected = new HerdrViewer(endpoint.socketPath, createHerdrViewerRun(endpoint, env)); viewers.set(endpoint.socketPath, selected); }
    return selected;
  };
  const make = (endpoint: NonNullable<ProviderStatus["launch"]>) => {
    const transportFactory = createHerdrSocketTransport(createHerdrSocketRpc(endpoint.socketPath));
    return new HerdrAdapter({
    transportFactory,
    following: new HerdrFollowView({ socketPath: endpoint.socketPath, run: createHerdrViewerRun(endpoint, env), transport: transportFactory(), input }),
    launch: endpoint,
    viewer: viewer(endpoint),
    newLaunchToken: () => `l${++launch}`,
  }); };
  const sessions = new Map<string, HerdrAdapter>();
  return {
    defaultProvider: make({ socketPath: defaultSocket, ...(env.HERDR_SESSION ? { session: env.HERDR_SESSION } : {}) }),
    // TerminalService validates this as one session name, not a filesystem path.
    sessionProvider: (session: string) => {
      let provider = sessions.get(session);
      if (!provider) {
        provider = make({ session, socketPath: resolveHerdrSocketPath(env, session) });
        sessions.set(session, provider);
      }
      return provider;
    },
  };
}
