import type { Migration } from "../migrate.js";

/**
 * A seat activity grant: one seat's (node's) authority to post activity for one launch generation, for a workload that
 * can't hold the install-wide hook token, such as a guest in another environment. Only the token's sha256 is stored. One
 * active grant per node; a revoked grant keeps its row so a later post is refused as revoked, not unknown.
 */
export const activityGrantsSchema: Migration = {
  name: "143_activity_grants.sql",
  sql: `
    CREATE TABLE activity_grants (
      grant_id      TEXT PRIMARY KEY,
      node_id       TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      generation    TEXT NOT NULL,
      token_sha256  TEXT NOT NULL UNIQUE,
      issued_by     TEXT NOT NULL,
      issued_at     TEXT NOT NULL,
      revoked_at    TEXT,
      revoke_reason TEXT
    );
    CREATE INDEX idx_activity_grants_active ON activity_grants(node_id) WHERE revoked_at IS NULL;
  `,
};
