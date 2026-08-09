import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity, PersistedEvent } from "./types.js";

export const AGENT_ACTIVITY_FRESHNESS_MS = 5 * 60 * 1000;

export interface HookActivityInput {
  runtime: string | null;
  sessionName?: string | null;
  nodeId?: string | null;
  hookEvent: string;
  subtype?: string | null;
  occurredAt?: string | null;
  /** W2a-1 — the EMITTING occupant's generation, CARRIED source-bound on the hook (the producer/relay
   *  supplies it at fire time; the route ingests it). NOT inferred from record-time state — that
   *  inference mis-attributes a delayed prior-occupant hook to the live occupant. Absent (producer not
   *  yet wired) ⇒ stamped null ⇒ unresolved at read (never false-fresh). */
  generation?: string | null;
}

export type RecordHookActivityResult =
  | { ok: true; activity: AgentActivity; event: PersistedEvent }
  | { ok: false; code: "missing_session_identity" | "session_not_found"; error: string };

interface AgentActivityStoreDeps {
  db: Database.Database;
  eventBus: EventBus;
  now?: () => Date;
  freshnessMs?: number;
  /** W2a-1 — resolve the LIVE occupant generation for a node (the shipped occupant-tenure
   *  generation_uuid), or null when UNKNOWN. Injected (not self-constructed) so the store stays
   *  decoupled from SessionRegistry and unit-testable with a fake. When ABSENT the store applies no
   *  generation gate — legacy clock-only freshness — so the existing callers are unchanged until the
   *  producer wiring injects the real resolver. Resolution is SYNCHRONOUS (a better-sqlite3 read),
   *  which is why the gate lives inline in the sync read path with no signature churn to 9 callers. */
  resolveOccupantGeneration?: (nodeId: string) => string | null;
  /** Confirm that a carried generation is registered for this node. A side-effect-free reservation
   * that never committed must remain unresolvable, not become positive mismatch evidence. */
  isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;
}

interface SessionLookupRow {
  rig_id: string;
  node_id: string;
  session_name: string;
  runtime: string | null;
}

interface EventPayloadRow {
  payload: string;
}

export class AgentActivityStore {
  readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly now: () => Date;
  private readonly freshnessMs: number;
  private readonly resolveOccupantGeneration?: (nodeId: string) => string | null;
  private readonly isRegisteredOccupantGeneration?: (nodeId: string, generation: string) => boolean;

  constructor(deps: AgentActivityStoreDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.freshnessMs = deps.freshnessMs ?? AGENT_ACTIVITY_FRESHNESS_MS;
    this.resolveOccupantGeneration = deps.resolveOccupantGeneration;
    this.isRegisteredOccupantGeneration = deps.isRegisteredOccupantGeneration;
  }

