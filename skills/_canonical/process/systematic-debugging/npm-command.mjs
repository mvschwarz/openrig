import { statSync, realpathSync } from "node:fs";
import { dirname, join, delimiter } from "node:path";
export function locateNpmCli({ env = process.env, node = process.execPath } = {}) {
  const get = name => env[name] ?? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1];
  const candidates = [get("npm_execpath"), join(dirname(node), "node_modules/npm/bin/npm-cli.js"), ...(get("PATH") ?? "").split(delimiter).filter(Boolean).map(dir => join(dir.replace(/^"(.*)"$/, "$1"), "node_modules/npm/bin/npm-cli.js"))];
  for (const file of candidates) { if (!file) continue; try { if (statSync(file).isFile()) return realpathSync(file); } catch {} }
  throw Object.assign(new Error("Missing prerequisite: npm. Install Node.js 22 or 24 with npm, then retry."), { status: 127, code: "ENOENT" });
}
export function npmCommand(args, { platform = process.platform, env = process.env, node = process.execPath } = {}) {
  return platform === "win32" ? [node, [locateNpmCli({env,node}), ...args]] : ["npm", args];
}
