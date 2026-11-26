import type { Migration } from "../migrate.js";

/**
 * #3625 (slice 1): the daemon's own list of accounts, by the operator's label, each with a reference that is local to
 * this daemon's host: a Claude token or API-key file's absolute path, or a Codex home and the name of a login saved in
 * it. A reference only, never credential bytes. A label is unique per provider.
 */
export const providerAccountRefsSchema: Migration = {
  name: "187_provider_account_refs.sql",
  sql: `
    CREATE TABLE provider_account_refs (
      provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
      label TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('claude_token_file', 'claude_api_key_file', 'codex_saved_login')),
      file_path TEXT,
      codex_home TEXT,
      login_name TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (provider, label),
      CHECK ((provider = 'codex') = (kind = 'codex_saved_login')),
      CHECK (CASE WHEN kind = 'codex_saved_login'
        THEN file_path IS NULL AND codex_home IS NOT NULL AND login_name IS NOT NULL
        ELSE file_path IS NOT NULL AND codex_home IS NULL AND login_name IS NULL END)
    );
  `,
};
