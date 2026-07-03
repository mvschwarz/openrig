// OPR.0.3.4.3 — rig reconcile-session: adopt a LIVE, hand-resumed canonical
// session back into its persisted node WITHOUT launch/relaunch/kill/startup
// replay/resume menus/compaction, and WITHOUT writing any input into the pane.
// The repair for "I manually resumed the seat; make the daemon see it again."

import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface ReconcileResponse {
  ok: boolean;
  result?: {
    rigId: string;
    rigName: string;
    nodeId: string;
    logicalId: string;
    sessionName: string;
    sessionId: string;
    projectionDrift: string[];
    continuity: string;
  };
  code?: string;
  message?: string;
  error?: string;
}

export function reconcileSessionCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("reconcile-session")
    .description("Adopt a live, hand-resumed session back into its persisted node (no launch, no input)");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<session>", "Canonical session name (e.g. dev-impl@my-rig) of the LIVE session to adopt")
    .option("--rig <rigId>", "Disambiguate: target rig id (requires --node)")
    .option("--node <logicalId>", "Disambiguate: target node logical id (requires --rig)")
    .option("--no-launch", "Never launch/relaunch (the only mode this command has; accepted for explicitness)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig reconcile-session dev-impl@my-rig --no-launch
  rig reconcile-session dev-impl@my-rig --rig <rig-id> --node dev.impl --no-launch
  rig reconcile-session dev-impl@my-rig --json

Use after manually resuming a seat (claude --resume / codex resume) inside its
canonical tmux session: the daemon still shows the seat down. Reconcile binds
the live process to its OWN persisted node (same node id - no re-key) and
updates the projection so rig ps / topology / send / capture / queue routing
work again. It NEVER launches, relaunches, kills, replays startup, presses
resume menus, compacts, or types into the pane. Anything it could not prove is
reported as projection drift; conversation continuity is never claimed.`)
    .action(async (session: string, opts: { rig?: string; node?: string; launch?: boolean; json?: boolean }) => {
      if ((opts.rig && !opts.node) || (!opts.rig && opts.node)) {
        console.error("--rig and --node must be provided together.");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const body: Record<string, unknown> = {};
      if (opts.rig) body["rigId"] = opts.rig;
      if (opts.node) body["logicalId"] = opts.node;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ReconcileResponse>(
        `/api/sessions/${encodeURIComponent(session)}/reconcile`,
        body,
        { headers: terminalAuthHeaders() },
      );
      const data = res.data;

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        if (res.status >= 400 || !data.ok) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !data.ok) {
        console.error(data.message ?? data.error ?? `Reconcile failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const r = data.result!;
      console.log(`Reconciled ${r.sessionName} into rig ${r.rigName}`);
      console.log(`  Node: ${r.logicalId} (node id unchanged - no relaunch, no input sent)`);
      if (r.projectionDrift.length > 0) {
        console.log("  Projection drift (unproven metadata):");
        for (const d of r.projectionDrift) console.log(`    - ${d}`);
      } else {
        console.log("  Projection drift: none detected");
      }
      console.log(`  Conversation continuity: ${r.continuity} (reconcile reconnects the projection; it does not verify the conversation)`);
    });

  return cmd;
}
