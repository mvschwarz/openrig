// The detached connector `rig exec run` starts, over the test's file queue instead of the daemon.
import { runExecConnector } from "../../src/commands/exec.js";
import { fileQueue } from "./exec-file-queue.js";

process.exitCode = await runExecConnector(process.argv[2]!, fileQueue(process.env.EXEC_QUEUE_FILE!));
