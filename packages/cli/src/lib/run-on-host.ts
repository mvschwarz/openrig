import { runCrossHostCommand, type CrossHostResult, type RunCrossHostCommandOpts } from "../cross-host-executor.js";
import { emitCrossHostError, emitCrossHostFailure } from "../cross-host-cli-helpers.js";
import { resolveOriginSelfHostId, type LifecycleDeps } from "../daemon-lifecycle.js";
import { hostDisplayTarget, loadHostRegistry, resolveHost, type HostEntry } from "../host-registry.js";

// Slice 18 — `--host` on the commands that move a Codex home (`rig auth status|list|switch`, `rig seat restart`):
// the same rig command, run on another registered machine over that machine's SSH entry, as the calling seat. It's
// not a generic remote executor: each command passes its own argv, and nothing but that argv and the command's own
// output crosses the connection. `rig auth switch` copies a profile already saved on that machine, there.

export interface RunOnHostDeps {
  hostRegistryLoader?: typeof loadHostRegistry;
  crossHostRun?: (host: HostEntry, argv: readonly string[], opts?: RunCrossHostCommandOpts) => Promise<CrossHostResult>;
  /** This host's id, for the origin (default: its persisted identity; undefined when it can't be read). */
  selfHostId?: () => Promise<string | undefined>;
}

/** This machine's persisted host id, read as `rig send --host` reads it: never from the daemon endpoint, which
 *  OPENRIG_URL may point at another machine, and readable during a daemon outage. Undefined when it can't be read. */
export async function localSelfHostId(deps: LifecycleDeps): Promise<string | undefined> {
  return resolveOriginSelfHostId(deps).catch(() => undefined);
}

/** The origin as `rig send` carries it: `<member>@<rig>@<selfHostId>`, adding this host's id only to a two-part name,
 *  so the other machine never takes it for one of its own seats. An upstream full triple is kept as given. */
export async function originFor(seat: string | undefined, selfHostId: (() => Promise<string | undefined>) | undefined): Promise<string | undefined> {
  if (!seat) return undefined;
  if (seat.split("@").length >= 3 || !selfHostId) return seat;
  const id = await selfHostId().catch(() => undefined);
  return id ? `${seat}@${id}` : seat;
}

export interface RunOnHostOptions {
  /** The calling seat's origin (see `originFor`). */
  origin?: string;
  /** For a command that changes something there: the read that shows whether it ran, when the connection is lost. */
  changes?: { check: string };
  json?: boolean;
}

/** Run `rig <argv>` on `hostId`'s SSH entry as `origin`. The remote command's stdout, stderr and exit status come back
 *  as its own, so `--json` stays its JSON. A lost connection on a changing command is an unknown outcome, never a
 *  failure: the command may have run there, so the answer names what to read before repeating it. */
export async function runOnSshHost(hostId: string, command: string, argv: readonly string[], opts: RunOnHostOptions, deps: RunOnHostDeps = {}): Promise<void> {
  const registry = (deps.hostRegistryLoader ?? loadHostRegistry)();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", resolved.error, opts.json);
    return;
  }
  const host = resolved.host;
  if (host.transport !== "ssh") {
    emitCrossHostError(host.id, "transport-unsupported",
      `rig ${command} --host ${host.id}: that entry reaches the machine over ${host.transport}, which can't run ${command} there. `
      + `Name the same machine's SSH entry instead (rig host list shows each entry's transport), or run rig ${command} on that machine.`, opts.json);
    return;
  }
  const target = hostDisplayTarget(host);
  const result = await (deps.crossHostRun ?? runCrossHostCommand)(host, ["rig", ...argv], opts.origin ? { originTriple: opts.origin } : {});
  console.error(`[via host=${host.id} (${target})]`);
  if (result.ok || result.failedStep === "remote-command-failed" || result.failedStep === "remote-command-not-found" || result.failedStep === "remote-daemon-unreachable") {
    // The remote shell answered: its output and status are the answer, refusals included.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (!result.ok && result.failedStep === "remote-command-not-found") console.error(result.hint);
    if (!result.ok) process.exitCode = result.remoteExitCode || 1;
    return;
  }
  if (result.failedStep === "ssh-unreachable" && opts.changes) {
    const error = `the connection to host=${host.id} (${target}) failed or dropped, so whether rig ${command} ran there is unknown. `
      + `Check before repeating it: ${opts.changes.check}`;
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, code: "remote-outcome-unknown", cross_host: { host: host.id, target }, failedStep: result.failedStep, error, check: opts.changes.check }));
    } else {
      console.error(`remote-outcome-unknown: ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  emitCrossHostFailure(host.id, target, result, opts.json);
}
