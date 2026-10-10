// Identity of the Claude Code session or Herdr pane that started the daemon.
// The daemon starts the tmux server, so anything left here reaches every seat.
// Named variables, never prefixes: CLAUDE_CODE_* also carries user configuration
// (for example CLAUDE_CODE_USE_BEDROCK) that seats must keep.
export const PARENT_SESSION_ENV_KEYS = [
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
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
