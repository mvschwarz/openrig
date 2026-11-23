import type Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { accountLabelProblem, claudeSeatTokenFileProblem, claudeSeatTokenRefProblem } from "../claude-seat-token.js";
import { shellArg } from "../../adapters/shell-quote.js";
import { authList, resolveCodexHome, validateProfileName } from "../codex-auth.js";
import { ProviderAccountAssignmentsRepository } from "./provider-account-assignments.js";

// #3625 (slice 1): the accounts this daemon knows by the operator's label, each with a reference that is local to this
// daemon's host: a Claude token or API-key file's absolute path, or a Codex home and the name of a login saved in it.
// Only the reference is kept. Adding one checks it the way a switch's precheck does, by looking at the file or the saved
// login's name, never by reading a credential, so no secret passes through here or into any answer.

export type AccountRefProvider = "claude" | "codex";
export type AccountRefKind = "claude_token_file" | "claude_api_key_file" | "codex_saved_login";

export interface AccountRef {
  provider: AccountRefProvider;
  label: string;
  kind: AccountRefKind;
  /** A Claude token or API-key file's absolute path; null for a Codex login. */
  file: string | null;
  /** A Codex login's home and its saved name there; null for a Claude file. */
  codexHome: string | null;
  login: string | null;
  createdAt: string;
}

/** What `rig provider account add` sends: one Claude file, or a Codex home and login name. */
export type AccountRefInput =
  | { provider: "claude"; label: string; tokenFile: string }
  | { provider: "claude"; label: string; apiKeyFile: string }
  | { provider: "codex"; label: string; codexHome: string; login: string };

export type AccountRefRefusal =
  /** The request doesn't name a usable reference (provider, label, path shape, or a mix of Claude and Codex fields). */
  | "invalid_reference"
  /** The reference is well formed but wouldn't work on this host: a missing, empty or non-private file, or no such login. */
  | "reference_unusable"
  | "duplicate_label"
  | "not_found";

export type AccountRefAddResult = { ok: true; account: AccountRef; warnings?: string[] } | { ok: false; code: AccountRefRefusal; message: string };
export type AccountRefRemoveResult =
  /** `assignedTo` and `warning` when rigs were assigned to the label: it's removed all the same. */
  | { ok: true; account: AccountRef; assignedTo?: string[]; warning?: string }
  | { ok: false; code: AccountRefRefusal; message: string };

const PROVIDERS: readonly string[] = ["claude", "codex"];
const NOTHING_STORED = "Nothing was stored.";

/** A request body read into an input, or why it can't be one. Only the shape is checked here. */
export function readAccountRefInput(body: Record<string, unknown>): AccountRefInput | { problem: string } {
  const { provider, label } = body;
  if (typeof provider !== "string" || !PROVIDERS.includes(provider)) return { problem: "provider must be claude or codex" };
  if (typeof label !== "string") return { problem: "label is required" };
  const refFields = ["tokenFile", "apiKeyFile", "codexHome", "login"].map((key) => body[key]);
  if (refFields.some((value) => value !== undefined && typeof value !== "string")) return { problem: "tokenFile, apiKeyFile, codexHome and login must be strings" };
  const [tokenFile, apiKeyFile, codexHome, login] = refFields as Array<string | undefined>;
  if (provider === "claude") {
    if (codexHome !== undefined || login !== undefined) return { problem: "a Claude account is a token or API-key file, not a Codex home and login" };
    if ((tokenFile === undefined) === (apiKeyFile === undefined)) return { problem: "a Claude account needs exactly one of tokenFile or apiKeyFile" };
    return tokenFile !== undefined ? { provider, label, tokenFile } : { provider, label, apiKeyFile: apiKeyFile! };
  }
  if (tokenFile !== undefined || apiKeyFile !== undefined) return { problem: "a Codex account is a Codex home and saved login, not a token or API-key file" };
  if (codexHome === undefined || login === undefined) return { problem: "a Codex account needs codexHome and login" };
  return { provider: "codex", label, codexHome, login };
}

