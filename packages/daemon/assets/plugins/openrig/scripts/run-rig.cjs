#!/usr/bin/env node
// Starts the openrig plugin's MCP server in Claude Code: `node run-rig.cjs mcp serve --front-door` runs the `rig` the
// plugin's hooks run (sessionRig in the hook bridge: OPENRIG_RIG_BIN, else `rig` on PATH, else the project's own
// node_modules/.bin/rig, else the first `rig` on a login shell's PATH, run with that PATH) with the same arguments, on this
// process's stdio, and exits with its status. So an OpenRig installed only inside the project serves too, and so does one
// whose folder only a login shell's PATH has, such as one installed after the app started. With no `rig` to run, it prints
// one line to stderr, which Claude Code logs as the server's stderr, and exits 1.
"use strict";
const { sessionRig } = require("../hooks/scripts/claude-hook-bridge.cjs");

const FAILED = "openrig plugin: OpenRig's MCP server can't start:";

function launch(args, { env = process.env, spawnSync = require("node:child_process").spawnSync, stderr = process.stderr, loginPath } = {}) {
  const rig = sessionRig(env, undefined, loginPath);
  if (!rig) {
    stderr.write(`${FAILED} no \`rig\` found (OPENRIG_RIG_BIN doesn't name one, there's none on PATH or on a login shell's PATH, `
      + "and none in this project's node_modules/.bin). Install OpenRig where every session finds it (npm install -g "
      + "@openrig/cli), with npm's global bin folder on PATH in the shell's login profile, such as ~/.zprofile, or set "
      + "OPENRIG_RIG_BIN to the full path of `rig`.\n");
    return 1;
  }
  // As rig's own bin wrapper re-runs itself: the child has the MCP pipe as its stdio, and its status comes back.
  const result = spawnSync(rig.bin, args, { stdio: "inherit", env: rig.env });
  if (result.error) {
    stderr.write(`${FAILED} ${rig.bin} couldn't be run (${result.error.code ?? result.error.message}).\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (require.main === module) process.exitCode = launch(process.argv.slice(2));
module.exports = { launch };