  recordHookEvent(input: HookActivityInput): RecordHookActivityResult {
    if (!input.sessionName && !input.nodeId) {
      return {
        ok: false,
        code: "missing_session_identity",
        error: "Hook activity requires a managed sessionName or nodeId",
      };
    }

    const session = this._resolveSession(input);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        error: "Hook activity did not match a managed session. List seats with: rig ps --nodes",
      };
    }

    const sampledAt = this.now().toISOString();
    const eventAt = parseTimestamp(input.occurredAt) ?? sampledAt;
    // W2a-1 — SOURCE-BOUND stamp: the emitting occupant's generation is CARRIED on the hook (supplied
    // by the producer/relay at fire time, ingested by the route), NEVER inferred from record-time
    // state. A delayed prior-occupant hook recorded after a new tenure minted carries its OWN (prior)
    // generation, so the read detects a mismatch rather than crediting it to the live occupant — and
    // this is immune to boot_at precision / clock skew because nothing is timed. Absent (the relay/env
    // producer-carry is a filed prerequisite, inert until it lands) ⇒ null ⇒ unresolved at read (the
    // P21 claimed-era pattern: absence recorded as its own state, never false-fresh). No record-time
    // resolver call — the live-gen resolver is used only at READ, for the comparison.
    const generation = input.generation ?? null;
    const activity = normalizeHookActivity({
      runtime: input.runtime ?? session.runtime,
      hookEvent: input.hookEvent,
      subtype: input.subtype ?? null,
      sampledAt,
      eventAt,
      generation,
    });

    const event = this.eventBus.emit({
      type: "agent.activity",
      rigId: session.rig_id,
      nodeId: session.node_id,
      sessionName: session.session_name,
      runtime: activity.runtime ?? session.runtime,
      activity,
    });

    return { ok: true, activity, event };
  }

  getLatestForNode(input: {
    nodeId?: string | null;
    sessionName?: string | null;
    now?: Date;
  }): AgentActivity | null {
    const nodeId = input.nodeId ?? (input.sessionName ? this._resolveSession({ sessionName: input.sessionName })?.node_id : null);
    if (!nodeId) return null;

    const row = this.db.prepare(
      "SELECT payload FROM events WHERE node_id = ? AND type = 'agent.activity' ORDER BY seq DESC LIMIT 1"
    ).get(nodeId) as EventPayloadRow | undefined;
    if (!row) return null;

    const payload = parseActivityPayload(row.payload);
    if (!payload?.activity) return null;

    const activity = payload.activity;
    if (input.sessionName && payload.sessionName !== input.sessionName) return null;

    const referenceTime = input.now ?? this.now();

    // W2a-1 — compare-at-read against the shipped occupant-tenure generation_uuid (pm ruling
    // 2026-08-08, the fully-specified Variant C):
    //  (1) the carried generation is REGISTERED FOR THIS NODE and differs from live ⇒ MISMATCH:
    //      positive evidence the claim belongs to a prior, dead tenure ⇒ unknown +
    //      `generation_mismatch`, stale:true, provenance RESOLVED. An unregistered prelaunch
    //      reservation is absence of evidence and stays UNRESOLVABLE, never mismatch.
    //  (2) both known and EQUAL (incl. a same-native-session relaunch — the ledger treats it as a
    //      continuation with no new generation) ⇒ provenance RESOLVED, deliver normally (fresh).
    //  (3) null on EITHER side ⇒ UNRESOLVABLE: ABSENCE of evidence, not a dead-tenure finding. State
    //      UNKNOWN + its distinct reason, stale:true — NEVER fresh (fresh is a positive liveness claim
    //      the seat has not earned; marking null-tenure fresh is bare-attribution one field over). The
    //      STORE delivers the row carrying generationProvenance='unresolved' at the ACTIVITY layer. The
    //      tap's discard-condition change that turns this label into a still-flowing consumer row is a
    //      FOLLOW-ON (qitem-20260808183747-f7f04662, verify-demotion) — NOT this fold; in the INTERIM
    //      the unchanged tap still discards it (a bounded regression whose exposure is the mint-race
    //      transient; mm2 is unaffected — its daemon carries no occupant_tenures table until 0.5.1).
    //      Ignorance and evidence get DIFFERENT verdicts; the two paths must not collapse.
    // Gate runs only when a resolver is injected (else legacy clock-only, no label).
    let generationProvenance: "resolved" | "unresolved" | undefined;
    if (this.resolveOccupantGeneration) {
      let liveGeneration: string | null;
      try {
        liveGeneration = this.resolveOccupantGeneration(nodeId);
      } catch {
        // Resolver EXCEPTION (e.g. a transient ledger/db fault) ⇒ DEGRADE to a distinct unknown
        // branch: never crash the read, never render fresh. Distinct from a clean null (unresolvable).
        return this.generationDegraded(activity, referenceTime);
      }
      const recordedGeneration = activity.generation ?? null;
      if (liveGeneration !== null && recordedGeneration !== null) {
        if (this.isRegisteredOccupantGeneration) {
          let registered: boolean;
          try {
            registered = this.isRegisteredOccupantGeneration(nodeId, recordedGeneration);
          } catch {
            return this.generationDegraded(activity, referenceTime);
          }
          if (!registered) {
            return this.generationUnresolved(activity, referenceTime, "generation_unresolvable");
          }
        }
        if (recordedGeneration !== liveGeneration) {
          return this.generationMismatch(activity, referenceTime);
        }
        generationProvenance = "resolved";
      } else {
        return this.generationUnresolved(
          activity,
          referenceTime,
          liveGeneration === null ? "generation_unresolvable" : "generation_unverifiable",
        );
      }
    }

    const eventTime = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (Number.isFinite(eventTime) && referenceTime.getTime() - eventTime > this.freshnessMs) {
      return {
        ...activity,
        state: "unknown",
        reason: "stale_runtime_hook",
        evidenceSource: "runtime_hook",
        sampledAt: referenceTime.toISOString(),
        fallback: false,
        stale: true,
        generationProvenance,
      };
    }

    return {
      ...activity,
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: false,
      generationProvenance,
    };
  }

  /** W2a-1 — the dead-tenure verdict: the claim's occupant generation is REGISTERED FOR THIS NODE and
   *  DIFFERENT from the live generation. The membership gate runs before this helper, so an uncommitted
   *  reservation can never manufacture a positive dead-tenure finding.
   *  It must not be honored as the live seat. Returns unknown + `generation_mismatch`,
   *  stale:true (detection fires), provenance `resolved` (both generations WERE resolved — they simply
   *  differ). This is the ONLY generation case that abstains; a null on either side is UNRESOLVED
   *  provenance and is DELIVERED labelled, never routed here. */
  private generationMismatch(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_mismatch",
      generationProvenance: "resolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1 — the UNRESOLVABLE-provenance verdict (ABSENCE of evidence, not a dead-tenure finding).
   *  State UNKNOWN + a distinct reason + stale:true so no consumer reads it as verified-live (fresh is
   *  a positive liveness claim). The STORE delivers the row carrying generationProvenance:"unresolved"
   *  at the ACTIVITY layer; turning that label into a still-flowing CONSUMER row is the tap FOLLOW-ON
   *  (verify-demotion, qitem-20260808183747-f7f04662) — the unchanged tap still discards it in the
   *  INTERIM (a bounded regression, mint-race-transient exposure; mm2 has no occupant_tenures table
   *  until 0.5.1). Kept DISTINCT from generationMismatch: ignorance and evidence get different verdicts,
   *  and the paths must not collapse — at the store now, and at the tap when the follow-on lands. */
  private generationUnresolved(
    activity: AgentActivity,
    referenceTime: Date,
    reason: "generation_unresolvable" | "generation_unverifiable",
  ): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason,
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  /** W2a-1 — the resolver-EXCEPTION verdict: the live-generation resolver threw (a transient ledger/db
   *  fault). DEGRADE to unknown + a DISTINCT reason (`generation_resolver_error`) + stale:true, so the
   *  read never crashes and the claim is never rendered fresh; provenance `unresolved`. Kept separate
   *  from a clean null (unresolvable) so a resolver FAULT is distinguishable from an honest ABSENCE. */
  private generationDegraded(activity: AgentActivity, referenceTime: Date): AgentActivity {
    return {
      ...activity,
      state: "unknown",
      reason: "generation_resolver_error",
      generationProvenance: "unresolved",
      evidenceSource: "runtime_hook",
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: true,
    };
  }

  resolveSession(input: { sessionName?: string | null; nodeId?: string | null; runtime?: string | null }): { sessionId: string; rigId: string; nodeId: string; sessionName: string } | null {
    const row = this._resolveSession(input);
    if (!row) return null;
    const sessionRow = this.db.prepare(
      "SELECT id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1"
    ).get(row.session_name) as { id: string } | undefined;
    if (!sessionRow) return null;
    return { sessionId: sessionRow.id, rigId: row.rig_id, nodeId: row.node_id, sessionName: row.session_name };
  }

  private _resolveSession(input: { sessionName?: string | null; nodeId?: string | null }): SessionLookupRow | null {
    if (input.nodeId) {
      const row = this.db.prepare(`
        SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
        FROM nodes n
        LEFT JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        WHERE n.id = ?
        LIMIT 1
      `).get(input.nodeId) as SessionLookupRow | undefined;
      if (row?.session_name) return row;
    }

    if (!input.sessionName) return null;
    const row = this.db.prepare(`
      SELECT n.rig_id, n.id AS node_id, s.session_name, n.runtime
      FROM sessions s
      JOIN nodes n ON n.id = s.node_id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(input.sessionName) as SessionLookupRow | undefined;
    return row ?? null;
  }
}

function normalizeHookActivity(input: {
  runtime: string | null;
  hookEvent: string;
  subtype: string | null;
  sampledAt: string;
  eventAt: string;
  generation?: string | null;
}): AgentActivity {
  const rawEvent = input.hookEvent;
  const rawSubtype = input.subtype;
  const reason = normalizeReason(rawSubtype ?? rawEvent);
  const runtime = input.runtime;
  let state: AgentActivity["state"] = "unknown";
  let normalizedReason = reason;

  if (rawEvent === "UserPromptSubmit" || rawEvent === "PreToolUse" || rawEvent === "active") {
    state = "running";
  } else if (rawEvent === "PermissionRequest") {
    // OPR.0.4.1.10 — Codex's official approval hook (openai/codex PR #17563). A PermissionRequest
    // means the agent is BLOCKED waiting on a command / patch / network approval = needs_input. This is
    // the HOOK-PRIMARY signal for Codex, which emits no Claude-style Notification; classifySendReadiness
    // already prefers a fresh runtime_hook needs_input runtime-agnostically, so wiring this event makes
    // the Codex rig-send guard hook-primary by construction (capture-pane scan stays as the fallback).
    // The official payload carries session_id/turn_id/cwd/model/permission_mode/tool_name/tool_input;
    // the relay forwards tool_name as the subtype, so `evidence` names the tool being approved.
    state = "needs_input";
    normalizedReason = "permission_request";
  } else if (rawEvent === "Notification") {
    if (rawSubtype === "permission_prompt" || rawSubtype === "elicitation_dialog") {
      state = "needs_input";
    } else if (rawSubtype === "idle_prompt") {
      state = "idle";
    } else {
      state = "unknown";
      normalizedReason = rawSubtype ? reason : "notification";
    }
  } else if (rawEvent === "Stop" || rawEvent === "SessionEnd" || rawEvent === "stop" || rawEvent === "idle") {
    state = "idle";
  } else if (rawEvent === "SessionStart") {
    state = "unknown";
    normalizedReason = "session_start_observed";
  } else {
    state = "unknown";
    normalizedReason = "unmapped_runtime_hook";
  }

  return {
    state,
    reason: normalizedReason,
    evidenceSource: "runtime_hook",
    sampledAt: input.sampledAt,
    evidence: rawSubtype ?? rawEvent,
    eventAt: input.eventAt,
    rawEvent,
    rawSubtype,
    runtime,
    fallback: false,
    stale: false,
    generation: input.generation ?? null,
  };
}

function normalizeReason(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function parseTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function parseActivityPayload(payload: string): { sessionName?: string; activity?: AgentActivity } | null {
  try {
    return JSON.parse(payload) as { sessionName?: string; activity?: AgentActivity };
  } catch {
    return null;
  }
}
