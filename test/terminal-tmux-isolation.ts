import fs from "node:fs";
import path from "node:path";
import type { TerminalServiceDeps } from "../packages/daemon/src/domain/terminal/terminal-service.js";

// Only roots created by the test setup grant access. An arbitrary /tmp path does not.
const privateRoots = new Set<string>();

export function beginPrivateTerminalTmux(base: string): string {
  const root = fs.mkdtempSync(path.join(base, "t-"));
  privateRoots.add(path.resolve(root));
  process.env["TMUX_TMPDIR"] = root;
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  return root;
}

function privatePath(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  const target = path.resolve(value);
  for (const root of privateRoots) {
    const relative = path.relative(root, target);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
    // Reject symlink escapes without looking up any socket outside our own root.
    let part = root;
    for (const component of relative.split(path.sep)) {
      part = path.join(part, component);
      try { if (fs.lstatSync(part).isSymbolicLink()) return false; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    return true;
  }
  return false;
}

/** Validate selection before the real TerminalService can reach either executor. */
export function assertPrivateTerminalTmux(args: readonly string[], env: NodeJS.ProcessEnv): void {
  let selected: { flag: "-L" | "-S"; value: string } | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "-L" || flag === "-S") {
      const value = args[++index];
      if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Unisolated terminal tmux access: invalid selector.");
      selected = { flag, value };
    } else if (flag === "-f") index++;
    else throw new Error("Unisolated terminal tmux access: unknown server arguments.");
  }
  if (selected?.flag === "-S") {
    if (privatePath(selected.value)) return;
  } else {
    const root = env["TMUX_TMPDIR"];
    if (root && privateRoots.has(path.resolve(root))) {
      if (selected?.flag === "-L" && /^[A-Za-z0-9_.-]+$/.test(selected.value)) return;
      if (!selected && !env["TMUX"]) return;
      if (!selected && env["TMUX"] && privatePath(env["TMUX"].replace(/,\d+,\d+$/, ""))) return;
    }
  }
  throw new Error("Unisolated terminal tmux access: inject a registered private socket or private TMUX_TMPDIR.");
}

/** Herdr-only tests have an explicit empty private tmux inventory, never a host fallback. */
export function privateTerminalTmuxDeps(): Pick<TerminalServiceDeps, "tmuxServerArgs" | "tmuxExec"> {
  const root = process.env["TMUX_TMPDIR"];
  if (!root || !privateRoots.has(path.resolve(root))) throw new Error("No private terminal tmux test scope.");
  return { tmuxServerArgs: () => ["-S", path.join(root, "unused.sock")], tmuxExec: async () => "" };
}

export function privateTerminalTmuxEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  assertPrivateTerminalTmux([], env);
  delete env["TMUX"];
  delete env["TMUX_PANE"];
  return env;
}
