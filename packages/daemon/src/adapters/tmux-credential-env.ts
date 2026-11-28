import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { defaultHostRegistryPath } from "../domain/hosts/hosts-registry-reader.js";

/** Environment names whose values grant authority or access; never inherit them from a tmux server. */
export const TMUX_CREDENTIAL_ENV_KEYS = [
  "OPENRIG_ACTIVITY_HOOK_TOKEN",
  "RIGGED_ACTIVITY_HOOK_TOKEN",
  "OPENRIG_AUTH_BEARER_TOKEN",
  "OPENRIG_TERMINAL_BEARER_TOKEN",
  "OPENRIG_RELAY_INBOUND_TOKEN",
  "OPENRIG_RELAY_OUTBOUND_TOKEN",
  // The Slack connector's tokens, under both names resolveSecret reads (gateway/slack/secrets.ts).
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENRIG_SLACK_BOT_TOKEN",
  "OPENRIG_SLACK_APP_TOKEN",
  // The notification target is an ntfy topic or webhook URL: whoever holds it can post as the daemon.
  "OPENRIG_NOTIFICATIONS_TARGET",
] as const;

const credentialEnvKeys: ReadonlySet<string> = new Set(TMUX_CREDENTIAL_ENV_KEYS);

/** The bearer_env names the host registry (hosts.yaml) configures: the variables the daemon reads its cross-host
 *  bearers from. Read at call time, from every entry that names one, so an entry the registry's validation would
 *  reject (another host's error, an edit in progress) still keeps its name out; a file that is absent or does not
 *  parse names none. */
export function hostRegistryBearerEnvKeys(path: string = defaultHostRegistryPath()): ReadonlySet<string> {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf-8"));
  } catch {
    return new Set();
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  if (!Array.isArray(hosts)) return new Set();
  return new Set(hosts.flatMap(host => {
    const name = (host as { bearer_env?: unknown } | null)?.bearer_env;
    return typeof name === "string" && name.trim() !== "" ? [name] : [];
  }));
}

/** Whether `key` names one of the daemon's credentials. The host registry's bearer_env names are read (one file read
 *  and parse) only when the fixed names don't match: to check a whole environment, use withoutTmuxCredentialEnv, which
 *  reads them once. */
export function isTmuxCredentialEnvKey(key: string, bearerEnvKeys?: ReadonlySet<string>): boolean {
  return credentialEnvKeys.has(key) || key.startsWith("OPENRIG_RUN_GRANT_")
    || (bearerEnvKeys ?? hostRegistryBearerEnvKeys()).has(key);
}

/** A copy of `env` without the daemon's credentials (every name isTmuxCredentialEnvKey matches), with the host
 *  registry's bearer_env names read once for the whole environment. */
export function withoutTmuxCredentialEnv<T extends Record<string, string | undefined>>(env: T): Partial<T> {
  const bearerEnvKeys = hostRegistryBearerEnvKeys();
  const kept: Partial<T> = { ...env };
  for (const key of Object.keys(kept)) if (isTmuxCredentialEnvKey(key, bearerEnvKeys)) delete kept[key];
  return kept;
}
