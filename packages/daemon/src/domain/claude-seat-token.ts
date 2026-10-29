import { execPath } from "node:process";
import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { OUTRANKING_TOKEN_ENV, type CredentialConflict } from "./claude-credential-precedence.js";

// Read at launch through a private pipe, with fixed errors and a bounded non-blocking fd read.
const API_KEY_READER = `const fs=require('node:fs'); let fd; const data=Buffer.alloc(8193); try {
  fd=fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const st=fs.fstatSync(fd); if(!st.isFile() || ![0o400,0o600].includes(st.mode & 0o777) || st.size<1 || st.size>8192) process.exit(1);
  const n=fs.readSync(fd,data,0,data.length,null); const key=data.subarray(0,n).toString('utf8').trim();
  if(n>8192 || !/^[!-~]+$/.test(key)) process.exit(1); process.stdout.write(key);
} catch { process.exitCode=1; } finally { data.fill(0); if(fd!==undefined)fs.closeSync(fd); }`;

/** A Claude seat's own subscription or API credential: an operator label and an absolute token-file path. A reference only: the
 *  launch script reads the file when Claude starts, so the value never passes through OpenRig. The label is the
 *  operator's name for it, not an account the provider observed. */
export interface ClaudeSeatTokenRef {
  label: string;
  tokenFile: string;
  /** Omitted for existing subscription-token references. */
  kind?: "api-key";
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Why a label or token-file path can't be a seat's reference, or null when it can. */
export function claudeSeatTokenRefProblem(ref: ClaudeSeatTokenRef): string | null {
  if (!LABEL_RE.test(ref.label)) return "the label must start with a letter or digit, then use letters, digits, '.', '_', '@' or '-' (at most 64)";
  if (!path.isAbsolute(ref.tokenFile) || /[\0\n\r]/.test(ref.tokenFile)) return "the token file must be an absolute path on one line";
  return null;
}

/** A spec's `claude_token: { label, file }` as the seat's reference; it throws, naming `where`, when it can't be one. The
 *  file isn't read: a missing or unreadable one starts the seat with the usual fallback notice. */
export function specClaudeTokenRef(value: unknown, where: string): ClaudeSeatTokenRef {
  const fields = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!fields || typeof fields["label"] !== "string" || typeof fields["file"] !== "string"
    || Object.keys(fields).some((key) => key !== "label" && key !== "file")) {
    throw new Error(`${where}: must be { label, file }, the token file's label and absolute path`);
  }
  const ref = { label: fields["label"] as string, tokenFile: fields["file"] as string };
  const problem = claudeSeatTokenRefProblem(ref);
  if (problem) throw new Error(`${where}: ${problem}`);
  return ref;
}

/** The stored reference, or null when it's absent or unreadable. */
export function parseClaudeSeatTokenRef(value: unknown): ClaudeSeatTokenRef | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const { label, tokenFile, kind } = JSON.parse(value) as { label?: unknown; tokenFile?: unknown; kind?: unknown };
    if (kind !== undefined && kind !== "api-key") return null;
    if (typeof label !== "string" || typeof tokenFile !== "string") return null;
    return claudeSeatTokenRefProblem({ label, tokenFile }) === null ? { label, tokenFile, ...(kind === "api-key" ? { kind } : {}) } : null;
  } catch {
    return null;
  }
}

/** A seat's reference, read where a launch needs it; null before the column exists. */
export function readClaudeSeatTokenRef(db: Database.Database, nodeId: string): ClaudeSeatTokenRef | null {
  const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "claude_token_ref")) return null;
  const row = db.prepare("SELECT claude_token_ref AS ref FROM nodes WHERE id = ?").get(nodeId) as { ref?: unknown } | undefined;
  return parseClaudeSeatTokenRef(row?.ref);
}

/** Why the seat's token file won't give Claude its token at the next launch, or null when it's readable and not empty. It
 *  checks the file without reading its contents. */
export function claudeSeatTokenFileProblem(ref: ClaudeSeatTokenRef): string | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(ref.tokenFile); } catch { return `the token file ${ref.tokenFile} doesn't exist`; }
  if (!stat.isFile()) return `${ref.tokenFile} isn't a regular file`;
  if (ref.kind === "api-key" && (![0o400, 0o600].includes(stat.mode & 0o777) || stat.size > 8192)) return "the API-key file must be private (0600 or 0400) and at most 8192 bytes";
  if (stat.size === 0) return `the token file ${ref.tokenFile} is empty`;
  try { fs.accessSync(ref.tokenFile, fs.constants.R_OK); } catch { return `the token file ${ref.tokenFile} isn't readable by the daemon's user`; }
  return null;
}

