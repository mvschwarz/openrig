import { readPlatformEnv } from "./platform-env.js";

// Identity of the Claude Code session, Herdr pane or Rex block that started the daemon.
// The daemon starts the tmux server, so anything left here reaches every seat.
// Named variables, never prefixes: CLAUDE_CODE_* also carries user configuration
// (for example CLAUDE_CODE_USE_BEDROCK) that seats must keep.
export const PARENT_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_STARTUP_CWD",
  "REX_SESSION",
  "REX_BLOCK",
] as const;

/** The parent-session names present in `env`. CLAUDE_EFFORT is user
 * configuration unless CLAUDECODE shows a parent Claude Code session set it. */
export function parentSessionEnvKeys(env: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string[] {
  const keys: string[] = [...PARENT_SESSION_ENV_KEYS];
  if (readPlatformEnv(env, "CLAUDECODE", platform)) keys.push("CLAUDE_EFFORT");
  if (platform === "win32") {
    const names = new Set(keys);
    return Object.keys(env).filter(key => names.has(key.toUpperCase()));
  }
  return keys.filter((key) => key in env);
}

/** Remove the parent session's identity from `env` in place; nothing else is
 * set or changed. Returns the removed names. */
export function removeParentSessionEnv(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string[] {
  const removed = parentSessionEnvKeys(env, platform);
  for (const key of removed) delete env[key];
  return removed;
}
