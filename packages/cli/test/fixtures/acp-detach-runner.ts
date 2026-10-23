// Runs one `rig acp` turn that detaches while the fake agent (FAKE_ACP_IGNORE_EOF) keeps running, then just returns.
// The process must end on its own, as `rig acp run` does; it prints the outcome and the pids the run reported.
import { runAcpAssignment, type AcpQueue } from "../../src/acp/connector.js";

const [agentScript, logPath] = process.argv.slice(2) as [string, string];
const notes: string[] = [];
const queue: AcpQueue = {
  show: async () => ({ qitemId: "qitem-detach", state: "in-progress", destinationSession: "runner@test", body: "scenario:hang" }),
  claim: async () => {},
  update: async (_id, change) => { notes.push(change.note); },
  create: async () => "qitem-unused",
};
const outcome = await runAcpAssignment(queue, {
  qitemId: "qitem-detach", agent: [process.execPath, agentScript], cwd: process.cwd(), self: "runner@test",
  runId: `acp-detach-${process.pid}`, logPath, detachRequested: new Promise((resolve) => setTimeout(resolve, 80)), exitWaitMs: 200,
});
const pids = /still run \(([\d, ]+)\)/.exec(notes.at(-1) ?? "")?.[1]?.split(", ").map(Number) ?? [];
console.log(JSON.stringify({ kind: outcome.kind, summary: outcome.summary, pids }));
