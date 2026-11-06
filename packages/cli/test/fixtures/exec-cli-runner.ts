// One `rig exec …` invocation in its own process, which then exits as the CLI does, over the test's file queue.
// EXEC_TEST_CONNECTOR=die starts a connector that exits before recording itself; =instant one that records a completed
// outcome before the CLI's first look. EXEC_TEST_WINNER=<outcome> has another caller claim the row, with a run that
// ended with that outcome, between this caller's claim read and its publish.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { claimRow, execCommand } from "../../src/commands/exec.js";
import { fileQueue } from "./exec-file-queue.js";

const entry = fileURLToPath(new URL("./exec-connector-entry.ts", import.meta.url));
const instant = fileURLToPath(new URL("./exec-instant-connector.ts", import.meta.url));
const queue = fileQueue(process.env.EXEC_QUEUE_FILE!);
const connector = process.env.EXEC_TEST_CONNECTOR;
const winner = process.env.EXEC_TEST_WINNER;
await execCommand({
  queue: async () => queue,
  connectorCommand: (runId) => connector === "die" ? [process.execPath, "-e", "process.exit(3)"]
    : [process.execPath, "--import", "tsx", connector === "instant" ? instant : entry, runId],
  pollMs: 100,
  startWaitMs: 20_000,
  beforeClaim: winner ? () => {
    const runs = join(process.env.OPENRIG_HOME!, "acp", "runs");
    writeFileSync(join(runs, "exec-winner.json"), JSON.stringify({
      runId: "exec-winner", qitemId: "qitem-task", harness: "claude", agent: ["claude-agent-acp"], cwd: runs, self: "builder@studio",
      pollMs: 1000, native: "x", state: "finished", pid: 1, requestedAt: "2026-11-06T00:00:00Z", endedAt: "2026-11-06T00:00:05Z",
      outcome: winner, summary: `the winner's run ended ${winner}`, transcript: join(runs, "exec-winner.jsonl"), connectorLog: join(runs, "exec-winner.connector.log"),
    }));
    claimRow("qitem-task", "exec-winner");
  } : undefined,
}).parseAsync(["node", "rig", ...process.argv.slice(2)]);
