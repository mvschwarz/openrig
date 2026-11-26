#!/usr/bin/env node
// Starts the openrig plugin's MCP server in Claude Code: `node run-rig.cjs mcp serve --front-door` runs the `rig` the
// plugin's hooks run (findRig in the hook bridge: OPENRIG_RIG_BIN, else `rig` on PATH, else the project's own
// node_modules/.bin/rig) with the same arguments, on this process's stdio, and exits with its status. So an OpenRig
// installed only inside the project serves too. With no `rig` to run, it prints one line to stderr, which Claude Code logs
// as the server's stderr, and exits 1.
"use strict";
const { findRig } = require("../hooks/scripts/claude-hook-bridge.cjs");

const FAILED = "openrig plugin: OpenRig's MCP server can't start:";

function launch(args, { env = process.env, spawnSync = require("node:child_process").spawnSync, stderr = process.stderr } = {}) {
  const bin = findRig({ env });
  if (!bin) {
    stderr.write(`${FAILED} no \`rig\` found (OPENRIG_RIG_BIN doesn't name one, there's none on PATH, and none in this project's `
      + "node_modules/.bin). Install OpenRig where every session finds it (npm install -g @openrig/cli), or set OPENRIG_RIG_BIN "
      + "to the full path of `rig`.\n");
    return 1;
  }
  // As rig's own bin wrapper re-runs itself: the child has the MCP pipe as its stdio, and its status comes back.
  const result = spawnSync(bin, args, { stdio: "inherit", env });
  if (result.error) {
    stderr.write(`${FAILED} ${bin} couldn't be run (${result.error.code ?? result.error.message}).\n`);
    return 1;
  }
  return result.status ?? 1;
}

if (require.main === module) process.exitCode = launch(process.argv.slice(2));
module.exports = { launch };
