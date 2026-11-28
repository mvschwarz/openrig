import { readFileSync, statSync } from "node:fs";
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

/** Names a process relies on to start, which a bearer_env typo must never take from every tmux client. */
const NEVER_BEARER_ENV_KEYS: ReadonlySet<string> = new Set(["PATH", "HOME", "SHELL", "TMUX_TMPDIR"]);

/** The last registry read: its path, the file's identity and the names it gave. */
let lastRegistryRead: { path: string; stamp: string; names: ReadonlySet<string> } | undefined;

/** The file's device, inode, size, modified and changed times, or null when it can't be stat'ed. */
function registryStamp(path: string): string | null {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
  } catch {
    return null;
  }
}

/** The bearer_env names the host registry (hosts.yaml) configures: the variables the daemon reads its cross-host
 *  bearers from. Taken from every entry that names one, so an entry the registry's validation would reject (another
 *  host's error, an edit in progress) still keeps its name out; a file that is absent or does not parse names none,
 *  and PATH, HOME, SHELL and TMUX_TMPDIR are never taken. The parsed names are reused until the file's device, inode,
 *  size, modified or changed time changes; a read that fails (EMFILE, EIO…) is not kept, so the next call reads the
 *  file again. */
export function hostRegistryBearerEnvKeys(path: string = defaultHostRegistryPath()): ReadonlySet<string> {
  const stamp = registryStamp(path);
  if (stamp === null) return new Set();
  if (lastRegistryRead && lastRegistryRead.path === path && lastRegistryRead.stamp === stamp) return lastRegistryRead.names;
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    parsed = null;
  }
  const hosts = (parsed as { hosts?: unknown } | null)?.hosts;
  const names: ReadonlySet<string> = new Set(Array.isArray(hosts) ? hosts.flatMap(host => {
    const name = (host as { bearer_env?: unknown } | null)?.bearer_env;
    return typeof name === "string" && name.trim() !== "" && !NEVER_BEARER_ENV_KEYS.has(name) ? [name] : [];
  }) : []);
  lastRegistryRead = { path, stamp, names };
  return names;
}

/** Whether `key` names one of the daemon's credentials. The host registry's bearer_env names are looked up (a stat of
 *  hosts.yaml, and a read and parse when it changed) only when the fixed names don't match: to check a whole
 *  environment, use withoutTmuxCredentialEnv, which looks them up once. */
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
