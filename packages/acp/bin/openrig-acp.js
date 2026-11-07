#!/usr/bin/env node
// OpenRig as an agent in ACP apps. The ACP registry starts an agent with `npx <package>@<version>`, and npx needs a
// package with one executable: @openrig/cli has two. This one starts `rig acp serve` from the @openrig/cli this package
// depends on, as Node resolves it (never a `rig` on the PATH), with the app's stdin and stdout, arguments, environment
// and working directory, and exits as it exits. Only ACP messages may reach stdout, so anything this file says goes to
// stderr.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

let rig;
try {
  const manifestPath = createRequire(import.meta.url).resolve("@openrig/cli/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  // Module resolution can reach a different @openrig/cli further up when this package's own copy is missing. That copy
  // most likely still works, and one that doesn't fails visibly, so say which version runs and run it.
  const wanted = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies["@openrig/cli"];
  if (manifest.version !== wanted) {
    console.error(`openrig-acp: found @openrig/cli ${manifest.version} at ${dirname(manifestPath)}, not the ${wanted} this package pins; running it anyway. Reinstall @openrig/acp to get ${wanted}.`);
  }
  rig = join(dirname(manifestPath), manifest.bin.rig);
} catch (error) {
  console.error(`openrig-acp: @openrig/cli isn't installed beside this package (${error.message}). Reinstall @openrig/acp.`);
  process.exit(1);
}

const child = spawn(process.execPath, [rig, "acp", "serve", ...process.argv.slice(2)], { stdio: "inherit" });
const forward = (signal) => child.kill(signal);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward);
child.on("error", (error) => {
  console.error(`openrig-acp: couldn't start rig acp serve: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    // End the same way the server did, so the app sees the signal rather than an exit code.
    process.removeListener(signal, forward);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
