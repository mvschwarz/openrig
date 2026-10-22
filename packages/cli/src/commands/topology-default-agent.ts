import { dirname } from "node:path";
import type { DaemonClient } from "../client.js";

interface AgentLibraryEntry {
  kind: "agent";
  name: string;
  sourceType: string;
  sourcePath: string;
}

/** Resolve the runtime's terminal seat or the shipped general-purpose agent. */
export async function resolveDefaultAgentRef(client: DaemonClient, runtime: string): Promise<string> {
  if (runtime === "terminal") return "builtin:terminal";
  const res = await client.get<AgentLibraryEntry[]>("/api/specs/library?kind=agent");
  const entry = res.data?.find(
    (candidate) =>
      candidate.kind === "agent"
      && candidate.name === "orchestrator"
      && candidate.sourceType === "builtin",
  );
  if (!entry) {
    throw new Error(`The shipped default agent is unavailable for runtime "${runtime}". Use rig up <spec> with an explicit agent_ref, or reinstall OpenRig and retry.`);
  }
  return `path:${dirname(entry.sourcePath)}`;
}
