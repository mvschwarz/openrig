"use strict";
const { spawnSync } = require("node:child_process");

function spawnPython(args, options = {}) {
  const env = options.env ?? process.env;
  const pythonKey = process.platform === "win32" ? Object.keys(env).sort().find(key => key.toUpperCase() === "PYTHON") : "PYTHON";
  const python = pythonKey === undefined ? undefined : env[pythonKey];
  const choices = python ? [[python, []]] : process.platform === "win32"
    ? [["py", ["-3"]], ["python3", []], ["python", []]] : [["python3", []]];
  const started = Date.now();
  let result;
  for (const [command, prefix] of choices) {
    const timeout = options.timeout === undefined ? undefined : options.timeout - (Date.now() - started);
    if (timeout !== undefined && timeout <= 0) return { error: new Error("no time left in the refocus budget"), status: null, stdout: "", stderr: "" };
    result = spawnSync(command, [...prefix, ...args], { ...options, ...(timeout === undefined ? {} : { timeout }), windowsHide: true });
    if (python || result.error?.code !== "ENOENT") return result;
  }
  return result;
}

module.exports = { spawnPython };
