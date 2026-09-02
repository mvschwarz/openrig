#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const rig = process.env.OPENRIG_RIG_BIN || "rig";

function probe(name, args, next) {
  const result = spawnSync(rig, args, { encoding: "utf8" });
  const stdout = result.stdout?.trim() || "";
  const stderr = result.stderr?.trim() || "";
  if (result.status === 0) {
    let value = stdout;
    try {
      value = JSON.parse(stdout);
    } catch {
      // Versions and older surfaces may intentionally return plain text.
    }
    return { name, ok: true, command: [rig, ...args], value };
  }
  return {
    name,
    ok: false,
    command: [rig, ...args],
    exitCode: result.status,
    error: stderr || stdout || result.error?.message || "command produced no diagnostic",
    next,
  };
}

const report = {
  schema: "openrig-upgrade-inspection/v1",
  generatedAt: new Date().toISOString(),
  rigVersion: probe("rigVersion", ["--version"], `run ${rig} --version directly and verify the installed wrapper`),
  daemonStatus: probe("daemonStatus", ["daemon", "status"], `run ${rig} daemon status and inspect daemon state and logs`),
  nodes: probe("nodes", ["ps", "--nodes", "--json"], `run ${rig} ps --nodes --json and resolve control-plane reachability before mutation`),
  plugins: probe("plugins", ["plugin", "list", "--json"], `run ${rig} plugin list --json and derive the installed plugin roots before refresh`),
};

report.ready = [report.rigVersion, report.daemonStatus, report.nodes, report.plugins].every((item) => item.ok);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
