import { dirname, join } from "node:path";

/** Native Windows spawn cannot execute npm.cmd. Keep npm arguments out of a
 * command shell by running the current npm CLI with this Node executable. */
export function npmCommand(args, { platform = process.platform, env = process.env, node = process.execPath } = {}) {
  if (platform !== "win32") return ["npm", args];
  const cli = env.npm_execpath ?? join(dirname(node), "node_modules/npm/bin/npm-cli.js");
  return [node, [cli, ...args]];
}
