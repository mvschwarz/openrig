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
  summary?: string | null;
  body?: string | null;
  destinationSession?: string | null;
  sourceSession?: string | null;
  evidenceRef?: string | null;
  /** F: the loudness discriminators (interim rule: escalations mention, all else quiet). */
  tier?: string | null;
  tags?: string[] | null;
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
        const q = (d.payload as OutboundPostPayload | undefined)?.qitemId;
        if (q) this.inflight.add(q);
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
      const fresh = alerts.filter((q) => !seen.has(q.qitemId) && !this.inflight.has(q.qitemId));
      const dispatched: string[] = [];
      const refused: { qitemId: string; error: string }[] = [];
      for (const alert of fresh) {
        const res = this.deps.dispatch(OUTBOUND_OP, alert.destinationSession ?? "(unknown)", toPayload(alert));
        if (res.ok) {
          this.inflight.add(alert.qitemId);
          dispatched.push(alert.qitemId);
        } else {
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

  /** The delivery layer marked a qitem seen (delivered) — release the in-memory guard. */
  release(qitemId: string): void {
    this.inflight.delete(qitemId);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

function toPayload(q: QueueItem): OutboundPostPayload {
  return {
    qitemId: q.qitemId,
    summary: q.summary,
    body: q.body,
    destinationSession: q.destinationSession,
    sourceSession: q.sourceSession,
    evidenceRef: q.evidenceRef,
    tier: q.tier,
    tags: q.tags,
  };
}
