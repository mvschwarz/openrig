import type { LifecycleDeps, StartOptions } from "./daemon-lifecycle.js";
import type { PreflightResult } from "./system-preflight.js";

/** The configuration and preflight shared by local command auto-starts. */
export async function prepareDaemonAutoStart(
  deps: LifecycleDeps,
  preflightExec?: (cmd: string) => Promise<string>,
): Promise<{ options: StartOptions; preflight: PreflightResult }> {
  const { ConfigStore } = await import("./config-store.js");
  const { SystemPreflight } = await import("./system-preflight.js");
  const { execSync } = await import("node:child_process");
  const { OPENRIG_DIR, getDaemonStatus, resolveBindIntent } = await import("./daemon-lifecycle.js");
  const configStore = new ConfigStore();
  const config = configStore.resolve();
  const hostResolution = configStore.resolveWithSource("daemon.host");
  // The inherited routing host is not bind intent. Keep the existing up rule:
  // only a file-selected host or OPENRIG_BIND_HOST selects an explicit bind.
  const host = resolveBindIntent({
    flagHost: undefined,
    envBindHost: process.env["OPENRIG_BIND_HOST"],
    configSource: hostResolution.source,
    configHost: config.daemon.host,
  }).host;
  const preflight = await new SystemPreflight({
    exec: preflightExec ?? (async (cmd: string) =>
      execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] })),
    configStore,
    getDaemonStatus: () => getDaemonStatus(deps),
    openrigHome: OPENRIG_DIR,
  }).run();
  return {
    preflight,
    options: {
      port: config.daemon.port,
      host,
      db: config.db.path,
      transcriptsEnabled: config.transcripts.enabled,
      transcriptsPath: config.transcripts.path,
      workspaceRoot: config.workspace.root,
      contextRoot: config.context.root,
      skillsRoot: config.skills.root,
      topologyRoot: config.topology.root,
    },
  };
}
