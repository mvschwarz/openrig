// Runs as a child of probe-groups-on-stop.test.ts: a process with a hung runtime probe that exits on its own
// (process.exit, as the shutdown timeout and a crash handler do), with no signal handler involved.
import { boundedProbeExec } from "../../src/adapters/bounded-probe-exec.js";

const pidFile = process.argv[2]!;
void boundedProbeExec()(`sleep 600 & echo $! > ${pidFile}; wait`).catch(() => {});
setTimeout(() => process.exit(0), 600);
