// The herdr-core terminal a process was started in. When that terminal ends, core
// ends every process whose environment carries its HC_SCOPE, and their children
// (herdr-core sweep.rs). HC_SESSION and HC_SOCKET only select which core to talk
// to, so they stay. Core reads the environment a process was started with
// (/proc/<pid>/environ), so removing these from a running process protects only
// what it starts later: the CLI also leaves them out when it spawns the daemon.
export const HERDR_CORE_TERMINAL_ENV_KEYS = ["HC_SCOPE", "HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"] as const;

// Identity of the Claude Code session, Herdr pane, herdr-core terminal or Rex block that started the daemon.
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
  ...HERDR_CORE_TERMINAL_ENV_KEYS,
  "REX_SESSION",
  "REX_BLOCK",
] as const;

/** The parent-session names present in `env`. CLAUDE_EFFORT is user
 * configuration unless CLAUDECODE shows a parent Claude Code session set it. */
export function parentSessionEnvKeys(env: Readonly<Record<string, string | undefined>>): string[] {
  const keys: string[] = [...PARENT_SESSION_ENV_KEYS];
  if (env.CLAUDECODE) keys.push("CLAUDE_EFFORT");
  return keys.filter((key) => key in env);
}

/** Remove the parent session's identity from `env` in place; nothing else is
 * set or changed. Returns the removed names. */
export function removeParentSessionEnv(env: Record<string, string | undefined>): string[] {
  const removed = parentSessionEnvKeys(env);
  for (const key of removed) delete env[key];
  return removed;
}
