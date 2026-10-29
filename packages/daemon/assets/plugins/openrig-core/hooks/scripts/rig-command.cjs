"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// npm's Windows cmd shim is not directly spawnable. Keep PATH order and invoke
// only its recognized OpenRig package entry, through this hook's Node, without a shell.
function resolveRigCommand(env = process.env, cwd = process.cwd()) {
  if (process.platform !== "win32") return { command: "rig", prefix: [] };
  for (const value of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    const dir = path.resolve(cwd, value.replace(/^"(.*)"$/, "$1"));
    for (const ext of [".com", ".exe", ".bat", ".cmd"]) {
      const candidate = path.join(dir, "rig" + ext);
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      if (ext === ".com" || ext === ".exe") return { command: fs.realpathSync(candidate), prefix: [] };
      if (ext !== ".cmd") throw new Error("Windows rig requires a native executable or recognized npm installation");
      const root = path.join(dir, "node_modules", "@openrig", "cli");
      const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.rig;
      if (manifest.name !== "@openrig/cli" || typeof entry !== "string" || path.isAbsolute(entry)) throw new Error("Unrecognized Windows rig npm entry");
      const file = path.resolve(root, entry), relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("rig npm entry escapes its package");
      const needle = "%dp0%\\node_modules\\@openrig\\cli\\" + entry.replaceAll("/", "\\");
      if (!fs.readFileSync(candidate, "utf8").includes(needle)) throw new Error("Unrecognized Windows rig shim");
      return { command: process.execPath, prefix: [fs.realpathSync(file)] };
    }
  }
  const error = new Error("No rig executable on the Windows launch PATH");
  error.code = "ENOENT";
  throw error;
}

function spawnRig(args, options = {}) {
  try {
    const selected = resolveRigCommand(options.env, options.cwd);
    return spawnSync(selected.command, [...selected.prefix, ...args], { ...options, windowsHide: true });
  } catch (error) {
    return { error, status: null, signal: null, stdout: "", stderr: "" };
  }
}

module.exports = { resolveRigCommand, spawnRig };
