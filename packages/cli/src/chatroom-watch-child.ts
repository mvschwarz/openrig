import { fileURLToPath } from "node:url";

// Set instance selection before the CLI imports its home-dependent state.
const [home, url, rig] = process.argv.slice(2);
if (!home || !url || rig === undefined) throw new Error("Missing watcher instance binding");
for (const key of Object.keys(process.env)) {
  if (["OPENRIG_HOME", "RIGGED_HOME", "OPENRIG_URL", "RIGGED_URL"].includes(key.toUpperCase())) delete process.env[key];
}
process.env.OPENRIG_HOME = home;
process.env.OPENRIG_URL = url;
const entry = fileURLToPath(new URL("./index.js", import.meta.url));
process.argv = [process.execPath, entry, "chatroom", "watch", "--", rig];
await import("./index.js");
