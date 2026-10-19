// Runs as a child of fixture-home-cleanup.test.ts: loads the shared vitest setup in a plain Node process,
// prints the homes it ended up with, and exits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "../../../../test/hermetic-env.setup.js";

// What a test does: make a temp dir the usual way, with os.tmpdir().
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "test-scratch-"));
fs.writeFileSync(path.join(scratch, "file"), "x");
console.log(JSON.stringify({ openrigHome: process.env["OPENRIG_HOME"], home: process.env["HOME"], tmpdir: os.tmpdir(), scratch }));
// With "wait", stay alive for the test to signal: a vitest worker is ended with SIGTERM while it is running.
if (process.argv[2] === "wait") setInterval(() => {}, 1000);
