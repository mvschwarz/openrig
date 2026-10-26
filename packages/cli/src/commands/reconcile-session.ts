// OPR.0.3.4.3 — rig reconcile-session: adopt a LIVE, hand-resumed canonical
// session back into its persisted node WITHOUT launch/relaunch/kill/startup
// replay/resume menus/compaction, and WITHOUT writing any input into the pane.
// The repair for "I manually resumed the seat; make the daemon see it again."

import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
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
    resumeMetadata?: {
      capture: { outcome: string; reason?: string };
      status: string;
      guidance?: string;
    };
    mode?: "repair-missing-pane";
    pane?: string;
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
    .option("--no-launch", "Never launch/relaunch (required explicitly with --repair-missing-pane)")
    .option("--repair-missing-pane", "Fill only a running launched seat's NULL tmux pane binding; keep its session, token and generation (requires --no-launch)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig reconcile-session dev-impl@my-rig --no-launch
  rig reconcile-session dev-impl@my-rig --rig <rig-id> --node dev.impl --no-launch
  rig reconcile-session dev-impl@my-rig --json
  rig reconcile-session dev-impl@my-rig --repair-missing-pane --no-launch

Use after manually resuming a seat (claude --resume / codex resume) inside its
canonical tmux session: the daemon still shows the seat down. Reconcile binds
the live process to its OWN persisted node (same node id - no re-key) and
updates the projection so rig ps / topology / send / capture / queue routing
work again. It NEVER launches, relaunches, kills, replays startup, presses
resume menus, compacts, or types into the pane. Anything it could not prove is
reported as projection drift; conversation continuity is never claimed.

--repair-missing-pane is different: it only fills an existing NULL pane binding
after two matching sole-pane observations. It keeps the current session, token,
generation, typing protection and capture state. It never adopts a session or
falls back to adoption on an older daemon. Native identity and conversation
continuity remain unverified; ordinary sends still apply their existing checks.`)
    .action(async (session: string, opts: { rig?: string; node?: string; launch?: boolean; repairMissingPane?: boolean; json?: boolean }) => {
      if (opts.repairMissingPane && opts.launch !== false) {
        console.error("--repair-missing-pane requires --no-launch.");
        process.exitCode = 1;
        return;
      }
      if ((opts.rig && !opts.node) || (!opts.rig && opts.node)) {
        console.error("--rig and --node must be provided together.");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const body: Record<string, unknown> = {};
      if (opts.rig) body["rigId"] = opts.rig;
      if (opts.node) body["logicalId"] = opts.node;

      const client = deps.clientFactory(getDaemonUrl(status));
      const res = await client.post<ReconcileResponse>(
        `/api/sessions/${encodeURIComponent(session)}/${opts.repairMissingPane ? "repair-missing-pane" : "reconcile"}`,
        body,
        { headers: terminalAuthHeaders() },
      );
      const data: ReconcileResponse = opts.repairMissingPane && res.status === 404
        ? { ok: false, code: "repair_missing_pane_unsupported", message: "This daemon does not support --repair-missing-pane; nothing was changed. Do not use plain reconcile-session for this repair: it adopts the session." }
        : res.data;

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
      if (opts.repairMissingPane) {
        console.log(`Repaired missing pane ${r.pane} for ${r.sessionName}`);
        console.log(`  Existing session ${r.sessionId} retained; no adoption, relaunch or input sent.`);
        console.log("  Native identity and conversation continuity remain unverified; ordinary send checks still apply.");
        return;
      }
      console.log(`Reconciled ${r.sessionName} into rig ${r.rigName}`);
      console.log(`  Node: ${r.logicalId} (node id unchanged - no relaunch, no input sent)`);
      if (r.resumeMetadata) {
        const { capture, status, guidance } = r.resumeMetadata;
        console.log(`Resume metadata: ${status} (capture: ${capture.outcome}${capture.reason ? `; ${capture.reason}` : ""}).`);
        if (guidance) console.log(guidance);
      }
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
