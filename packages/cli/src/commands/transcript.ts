import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { loadHostRegistry, resolveHost, hostDisplayTarget } from "../host-registry.js";
import { emitCrossHostError, emitRemoteHttpFailure } from "../cross-host-cli-helpers.js";
import { resolveCrossHostTarget } from "../cross-host-target.js";
import { runRemoteHttpOp } from "../remote-host-ops.js";

export interface TranscriptDeps extends StatusDeps {
  /** Test seam: inject a registry loader so no real ~/.openrig is touched. */
  hostRegistryLoader?: () => ReturnType<typeof loadHostRegistry>;
}

export function transcriptCommand(depsOverride?: TranscriptDeps): Command {
  const cmd = new Command("transcript").description("Read agent transcript output");
  const getDeps = (): TranscriptDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<session>", "Session name (e.g. dev-impl@my-rig)")
    .option("--tail <lines>", "Show last N lines (default: 50)", "50")
    .option("--grep <pattern>", "Search for lines matching pattern (regex)")
    .option("--host <id>", "Read from a remote host declared in ~/.openrig/hosts.yaml (http hosts only — CLI-direct to the remote daemon's transcript routes)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig transcript dev-impl@my-rig --tail 100
  rig transcript dev-impl@my-rig --grep "decision|architecture"
  rig transcript dev-impl@my-rig --json
  rig transcript --host vps-b dev-impl@my-rig --tail 100
  rig transcript dev-impl@my-rig@vps-b --grep "handoff"

--host reads the transcript from a remote host declared in
~/.openrig/hosts.yaml, CLI-direct against that daemon's shipped transcript
routes (http-registered hosts, e.g. pair-registered; an ssh-registered host
fails with the structured transport-requirement error). Output shape is the
origin's, verbatim. A session of the form agent@rig@host is sugar for --host
when the suffix is a REGISTERED host id (explicit --host > sugar > persisted
selection).`)
    .action(async (session: string, opts: { tail?: string; grep?: string; host?: string; json?: boolean }) => {
      // OPR.0.4.6.MH4 C2 — cross-host observe: explicit --host > the
      // `agent@rig@host` target sugar > the persisted host selection
      // (resolveEffectiveHost). The local path below is byte-untouched.
      const explicitHost = opts.host;
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDeps();

      const targetResolution = resolveCrossHostTarget(session, explicitHost, deps.hostRegistryLoader);
      if (!targetResolution.ok) {
        console.error(targetResolution.error);
        process.exitCode = 1;
        return;
      }
      session = targetResolution.target;
      const crossHostHint = targetResolution.hint;
      opts.host = explicitHost ?? targetResolution.sugarHost ?? opts.host;

      // --grep takes precedence over --tail when both given
      const useGrep = !!opts.grep;
      const tailLines = parseInt(opts.tail ?? "50", 10);
      const apiPath = useGrep
        ? `/api/transcripts/${encodeURIComponent(session)}/grep?pattern=${encodeURIComponent(opts.grep!)}`
        : `/api/transcripts/${encodeURIComponent(session)}/tail?lines=${isNaN(tailLines) ? 50 : tailLines}`;

      // --- Cross-host path (CLI-direct GET to the remote daemon's shipped
      // transcript routes — the SAME paths the local path builds, origin
      // shape verbatim; read-class deadline; daemon untouched). ---
      if (opts.host) {
        await runCrossHostTranscript(opts.host, apiPath, useGrep, opts, deps, crossHostHint);
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.get<Record<string, unknown>>(apiPath);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Transcript request failed (HTTP ${res.status})`);
        // MH-4 §4 loud-failure hint: 3-part-shaped target, unregistered suffix.
        if (crossHostHint) console.error(`hint: ${crossHostHint}`);
        process.exitCode = 1;
        return;
      }

      renderTranscript(res.data, useGrep);
    });

  return cmd;
}

/**
 * OPR.0.4.6.MH4 C2 — cross-host transcript over http, CLI-DIRECT to the
 * remote daemon's shipped GET /api/transcripts/:session/tail | /grep
 * (zero daemon-side changes; the MH-2 read-through PATTERN, one hop from
 * the bearer-capable CLI). An ssh-registered host surfaces runRemoteHttpOp's
 * structured transport error — never a silent wrong-transport attempt.
 */
async function runCrossHostTranscript(
  hostId: string,
  apiPath: string,
  useGrep: boolean,
  opts: { json?: boolean },
  deps: TranscriptDeps,
  hint?: string,
): Promise<void> {
  // Resolve the host in the caller (the send/capture pattern) so an unknown
  // host surfaces as the SAME `unknown-host` step class across all four
  // verbs, and the banner carries the display target uniformly.
  const loader = deps.hostRegistryLoader ?? loadHostRegistry;
  const registry = loader();
  if (!registry.ok) {
    emitCrossHostError(hostId, "registry-load-failed", registry.error, opts.json);
    return;
  }
  const resolved = resolveHost(registry.registry, hostId);
  if (!resolved.ok) {
    emitCrossHostError(hostId, "unknown-host", hint ? `${resolved.error} (${hint})` : resolved.error, opts.json);
    return;
  }
  const host = resolved.host;

  const result = await runRemoteHttpOp(hostId, "GET", apiPath, undefined, deps, {});

  if (opts.json) {
    console.log(JSON.stringify({
      cross_host: { host: host.id, target: hostDisplayTarget(host), transport: "http" },
      result,
      ...(!result.ok && hint ? { hint } : {}),
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (!result.ok) {
    emitRemoteHttpFailure(host.id, hostDisplayTarget(host), result, false, hint);
    return;
  }

  console.log(`[via host=${host.id} (${hostDisplayTarget(host)})]`);
  renderTranscript((result.data ?? {}) as Record<string, unknown>, useGrep);
}

/** One renderer, two callers — the remote output shape is the origin's,
 *  so local and cross-host reads render identically. */
function renderTranscript(data: Record<string, unknown>, useGrep: boolean): void {
  if (useGrep) {
    const matches = data["matches"] as string[] | undefined;
    if (matches && matches.length > 0) {
      for (const line of matches) {
        console.log(line);
      }
    } else {
      console.log("No matches found.");
    }
  } else {
    const content = data["content"] as string | undefined;
    if (content) {
      // Print each line via console.log for consistent capture in tests and terminal
      const lines = content.split("\n");
      for (const line of lines) {
        if (line) console.log(line);
      }
    }
  }
}
