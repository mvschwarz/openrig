import { execFileSync } from "node:child_process";
import {
  listRigNodes,
  parseArgs,
  writeJson,
  isAgentRuntime,
  sleep,
} from "./common.js";
import { probeNodeResume } from "./resume-probe-lib.js";

interface SeedRoundResult {
  round: number;
  sentTo: string[];
  probe: Awaited<ReturnType<typeof probeNodeResume>>[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rig = String(args["rig"] ?? "demo-rig");
  const maxRounds = Number(args["max-rounds"] ?? "6");
  const waitMs = Number(args["wait-ms"] ?? "8000");
  const json = args["json"] === true;
  const output = typeof args["output"] === "string" ? String(args["output"]) : null;

  const allNodes = listRigNodes(rig).filter((node) => isAgentRuntime(node.runtime));
  if (allNodes.length === 0) {
    console.error(`No agent nodes found for rig '${rig}'.`);
    process.exitCode = 1;
    return;
  }

  const verified = new Set<string>();
  const rounds: SeedRoundResult[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const targets = allNodes.filter((node) => !verified.has(node.logicalId));
    if (targets.length === 0) break;

    for (const node of targets) {
      sendWarmup(node.canonicalSessionName, buildWarmupPrompt(node.logicalId, round));
    }

    await sleep(waitMs);

    const probe = [];
    for (const node of targets) {
      const result = await probeNodeResume(node);
      probe.push(result);
      if (result.status === "resumed") {
        verified.add(node.logicalId);
      }
    }

    rounds.push({
      round,
      sentTo: targets.map((node) => node.logicalId),
      probe,
    });
  }

  const finalNodes = listRigNodes(rig).filter((node) => isAgentRuntime(node.runtime));
  const summary = {
    rig,
    ok: verified.size === finalNodes.length,
    verified: [...verified].sort(),
    unverified: finalNodes
      .map((node) => node.logicalId)
      .filter((logicalId) => !verified.has(logicalId)),
    rounds,
  };

  if (output) {
    writeJson(output, summary);
  }

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Resume baseline seeding: ${rig}`);
    console.log(`Verified: ${summary.verified.length}/${finalNodes.length}`);
    for (const round of rounds) {
      console.log(`- Round ${round.round}: ${round.sentTo.join(", ")}`);
      for (const result of round.probe) {
        console.log(`  ${result.logicalId}: ${result.status} (${result.code})`);
      }
    }
    if (summary.unverified.length > 0) {
      console.log(`Unverified after seeding: ${summary.unverified.join(", ")}`);
    }
  }

  if (!summary.ok) {
    process.exitCode = 1;
  }
}

function sendWarmup(sessionName: string | null, text: string): void {
  if (!sessionName) {
    throw new Error("Cannot seed a node without a canonical session name.");
  }

  execFileSync(
    "rigged",
    ["send", sessionName, text, "--verify", "--force", "--json"],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );
}

function buildWarmupPrompt(logicalId: string, round: number): string {
  if (round === 1) {
    return `Baseline warmup 1/6 for ${logicalId}. Reply in exactly one line: ACK ${logicalId} 1`;
  }
  if (round === 2) {
    return `Baseline warmup 2/6 for ${logicalId}. Reply in exactly one line: ACK ${logicalId} 2`;
  }
  if (round === 3) {
    return `Baseline warmup 3/6 for ${logicalId}. In one short sentence, state your role in this demo rig.`;
  }
  if (round === 4) {
    return `Baseline warmup 4/6 for ${logicalId}. In one short sentence, state the repository you are operating in.`;
  }
  return `Baseline warmup ${round}/6 for ${logicalId}. Reply in exactly one line: ACK ${logicalId} ${round}`;
}

await main();
