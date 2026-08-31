import { resolve as resolvePath } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveDefaultAgentRef } from "./topology-default-agent.js";

interface RigNode {
  rigName: string;
  podNamespace: string | null;
}

interface GrowResult {
  ok: boolean;
  result?: {
    podNamespace: string;
    node: {
      logicalId: string;
      status: "launched" | "failed" | "attention_required";
      sessionName?: string;
      error?: string;
    };
  };
  errors?: string[];
  message?: string;
  error?: string;
}

export function growCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("grow").description("Add one seat to a running rig");
  const getDeps = () => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<rig-id>", "Target rig ID")
    .argument("<member>", "Name for the new seat")
    .option("--pod <pod>", "Target pod; inferred when the rig has one pod")
    .option("--runtime <runtime>", "Agent runtime", "claude-code")
    .option("--cwd <path>", "Working directory for the seat", process.cwd())
    .option("--json", "JSON output for agents")
    .action(async (
      rigId: string,
      member: string,
      opts: { pod?: string; runtime: string; cwd: string; json?: boolean },
    ) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRes = await client.get<RigNode[]>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
      if (rigRes.status >= 400) {
        console.error(`Rig ${rigId} was not found.`);
        process.exitCode = 1;
        return;
      }
      const rigName = rigRes.data[0]?.rigName;
      const pods = [...new Set(
        rigRes.data
          .map((node) => node.podNamespace)
          .filter((namespace): namespace is string => typeof namespace === "string"),
      )];
      const pod = opts.pod
        ? pods.find((candidate) => candidate === opts.pod)
        : pods.length === 1
          ? pods[0]
          : undefined;
      if (!pod) {
        const available = pods.join(", ") || "none";
        console.error(opts.pod
          ? `Pod ${opts.pod} was not found. Available pods: ${available}.`
          : `Choose a pod with --pod. Available pods: ${available}.`);
        process.exitCode = 1;
        return;
      }

      let agentRef: string;
      try {
        agentRef = await resolveDefaultAgentRef(client);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
        return;
      }
      const cwd = resolvePath(opts.cwd);
      const res = await client.post<GrowResult>(
        `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(pod)}/members`,
        {
          member: {
            id: member,
            agent_ref: agentRef,
            runtime: opts.runtime,
            profile: "default",
            cwd,
          },
          rigRoot: cwd,
        },
        { timeoutMs: 120_000 },
      );
      const node = res.data.result?.node;
      const ok = res.status < 400 && res.data.ok && node?.status === "launched";

      if (opts.json) {
        console.log(JSON.stringify({
          ok,
          rigId,
          rigName,
          pod,
          seat: node?.logicalId ?? `${pod}.${member}`,
          source: agentRef,
          node,
        }, null, 2));
      } else if (ok) {
        console.log(`Grew rig ${rigName ?? rigId}`);
        console.log(`  Seat: ${node?.logicalId}${node?.sessionName ? ` (${node.sessionName})` : ""}`);
      } else {
        const detail = res.data.errors?.join("; ")
          ?? res.data.message
          ?? res.data.error
          ?? node?.error
          ?? `Grow failed (HTTP ${res.status})`;
        console.error(detail);
      }

      if (!ok) process.exitCode = 1;
    });

  return cmd;
}
