import fs from "node:fs";
import path from "node:path";

/** What Claude Code ranks above `CLAUDE_CODE_OAUTH_TOKEN` (https://code.claude.com/docs/en/authentication, "Authentication
 *  precedence"): a cloud provider, then `ANTHROPIC_AUTH_TOKEN`, then `ANTHROPIC_API_KEY`, then an `apiKeyHelper`. Any of
 *  them would bill a different source than the seat's own subscription token. */
export const OUTRANKING_TOKEN_ENV = [
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
] as const;

/** Profile and federation selectors outrank stored login, but not an explicit subscription token. */
export const ANTHROPIC_PROFILE_ENV = ["ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"] as const;

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

/** Match the bounded profile-fingerprint read: a FIFO cannot hold the open, and only a regular file up to 1 MiB is read.
 * Kept synchronous because launch assertions must finish before native input is dispatched. */
function readCredentialSettings(file: string): string {
  const maxBytes = 1024 * 1024;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Unusable credential settings file");
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) return buffer.subarray(0, length).toString("utf8");
      length += count;
      if (length > maxBytes) throw new Error("Credential settings file exceeds limit");
    }
  } finally { fs.closeSync(fd); }
}

/** One settings file's `apiKeyHelper` and outranking `env` entries, and with `storedLogin` its `env` block's
 *  `CLAUDE_CODE_OAUTH_TOKEN`. An absent file has none. */
export function settingsFileConflicts(file: string, scope: string, read: (file: string) => string = readCredentialSettings,
  opts: { storedLogin?: boolean; apiKey?: boolean; isolatedAccountHome?: boolean; profileSelectorsOnly?: boolean } = {}): { conflicts: CredentialConflict[]; instead?: CredentialConflict[]; checked?: string; notChecked?: string } {
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
  if (!opts.profileSelectorsOnly && !opts.apiKey && settings?.apiKeyHelper !== undefined) conflicts.push({ name: "apiKeyHelper", source: `${scope} settings ${file}`, remedy });
  const env = settings?.env && typeof settings.env === "object" ? settings.env as Record<string, unknown> : {};
  const names = opts.apiKey ? [...OUTRANKING_TOKEN_ENV, "ANTHROPIC_BASE_URL"] : opts.profileSelectorsOnly ? ANTHROPIC_PROFILE_ENV
    : [...OUTRANKING_TOKEN_ENV, ...(opts.isolatedAccountHome ? ["ANTHROPIC_BASE_URL", ...ANTHROPIC_PROFILE_ENV] : [])];
  for (const name of names) {
    if (env[name] !== undefined) conflicts.push({ name, source: `the env block of ${scope} settings ${file}`, remedy });
  }
  const instead = opts.storedLogin && !opts.profileSelectorsOnly && env.CLAUDE_CODE_OAUTH_TOKEN !== undefined
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

/** An isolated home may own an API helper, but project settings must not choose another account. A selected token also
 *  requires its home not to contain a helper or env that would outrank that token. Only names are reported. */
export function isolatedClaudeAccountProblem(home: string, cwd: string, selectedToken: boolean, apiKey = false): string | null {
  const root = projectRootForLocalSettings(cwd) ?? cwd;
  const files = [
    path.join(home, "settings.json"),
    ...new Set([root, cwd].flatMap(dir => [path.join(dir, ".claude/settings.json"), path.join(dir, ".claude/settings.local.json")])),
  ];
  for (const file of files) {
    const check = settingsFileConflicts(file, "account or project", undefined, { storedLogin: !apiKey, isolatedAccountHome: true, apiKey,
      profileSelectorsOnly: file === path.join(home, "settings.json") && !selectedToken });
    if (check.conflicts.length || check.instead?.length || check.notChecked) {
      return "Claude credential settings could override the selected account home or token; remove those settings or make them readable before switching. Nothing changed.";
    }
  }
  return null;
}
