import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { OUTRANKING_TOKEN_ENV } from "./claude-credential-precedence.js";

/** A Claude seat's own subscription credential: an operator label and an absolute token-file path. A reference only: the
 *  launch script reads the file when Claude starts, so the value never passes through OpenRig. The label is the
 *  operator's name for it, not an account the provider observed. */
export interface ClaudeSeatTokenRef {
  label: string;
  tokenFile: string;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** Why a label or token-file path can't be a seat's reference, or null when it can. */
export function claudeSeatTokenRefProblem(ref: ClaudeSeatTokenRef): string | null {
  if (!LABEL_RE.test(ref.label)) return "the label must start with a letter or digit, then use letters, digits, '.', '_', '@' or '-' (at most 64)";
  if (!path.isAbsolute(ref.tokenFile) || /[\0\n\r]/.test(ref.tokenFile)) return "the token file must be an absolute path on one line";
  return null;
}

/** The stored reference, or null when it's absent or unreadable. */
export function parseClaudeSeatTokenRef(value: unknown): ClaudeSeatTokenRef | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const { label, tokenFile } = JSON.parse(value) as { label?: unknown; tokenFile?: unknown };
    if (typeof label !== "string" || typeof tokenFile !== "string") return null;
    return claudeSeatTokenRefProblem({ label, tokenFile }) === null ? { label, tokenFile } : null;
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
  if (stat.size === 0) return `the token file ${ref.tokenFile} is empty`;
  try { fs.accessSync(ref.tokenFile, fs.constants.R_OK); } catch { return `the token file ${ref.tokenFile} isn't readable by the daemon's user`; }
  return null;
}

/** What a launch that couldn't apply the seat's token says, wherever it's reported. */
export function claudeSeatTokenFallbackNotice(ref: ClaudeSeatTokenRef, problem: string): string {
  return `This seat's Claude subscription token (${ref.label}) wasn't applied: ${problem}. Claude started without it, on its config dir's `
    + "stored login (or a token the daemon gives every seat), which may be another account. Fix the file, or choose another with "
    + "rig provider switch --seat.";
}

/** The launch-script step that gives Claude the seat's token, read from its file as Claude starts. With the token, the
 *  names Claude Code ranks above it are unset for this process only (the pane shell's own exports included), so it's the
 *  token Claude uses. When the file can't be read or is empty, Claude still starts, on the config dir's stored login, and
 *  the pane says so; any token the launch already carried is kept unless `removeOnFailure`, and an empty one is never
 *  exported. */
export function claudeSeatTokenStep(ref: ClaudeSeatTokenRef, quote: (value: string) => string, opts: { removeOnFailure?: boolean } = {}): string {
  const notice = claudeSeatTokenFallbackNotice(ref, `${ref.tokenFile} couldn't be read when Claude started`);
  return `{ __openrig_token=$(/bin/cat -- ${quote(ref.tokenFile)} 2>/dev/null); if [ -n "$__openrig_token" ]; `
    + `then unset ${OUTRANKING_TOKEN_ENV.join(" ")}; CLAUDE_CODE_OAUTH_TOKEN=$__openrig_token; export CLAUDE_CODE_OAUTH_TOKEN; `
    + `else ${opts.removeOnFailure ? "unset CLAUDE_CODE_OAUTH_TOKEN; " : ""}printf '%s\\n' ${quote(`OpenRig: ${notice}`)} >&2; fi; unset __openrig_token; }`;
}

/** Whether a launch warning is the one a launch that couldn't apply the seat's token gives. */
export function isClaudeSeatTokenFallback(warning: string): boolean {
  return warning.includes("This seat's Claude subscription token (") && warning.includes(") wasn't applied: ");
}
