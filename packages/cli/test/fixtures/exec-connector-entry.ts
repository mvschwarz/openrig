// The detached connector `rig exec run` starts, over the test's file queue instead of the daemon.
// EXEC_TEST_HOOK puts a concurrent reconciler at one point in the connector's life, holding the copy of the run it read
// earlier and settling it as interrupted: after-guard (before the connector claims its start), after-start (after it
// has, still holding the requested copy), before-end (holding the started copy, before the connector records its end).
import { readRun, runExecConnector, settleRun, type ConnectorHooks, type ExecRun } from "../../src/commands/exec.js";
import { fileQueue } from "./exec-file-queue.js";

const runId = process.argv[2]!;
const queue = fileQueue(process.env.EXEC_QUEUE_FILE!);
const requested = readRun(runId);
const interrupt = async (label: string, stale: ExecRun | undefined) => {
  const settled = await settleRun(stale!, { state: "interrupted", outcome: "unknown", summary: `interrupted by a test reconciler ${label}`, endedAt: new Date().toISOString() },
    `test reconciler ${label} settled ${runId}`, async () => queue);
  console.error(`reconciler ${label}: ${settled.won ? "won" : "lost"}`);
};
const hook = process.env.EXEC_TEST_HOOK;
const hooks: ConnectorHooks = hook === "after-guard" ? { afterGuard: () => interrupt(hook, requested) }
  : hook === "after-start" ? { afterStart: () => interrupt(hook, requested) }
    : hook === "before-end" ? { beforeEnd: () => interrupt(hook, readRun(runId)) }
      : {};

process.exitCode = await runExecConnector(runId, queue, hooks);
