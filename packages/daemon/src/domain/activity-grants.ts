// A seat activity grant: the authority a workload outside the host's own hook setup, such as
// a guest in another environment or a runner inside one, uses to post activity for ONE seat. Managed hosted runners
// additionally bind that authority to one actual launch, its concrete Core pane and originating session.
// The install-wide hook token (activity-endpoint.ts) speaks for every seat, so it never goes into a guest; a grant goes
// there instead, under the same variable name, so runners need no change. The ingress (routes/activity.ts) resolves
// the grant first and only then accepts the seat and generation a post claims.

import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { SessionRegistry } from "./session-registry.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
const TOKEN_PREFIX = "oag_";

export type RunGrantBinding = { runtime: string; runner: number; pane: string; panePid: number };
export type ActivityGrant = {
  runId: string | null;
  sessionId: string | null;
  activatedAt: string | null;
  binding: RunGrantBinding | null;
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
  revoked_at: string | null; revoke_reason: string | null; run_id?: string | null; session_id?: string | null;
  activated_at?: string | null; binding_json?: string | null };

const sha256 = (token: string): string => createHash("sha256").update(token).digest("hex");

function toGrant(row: Row): ActivityGrant {
  let binding: RunGrantBinding | null = null;
  try { binding = row.binding_json ? JSON.parse(row.binding_json) : null; } catch { /* unavailable */ }
  return { runId: row.run_id ?? null, sessionId: row.session_id ?? null, activatedAt: row.activated_at ?? null, binding, grantId: row.grant_id, nodeId: row.node_id, generation: row.generation, issuedAt: row.issued_at,
    issuedBy: row.issued_by, revokedAt: row.revoked_at, revokeReason: row.revoke_reason };
}

/** A daemon whose database predates migration 143 has no grants, so every grant token is unknown there. */
export function hasActivityGrantsTable(db: Database.Database): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'activity_grants'").get());
}

