import { runCrossHostCommand, type CrossHostResult, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { hostDisplayTarget, loadHostRegistry, resolveHost, type HostEntry } from "../host-registry.js";

// Slice 18 — `--host` on the commands that move a Codex home (`rig auth status|list|switch`, `rig seat restart`):
// the same rig command, run on another registered machine over that machine's SSH entry, as the calling seat. It's
// not a generic remote executor: each command passes its own argv, and nothing but that argv and the command's own
// output crosses the connection. `rig auth switch` copies a profile already saved on that machine, there.

export interface RunOnHostDeps {
  hostRegistryLoader?: typeof loadHostRegistry;
  crossHostRun?: (host: HostEntry, argv: readonly string[], opts?: RunCrossHostCommandOpts) => Promise<CrossHostResult>;
}

/** Run `rig <argv>` on `hostId`'s SSH entry, carrying `origin` (the calling seat) into the remote command's
 *  identity. The remote command's stdout, stderr and exit status come back as its own, so `--json` stays its JSON. */
export async function runOnSshHost(
  hostId: string,
  command: string,
  argv: readonly string[],
  origin: string | undefined,
  deps: RunOnHostDeps = {},
): Promise<void> {
  const registry = (deps.hostRegistryLoader ?? loadHostRegistry)();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error);
    return;
  }
  const host = resolved.host;
  if (host.transport !== "ssh") {
    console.error(
      `rig ${command} --host ${host.id}: that entry reaches the machine over ${host.transport}, which can't run ${command} there. `
      + `Name the same machine's SSH entry instead (rig host list shows each entry's transport), or run rig ${command} on that machine.`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await (deps.crossHostRun ?? runCrossHostCommand)(host, ["rig", ...argv], origin ? { originTriple: origin } : {});
  console.error(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  if (result.ok || result.failedStep === "remote-command-failed") {
    // The remote command ran: its output and status are the answer, refusals included.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.ok) process.exitCode = result.remoteExitCode || 1;
    return;
  }
  emitCrossHostFailure(host.id, hostDisplayTarget(host), result);
}
