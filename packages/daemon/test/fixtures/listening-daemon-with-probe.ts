// Runs as a child of probe-groups-on-stop.test.ts: the real startServer, listening, with a hung runtime probe
// running in it (as a preflight during a `rig up` would be). The test then sends it SIGTERM.
import { once } from "node:events";
import { boundedProbeExec } from "../../src/adapters/bounded-probe-exec.js";
import { startServer } from "../../src/index.js";

const pidFile = process.argv[2]!;
const termMarker = process.argv[3]!;
const listeners = () => ({ SIGINT: process.listenerCount("SIGINT"), SIGTERM: process.listenerCount("SIGTERM") });
const before = listeners();
const server = await startServer(0);
if (!server.listening) await once(server, "listening");
// The probe notes the TERM the shutdown phase sends first; the exit hook's KILL would leave no note.
void boundedProbeExec()(`trap 'touch ${termMarker}' TERM; sleep 600 & echo $! > ${pidFile}; wait`).catch(() => {});
const after = listeners();
// Once listening, the shutdown handlers are the only ones startServer added: the startup handlers are gone.
console.log(JSON.stringify({ addedSIGINT: after.SIGINT - before.SIGINT, addedSIGTERM: after.SIGTERM - before.SIGTERM }));
console.log("ready");
