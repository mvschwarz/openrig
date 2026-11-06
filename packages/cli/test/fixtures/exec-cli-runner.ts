// One `rig exec …` invocation in its own process, which then exits as the CLI does, over the test's file queue.
import { fileURLToPath } from "node:url";
import { execCommand } from "../../src/commands/exec.js";
import { fileQueue } from "./exec-file-queue.js";

const entry = fileURLToPath(new URL("./exec-connector-entry.ts", import.meta.url));
const queue = fileQueue(process.env.EXEC_QUEUE_FILE!);
await execCommand({
  queue: async () => queue,
  connectorCommand: (runId) => [process.execPath, "--import", "tsx", entry, runId],
  pollMs: 100,
  startWaitMs: 20_000,
}).parseAsync(["node", "rig", ...process.argv.slice(2)]);
