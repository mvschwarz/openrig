import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

// The trigger is two-phase (prep → wait-for-idle → /compact); the wait-for-idle
// half can take up to the daemon's manual-prep ceiling (~120s). Give the HTTP
// call generous headroom so the client does not time out mid-sequence.
const MANUAL_COMPACT_REQUEST_TIMEOUT_MS = 180_000;

export interface CompactDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

/**
 * OPR.0.4.3.14 — `rig compact <session>`: manually run the guided compaction
 * lifecycle (prep → /compact → restore → audit) for one Claude seat, on demand,
 * independent of the auto threshold. Distinct from the read-only `rig
 * compact-plan` triage command.
 */
export function compactCommand(depsOverride?: CompactDeps): Command {
  const cmd = new Command("compact")
    .description("Manually run the guided compaction sequence (prep → /compact → restore → audit) for one Claude seat")
    .argument("<session>", "Target Claude session name (e.g. dev-impl@my-rig)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig compact dev-impl@my-rig          Manually compact one Claude seat now
  rig compact dev-impl@my-rig --json   JSON output for agents

Runs the SAME guided lifecycle the auto-compaction policy runs (pre-compact
prep → /compact with the trust-bridge → restore-from-marker → read-depth audit)
on demand, for ONE Claude seat, without waiting for the context threshold. It is
NOT a bare /compact and NOT the read-only 'rig compact-plan' triage. Non-Claude
seats are rejected. The /compact is sent only AFTER the prep turn completes.`);

  const getDepsF = (): CompactDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (session: string, opts: { json?: boolean }) => {
    const deps = getDepsF();

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon is not running. Start it with: rig daemon start");
      process.exitCode = 1;
      return;
    }

    const client = deps.clientFactory(getDaemonUrl(status));
    const res = await client.post<Record<string, unknown>>(
      "/api/compaction/trigger",
      { session },
      { headers: terminalAuthHeaders(), timeoutMs: MANUAL_COMPACT_REQUEST_TIMEOUT_MS },
    );

    if (opts.json) {
      console.log(JSON.stringify(res.data));
      if (res.status >= 400) process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    if (res.status >= 400) {
      const error = res.data["error"] as string | undefined;
      console.error(error ?? `Manual compaction failed (HTTP ${res.status})`);
      process.exitCode = res.status >= 500 ? 2 : 1;
      return;
    }

    const stage = res.data["stage"] as string | undefined;
    console.log(`Manual compaction triggered for ${session}${stage ? ` (stage: ${stage})` : ""}.`);
    console.log("The restore + read-depth audit prompts follow automatically as the seat drains below threshold.");
  });

  return cmd;
}
