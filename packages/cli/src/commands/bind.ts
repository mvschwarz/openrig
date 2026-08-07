import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function bindCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bind").description("Bind a discovered session to a rig node (existing or new)");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  cmd
    .argument("<discoveredId>", "ID of the discovered session")
    .requiredOption("--rig <rigId>", "Target rig ID")
    .option("--node <logicalId>", "Bind to existing logical node")
    .option("--pod <namespace>", "Create new node in this pod (requires --member)")
    .option("--member <name>", "Member name for the new node (requires --pod)")
    .action(async (discoveredId: string, opts: { rig: string; node?: string; pod?: string; member?: string }) => {
      // XOR mode validation
      const hasNode = !!opts.node;
      const hasPod = !!opts.pod || !!opts.member;

      if (hasNode && hasPod) {
        console.error("Specify either --node (bind to existing) or --pod + --member (create in pod), not both.");
        process.exitCode = 1;
        return;
      }
      if (!hasNode && !hasPod) {
        console.error("Specify --node <logicalId> to bind to an existing node, or --pod <namespace> --member <name> to create a new node in a pod.");
        process.exitCode = 1;
        return;
      }
      if (hasPod && (!opts.pod || !opts.member)) {
        console.error("Both --pod and --member are required when creating a new node in a pod.");
        process.exitCode = 1;
        return;
      }

      const deps = getDeps();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const body: Record<string, unknown> = { rigId: opts.rig };
      if (hasNode) {
        body["logicalId"] = opts.node;
      } else {
        body["podNamespace"] = opts.pod;
        body["memberName"] = opts.member;
      }

      const res = await client.post<Record<string, unknown>>(`/api/discovery/${encodeURIComponent(discoveredId)}/bind`, body);

      if (res.status >= 400) {
        console.error(res.data["error"] ?? `Bind failed (HTTP ${res.status})`);
        process.exitCode = 1;
        return;
      }

      if (hasNode) {
        console.log(`Bound discovery ${discoveredId} to node ${opts.node} in rig ${opts.rig}`);
      } else {
        console.log(`Created node ${opts.pod}.${opts.member} and bound discovery ${discoveredId} in rig ${opts.rig}`);
      }
    });

  return cmd;
}
