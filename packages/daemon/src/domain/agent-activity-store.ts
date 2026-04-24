import type Database from "better-sqlite3";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity, PersistedEvent } from "./types.js";

const DEFAULT_FRESHNESS_MS = 5 * 60 * 1000;

export interface HookActivityInput {
  runtime: string | null;
  sessionName?: string | null;
  nodeId?: string | null;
  hookEvent: string;
  subtype?: string | null;
  occurredAt?: string | null;
}

export type RecordHookActivityResult =
  | { ok: true; activity: AgentActivity; event: PersistedEvent }
  | { ok: false; code: "missing_session_identity" | "session_not_found"; error: string };

interface AgentActivityStoreDeps {
  db: Database.Database;
  eventBus: EventBus;
  now?: () => Date;
  freshnessMs?: number;
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

  constructor(deps: AgentActivityStoreDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.freshnessMs = deps.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  }

  recordHookEvent(input: HookActivityInput): RecordHookActivityResult {
    if (!input.sessionName && !input.nodeId) {
      return {
        ok: false,
        code: "missing_session_identity",
        error: "Hook activity requires a managed sessionName or nodeId",
      };
    }

    const session = this.resolveSession(input);
    if (!session) {
      return {
        ok: false,
        code: "session_not_found",
        error: "Hook activity did not match a managed session. List seats with: rig ps --nodes",
      };
    }

    const sampledAt = this.now().toISOString();
    const eventAt = parseTimestamp(input.occurredAt) ?? sampledAt;
    const activity = normalizeHookActivity({
      runtime: input.runtime ?? session.runtime,
      hookEvent: input.hookEvent,
      subtype: input.subtype ?? null,
      sampledAt,
      eventAt,
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
    const nodeId = input.nodeId ?? (input.sessionName ? this.resolveSession({ sessionName: input.sessionName })?.node_id : null);
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
      };
    }

    return {
      ...activity,
      sampledAt: referenceTime.toISOString(),
      fallback: false,
      stale: false,
    };
  }

  private resolveSession(input: { sessionName?: string | null; nodeId?: string | null }): SessionLookupRow | null {
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
}): AgentActivity {
  const rawEvent = input.hookEvent;
  const rawSubtype = input.subtype;
  const reason = normalizeReason(rawSubtype ?? rawEvent);
  const runtime = input.runtime;
  let state: AgentActivity["state"] = "unknown";
  let normalizedReason = reason;

  if (rawEvent === "UserPromptSubmit" || rawEvent === "PreToolUse" || rawEvent === "active") {
    state = "running";
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
