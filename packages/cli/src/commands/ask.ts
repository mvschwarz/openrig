import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  insufficient: boolean;
  guidance?: string;
}

export function askCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ask")
    .description("Search rig transcript history with a natural language question")
    .argument("<rig>", "Rig name to search")
    .argument("<question>", "Question to search for in transcripts")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig ask my-rig "what decisions were made about deployment?"
  rig ask my-rig "error handling strategy" --json

Exit codes:
  0  Success
  1  Daemon not running
  2  Failed to fetch data from daemon`);

  const getDeps = (): StatusDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (rig: string, question: string, opts: { json?: boolean }) => {
    const deps = getDeps();

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running. Start it with: rig daemon start");
      process.exitCode = 1;
      return;
    }

    const client = deps.clientFactory(getDaemonUrl(status));
    const res = await client.post<AskResult>("/api/ask", { rig, question });

    if (res.status >= 400) {
      console.error(`Failed to query rig (HTTP ${res.status}). Check daemon status with: rig status`);
      process.exitCode = 2;
      return;
    }

    const result = res.data;

    if (opts.json) {
      console.log(JSON.stringify(result));
      return;
    }

    // Human-readable output
    console.log(`Question: ${result.question}`);
    console.log("");

    if (result.rig) {
      console.log(`Rig: ${result.rig.name}  [${result.rig.status}]  ${result.rig.runningCount}/${result.rig.nodeCount} nodes  uptime: ${result.rig.uptime ?? "—"}`);
    } else {
      console.log(`Rig: ${rig}  [not found]`);
    }

    console.log(`Search: ${result.evidence.backend}`);
    console.log("");

    if (result.guidance) {
      console.log(result.guidance);
      console.log("");
    }

    if (result.evidence.excerpts.length > 0) {
      console.log(`Evidence (${result.evidence.excerpts.length} matches):`);
      for (const excerpt of result.evidence.excerpts) {
        console.log(`  ${excerpt}`);
      }
    }

    if (result.evidence.chatExcerpts && result.evidence.chatExcerpts.length > 0) {
      if (result.evidence.excerpts.length > 0) {
        console.log("");
      }
      console.log(`Chat Evidence (${result.evidence.chatExcerpts.length} matches):`);
      for (const excerpt of result.evidence.chatExcerpts) {
        console.log(`  ${excerpt}`);
      }
    }

    if (
      result.evidence.excerpts.length === 0 &&
      (!result.evidence.chatExcerpts || result.evidence.chatExcerpts.length === 0) &&
      !result.guidance
    ) {
      console.log("No transcript evidence found.");
    }
  });

  return cmd;
}
