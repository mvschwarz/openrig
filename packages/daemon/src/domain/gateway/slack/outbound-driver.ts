// S10 — the OUTBOUND driver: the gateway subsystem owns the outbound decision (the shape the
// M1 reconciliation named — queue poll + admission — now in-process). Each sweep selects the
// FRESH human alerts (slice-11 semantics preserved verbatim: qitemId-keyed durable seen-state,
// marked ONLY after delivered) and dispatches each through the subsystem wire, which persists
// the decision durably BEFORE delivery and retains it on failure (replay owns the retry).
//
// Duplicate-absence design (proof item: durability through failure):
//   - seen(qitemId): marked only after delivered-ok — the slice-11 at-least-once contract.
//   - inflight(qitemId), in-memory: a dispatched-but-unresolved qitem is not re-dispatched by
//     a later sweep — the durable buffer owns its retry (replay), never a second decision.
//   - at start(), inflight SEEDS from the durable buffer's pending decisions (payload carries
//     qitemId): after a daemon restart the replay path owns those qitems, so a sweep cannot
//     mint a second decisionId for the same alert — the restart double-dispatch window is
//     closed by construction. The only remaining duplicate is the locked contract's accepted
//     rare crash window (delivered but crashed before seen-mark/ack): byte-identical, never a drop.

import type { SeenStore } from "./state-store.js";
import type { AlertFilterOpts, OutboundQueuePort, QueueItem } from "./queue-access.js";
import type { DispatchResult } from "../dispatcher.js";
import { DispatchBuffer } from "../dispatch-buffer.js";

export const OUTBOUND_OP = "post_message";

/** The decision payload for op=post_message: the queue content the delivery layer renders.
 *  qitemId rides along as the idempotency anchor (seen-state key + the H reconcile marker). */
export interface OutboundPostPayload {
  qitemId: string;
  notificationKey?: string | null;
  ownerNotificationKind?: string | null;
  ownerNotificationLevel?: import("../../queue-transition-log.js").OwnerNotificationLevel | null;
  humanIntent?: "decision" | "update" | null;
  humanDetail?: string | null;
  /** #96: an update posted into this earlier qitem's thread (subsystem-resolved). */
  replyTo?: string | null;
  humanQuestions?: import("../../human-questions.js").HumanQuestion[] | null;
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
  sourceSession?: string | null;
  evidenceRef?: string | null;
  /** F: the loudness discriminators (interim rule: escalations mention, all else quiet). */
  tier?: string | null;
  tags?: string[] | null;
  /** #1013 — the row's state, so the renderer can tell a gate PARKED on a human
   *  (state=blocked) from the same row while an agent seat owns it. */
  state?: string | null;
}

export interface OutboundDriverDeps {
  home: string;
  queue: OutboundQueuePort;
  seen: SeenStore;
  filter: AlertFilterOpts;
  /** Dispatch into the subsystem wire (durable-first). Injected: the driver never posts itself. */
  dispatch: (op: string, entityBindingRef: string, payload: unknown) => DispatchResult;
  /** Called by the delivery layer's ack path? No — the WIRE acks; the driver learns success by
   *  the seen-store the delivery layer marks. This callback seam is for tests observing sweeps. */
  onSweep?: (result: SweepResult) => void;
  intervalMs?: number;
  log?: (msg: string) => void;
}

export interface SweepResult {
  alerts: number;
  fresh: number;
  dispatched: string[]; // qitemIds
  refused: { qitemId: string; error: string }[];
}

export class SlackOutboundDriver {
  private readonly inflight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;

  constructor(private readonly deps: OutboundDriverDeps) {}

  /** Seed inflight from the durable buffer (restart no-double-dispatch), then start the poll. */
  start(): void {
    try {
      for (const d of new DispatchBuffer(this.deps.home).pending()) {
        const payload = d.payload as OutboundPostPayload | undefined;
        const key = payload?.notificationKey ?? payload?.qitemId;
        if (key) this.inflight.add(key);
      }
    } catch { /* unreadable buffer: replay still dedups by decisionId at delivery */ }
    const interval = this.deps.intervalMs ?? 30000;
    this.timer = setInterval(() => void this.sweepOnce(), interval);
    if (typeof (this.timer as unknown as { unref?: () => void }).unref === "function") {
      (this.timer as unknown as { unref: () => void }).unref();
    }
  }

