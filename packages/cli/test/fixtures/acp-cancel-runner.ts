import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { watchCancelRequest } from "../../src/acp/cancel-request.js";
import { processStart } from "../../src/commands/acp.js";
import { runAcpAssignment, type AcpQueue } from "../../src/acp/connector.js";

const home = process.argv[2]!;
let cancel!: () => void;
const cancelRequested = new Promise<void>((resolve) => { cancel = resolve; });
const stop = watchCancelRequest(join(home, "acp/runs/acp-live.cancel.json"), processStart(process.pid), cancel);
const queue: AcpQueue = {
  show: async () => ({ qitemId: "qitem-x", state: "in-progress", destinationSession: "fixture@test", body: "scenario:slow" }),
  claim: async () => {}, update: async () => {}, create: async () => "unused",
};
writeFileSync(join(home, "ready"), "ready");
try {
  const outcome = await runAcpAssignment(queue, {
    qitemId: "qitem-x", self: "fixture@test", runId: `cancel-fixture-${process.pid}`, cwd: home,
    agent: [process.execPath, fileURLToPath(new URL("./fake-acp-agent.mjs", import.meta.url))],
    logPath: join(home, "run.jsonl"), cancelRequested,
  });
  writeFileSync(join(home, "outcome.json"), JSON.stringify(outcome));
} finally { stop(); }
