// A seat activity grant: the authority a workload outside the host's own hook setup, such as
// a guest in another environment or a runner inside one, uses to post activity for ONE seat and ONE launch generation.
// The install-wide hook token (activity-endpoint.ts) speaks for every seat, so it never goes into a guest; a grant goes
// there instead, under the same variable name, so runners need no change. The ingress (routes/activity.ts) resolves
// the grant first and only then accepts the seat and generation a post claims.

import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
const TOKEN_PREFIX = "oag_";

export type ActivityGrant = {
  grantId: string;
  nodeId: string;
  generation: string;
  issuedAt: string;
  issuedBy: string;
  revokedAt: string | null;
  revokeReason: string | null;
};

export class ActivityGrantError extends Error {
  constructor(readonly code: "node_not_found" | "invalid_grant_input", message: string) {
    super(message);
  }
}

type Row = { grant_id: string; node_id: string; generation: string; issued_at: string; issued_by: string;
  revoked_at: string | null; revoke_reason: string | null };

const sha256 = (token: string): string => createHash("sha256").update(token).digest("hex");

function toGrant(row: Row): ActivityGrant {
  return { grantId: row.grant_id, nodeId: row.node_id, generation: row.generation, issuedAt: row.issued_at,
    issuedBy: row.issued_by, revokedAt: row.revoked_at, revokeReason: row.revoke_reason };
}

/** A daemon whose database predates migration 143 has no grants, so every grant token is unknown there. */
export function hasActivityGrantsTable(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_grants'").get());
}

export class ActivityGrantStore {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** Issue the node's grant for `generation`: the occupant generation its launch reserved, which may not be registered
   *  yet. One active grant per node, so this revokes any earlier one ("reissued"): a lost response is reconciled by
   *  issuing again. The token is returned once; only its sha256 is stored. */
  issue(input: { nodeId: string; generation: string; issuedBy: string }): ActivityGrant & { token: string } {
    if (!input.nodeId.trim() || !input.generation.trim() || !input.issuedBy.trim()) {
      throw new ActivityGrantError("invalid_grant_input", "An activity grant needs a node, a launch generation and who issued it.");
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
    const grantId = `agrant-${ulid()}`;
    const issuedAt = this.now().toISOString();
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(input.nodeId)) {
        throw new ActivityGrantError("node_not_found", `No seat with node ${input.nodeId}.`);
      }
      this.revokeActive(input.nodeId, "reissued", issuedAt);
      this.db.prepare(`INSERT INTO activity_grants (grant_id, node_id, generation, token_sha256, issued_by, issued_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(grantId, input.nodeId, input.generation, sha256(token), input.issuedBy, issuedAt);
    })();
    return { ...this.get(grantId)!, token };
  }

  /** Revoke one grant, or the node's active grant. Returns how many were revoked; revoking again changes nothing. */
  revoke(target: { grantId: string } | { nodeId: string }, reason: string): number {
    const at = this.now().toISOString();
    if ("nodeId" in target) return this.revokeActive(target.nodeId, reason, at);
    return this.db.prepare("UPDATE activity_grants SET revoked_at = ?, revoke_reason = ? WHERE grant_id = ? AND revoked_at IS NULL")
      .run(at, reason, target.grantId).changes;
  }

  get(grantId: string): ActivityGrant | null {
    const row = this.db.prepare("SELECT * FROM activity_grants WHERE grant_id = ?").get(grantId) as Row | undefined;
    return row ? toGrant(row) : null;
  }

  activeForNode(nodeId: string): ActivityGrant | null {
    const row = this.db.prepare("SELECT * FROM activity_grants WHERE node_id = ? AND revoked_at IS NULL").get(nodeId) as Row | undefined;
    return row ? toGrant(row) : null;
  }

  /** The grant a presented token belongs to, revoked or not, or null for any other token. */
  authenticate(token: string | null | undefined): ActivityGrant | null {
    if (!token?.startsWith(TOKEN_PREFIX) || !hasActivityGrantsTable(this.db)) return null;
    const row = this.db.prepare("SELECT * FROM activity_grants WHERE token_sha256 = ?").get(sha256(token)) as Row | undefined;
    return row ? toGrant(row) : null;
  }

  private revokeActive(nodeId: string, reason: string, at: string): number {
    return this.db.prepare("UPDATE activity_grants SET revoked_at = ?, revoke_reason = ? WHERE node_id = ? AND revoked_at IS NULL")
      .run(at, reason, nodeId).changes;
  }
}

/** Where a grant stands against the node's occupant ledger: `current` speaks for the seat; `stale` names an occupant
 *  that has been replaced; `pending` names a reserved generation its launch hasn't registered yet. */
export function grantGeneration(grant: ActivityGrant, ledger: {
  current(nodeId: string): string | null;
  registered(nodeId: string, generation: string): boolean;
}): "current" | "stale" | "pending" {
  if (ledger.current(grant.nodeId) === grant.generation) return "current";
  return ledger.registered(grant.nodeId, grant.generation) ? "stale" : "pending";
}

/** The only activity values a guest receives. Build a guest's environment from an allow-list that includes these, never
 *  by copying the host's: the host carries the install-wide token. `guestBaseUrl` is the provider's mapping of the
 *  daemon's listener into the guest: an http(s) origin, with no credentials, path, query or fragment. */
export function guestActivityEnv(grant: { token: string; nodeId: string; generation: string }, sessionName: string, guestBaseUrl: string): {
  OPENRIG_URL: string; OPENRIG_ACTIVITY_HOOK_TOKEN: string; OPENRIG_NODE_ID: string; OPENRIG_SESSION_NAME: string; OPENRIG_OCCUPANT_GENERATION: string;
} {
  let url: URL;
  try {
    url = new URL(guestBaseUrl);
  } catch {
    throw new ActivityGrantError("invalid_grant_input", `The guest's activity address isn't a URL: ${guestBaseUrl}`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password
    || url.pathname !== "/" || url.search || url.hash) {
    throw new ActivityGrantError("invalid_grant_input", "The guest's activity address must be an http(s) origin, such as http://host.example:7433.");
  }
  return { OPENRIG_URL: url.origin, OPENRIG_ACTIVITY_HOOK_TOKEN: grant.token, OPENRIG_NODE_ID: grant.nodeId,
    OPENRIG_SESSION_NAME: sessionName, OPENRIG_OCCUPANT_GENERATION: grant.generation };
}
