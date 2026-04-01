import { listRigNodes, listRigSummaries, parseArgs, isAgentRuntime } from "./common.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rig = String(args["rig"] ?? "demo-rig");
  const json = args["json"] === true;

  const rigSummary = listRigSummaries().find((entry) => entry.name === rig) ?? null;
  const nodes = listRigNodes(rig);

  const summary = {
    rig,
    exists: Boolean(rigSummary),
    nodeCount: nodes.length,
    agentCount: nodes.filter((node) => isAgentRuntime(node.runtime)).length,
    startupReady: nodes.filter((node) => node.startupStatus === "ready").map((node) => node.logicalId),
    startupPending: nodes.filter((node) => node.startupStatus !== "ready").map((node) => ({
      logicalId: node.logicalId,
      startupStatus: node.startupStatus,
      restoreOutcome: node.restoreOutcome,
      latestError: node.latestError ?? null,
    })),
    resumeMetadata: nodes
      .filter((node) => isAgentRuntime(node.runtime))
      .map((node) => ({
        logicalId: node.logicalId,
        runtime: node.runtime,
        resumeType: node.resumeType ?? null,
        hasResumeToken: Boolean(node.resumeToken),
      })),
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Demo health: ${rig}`);
    console.log(`- exists: ${summary.exists ? "yes" : "no"}`);
    console.log(`- nodes: ${summary.nodeCount}`);
    console.log(`- ready: ${summary.startupReady.length}`);
    if (summary.startupPending.length > 0) {
      console.log("- pending/failed:");
      for (const item of summary.startupPending) {
        console.log(
          `  ${item.logicalId}: startup=${item.startupStatus ?? "n/a"} restore=${item.restoreOutcome ?? "n/a"}`
        );
        if (item.latestError) {
          console.log(`    error: ${item.latestError}`);
        }
      }
    }
    console.log("- resume metadata:");
    for (const item of summary.resumeMetadata) {
      console.log(
        `  ${item.logicalId} [${item.runtime}] type=${item.resumeType ?? "none"} token=${item.hasResumeToken ? "yes" : "no"}`
      );
    }
  }

  if (!summary.exists || summary.nodeCount === 0) {
    process.exitCode = 1;
  }
}

await main();
