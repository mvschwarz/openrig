import fs from "node:fs";
import path from "node:path";
import type { TerminalServiceDeps } from "../packages/daemon/src/domain/terminal/terminal-service.js";

type Root = { dev: number; ino: number; previous: Record<string, string | undefined> };
const privateRoots = new Map<string, Root>();
let cleanupInstalled = false;
const envKeys = ["TMUX_TMPDIR", "TMUX", "TMUX_PANE"] as const;

function sameRoot(root: string, identity: Root): boolean {
  try {
    const stat = fs.lstatSync(root);
    return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino;
  } catch { return false; }
}

/** Keep this scope alive until its own real servers have been cleaned up. */
export function beginPrivateTerminalTmux(base: string): string {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(base), "t-"));
  const stat = fs.lstatSync(root);
  privateRoots.set(root, { dev: stat.dev, ino: stat.ino,
    previous: Object.fromEntries(envKeys.map(key => [key, process.env[key]])) });
  if (!cleanupInstalled) {
    cleanupInstalled = true;
    const cleanup = () => { for (const owned of [...privateRoots.keys()].reverse()) endPrivateTerminalTmux(owned); };
    process.once("exit", cleanup);
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      process.once(signal, () => { cleanup(); process.kill(process.pid, signal); });
    }
  }
  process.env["TMUX_TMPDIR"] = root;
  delete process.env["TMUX"]; delete process.env["TMUX_PANE"];
  return root;
}

export function endPrivateTerminalTmux(root: string): void {
  const identity = privateRoots.get(root);
  if (!identity) return;
  privateRoots.delete(root);
  // A replacement directory or symlink is not ours to remove.
  if (sameRoot(root, identity)) fs.rmSync(root, { recursive: true, force: true });
  if (process.env["TMUX_TMPDIR"] === root) {
    for (const key of envKeys) {
      const previous = identity.previous[key];
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
  }
}

function privatePath(value: string): boolean {
  // Resolving link/../socket before lstat can hide the link. Reject raw parents first.
  if (!path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    || value.split(/[\\/]/).some(part => part === "." || part === "..")
    || path.normalize(value) !== value) return false;
  for (const [root, identity] of [...privateRoots].sort((a, b) => b[0].length - a[0].length)) {
    if (!value.startsWith(root + path.sep)) continue;
    if (!sameRoot(root, identity)) return false;
    let current = root;
    const parts = value.slice(root.length + 1).split(path.sep);
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) return false;
      } catch (error) {
        // The private socket or its tmux-UID directory can be absent before startup.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        return false;
      }
    }
    return true;
  }
  return false;
}

/** No selector precedence is assumed. Every possible selected path must be private. */
export function assertPrivateTerminalTmux(args: readonly string[], env: NodeJS.ProcessEnv): void {
  const reject = (): never => { throw new Error("Unisolated terminal tmux access: inject one registered private endpoint."); };
  let selected: { flag: string; value: string } | undefined;
  let config = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[++index];
    if (!value || /[\x00-\x1f\x7f]/.test(value)) reject();
    if (flag === "-S" || flag === "-L") {
      if (selected) reject();
      selected = { flag, value: value! };
    } else if (flag === "-f" && !config && value === "/dev/null") config = true;
    else reject();
  }
  const inherited = env["TMUX"];
  let inheritedPath: string | undefined;
  if (inherited) {
    const match = /^([^,]+),\d+,\d+$/.exec(inherited);
    if (!match || !privatePath(match[1]!)) reject();
    inheritedPath = match![1];
  }
  if (selected?.flag === "-S") {
    if (!privatePath(selected.value)) reject();
    return;
  }
  const root = env["TMUX_TMPDIR"];
  const identity = root ? privateRoots.get(root) : undefined;
  if (!root || !identity || !sameRoot(root, identity)) reject();
  if (selected && !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(selected.value)) reject();
  if (!selected && inheritedPath) return;
  const uid = process.getuid?.();
  if (uid === undefined || !privatePath(path.join(root!, `tmux-${uid}`, selected?.value ?? "default"))) reject();
}

/** Herdr-only tests inject an explicit private empty inventory, with no native fallback. */
export function privateTerminalTmuxDeps(): Pick<TerminalServiceDeps, "tmuxServerArgs" | "tmuxExec"> {
  const root = process.env["TMUX_TMPDIR"];
  if (!root || !privatePath(path.join(root, "unused.sock"))) throw new Error("No private terminal tmux test scope.");
  return { tmuxServerArgs: () => ["-S", path.join(root, "unused.sock")], tmuxExec: async () => "" };
}

export function privateTerminalTmuxEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  assertPrivateTerminalTmux([], env);
  delete env["TMUX"]; delete env["TMUX_PANE"];
  return env;
}
