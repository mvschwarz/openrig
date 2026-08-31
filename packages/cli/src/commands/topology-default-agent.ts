import { dirname } from "node:path";
import type { DaemonClient } from "../client.js";

interface AgentLibraryEntry {
  kind: "agent";
  name: string;
  sourceType: string;
  sourcePath: string;
}

/** Resolve the shipped general-purpose agent already installed with the daemon. */
export async function resolveDefaultAgentRef(client: DaemonClient): Promise<string> {
  const res = await client.get<AgentLibraryEntry[]>("/api/specs/library?kind=agent");
  const entry = res.data?.find(
    (candidate) =>
      candidate.kind === "agent"
      && candidate.name === "orchestrator"
      && candidate.sourceType === "builtin",
  );
  if (!entry) {
    throw new Error("The shipped default agent is unavailable. Reinstall OpenRig and retry.");
  }
  return `path:${dirname(entry.sourcePath)}`;
}
