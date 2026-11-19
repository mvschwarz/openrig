import { resolveWindowsCommand } from "@openrig/daemon/windows-launch";
import { readPlatformEnv } from "../lib/codex-auth.js";
export function resolveAcpAgentCommand(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command, prefix: [] };
  const selected = resolveWindowsCommand([command], readPlatformEnv(env, "PATH") ?? "", readPlatformEnv(env, "PATHEXT"), cwd);
  return { command: selected[0]!, prefix: selected.slice(1) };
}
