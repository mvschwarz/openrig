/** Environment names whose values grant authority or access; never inherit them from a tmux server. */
export const TMUX_CREDENTIAL_ENV_KEYS = [
  "OPENRIG_ACTIVITY_HOOK_TOKEN",
  "RIGGED_ACTIVITY_HOOK_TOKEN",
  "OPENRIG_AUTH_BEARER_TOKEN",
  "OPENRIG_TERMINAL_BEARER_TOKEN",
  "OPENRIG_RELAY_INBOUND_TOKEN",
  "OPENRIG_RELAY_OUTBOUND_TOKEN",
] as const;

const credentialEnvKeys: ReadonlySet<string> = new Set(TMUX_CREDENTIAL_ENV_KEYS);

export function isTmuxCredentialEnvKey(key: string): boolean {
  return credentialEnvKeys.has(key) || key.startsWith("OPENRIG_RUN_GRANT_");
}