/** Why the reference can't be added, or null when it would work on this host. Files are looked at, never read; a Codex
 *  login is found by its name among the logins saved in that home (`rig auth list --codex-home <home>`). */
export function accountRefProblem(input: AccountRefInput): { code: "invalid_reference" | "reference_unusable"; message: string } | null {
  const invalid = (message: string) => ({ code: "invalid_reference" as const, message: `${message}. ${NOTHING_STORED}` });
  const unusable = (message: string) => ({ code: "reference_unusable" as const, message: `${message}. ${NOTHING_STORED}` });
  const labelProblem = accountLabelProblem(input.label);
  if (labelProblem) return invalid(labelProblem);
  if (input.provider === "claude") {
    const apiKey = "apiKeyFile" in input;
    const ref = { label: input.label, tokenFile: apiKey ? input.apiKeyFile : input.tokenFile, ...(apiKey ? { kind: "api-key" as const } : {}) };
    const shape = claudeSeatTokenRefProblem(ref);
    if (shape) return invalid(shape);
    // The switch's own check: the API-key file must be private; a subscription token file has no mode rule there, so it
    // has none here (accountRefWarnings notes a loose one).
    const fileProblem = claudeSeatTokenFileProblem(ref);
    if (fileProblem) return unusable(fileProblem);
    return null;
  }
  if (!path.isAbsolute(input.codexHome) || /[\0\n\r]/.test(input.codexHome)) return invalid("the Codex home must be an absolute path on one line");
  if (!validateProfileName(input.login)) return invalid("the login must be a saved login's name: a letter or digit, then letters, digits, '.', '_' or '-' (at most 64)");
  let stat: fs.Stats;
  try { stat = fs.statSync(input.codexHome); } catch { return unusable(`the Codex home ${input.codexHome} doesn't exist`); }
  if (!stat.isDirectory()) return unusable(`${input.codexHome} isn't a directory`);
  if (!authList(resolveCodexHome({ CODEX_HOME: input.codexHome })).includes(input.login)) {
    return unusable(`no login named ${input.login} is saved in ${input.codexHome} (rig auth list --codex-home ${shellArg(input.codexHome)} lists them)`);
  }
  // rig auth switch copies only a 0600 saved login, so a looser one would be refused when it's used. authList has already
  // refused a symlink or hard link here, so this looks at the saved file itself, without reading it.
  const saved = path.join(resolveCodexHome({ CODEX_HOME: input.codexHome }).profileDir, `${input.login}.json`);
  let savedMode: number;
  try { savedMode = fs.lstatSync(saved).mode & 0o777; } catch { return unusable(`the saved login ${saved} doesn't exist`); }
  if (savedMode !== 0o600) return unusable(`the saved login ${saved} must be private (0600), and it is ${savedMode.toString(8).padStart(4, "0")}`);
  return null;
}

/** What's worth knowing about a reference that would work: a subscription token file that group or others can read.
 *  `rig provider switch --token-file` accepts it, so adding it does too. */
export function accountRefWarnings(input: AccountRefInput): string[] | { problem: string } {
  if (input.provider !== "claude" || !("tokenFile" in input)) return [];
  let mode: number;
  try { mode = fs.statSync(input.tokenFile).mode & 0o777; } catch { return { problem: `the token file ${input.tokenFile} doesn't exist` }; }
  return (mode & 0o044) !== 0
    ? [`the token file ${input.tokenFile} can be read by group or others (mode ${mode.toString(8).padStart(4, "0")}); 0600 or 0400 is recommended`] : [];
}

interface AccountRefRow {
  provider: AccountRefProvider;
  label: string;
  kind: AccountRefKind;
  file_path: string | null;
  codex_home: string | null;
  login_name: string | null;
  created_at: string;
}

const fromRow = (row: AccountRefRow): AccountRef => ({
  provider: row.provider,
  label: row.label,
  kind: row.kind,
  file: row.file_path,
  codexHome: row.codex_home,
  login: row.login_name,
  createdAt: row.created_at,
});