  /** One sweep: fresh = active human alerts minus seen minus inflight. Dispatch each. */
  async sweepOnce(): Promise<SweepResult> {
    if (this.sweeping) return { alerts: 0, fresh: 0, dispatched: [], refused: [] };
    this.sweeping = true;
    try {
      const alerts = await this.deps.queue.listHumanAlerts(this.deps.filter);
      const seen = this.deps.seen.load();
      const fresh = alerts.filter((q) => !seen.has(notificationKey(q)) && !this.inflight.has(notificationKey(q)));
      const dispatched: string[] = [];
      const refused: { qitemId: string; error: string }[] = [];
      for (const alert of fresh) {
        // Marked in flight BEFORE dispatching: the delivery layer can run synchronously inside dispatch and release the
        // key (a deferred decision does), and that release must win over this mark, or the ask is never offered again.
        const key = notificationKey(alert);
        this.inflight.add(key);
        let res: DispatchResult;
        try {
          res = this.deps.dispatch(OUTBOUND_OP, alert.destinationSession ?? "(unknown)", toPayload(alert));
        } catch (error) {
          // A throw after the decision was persisted leaves it pending in the durable buffer, and replay owns it: the key
          // stays in flight, or the next sweep would make a second decision (a duplicate post). A throw before
          // persistence left nothing durable: the key is cleared so the next sweep offers the ask again. The catch only
          // ever clears, so a release the delivery layer already made still stands. Either way, the sweep goes on.
          if (!this.pendingInBuffer(key)) this.inflight.delete(key);
          const message = `dispatch threw: ${(error as Error).message}`;
          refused.push({ qitemId: alert.qitemId, error: message });
          this.deps.log?.(`outbound dispatch failed for ${alert.qitemId}: ${message}`);
          continue;
        }
        if (res.ok) {
          dispatched.push(alert.qitemId);
        } else {
          this.inflight.delete(key);
          // Refused (e.g. delivery layer unconfigured → op unadvertised): honest, retried next
          // sweep — nothing durable was minted, so this is not a retained decision.
          refused.push({ qitemId: alert.qitemId, error: res.error });
          this.deps.log?.(`outbound dispatch refused for ${alert.qitemId}: ${res.error}`);
        }
      }
      const result = { alerts: alerts.length, fresh: fresh.length, dispatched, refused };
      this.deps.onSweep?.(result);
      return result;
    } finally {
      this.sweeping = false;
    }
  }

  /** Whether the durable buffer holds a pending decision for this key (the rule start() reseeds by). A buffer that can't
   *  be read counts as pending: waiting for the restart reseed is better than a duplicate post. */
  private pendingInBuffer(key: string): boolean {
    try {
      return new DispatchBuffer(this.deps.home).pendingStrict().some((d) => {
        const payload = d.payload as OutboundPostPayload | undefined;
        return (payload?.notificationKey ?? payload?.qitemId) === key;
      });
    } catch {
      return true;
    }
  }

  /** The delivery layer is done with an offer — release the in-memory guard. The guard is keyed by notification key
   *  (`qitemId:transitionId` for a real alert); a caller that passes the bare qitem id releases nothing for such a key,
   *  which is harmless when it has also marked the key seen (the sweep excludes seen keys) but not otherwise. */
  release(key: string): void {
    this.inflight.delete(key);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function toPayload(q: QueueItem): OutboundPostPayload {
  return {
    qitemId: q.qitemId,
    notificationKey: q.notificationKey,
    ownerNotificationKind: q.ownerNotificationKind,
    ownerNotificationLevel: q.ownerNotificationLevel,
    humanIntent: q.humanIntent,
    humanDetail: q.humanDetail,
    replyTo: q.replyTo,
    humanQuestions: q.humanQuestions,
    summary: q.summary,
    body: q.body,
    destinationSession: q.destinationSession,
    sourceSession: q.sourceSession,
    evidenceRef: q.evidenceRef,
    tier: q.tier,
    tags: q.tags,
    state: q.state,
  };
}

function notificationKey(q: QueueItem): string {
  return q.notificationKey ?? q.qitemId;
}
