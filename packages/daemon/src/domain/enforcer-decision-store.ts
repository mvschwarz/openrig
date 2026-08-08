import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

export const CLAUDE_COMPACTION_ENFORCER_KIND = "claude_compaction" as const;
export const AUTHORIZABLE_COMPACTION_REASONS = [
  "disabled",
  "post_restore_cooldown",
  "stale_generation",
] as const;

export type AuthorizableCompactionReason = typeof AUTHORIZABLE_COMPACTION_REASONS[number];
export type EnforcerDecisionDirection = "hold" | "authorize";

export interface EnforcerDecision {
  decisionId: string;
  enforcerKind: string;
  sessionName: string;
  generationUuid: string;
  direction: EnforcerDecisionDirection;
  automaticReason: string | null;
  reason: string;
  actorSession: string;
  identityProvenance: string;
  createdAt: string;
  expiresAt: string | null;
  active: boolean;
  releaseKind: string | null;
  releasedAt: string | null;
  releasedBySession: string | null;
  releaseIdentityProvenance: string | null;
  releaseReason: string | null;
  consumedAt: string | null;
  consumedByEnforcerKind: string | null;
  liftedReason: string | null;
  attemptOutcome: string | null;
  attemptFailureReason: string | null;
  lastObservedAt: string | null;
  lastObservedOutcome: string | null;
}

export interface CreateEnforcerDecisionInput {
  enforcerKind: string;
  sessionName: string;
  generationUuid: string;
  direction: EnforcerDecisionDirection;
  automaticReason?: string | null;
  reason: string;
  actorSession: string;
  identityProvenance: string;
}

interface DecisionRow {
  decision_id: string;
  enforcer_kind: string;
  session_name: string;
  generation_uuid: string;
  direction: EnforcerDecisionDirection;
  automatic_reason: string | null;
  reason: string;
  actor_session: string;
  identity_provenance: string;
  created_at: string;
  expires_at: string | null;
  active: number;
  release_kind: string | null;
  released_at: string | null;
  released_by_session: string | null;
  release_identity_provenance: string | null;
  release_reason: string | null;
  consumed_at: string | null;
  consumed_by_enforcer_kind: string | null;
  lifted_reason: string | null;
  attempt_outcome: string | null;
  attempt_failure_reason: string | null;
  last_observed_at: string | null;
  last_observed_outcome: string | null;
}

const AUTHORIZABLE = new Set<string>(AUTHORIZABLE_COMPACTION_REASONS);