export class ActivityGrantStore {
  constructor(private readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {}

  /** Legacy issuance revokes earlier grants as before. An actual-run issuance stays pending and preserves
   * the active predecessor; only another pending credential for this same run is superseded. Activation owns cutover.
   * The token is returned once; only its sha256 is stored. */
  issue(input: { nodeId: string; generation: string; issuedBy: string; run?: { runId: string; sessionId?: string; binding: RunGrantBinding } }): ActivityGrant & { token: string } {
    if (!input.nodeId.trim() || !input.generation.trim() || !input.issuedBy.trim()) {
      throw new ActivityGrantError("invalid_grant_input", "An activity grant needs a node, a launch generation and who issued it.");
    }
    if (input.run && (!input.run.runId.trim() || !input.run.binding.runtime || !input.run.binding.pane
      || !Number.isSafeInteger(input.run.binding.panePid) || input.run.binding.panePid <= 0)) {
      throw new ActivityGrantError("invalid_grant_input", "A run grant needs a concrete Core launch binding.");
    }
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
    const grantId = `agrant-${ulid()}`;
    const issuedAt = this.now().toISOString();
    this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(input.nodeId)) {
        throw new ActivityGrantError("node_not_found", `No seat with node ${input.nodeId}.`);
      }
      if (input.run) {
        this.db.prepare("UPDATE activity_grants SET revoked_at = ?, revoke_reason = 'reissued' WHERE node_id = ? AND run_id = ? AND activated_at IS NULL AND revoked_at IS NULL")
          .run(issuedAt, input.nodeId, input.run.runId);
      } else this.revokeActive(input.nodeId, "reissued", issuedAt);
      this.db.prepare(`INSERT INTO activity_grants (grant_id, node_id, generation, token_sha256, issued_by, issued_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(grantId, input.nodeId, input.generation, sha256(token), input.issuedBy, issuedAt);
      if (input.run) this.db.prepare("UPDATE activity_grants SET run_id = ?, session_id = ?, binding_json = ? WHERE grant_id = ?")
        .run(input.run.runId, input.run.sessionId ?? null, JSON.stringify(input.run.binding), grantId);
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
    const row = this.db.prepare(this.hasRunColumns()
      ? "SELECT * FROM activity_grants WHERE node_id = ? AND revoked_at IS NULL AND (run_id IS NULL OR activated_at IS NOT NULL) ORDER BY activated_at DESC LIMIT 1"
      : "SELECT * FROM activity_grants WHERE node_id = ? AND revoked_at IS NULL").get(nodeId) as Row | undefined;
    return row ? toGrant(row) : null;
  }

  /** Activate only against the committed Core binding. Staged launches remain pending until cutover. */
  activate(grantId: string): boolean {
    return this.db.transaction(() => {
      const grant = this.get(grantId);
      if (!grant?.runId || grant.revokedAt || !this.matchesBinding(grant, false, !grant.activatedAt)) return false;
      if (grant.activatedAt) return true;
      const active = this.activeForNode(grant.nodeId);
      if (active?.runId && active.grantId > grant.grantId && this.bindingMatch(active, true) !== false) return false;
      const session = this.currentSession(grant.nodeId)!;
      // Only this pending, Core-selected launch may fill an empty declaration; never overwrite a conflicting record.
      if (grant.binding!.runtime !== "pi" && session.agent_app == null && session.agent_runner == null) {
        this.db.prepare("UPDATE sessions SET agent_app = ?, agent_runner = ? WHERE id = ?")
          .run(grant.binding!.runtime, grant.binding!.runner, session.id);
      }
      const at = this.now().toISOString();
      this.db.prepare("UPDATE activity_grants SET revoked_at = ?, revoke_reason = 'run_replaced' WHERE node_id = ? AND grant_id <> ? AND revoked_at IS NULL AND (run_id IS NULL OR activated_at IS NOT NULL)")
        .run(at, grant.nodeId, grantId);
      this.db.prepare("UPDATE activity_grants SET activated_at = ?, session_id = ? WHERE grant_id = ? AND revoked_at IS NULL")
        .run(at, session.id, grantId);
      return true;
    })();
  }

  /** Core's existing claimed-session commit is the staged activation point. Only an unambiguous
   * matching launch may restore its recorded runner declaration onto that new session row. */
  reconcileBinding(nodeId: string): void {
    if (!hasActivityGrantsTable(this.db) || !this.hasRunColumns()) return;
    try { this.db.transaction(() => {
      const grants = (this.db.prepare("SELECT * FROM activity_grants WHERE node_id = ? AND run_id IS NOT NULL AND revoked_at IS NULL")
        .all(nodeId) as Row[]).map(toGrant);
      if (grants.length === 0) return;
      const session = this.currentSession(nodeId);
      if (!session) return;
      const registry = new SessionRegistry(this.db);
      const generation = registry.currentOccupantTenure(nodeId)?.generationUuid;
      const candidates = grants.filter(grant => grant.binding?.pane === session.tmux_pane && grant.binding.runtime === session.runtime
        && (grant.generation === generation || (grant.activatedAt && registry.isOccupantContinuedByAdoption(nodeId, grant.generation)
          && this.adoptionAnchorMatches(grant, session.session_name))));
      if (candidates.length === 1) {
        const grant = candidates[0]!;
        if (grant.binding!.runtime !== "pi" && session.agent_app == null && session.agent_runner == null) {
          this.db.prepare("UPDATE sessions SET agent_app = ?, agent_runner = ? WHERE id = ?")
            .run(grant.binding!.runtime, grant.binding!.runner, session.id);
        }
        if (!grant.activatedAt) this.activate(grant.grantId);
      }
      for (const grant of grants) {
        if (grant.activatedAt && this.bindingMatch(grant, true) === false) this.revoke({ grantId: grant.grantId }, "binding_replaced");
      }
    })(); } catch { /* Optional reconciliation cannot turn an unreadable binding into revocation or fail registration. */ }
  }

  /** Pending issuance IDs for a Core-reserved operation, captured before its recovery awaits.
   * This selects cleanup work; generation alone never authenticates a report or activates a grant. */
  pendingForGeneration(nodeId: string, generation: string): ActivityGrant[] {
    if (!hasActivityGrantsTable(this.db) || !this.hasRunColumns()) return [];
    return (this.db.prepare(`SELECT * FROM activity_grants WHERE node_id = ? AND generation = ?
      AND run_id IS NOT NULL AND activated_at IS NULL AND revoked_at IS NULL`).all(nodeId, generation) as Row[]).map(toGrant);
  }

  /** A status observation for an old row cannot revoke the replacement's run. */
  revokeForSession(sessionId: string, reason: string): void {
    if (!hasActivityGrantsTable(this.db) || !this.hasRunColumns()) return;
    const row = this.db.prepare("SELECT node_id FROM sessions WHERE id = ?").get(sessionId) as { node_id: string } | undefined;
    if (!row) return;
    const current = this.currentSession(row.node_id);
    const grants = (this.db.prepare("SELECT * FROM activity_grants WHERE node_id = ? AND run_id IS NOT NULL AND revoked_at IS NULL")
      .all(row.node_id) as Row[]).map(toGrant);
    for (const grant of grants) {
      if ((grant.sessionId === sessionId && (current?.id === sessionId || this.bindingMatch(grant, true) === false))
        || (grant.activatedAt && current?.id === sessionId)) {
        this.revoke({ grantId: grant.grantId }, reason);
      }
    }
  }

  standing(grantId: string): "current" | "pending" | "stale" | "unverified" | "revoked" {
    const grant = this.get(grantId);
    if (!grant || grant.revokedAt) return "revoked";
    if (!grant.runId || !this.hasRunColumns()) return "stale";
    if (!grant.activatedAt) return "pending";
    const binding = this.bindingMatch(grant, true);
    return binding === null ? "unverified" : binding ? "current" : "stale";
  }

  private hasRunColumns(): boolean {
    return (this.db.prepare("PRAGMA table_info(activity_grants)").all() as Array<{ name: string }>).some(row => row.name === "run_id");
  }

  private currentSession(nodeId: string): { id: string; session_name: string; agent_app: string | null; agent_runner: number | null; tmux_pane: string | null; runtime: string | null } | undefined {
    return this.db.prepare(`SELECT s.id, s.session_name, s.agent_app, s.agent_runner, b.tmux_pane, n.runtime
      FROM sessions s JOIN nodes n ON n.id=s.node_id JOIN bindings b ON b.node_id=n.id AND b.tmux_session=s.session_name
      WHERE s.node_id=? AND s.id=(SELECT id FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1)
        AND s.status NOT IN ('exited','detached','superseded')`).get(nodeId, nodeId) as ReturnType<ActivityGrantStore["currentSession"]>;
  }

  private matchesBinding(grant: ActivityGrant, allowAdoption: boolean, allowUnrecorded = false): boolean {
    return this.bindingMatch(grant, allowAdoption, allowUnrecorded) === true;
  }

  /** Unknown evidence refuses reports, but cannot authorize destructive lifecycle cleanup. */
  private bindingMatch(grant: ActivityGrant, allowAdoption: boolean, allowUnrecorded = false): boolean | null {
    try {
      const anchor = grant.binding, session = this.currentSession(grant.nodeId);
      if (!anchor || !session || session.tmux_pane !== anchor.pane || session.runtime !== anchor.runtime) return false;
      if (anchor.runtime !== "pi" && ((session.agent_app != null && session.agent_app !== anchor.runtime)
        || (session.agent_runner != null && session.agent_runner !== anchor.runner))) return false;
      const declarationMissing = anchor.runtime !== "pi" && (session.agent_app == null || session.agent_runner == null)
        && !(allowUnrecorded && session.agent_app == null && session.agent_runner == null && [1, 2].includes(anchor.runner));
      const registry = new SessionRegistry(this.db);
      const current = registry.currentOccupantTenure(grant.nodeId)?.generationUuid;
      if (!current) return null;
      const adoption = current !== grant.generation;
      if (adoption && (!allowAdoption || !registry.isOccupantContinuedByAdoption(grant.nodeId, grant.generation))) return false;
      if (!adoption && grant.sessionId && grant.sessionId !== session.id) return false;
      const evidence = new SeatIdentityStore(this.db).getForNode(grant.nodeId);
      if (adoption) {
        const match = this.adoptionAnchorMatch(grant, session.session_name);
        if (match !== true) return match;
      }
      if (evidence?.sessionName === session.session_name && evidence.evidence.registeredPane === anchor.pane
        && Date.parse(evidence.observedAt) >= Date.parse(grant.issuedAt)
        && evidence.evidence.observedPanePid != null && evidence.evidence.observedPanePid !== anchor.panePid) return false;
      // Missing declaration is unknown only after ruling out positive binding/tenure/process replacement.
      return declarationMissing ? null : true;
    } catch { return null; }
  }

  private adoptionAnchorMatches(grant: ActivityGrant, sessionName: string): boolean {
    return this.adoptionAnchorMatch(grant, sessionName) === true;
  }

  private adoptionAnchorMatch(grant: ActivityGrant, sessionName: string): boolean | null {
    const store = new SeatIdentityStore(this.db), evidence = store.getForNode(grant.nodeId);
    const process = store.getProcessEvidence(grant.nodeId);
    if (!evidence || !process || evidence.sessionName !== sessionName || process.sessionName !== sessionName
      || evidence.evidence.observedPanePid == null || process.panePid == null) return null;
    return !!grant.binding && evidence.sessionName === sessionName && process.sessionName === sessionName
      && evidence.evidence.registeredPane === grant.binding.pane
      && evidence.evidence.observedPanePid === grant.binding.panePid && process.panePid === grant.binding.panePid;
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
