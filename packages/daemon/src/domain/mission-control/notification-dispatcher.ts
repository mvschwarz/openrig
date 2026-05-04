// PL-005 Phase B: Mission Control notification dispatcher.
//
// Subscribes to relevant events on the EventBus and POSTs through the
// configured notification adapter (ntfy default; webhook alternate).
// Best-effort delivery; failure does NOT interrupt the underlying
// action being notified about (PRD invariant). Emits `mission_control
// .notification_sent` / `_failed` for the audit trail.
//
// Triggers (Phase B v0):
//   - Mandatory: human-gate qitem arrival. Detected via the
//     `queue.created` event (Phase A coordination event) where the
//     created qitem's tier == "human-gate".
//   - Optional: verb completion. When opts.includeVerbCompletion is
//     true, `mission_control.action_executed` events also dispatch.
//
// Single notification target (the operator's phone). MVP context:
// no multi-user routing, no per-user opt-in matrix.

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { PersistedEvent } from "../types.js";
import type {
  NotificationAdapter,
  NotificationPayload,
} from "./notification-adapter-types.js";

export interface NotificationDispatcherDeps {
  db: Database.Database;
  eventBus: EventBus;
  adapter: NotificationAdapter;
  /**
   * When true, dispatch on `mission_control.action_executed` events
   * (verb completion). Default false: only human-gate arrivals
   * trigger by default (per planner brief mandatory trigger).
   */
  includeVerbCompletion?: boolean;
  missionControlBaseUrl?: string;
  now?: () => Date;
}

interface QueueRow {
  qitem_id: string;
  source_session: string;
  destination_session: string;
  tier: string | null;
  body: string;
}

export class MissionControlNotificationDispatcher {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly adapter: NotificationAdapter;
  private readonly includeVerbCompletion: boolean;
  private readonly missionControlBaseUrl: string | null;
  private readonly now: () => Date;
  private unsubscribe: (() => void) | null = null;
  /** Per-(qitem_id, mechanism) drop set for once-per-qitem dedup. */
  private readonly dispatchedKeys = new Set<string>();

  constructor(deps: NotificationDispatcherDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.adapter = deps.adapter;
    this.includeVerbCompletion = Boolean(deps.includeVerbCompletion);
    this.missionControlBaseUrl = normalizeBaseUrl(deps.missionControlBaseUrl);
    this.now = deps.now ?? (() => new Date());
  }

  /** Subscribe to relevant EventBus events. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  /** Unsubscribe + clear dedup set. Idempotent. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.dispatchedKeys.clear();
  }

  /**
   * Send a synthetic notification through the configured adapter so
   * the operator can verify their setup. Used by the
   * `POST /api/mission-control/notifications/test` route.
   */
  async sendTest(): Promise<{
    mechanism: string;
    target: string;
    ok: boolean;
    ack?: string;
    error?: string;
  }> {
    const payload: NotificationPayload = {
      title: "Mission Control test notification",
      body: `Synthetic test from OpenRig daemon at ${this.now().toISOString()}`,
      tags: ["openrig", "mission-control", "test"],
    };
    const result = await this.adapter.send(payload);
    if (result.ok) {
      this.emitSent(null, "test");
    } else {
      this.emitFailed(null, result.error ?? "unknown");
    }
    return {
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      ok: result.ok,
      ack: result.ack,
      error: result.error,
    };
  }

  private async handleEvent(event: PersistedEvent): Promise<void> {
    if (event.type === "queue.created") {
      const qitem = this.lookupQitem(event.qitemId);
      if (!qitem || qitem.tier !== "human-gate") return;
      // Mandatory trigger: human-gate qitem arrival.
      await this.dispatch({
        triggerKind: "human-gate-arrival",
        qitemId: qitem.qitem_id,
        title: "human-gate qitem arrived",
        body:
          `New human-gate qitem ${qitem.qitem_id} from ${qitem.source_session} → ${qitem.destination_session}\n\n` +
          truncateBody(qitem.body, 280),
        tags: ["openrig", "mission-control", "human-gate"],
      });
      return;
    }
    if (event.type === "mission_control.action_executed" && this.includeVerbCompletion) {
      await this.dispatch({
        triggerKind: "verb-completion",
        qitemId: event.qitemId,
        title: `verb completed: ${event.actionVerb}`,
        body: `Mission Control verb ${event.actionVerb} on qitem ${event.qitemId ?? "(none)"} by ${event.actorSession}`,
        tags: ["openrig", "mission-control", "verb-complete"],
      });
      return;
    }
  }

  private async dispatch(input: {
    /** Used as part of the dedup key so different triggers about the
     * same qitem don't suppress each other (human-gate-arrival and
     * verb-completion are distinct events). */
    triggerKind: string;
    qitemId: string | null;
    title: string;
    body: string;
    tags?: string[];
  }): Promise<void> {
    const dedupKey = `${input.qitemId ?? "no-qitem"}::${input.triggerKind}::${this.adapter.mechanism}`;
    if (this.dispatchedKeys.has(dedupKey)) return;
    this.dispatchedKeys.add(dedupKey);
    const result = await this.adapter.send({
      title: input.title,
      body: input.body,
      qitemRef: this.qitemRef(input.qitemId),
      tags: input.tags,
    });
    if (result.ok) {
      this.emitSent(input.qitemId, result.ack ?? "ok");
    } else {
      this.emitFailed(input.qitemId, result.error ?? "unknown");
    }
  }

  private emitSent(qitemId: string | null, _ack: string): void {
    this.eventBus.emit({
      type: "mission_control.notification_sent",
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      qitemId,
      sentAt: this.now().toISOString(),
    });
  }

  private emitFailed(qitemId: string | null, error: string): void {
    this.eventBus.emit({
      type: "mission_control.notification_failed",
      mechanism: this.adapter.mechanism,
      target: this.adapter.target,
      qitemId,
      error,
      failedAt: this.now().toISOString(),
    });
  }

  private lookupQitem(qitemId: string): QueueRow | null {
    const row = this.db
      .prepare(
        `SELECT qitem_id, source_session, destination_session, tier, body
           FROM queue_items WHERE qitem_id = ? LIMIT 1`,
      )
      .get(qitemId) as QueueRow | undefined;
    return row ?? null;
  }

  private qitemRef(qitemId: string | null): string | undefined {
    if (!qitemId) return undefined;
    if (!this.missionControlBaseUrl) return qitemId;
    const url = new URL("/mission-control", this.missionControlBaseUrl);
    url.searchParams.set("view", "human-gate");
    url.searchParams.set("qitem", qitemId);
    return url.toString();
  }

  /** Test/observability: clear once-per-qitem dedup set. */
  resetDedupForTest(): void {
    this.dispatchedKeys.clear();
  }
}

function truncateBody(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function normalizeBaseUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.toString();
  } catch {
    return null;
  }
}
