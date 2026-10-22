// Runs as a child of probe-groups-on-stop.test.ts: a daemon that is still starting (no shutdown handlers yet)
// with a hung runtime probe, whose own SIGTERM the test then sends.
import { boundedProbeExec, endProbeGroupsOnStartupSignal } from "../../src/adapters/bounded-probe-exec.js";

const pidFile = process.argv[2]!;
endProbeGroupsOnStartupSignal();
void boundedProbeExec()(`sleep 600 & echo $! > ${pidFile}; wait`).catch(() => {});
console.log("ready");
setInterval(() => {}, 1000);
