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

interface GrowNode {
  logicalId: string;
  status: "launched" | "failed" | "attention_required";
  sessionName?: string;
  error?: string;
}

interface AddMemberResult {
  ok: boolean;
  result?: {
    podNamespace: string;
    node: GrowNode;
  };
  errors?: string[];
  message?: string;
  error?: string;
}

interface ExpandResult {
  ok: boolean;
  status?: "ok" | "partial" | "failed";
  podNamespace?: string;
  nodes?: GrowNode[];
  errors?: string[];
  message?: string;
  error?: string;
}

export function growCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("grow").description("Add one or more seats to a running rig");
  const getDeps = () => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .argument("<rig-id>", "Target rig ID")
    .argument("<members...>", "Names for the new seats")
    .option("--pod <pod>", "Target pod; inferred when the rig has one pod")
    .option("--new-pod <pod>", "Create a new pod for the seats")
    .option("--runtime <runtime>", "Agent runtime", "claude-code")
    .option("--cwd <path>", "Working directory for the seat", process.cwd())
    .option("--json", "JSON output for agents")
    .action(async (
      rigId: string,
      members: string[],
      opts: { pod?: string; newPod?: string; runtime: string; cwd: string; json?: boolean },
    ) => {
      if (opts.pod && opts.newPod) {
        console.error("Choose either --pod or --new-pod, not both.");
        process.exitCode = 1;
        return;
      }

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
      if (opts.newPod && pods.includes(opts.newPod)) {
        console.error(`Pod ${opts.newPod} already exists. Use --pod ${opts.newPod} to grow it.`);
        process.exitCode = 1;
        return;
      }
      const pod = opts.newPod
        ?? (opts.pod
          ? pods.find((candidate) => candidate === opts.pod)
          : pods.length === 1
            ? pods[0]
            : undefined);
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
      const memberSpecs = members.map((member) => ({
        id: member,
        agent_ref: agentRef,
        runtime: opts.runtime,
        profile: "default",
        cwd,
      }));
      let nodes: GrowNode[] = [];
      let ok = false;
      let detail: string | undefined;

      if (opts.newPod) {
        const res = await client.post<ExpandResult>(
          `/api/rigs/${encodeURIComponent(rigId)}/expand`,
          {
            pod: { id: pod, label: pod, members: memberSpecs, edges: [] },
            rigRoot: cwd,
          },
          { timeoutMs: 120_000 },
        );
        nodes = res.data.nodes ?? [];
        ok = res.status < 400
          && res.data.ok
          && res.data.status === "ok"
          && nodes.length === members.length
          && nodes.every((node) => node.status === "launched");
        detail = res.data.errors?.join("; ")
          ?? res.data.message
          ?? res.data.error
          ?? nodes.find((node) => node.error)?.error;
      } else {
        const failures: string[] = [];
        for (const member of memberSpecs) {
          const res = await client.post<AddMemberResult>(
            `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(pod)}/members`,
            { member, rigRoot: cwd },
            { timeoutMs: 120_000 },
          );
          const responseDetail = res.data.errors?.join("; ")
            ?? res.data.message
            ?? res.data.error
            ?? res.data.result?.node.error
            ?? `Grow failed (HTTP ${res.status})`;
          const node = res.data.result?.node ?? {
            logicalId: `${pod}.${member.id}`,
            status: "failed" as const,
            error: responseDetail,
          };
          nodes.push(node);
          if (res.status >= 400 || !res.data.ok || node.status !== "launched") {
            failures.push(`${member.id}: ${responseDetail}`);
          }
        }
        ok = failures.length === 0;
        detail = failures.join("; ") || undefined;
      }

      if (opts.json) {
        console.log(JSON.stringify({
          ok,
          rigId,
          rigName,
          pod,
          seats: nodes.map((node) => node.logicalId),
          source: agentRef,
          ...(nodes.length === 1 ? { seat: nodes[0]?.logicalId, node: nodes[0] } : {}),
          nodes,
        }, null, 2));
      } else if (ok) {
        console.log(`Grew rig ${rigName ?? rigId}`);
        if (nodes.length === 1) {
          const node = nodes[0]!;
          console.log(`  Seat: ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}`);
        } else {
          console.log("  Seats:");
          for (const node of nodes) {
            console.log(`    ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}`);
          }
        }
      } else {
        console.error(detail ?? "Grow failed.");
      }

      if (!ok) process.exitCode = 1;
    });

  return cmd;
}