/** What a launch that couldn't apply the seat's token says, wherever it's reported. */
export function claudeSeatTokenFallbackNotice(ref: ClaudeSeatTokenRef, problem: string): string {
  if (ref.kind === "api-key") return `This seat's Claude API key (${ref.label}) is unavailable: ${problem}. No Claude process will start; fix its file or switch back to a subscription.`;
  return `This seat's Claude subscription token (${ref.label}) wasn't applied: ${problem}. Claude started without it, on its config dir's `
    + "stored login (or a token the daemon gives every seat), which may be another account. Fix the file, or choose another with "
    + "rig provider switch --seat.";
}

/** The launch-script step that gives Claude the seat's token, read from its file as Claude starts. With the token, the
 *  names Claude Code ranks above it are unset for this process only (the pane shell's own exports included), so it's the
 *  token Claude uses. When the file can't be read or is empty, Claude still starts, on the config dir's stored login, and
 *  the pane says so; any token the launch already carried is kept unless `removeOnFailure`, and an empty one is never
 *  exported. API-key references instead fail closed and scrub other auth/routing variables. A pane shell with tracing on
 *  (set -x) would print a subscription token as it's read and assigned, so tracing is suspended for those and restored
 *  afterwards. */
export function claudeSeatTokenStep(ref: ClaudeSeatTokenRef, quote: (value: string) => string, opts: { removeOnFailure?: boolean; required?: boolean } = {}): string {
  if (ref.kind === "api-key") {
    // A missing API key must never silently fall back to a subscription or another account.
    const file = quote(ref.tokenFile);
    const scrub = [...OUTRANKING_TOKEN_ENV, "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_PROFILE", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"];
    return `{ set +x; unset ${scrub.join(" ")}; if [ -f ${file} ] && [ -r ${file} ]; then __openrig_token=$(/usr/bin/env -i ${quote(execPath)} -e ${quote(API_KEY_READER)} ${file} 2>/dev/null); else __openrig_token=; fi; `
      + `if [ -n "$__openrig_token" ]; then ANTHROPIC_API_KEY=$__openrig_token; export ANTHROPIC_API_KEY; unset __openrig_token; `
      + `else unset __openrig_token; printf '%s\\n' 'OpenRig: selected API-key file unavailable; no Claude process started.' >&2; exit 1; fi; }`;
  }
  const notice = opts.required ? "OpenRig: the selected account's token could not be read; no agent started."
    : `OpenRig: ${claudeSeatTokenFallbackNotice(ref, `${ref.tokenFile} couldn't be read when Claude started`)}`;
  const restore = 'if [ -n "$__openrig_x" ]; then set -x; fi; unset __openrig_x; ';
  return `{ case $- in *x*) __openrig_x=1; set +x;; *) __openrig_x=;; esac; `
    + `__openrig_token=$(/bin/cat -- ${quote(ref.tokenFile)} 2>/dev/null); if [ -n "$__openrig_token" ]; `
    + `then unset ${OUTRANKING_TOKEN_ENV.join(" ")}; CLAUDE_CODE_OAUTH_TOKEN=$__openrig_token; export CLAUDE_CODE_OAUTH_TOKEN; unset __openrig_token; ${restore}`
    + `else ${opts.removeOnFailure || opts.required ? "unset CLAUDE_CODE_OAUTH_TOKEN; " : ""}printf '%s\\n' ${quote(notice)} >&2; unset __openrig_token; ${restore}${opts.required ? "false;" : ""} fi; }`;

}

/** What a launch says when a setting would make Claude Code use another credential ahead of the seat's token, in the
 *  switch's words. The launch goes ahead: it's a warning, not a refusal. */
export function claudeSeatTokenOutrankedNotice(ref: ClaudeSeatTokenRef, conflicts: readonly CredentialConflict[]): string {
  return `This seat's Claude subscription token (${ref.label}) may not be the credential Claude uses. Claude Code would use these instead: `
    + `${conflicts.map((c) => `${c.name} (${c.source}; ${c.remedy})`).join("; ")}.`;
}

/** Whether a launch warning is the one a launch that couldn't apply the seat's token gives. */
export function isClaudeSeatTokenFallback(warning: string): boolean {
  return warning.includes("This seat's Claude subscription token (") && warning.includes(") wasn't applied: ");
}
