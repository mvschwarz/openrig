import fs from "node:fs";
import path from "node:path";

/** What Claude Code ranks above `CLAUDE_CODE_OAUTH_TOKEN` (https://code.claude.com/docs/en/authentication, "Authentication
 *  precedence"): a cloud provider, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then an `apiKeyHelper`. Any of
 *  them would bill a different source than the seat's own subscription token. */
export const OUTRANKING_TOKEN_ENV = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
] as const;

export interface CredentialConflict {
  name: string;
  source: string;
  /** What removes it for this seat. OpenRig changes no owner configuration to make a move pass. */
  remedy: string;
}

export interface CredentialPrecedence {
  conflicts: CredentialConflict[];
  /** Asked for a move back to the stored login: a `CLAUDE_CODE_OAUTH_TOKEN` the seat would still receive, which Claude Code
   *  uses ahead of the stored login. */
  instead?: CredentialConflict[];
  checked: string[];
  /** What the check couldn't read. The restarted seat's /status is the evidence for these. */
  notChecked: string[];
}

/** One settings file's `apiKeyHelper` and outranking `env` entries, and with `storedLogin` its `env` block's
 *  `CLAUDE_CODE_OAUTH_TOKEN`. An absent file has none. */
export function settingsFileConflicts(file: string, scope: string, read: (file: string) => string = (f) => fs.readFileSync(f, "utf8"),
  opts: { storedLogin?: boolean } = {}): { conflicts: CredentialConflict[]; instead?: CredentialConflict[]; checked?: string; notChecked?: string } {
  let text: string;
  try { text = read(file); } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { conflicts: [], checked: `${scope} settings ${file} (absent)` }
      : { conflicts: [], notChecked: `${scope} settings ${file} (unreadable)` };
  }
  let settings: { apiKeyHelper?: unknown; env?: unknown };
  try { settings = JSON.parse(text) as typeof settings; } catch { return { conflicts: [], notChecked: `${scope} settings ${file} (not valid JSON)` }; }
  const remedy = `remove it from ${file} (OpenRig doesn't edit settings files)`;
  const conflicts: CredentialConflict[] = [];
  if (settings?.apiKeyHelper !== undefined) conflicts.push({ name: "apiKeyHelper", source: `${scope} settings ${file}`, remedy });
  const env = settings?.env && typeof settings.env === "object" ? settings.env as Record<string, unknown> : {};
  for (const name of OUTRANKING_TOKEN_ENV) {
    if (env[name] !== undefined) conflicts.push({ name, source: `the env block of ${scope} settings ${file}`, remedy });
  }
  const instead = opts.storedLogin && env.CLAUDE_CODE_OAUTH_TOKEN !== undefined
    ? [{ name: "CLAUDE_CODE_OAUTH_TOKEN", source: `the env block of ${scope} settings ${file}`, remedy }] : [];
  return { conflicts, ...(instead.length ? { instead } : {}), checked: `${scope} settings ${file}` };
}

/** Where Claude Code reads a project's local settings: the git repository root, or the main checkout's root for a worktree
 *  (https://code.claude.com/docs/en/settings); null outside a repository. */
export function projectRootForLocalSettings(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | null = null;
    try { stat = fs.statSync(dotGit); } catch { /* not here */ }
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      const main = gitdir ? path.resolve(dir, gitdir).split(`${path.sep}.git${path.sep}worktrees${path.sep}`)[0] : undefined;
      return main && main !== path.resolve(dir, gitdir!) ? main : dir;
    }
    if (path.dirname(dir) === dir) return null;
  }
}
