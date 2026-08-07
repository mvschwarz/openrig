import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveIdentitySource } from "./whoami.js";

interface AskRigInfo {
  name: string;
  status: string;
  nodeCount: number;
  runningCount: number;
  uptime: string | null;
}

interface AskSeatEvidence {
  name: string;
  generations: number;
  hits: Array<{ generation: number; text: string }>;
  degraded?: { reason: string; message: string };
  advisory?: string;
}

interface AskResult {
  question: string;
  rig: AskRigInfo | null;
  evidence: {
    backend: string;
    excerpts: string[];
    chatExcerpts?: string[];
  };
  seat?: AskSeatEvidence;
  insufficient: boolean;
  guidance?: string;
}

interface AskCommandDeps extends StatusDeps {
  identityResolver?: typeof resolveIdentitySource;
}

export function askCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("ask")
    .description("Search rig transcript history with a natural language question")
    .argument("<rig>", "Rig name to search")
    .argument("<question>", "Question to search for in transcripts")
    .option("--json", "JSON output for agents")
    .option("--seat <session>", "Scope the search to ONE seat's transcript across every generation that sat in it (cross-generation archaeology)")
    .addHelpText("after", `
rig ask is one verb for information about the PAST, three ways to reach it:
  1. rig ask <rig> "<q>"                 search the whole rig's transcripts
  2. rig ask <rig> "<q>" --seat <seat>   scope to ONE seat, across every
                                         generation that sat in it (L1)

Examples:
  rig ask my-rig "what decisions were made about deployment?"
  rig ask my-rig "error handling strategy" --json
  rig ask my-rig "what did we decide" --seat dev-planner@my-rig

Exit codes:
  0  Success
  1  Daemon not running
  2  Failed to fetch data from daemon`);

  const getDeps = (): AskCommandDeps => (depsOverride as AskCommandDeps | undefined) ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd.action(async (rig: string, question: string, opts: { json?: boolean; seat?: string }) => {
    const deps = getDeps();

    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return;

    const client = deps.clientFactory(getDaemonUrl(status));
    const identity = (deps.identityResolver ?? resolveIdentitySource)({});
    const res = await client.post<AskResult>("/api/ask", {
      rig,
      question,
      nodeId: identity?.nodeId,
      sessionName: identity?.sessionName,
      seat: opts.seat,
    });

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

    if (result.seat) {
      console.log(`Seat: ${result.seat.name}  (${result.seat.generations} generation(s) searched)`);
      if (result.seat.advisory) {
        console.log(`  ⚠ ${result.seat.advisory}`);
      }
    }

    console.log(`Search: ${result.evidence.backend}`);
    console.log("");

    if (result.guidance) {
      console.log(result.guidance);
      console.log("");
    }

    if (result.evidence.excerpts.length > 0) {
      const heading = result.evidence.backend === "structured"
        ? `Structured Answer (${result.evidence.excerpts.length} items):`
        : `Transcript Evidence (${result.evidence.excerpts.length} matches):`;
      console.log(heading);
      for (const excerpt of result.evidence.excerpts) {
        console.log(`  - ${excerpt}`);
      }
    }

    if (result.evidence.chatExcerpts && result.evidence.chatExcerpts.length > 0) {
      if (result.evidence.excerpts.length > 0) {
        console.log("");
      }
      console.log(`Chat Evidence (${result.evidence.chatExcerpts.length} matches):`);
      for (const excerpt of result.evidence.chatExcerpts) {
        console.log(`  - ${excerpt}`);
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
