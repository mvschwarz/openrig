// Slice-11 slack-connector — secret resolution (item 7 + 10).
//
// Secrets (Slack bot token / app-level token / incoming-webhook URL) resolve
// from EITHER an OPENRIG_SLACK_* environment variable OR a 0600 env file, at
// call time — NEVER stored in the connector config file, NEVER in the repo,
// NEVER logged. Mirrors the daemon's bearer_file/activity-hook-token posture.
// The env file lives on the TRUSTED host (item 10 secret-host axis); it may be
// a different host from the queue/alert host.
import fs from "node:fs";

export interface SecretFsOps {
  readFileSync(p: string): string;
  statMode(p: string): number | null; // octal perm bits, or null if absent
}

export const nodeSecretFs: SecretFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  statMode: (p) => {
    try {
      return fs.statSync(p).mode & 0o777;
    } catch {
      return null;
    }
  },
};

/** Parse KEY=VALUE lines (quotes trimmed). Blank lines / #comments ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return out;
}

export interface SecretLookupOpts {
  envFile?: string; // path to the 0600 env file (optional)
  env?: NodeJS.ProcessEnv; // process env (default process.env)
  fsops?: SecretFsOps;
}

/** Warn if the env file is group/world readable (item 10 hygiene). Returns a warning string or null. */
export function checkEnvFilePermissions(envFile: string, fsops: SecretFsOps = nodeSecretFs): string | null {
  const mode = fsops.statMode(envFile);
  if (mode === null) return null; // absent — a separate "unconfigured" concern
  if (mode & 0o077) return `secret env file ${envFile} is mode ${mode.toString(8)} — should be 0600 (group/other must not read secrets)`;
  return null;
}

/**
 * Resolve a secret by logical name. Precedence: explicit env var (OPENRIG_SLACK_<NAME>
 * or the raw name) → env-file key. Returns null when unresolved (honest: callers
 * report "unconfigured", they do NOT fabricate). Never logs the value.
 */
export function resolveSecret(name: string, opts: SecretLookupOpts = {}): string | null {
  const env = opts.env ?? process.env;
  const fsops = opts.fsops ?? nodeSecretFs;
  // Aliases: the raw name (e.g. SLACK_WEBHOOK_URL) and the OPENRIG_-prefixed
  // form (OPENRIG_SLACK_WEBHOOK_URL). NOT OPENRIG_SLACK_<name> — that would
  // double the SLACK_ segment (the B4 defect).
  const envKeys = [name, `OPENRIG_${name.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`];
  for (const k of envKeys) {
    if (env[k]) return env[k]!;
  }
  if (opts.envFile) {
    try {
      const map = parseEnvFile(fsops.readFileSync(opts.envFile));
      if (map[name]) return map[name];
    } catch {
      /* absent/unreadable → null */
    }
  }
  return null;
}
