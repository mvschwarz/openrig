import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

type LaunchResponse = {
  ok: boolean;
  rigId?: string;
  nodeId?: string;
  logicalId?: string;
  sessionName?: string;
  error?: string;
  code?: string;
  launched?: Array<{ nodeId: string; logicalId: string; status: string; error?: string }>;
  held?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  alreadyRunning?: Array<{ nodeId: string; logicalId: string }>;
  failedTargets?: Array<{ nodeId: string; logicalId: string; reason: string }>;
  // OPR.0.4.3.28 correction — non-blocking launch warnings (e.g. liveness_probe_unknown: launched
  // despite a failed tmux liveness probe). Surfaced as human output WITHOUT a non-zero exit.
  warnings?: string[];
};

// OPR.0.4.3.20 FR-7 — a launched-entry status that means NO session is running (the
// operator must act). These are NOT successful launches — never print "Launched" for
// them; exit non-zero. Mirrors the daemon's NON_RUNNING_LAUNCH_STATUSES.
const NON_RUNNING_LAUNCH_STATUSES = new Set(["awaiting-decision", "attention_required", "failed"]);
function launchStatusRunning(status: string): boolean {
  return !NON_RUNNING_LAUNCH_STATUSES.has(status);
}

export function launchCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("launch").description("Launch or relaunch a node in a running rig");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running. Start it with: rig daemon start");
      return null;
    }
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<rigId>", "Target rig ID")
    .argument("[nodeRef]", "Node logical ID or node ID (single target)")
    .option("--seats <ids>", "Comma-separated logical IDs for subset launch")
    .option("--hold-reason <reason>", "Reason for holding non-target seats")
    .option("--json", "JSON output")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (rigId: string, nodeRef: string | undefined, opts: { json?: boolean; holdReason?: string; seats?: string; host?: string }) => {
      const deps = getDeps();

      if (opts.host) {
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const seatList = opts.seats ? opts.seats.split(",").map((s) => s.trim()).filter(Boolean) : [];
        let apiPath: string;
        let body: unknown;
        if (seatList.length > 0) {
          apiPath = `/api/rigs/${encodeURIComponent(rigId)}/nodes/launch-subset`;
          body = { seats: seatList, ...(opts.holdReason ? { holdReason: opts.holdReason } : {}) };
        } else if (nodeRef) {
          apiPath = `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}/launch`;
          body = opts.holdReason ? { holdReason: opts.holdReason } : {};
        } else {
          console.error("Either a node reference or --seats is required for launch --host");
          process.exitCode = 1;
          return;
        }
        const result = await runRemoteHttpOp(opts.host, "POST", apiPath, body, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`Error on host ${opts.host}: ${result.error}`);
          process.exitCode = 1;
        }
        return;
      }

      const client = await getClient(deps);
      if (!client) {
        process.exitCode = 1;
        return;
      }

      const seatList = opts.seats ? opts.seats.split(",").map((s) => s.trim()).filter(Boolean) : [];

      if (seatList.length > 0) {
        const body: { seats: string[]; holdReason?: string } = { seats: seatList };
        if (opts.holdReason) body.holdReason = opts.holdReason;
        const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/launch-subset`, body);
        if (opts.json) {
          console.log(JSON.stringify(res.data, null, 2));
          if (res.status >= 400) process.exitCode = 1;
          return;
        }
        // Hard failure (no per-seat result to render — e.g. rig_not_found): error + exit.
        if (!res.data.launched && !res.data.held && !res.data.alreadyRunning) {
          console.error(res.data.error ?? `Launch failed (HTTP ${res.status})`);
          process.exitCode = 1;
          return;
        }
        // OPR.0.4.3.20 FR-7 — only actually-running restore outcomes are "Launched".
        // A seat that landed awaiting-decision / attention_required / failed is NOT
        // launched (no session running) — print it honestly + exit non-zero.
        const launchedAll = res.data.launched ?? [];
        const running = launchedAll.filter((n) => launchStatusRunning(n.status));
        const needsDecision = launchedAll.filter((n) => !launchStatusRunning(n.status));
        const heldIds = (res.data.held ?? []).map((n) => `${n.logicalId} (${n.reason})`).join(", ");
        if (running.length) console.log(`Launched: ${running.map((n) => n.logicalId).join(", ")}`);
        if (heldIds) console.log(`Held: ${heldIds}`);
        if (res.data.alreadyRunning?.length) console.log(`Already running: ${res.data.alreadyRunning.map((n) => n.logicalId).join(", ")}`);
        // OPR.0.4.3.28 correction — proceed-with-warning: print non-blocking launch warnings (e.g.
        // liveness_probe_unknown) WITHOUT setting a non-zero exit.
        for (const w of res.data.warnings ?? []) console.warn(`Warning: ${w}`);
        for (const n of needsDecision) {
          console.error(`  ${n.logicalId}: ${n.status}${n.error ? ` — ${n.error}` : ""}`);
        }
        if (needsDecision.length > 0) process.exitCode = 1;
        if (res.data.failedTargets?.length) {
          console.error(`Failed (liveness unknown): ${res.data.failedTargets.map((n) => n.logicalId).join(", ")}`);
          process.exitCode = 1;
        }
        if ((res.data as Record<string, unknown>).unmatchedIds && ((res.data as Record<string, unknown>).unmatchedIds as string[]).length > 0) {
          console.error(`Unmatched seats (not found): ${((res.data as Record<string, unknown>).unmatchedIds as string[]).join(", ")}`);
          process.exitCode = 1;
        }
        return;
      }

      if (!nodeRef) {
        console.error("Provide a node logical ID or use --seats <a,b> for subset launch");
        process.exitCode = 1;
        return;
      }

      const body: Record<string, string> = {};
      if (opts.holdReason) body.holdReason = opts.holdReason;

      const res = await client.post<LaunchResponse>(`/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeRef)}/launch`, body);
      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status >= 400 || !res.data.ok) {
        console.error(res.data.error ?? `Launch failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      const logicalId = res.data.logicalId ?? nodeRef;
      // OPR.0.4.3.28 correction — proceed-with-warning: print non-blocking launch warnings (e.g.
      // liveness_probe_unknown) WITHOUT setting a non-zero exit.
      const printLaunchWarnings = () => {
        for (const w of res.data.warnings ?? []) console.warn(`Warning: ${w}`);
      };
      if (res.data.code === "already_running" || (res.data.alreadyRunning && res.data.alreadyRunning.length > 0)) {
        console.log(`Node ${logicalId} is already running in rig ${rigId} (not relaunched)`);
        printLaunchWarnings();
        return;
      }
      const sessionSuffix = res.data.sessionName ? ` (${res.data.sessionName})` : "";
      console.log(`Launched node ${logicalId} in rig ${rigId}${sessionSuffix}`);
      printLaunchWarnings();
    });

  return cmd;
}