function required(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function mapDecision(row: DecisionRow): EnforcerDecision {
  return {
    decisionId: row.decision_id,
    enforcerKind: row.enforcer_kind,
    sessionName: row.session_name,
    generationUuid: row.generation_uuid,
    direction: row.direction,
    automaticReason: row.automatic_reason,
    reason: row.reason,
    actorSession: row.actor_session,
    identityProvenance: row.identity_provenance,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    active: row.active === 1,
    releaseKind: row.release_kind,
    releasedAt: row.released_at,
    releasedBySession: row.released_by_session,
    releaseIdentityProvenance: row.release_identity_provenance,
    releaseReason: row.release_reason,
    consumedAt: row.consumed_at,
    consumedByEnforcerKind: row.consumed_by_enforcer_kind,
    liftedReason: row.lifted_reason,
    attemptOutcome: row.attempt_outcome,
    attemptFailureReason: row.attempt_failure_reason,
    lastObservedAt: row.last_observed_at,
    lastObservedOutcome: row.last_observed_outcome,
  };
}

export class EnforcerDecisionStore {
  constructor(
    private readonly db: Database.Database,
    private readonly opts: { now: () => Date; authorizeTtlMinutes: () => number },
  ) {}

  private nowIso(): string {
    return this.opts.now().toISOString();
  }

  private expireAuthorizations(now = this.nowIso()): void {
    this.db.prepare(`
      UPDATE enforcer_decisions
      SET active = 0,
          release_kind = 'expired',
          released_at = ?
      WHERE active = 1
        AND direction = 'authorize'
        AND expires_at IS NOT NULL
        AND expires_at <= ?
    `).run(now, now);
  }

  private getById(decisionId: string): EnforcerDecision | null {
    const row = this.db.prepare(
      "SELECT * FROM enforcer_decisions WHERE decision_id = ?",
    ).get(decisionId) as DecisionRow | undefined;
    return row ? mapDecision(row) : null;
  }

  create(input: CreateEnforcerDecisionInput): EnforcerDecision {
    const enforcerKind = required(input.enforcerKind, "enforcer kind");
    const sessionName = required(input.sessionName, "session name");
    const generationUuid = required(input.generationUuid, "generation UUID");
    const reason = required(input.reason, "reason");
    const actorSession = required(input.actorSession, "actor session");
    const identityProvenance = required(input.identityProvenance, "identity provenance");
    if (input.direction !== "hold" && input.direction !== "authorize") {
      throw new Error("direction must be hold or authorize");
    }

    let automaticReason: string | null = null;
    if (input.direction === "authorize") {
      automaticReason = required(input.automaticReason, "automatic reason");
      if (!AUTHORIZABLE.has(automaticReason)) {
        throw new Error(`automatic reason '${automaticReason}' is not authorizable`);
      }
    }

    const now = this.nowIso();
    this.expireAuthorizations(now);
    const decisionId = randomUUID();
    const ttlMinutes = this.opts.authorizeTtlMinutes();
    const expiresAt = input.direction === "authorize"
      ? new Date(this.opts.now().getTime() + ttlMinutes * 60_000).toISOString()
      : null;

    const transaction = this.db.transaction(() => {
      const active = this.db.prepare(`
        SELECT direction FROM enforcer_decisions
        WHERE enforcer_kind = ? AND session_name = ? AND generation_uuid = ? AND active = 1
      `).get(enforcerKind, sessionName, generationUuid) as { direction: EnforcerDecisionDirection } | undefined;

      if (input.direction === "authorize" && active?.direction === "hold") {
        throw new Error("cannot authorize while an active hold exists");
      }
      if (active?.direction === input.direction) {
        throw new Error(`an active ${input.direction} decision already exists`);
      }
      if (input.direction === "hold" && active?.direction === "authorize") {
        this.db.prepare(`
          UPDATE enforcer_decisions
          SET active = 0,
              release_kind = 'revoked_by_hold',
              released_at = ?,
              released_by_session = ?,
              release_identity_provenance = ?,
              release_reason = ?
          WHERE enforcer_kind = ? AND session_name = ? AND generation_uuid = ? AND active = 1
        `).run(
          now,
          actorSession,
          identityProvenance,
          reason,
          enforcerKind,
          sessionName,
          generationUuid,
        );
      }

      this.db.prepare(`
        INSERT INTO enforcer_decisions (
          decision_id, enforcer_kind, session_name, generation_uuid, direction,
          automatic_reason, reason, actor_session, identity_provenance,
          created_at, expires_at, active
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        decisionId,
        enforcerKind,
        sessionName,
        generationUuid,
        input.direction,
        automaticReason,
        reason,
        actorSession,
        identityProvenance,
        now,
        expiresAt,
      );
    });
    transaction.immediate();
    return this.getById(decisionId)!;
  }

  list(input: { sessionName?: string } = {}): EnforcerDecision[] {
    this.expireAuthorizations();
    const rows = input.sessionName
      ? this.db.prepare(`
          SELECT * FROM enforcer_decisions WHERE session_name = ?
          ORDER BY created_at DESC, rowid DESC
        `).all(input.sessionName) as DecisionRow[]
      : this.db.prepare(`
          SELECT * FROM enforcer_decisions ORDER BY created_at DESC, rowid DESC
        `).all() as DecisionRow[];
    return rows.map(mapDecision);
  }

  clear(input: {
    decisionId: string;
    actorSession: string;
    identityProvenance: string;
    reason: string;
  }): EnforcerDecision {
    const decisionId = required(input.decisionId, "decision ID");
    const actorSession = required(input.actorSession, "actor session");
    const identityProvenance = required(input.identityProvenance, "identity provenance");
    const reason = required(input.reason, "reason");
    const result = this.db.prepare(`
      UPDATE enforcer_decisions
      SET active = 0,
          release_kind = 'cleared',
          released_at = ?,
          released_by_session = ?,
          release_identity_provenance = ?,
          release_reason = ?
      WHERE decision_id = ? AND active = 1
    `).run(this.nowIso(), actorSession, identityProvenance, reason, decisionId);
    if (result.changes !== 1) throw new Error("active decision not found");
    return this.getById(decisionId)!;
  }

  findActiveHold(input: {
    enforcerKind: string;
    sessionName: string;
    liveGenerationUuid: string | null;
  }): EnforcerDecision | null {
    this.expireAuthorizations();
    const row = input.liveGenerationUuid === null
      ? this.db.prepare(`
          SELECT * FROM enforcer_decisions
          WHERE enforcer_kind = ? AND session_name = ? AND direction = 'hold' AND active = 1
          ORDER BY created_at DESC, rowid DESC LIMIT 1
        `).get(input.enforcerKind, input.sessionName) as DecisionRow | undefined
      : this.db.prepare(`
          SELECT * FROM enforcer_decisions
          WHERE enforcer_kind = ? AND session_name = ? AND generation_uuid = ?
            AND direction = 'hold' AND active = 1
          LIMIT 1
        `).get(input.enforcerKind, input.sessionName, input.liveGenerationUuid) as DecisionRow | undefined;
    return row ? mapDecision(row) : null;
  }

  findMatchingAuthorization(input: {
    enforcerKind: string;
    sessionName: string;
    liveGenerationUuid: string | null;
    automaticReason: string;
  }): EnforcerDecision | null {
    this.expireAuthorizations();
    if (input.liveGenerationUuid === null) return null;
    const row = this.db.prepare(`
      SELECT * FROM enforcer_decisions
      WHERE enforcer_kind = ? AND session_name = ? AND generation_uuid = ?
        AND direction = 'authorize' AND automatic_reason = ? AND active = 1
      LIMIT 1
    `).get(
      input.enforcerKind,
      input.sessionName,
      input.liveGenerationUuid,
      input.automaticReason,
    ) as DecisionRow | undefined;
    return row ? mapDecision(row) : null;
  }

  observeHold(input: { decisionId: string; outcome: "human_hold" }): void {
    this.db.prepare(`
      UPDATE enforcer_decisions
      SET last_observed_at = ?, last_observed_outcome = ?
      WHERE decision_id = ? AND direction = 'hold' AND active = 1
    `).run(this.nowIso(), input.outcome, input.decisionId);
  }

  consumeAuthorizationForAttempt(input: {
    decisionId: string;
    enforcerKind: string;
    liftedReason: string;
  }): boolean {
    const now = this.nowIso();
    this.expireAuthorizations(now);
    const result = this.db.prepare(`
      UPDATE enforcer_decisions
      SET active = 0,
          consumed_at = ?,
          consumed_by_enforcer_kind = ?,
          lifted_reason = ?
      WHERE decision_id = ?
        AND direction = 'authorize'
        AND automatic_reason = ?
        AND active = 1
        AND expires_at > ?
    `).run(
      now,
      input.enforcerKind,
      input.liftedReason,
      input.decisionId,
      input.liftedReason,
      now,
    );
    return result.changes === 1;
  }

  recordAuthorizationAttempt(input: {
    decisionId: string;
    outcome: "succeeded" | "failed";
    failureReason?: string;
  }): void {
    this.db.prepare(`
      UPDATE enforcer_decisions
      SET attempt_outcome = ?, attempt_failure_reason = ?
      WHERE decision_id = ? AND consumed_at IS NOT NULL
    `).run(input.outcome, input.failureReason ?? null, input.decisionId);
  }
}