/** What uses an account label: the rigs assigned to it, each named as "rig <name> (<provider>)". */
export function accountRefUses(db: Database.Database): (provider: AccountRefProvider, label: string) => string[] {
  const assignments = new ProviderAccountAssignmentsRepository(db);
  return (provider, label) => assignments.rigsUsing(provider, label).map((rig) => `rig ${rig} (${provider})`);
}

export interface ProviderAccountRefsOptions {
  /** What uses a label, named in the warning when it's removed: the rigs assigned to it. */
  uses?: (provider: AccountRefProvider, label: string) => string[];
  now?: () => string;
}

export class ProviderAccountRefsRepository {
  constructor(private readonly db: Database.Database, private readonly opts: ProviderAccountRefsOptions = {}) {}

  list(provider?: AccountRefProvider): AccountRef[] {
    const rows = provider === undefined
      ? this.db.prepare("SELECT * FROM provider_account_refs ORDER BY provider, label").all()
      : this.db.prepare("SELECT * FROM provider_account_refs WHERE provider = ? ORDER BY label").all(provider);
    return (rows as AccountRefRow[]).map(fromRow);
  }

  get(provider: AccountRefProvider, label: string): AccountRef | null {
    const row = this.db.prepare("SELECT * FROM provider_account_refs WHERE provider = ? AND label = ?").get(provider, label) as AccountRefRow | undefined;
    return row ? fromRow(row) : null;
  }

  /** Adds the reference once it's checked; a refusal stores nothing. */
  add(input: AccountRefInput): AccountRefAddResult {
    if (this.get(input.provider, input.label)) {
      return { ok: false, code: "duplicate_label", message: `There's already a ${input.provider} account labelled ${input.label}; remove it first to point the label elsewhere. ${NOTHING_STORED}` };
    }
    const problem = accountRefProblem(input);
    if (problem) return { ok: false, ...problem };
    // Looked at again for the warning before anything is stored: a file gone since the check is refused, not added.
    const warnings = accountRefWarnings(input);
    if (!Array.isArray(warnings)) return { ok: false, code: "reference_unusable", message: `${warnings.problem}. ${NOTHING_STORED}` };
    const kind: AccountRefKind = input.provider === "codex" ? "codex_saved_login" : "apiKeyFile" in input ? "claude_api_key_file" : "claude_token_file";
    const file = input.provider === "claude" ? ("apiKeyFile" in input ? input.apiKeyFile : input.tokenFile) : null;
    this.db.prepare(`INSERT INTO provider_account_refs (provider, label, kind, file_path, codex_home, login_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.provider, input.label, kind, file,
      input.provider === "codex" ? input.codexHome : null, input.provider === "codex" ? input.login : null,
      (this.opts.now ?? (() => new Date().toISOString()))());
    return { ok: true, account: this.get(input.provider, input.label)!, ...(warnings.length ? { warnings } : {}) };
  }

  /** Removes the label, and only the label. When rigs are assigned to it, the result names them with a warning: their
   *  seats, the seats' credentials and the recorded assignment and results stay, and status shows the reference as
   *  missing. */
  remove(provider: AccountRefProvider, label: string): AccountRefRemoveResult {
    const account = this.get(provider, label);
    if (!account) return { ok: false, code: "not_found", message: `There's no ${provider} account labelled ${label}.` };
    const assignedTo = this.opts.uses?.(provider, label) ?? [];
    this.db.prepare("DELETE FROM provider_account_refs WHERE provider = ? AND label = ?").run(provider, label);
    if (!assignedTo.length) return { ok: true, account };
    return { ok: true, account, assignedTo, warning: `${label} was assigned to ${assignedTo.join(", ")}. Those seats and their credentials are `
      + `as they were, and status shows the reference as missing until the label is added again or another account is assigned `
      + `(rig provider assign <rig> --provider ${provider} --account <label>).` };
  }
}
