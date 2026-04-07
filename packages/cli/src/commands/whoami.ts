import { Command } from "commander";
import { execSync } from "node:child_process";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface WhoamiIdentity {
  rigName: string;
  logicalId: string;
  podId: string | null;
  memberId: string;
  sessionName: string;
  runtime: string;
}

interface WhoamiPeer {
  logicalId: string;
  sessionName: string;
  runtime: string;
}

interface WhoamiEdge {
  kind: string;
  to?: { logicalId: string; sessionName: string };
  from?: { logicalId: string; sessionName: string };
}

interface WhoamiResult {
  resolvedBy: string;
  identity: WhoamiIdentity & Record<string, unknown>;
  peers: WhoamiPeer[];
  edges: { outgoing: WhoamiEdge[]; incoming: WhoamiEdge[] };
  transcript: { enabled: boolean; path: string | null; tailCommand: string | null };
}

type TmuxExecFn = (cmd: string) => string;

const defaultTmuxExec: TmuxExecFn = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();

/**
 * Resolve the current session identity using the approved resolution chain:
 * 1. --node-id flag
 * 2. --session flag
 * 3. OPENRIG_NODE_ID env
 * 4. OPENRIG_SESSION_NAME env
 * 5. TMUX_PANE → @rigged_node_id tmux metadata
 * 6. TMUX_PANE → @rigged_session_name tmux metadata
 * 7. TMUX_PANE → tmux display-message (raw session name)
 * 8. fail
 */
export function resolveIdentitySource(
  opts: { nodeId?: string; session?: string },
  tmuxExec: TmuxExecFn = defaultTmuxExec,
): { nodeId?: string; sessionName?: string } | null {
  if (opts.nodeId) return { nodeId: opts.nodeId };
  if (opts.session) return { sessionName: opts.session };

  const envNodeId = readOpenRigEnv("OPENRIG_NODE_ID", "RIGGED_NODE_ID");
  if (envNodeId) return { nodeId: envNodeId };

  const envSessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME");
  if (envSessionName) return { sessionName: envSessionName };

  // TMUX_PANE fallback — try OpenRig metadata first, then raw session name
  const tmuxPane = process.env["TMUX_PANE"];
  if (tmuxPane) {
    // Step 5: @rigged_node_id metadata (strongest adopted-session anchor)
    try {
      const nodeId = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_node_id`);
      if (nodeId) return { nodeId };
    } catch { /* metadata not set — continue */ }

    // Step 6: @rigged_session_name metadata
    try {
      const sessionName = tmuxExec(`tmux show-option -v -t ${JSON.stringify(tmuxPane)} @rigged_session_name`);
      if (sessionName) return { sessionName };
    } catch { /* metadata not set — continue */ }

    // Step 7: raw tmux session name (weakest fallback)
    try {
      const sessionName = tmuxExec(`tmux display-message -p -t ${JSON.stringify(tmuxPane)} "#{session_name}"`);
      if (sessionName) return { sessionName };
    } catch {
      // tmux not available or pane not found — skip
    }
  }

  return null;
}

export function whoamiCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("whoami").description("Show current managed identity in an OpenRig topology");
  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .option("--node-id <id>", "Resolve by node ID")
    .option("--session <name>", "Resolve by session name")
    .option("--json", "JSON output for agents")
    .action(async (opts: { nodeId?: string; session?: string; json?: boolean }) => {
      const source = resolveIdentitySource(opts);
      if (!source) {
        console.error("Cannot determine identity. Run inside an OpenRig-managed session, or use --session or --node-id.");
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

      const client = deps.clientFactory(getDaemonUrl(status));
      const query = source.nodeId
        ? `nodeId=${encodeURIComponent(source.nodeId)}`
        : `sessionName=${encodeURIComponent(source.sessionName!)}`;

      const res = await client.get<Record<string, unknown>>(`/api/whoami?${query}`);

      if (opts.json) {
        console.log(JSON.stringify(res.data, null, 2));
        if (res.status >= 400) process.exitCode = 1;
        return;
      }

      if (res.status === 404) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "Session not found in any managed rig. Check: rig ps --nodes");
        process.exitCode = 1;
        return;
      }

      if (res.status === 409) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? "Session is ambiguous. Use --node-id instead.");
        process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const error = (res.data as Record<string, unknown>)["error"] as string | undefined;
        console.error(error ?? `Whoami failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      // Human-readable output
      const data = res.data as unknown as WhoamiResult;
      const id = data.identity;
      console.log(`Rig:        ${id.rigName}`);
      console.log(`Logical ID: ${id.logicalId}`);
      console.log(`Pod:        ${id.podId ?? "—"} / ${id.memberId}`);
      console.log(`Session:    ${id.sessionName}`);
      console.log(`Runtime:    ${id.runtime}`);
      console.log(`Resolved:   via ${data.resolvedBy.replace(/_/g, " ")}`);

      if (data.peers.length > 0) {
        console.log("");
        console.log("Peers:");
        for (const peer of data.peers) {
          console.log(`  ${peer.logicalId.padEnd(20)} ${peer.sessionName.padEnd(30)} ${peer.runtime}`);
        }
      }

      if (data.edges.outgoing.length > 0 || data.edges.incoming.length > 0) {
        console.log("");
        console.log("Edges:");
        for (const edge of data.edges.outgoing) {
          console.log(`  → ${edge.kind}  ${edge.to?.logicalId ?? "?"}`);
        }
        for (const edge of data.edges.incoming) {
          console.log(`  ← ${edge.kind}  ${edge.from?.logicalId ?? "?"}`);
        }
      }

      if (data.transcript.enabled && data.transcript.tailCommand) {
        console.log("");
        console.log(`Transcript: ${data.transcript.path ?? "enabled"}`);
        console.log(`  ${data.transcript.tailCommand}`);
      }
    });

  return cmd;
}
