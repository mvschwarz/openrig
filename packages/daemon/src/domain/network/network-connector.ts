// The outbound connector: for each active network binding, reach the hub as that participant, take the items addressed
// to it into the bound local seat's queue, and carry what happens locally back to the hub item.
//
// Honest stages, kept apart on the hub item:
// - a hub claim is the connector taking custody of the item, not the agent picking it up;
// - "picked up" is reported only once the local item is claimed;
// - the result is the local item's own closing outcome.
//
// Each hub item maps to one local item, under an id derived from what it is: the seat's node, the hub, the participant
// and the hub item. The queue's same-id absorption makes every retry, restart or new binding for the same seat, hub and
// participant land on that one item, so a lost response never starts a second one. An item whose local record is gone
// reads unknown and is never run again.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { QueueRepositoryError, type QueueItem, type QueueRepository } from "../queue-repository.js";
import { NetworkBindingError, readNetworkCredential, type NetworkBinding, type NetworkBindingStore } from "./network-bindings.js";
import { connectMcpHub, HubError, type HubConnect, type HubItem, type HubSession } from "./hub-client.js";

/** OpenRig's own sender: the connector creates the local item for the hub's requester, who is named first in it. */
const LOCAL_SOURCE = "daemon@kernel";
const PAGE = 25;
const MAX_PAGES = 8;
/** Receipts looked at per pass, the least recently looked at first, so a long backlog still gives every item a turn. */
const REPORT_LIMIT = 50;
/** How long one binding's pass may take before its connection is closed, so one slow hub can't hold the others. */
const PASS_TIMEOUT_MS = 60_000;

/** The local item for a hub item, by what it is. A retry, a restart or a new binding for the same seat, hub and
 *  participant lands on the same item. */
export function networkLocalItemId(binding: Pick<NetworkBinding, "nodeId" | "hubUrl" | "hubSeat">, hubQitemId: string): string {
  return `qitem-net-${createHash("sha256").update([binding.nodeId, binding.hubUrl, binding.hubSeat, hubQitemId].join("\n")).digest("hex").slice(0, 20)}`;
}

export interface NetworkConnectorDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  bindings: NetworkBindingStore;
  home: string;
  connect?: HubConnect;
  now?: () => Date;
  log?: (line: string) => void;
  passTimeoutMs?: number;
  reportLimit?: number;
}

export interface NetworkPassResult {
  bindingId: string;
  taken: number;
  pickupsSent: number;
  resultsSent: number;
  unknown: number;
  /** Why the pass stopped early, if it did. `revoked` ended the binding; `no_session` left the hub's items pending;
   *  `local` is a failure here, not the hub's. */
  error?: HubError["kind"] | "credential" | "no_session" | "http_not_allowed" | "local";
}

/** The seat's current address: the node's latest session, as the queue's other node lookups read it. */
function currentSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

interface Receipt {
  local_qitem_id: string; binding_id: string; hub_qitem_id: string; queued_sent_at: string | null; pickup_sent_at: string | null;
  settled_at: string | null; outcome: string | null;
}

/** The states a local item ends in. A handed-off local item ends at its successor, which is followed. */
const FINAL = new Set(["done", "canceled", "denied", "failed"]);
/** The states in which the hub item is closed to this connector. A hub item handed on by someone there is closed here:
 *  its successor isn't followed, and it's never written to again. */
const HUB_CLOSED = new Set([...FINAL, "handed-off"]);

/** One pass for one binding, bounded by its deadline and the connector's stop. Never throws: a failure is recorded on
 *  the binding and returned. */
export async function runNetworkBindingPass(deps: NetworkConnectorDeps, binding: NetworkBinding,
  opts: { signal?: AbortSignal } = {}): Promise<NetworkPassResult> {
  const now = deps.now ?? (() => new Date());
  const result: NetworkPassResult = { bindingId: binding.id, taken: 0, pickupsSent: 0, resultsSent: 0, unknown: 0 };
  // The token goes to a plain-http hub only on the person's recorded choice for this binding.
  if (binding.unencrypted && !binding.allowHttp) {
    deps.bindings.recordError(binding.id, `${binding.hubUrl} is plain http and this binding has no --allow-http choice, so its token isn't sent. Connect again with the hub's https URL, or with --allow-http.`);
    return { ...result, error: "http_not_allowed" };
  }
  let token: string;
  try {
    token = readNetworkCredential(deps.home, binding.id);
  } catch (error) {
    deps.bindings.recordError(binding.id, error instanceof NetworkBindingError ? error.message : String(error));
    return { ...result, error: "credential" };
  }

  const timeoutMs = deps.passTimeoutMs ?? PASS_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref?.();
  const onStop = () => deadline.abort();
  if (opts.signal?.aborted) deadline.abort();
  opts.signal?.addEventListener("abort", onStop, { once: true });
  // Checked before every take, and again just before a local item is made: an ended binding, the pass's deadline or
  // the connector's stop starts no local work, even when a hub answer arrives late.
  const live = () => !deadline.signal.aborted && deps.bindings.get(binding.id)?.state === "active";

  let hub: HubSession | null = null;
  try {
    hub = await (deps.connect ?? connectMcpHub)(binding.hubUrl, token, deadline.signal);
    // Work goes to the seat at its current address. With no session there's nobody to give it to, so nothing is taken.
    const destination = currentSession(deps.db, binding.nodeId);
    if (destination) {
      // What this participant already holds (claimed before a restart, or through an earlier binding) comes first.
      for (const held of await hub.listOwned("in-progress", PAGE * MAX_PAGES)) {
        if (!live()) break;
        if (held.destinationSession === binding.hubSeat && await ensureLocal(deps, binding, hub, held, destination, now, live)) result.taken++;
      }
      // New work, a page at a time: a claim moves an item out of pending, so each page is new items.
      for (let page = 0; page < MAX_PAGES && live(); page++) {
        const pending = await hub.listOwned("pending", PAGE);
        for (const item of pending) {
          if (!live()) break;
          if (item.destinationSession !== binding.hubSeat) continue;
          try {
            await hub.claim(item.qitemId);
          } catch (error) {
            // Another claimant, or the item closed meanwhile: it isn't this binding's to take.
            if (error instanceof HubError && error.kind === "refused") continue;
            throw error;
          }
          if (await ensureLocal(deps, binding, hub, item, destination, now, live)) result.taken++;
        }
        if (pending.length < PAGE) break;
      }
    }
    // Report back what happened locally, for the items this binding holds. A revoked binding never gets here.
    if (live()) await reportBack(deps, binding, hub, now, result);
    deps.bindings.recordContact(binding.id, now());
    if (!destination) {
      deps.bindings.recordError(binding.id, `${binding.localSession} has no session here, so its hub items stay pending until it has one.`);
      return { ...result, error: "no_session" };
    }
    return result;
  } catch (error) {
    if (deadline.signal.aborted) {
      deps.bindings.recordError(binding.id, opts.signal?.aborted
        ? "The connector stopped during this pass and closed its connection to the hub."
        : `This pass took longer than ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}, so its connection to the hub was closed. The next pass tries again.`);
      return { ...result, error: "unavailable" };
    }
    // Only the hub session's own failures are the hub's (it reports them as HubError); anything else happened here.
    if (!(error instanceof HubError)) {
      deps.bindings.recordError(binding.id, `A local error stopped this pass: ${error instanceof Error ? error.message : String(error)}`);
      return { ...result, error: "local" };
    }
    if (error.kind === "revoked") {
      try {
        deps.bindings.markRevoked(binding.id, error.message);
      } catch (cleanup) {
        // The binding is revoked either way; only its credential's removal failed, and the error says how to retry.
        if (!(cleanup instanceof NetworkBindingError) || cleanup.code !== "credential_cleanup_failed") throw cleanup;
        deps.bindings.recordError(binding.id, cleanup.message);
      }
      deps.log?.(`network ${binding.id}: revoked by the hub; no new work comes in through it`);
    } else {
      deps.bindings.recordError(binding.id, error.message);
    }
    return { ...result, error: error.kind };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onStop);
    await hub?.end();
  }
}

/** The local item for a hub item this participant holds: created once, or found again. Returns true when it was new. */
async function ensureLocal(deps: NetworkConnectorDeps, binding: NetworkBinding, hub: HubSession, item: HubItem, destination: string,
  now: () => Date, live: () => boolean): Promise<boolean> {
  const localId = networkLocalItemId(binding, item.qitemId);
  const taken = deps.db.prepare("SELECT binding_id FROM network_receipts WHERE local_qitem_id = ?").get(localId) as { binding_id: string } | undefined;
  if (taken) {
    // Taken already, perhaps through an earlier binding for this seat, hub and participant: this binding reports it now,
    // with what was already sent and its outcome, unknown included, kept.
    if (taken.binding_id !== binding.id) deps.db.prepare("UPDATE network_receipts SET binding_id = ? WHERE local_qitem_id = ?").run(binding.id, localId);
    return false;
  }
  const full = item.body == null ? await hub.show(item.qitemId) : item;
  if (!live()) return false;
  let outcome: string | null = null;
  try {
    await deps.queueRepo.create({
      qitemId: localId,
      sourceSession: LOCAL_SOURCE,
      destinationSession: destination,
      // Where it came from is read first: the requester and the hub, before the requester's own words.
      summary: full.summary ? `From ${item.sourceSession} via network hub: ${full.summary}` : `From ${item.sourceSession} via network hub`,
      body: [
        `From ${item.sourceSession} through the network hub ${binding.hubUrl}, as ${binding.hubSeat} (hub item ${item.qitemId}).`,
        "",
        full.body ?? "",
        "",
        "---",
        `Answer by closing this item with your result: rig queue update ${localId} --state done --closure-reason no-follow-on --resolution "<your answer>".`,
        "OpenRig returns the resolution to the hub item.",
      ].join("\n"),
      tags: [`network-binding:${binding.id}`, `network-hub-item:${item.qitemId}`],
    });
  } catch (error) {
    const code = error instanceof QueueRepositoryError ? error.code : null;
    // Its id was used before and its record erased: whether it ran is unknown, and it's never run again. The hub hears
    // that from reportBack, which retries the note until it lands.
    if (code === "qitem_erased") outcome = "unknown";
    // The same id with another destination: the seat's address changed between attempts; the item already exists.
    else if (code !== "qitem_id_reuse" || !deps.queueRepo.getById(localId)) throw error;
  }
  const inserted = deps.db.prepare(`INSERT INTO network_receipts (local_qitem_id, binding_id, hub_qitem_id, created_at, outcome)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(localId, binding.id, item.qitemId, now().toISOString(), outcome).changes > 0;
  // Every stage note, queued included, goes out from reportBack, which marks it sent only once it lands.
  return inserted && outcome === null;
}

/** The item a local item ends at, following local handoffs: a successor names the item it came from. Null when a
 *  handed-off item has no one successor here (handed to another host, or the record is gone): its outcome is unknown. */
function finalItem(repo: QueueRepository, start: QueueItem): QueueItem | null {
  let current = start;
  for (let hop = 0; hop < 20 && current.state === "handed-off"; hop++) {
    const next = repo.list({ handedOffFrom: current.qitemId, limit: 2 });
    if (next.length !== 1) return null;
    current = next[0]!;
  }
  return current.state === "handed-off" ? null : current;
}

/** What the hub hears as the result: the resolution, else the closer's own note on the close itself. The close is read
 *  with `closingTransition`, since later notes on a closed item repeat its state. Other notes on the item can be
 *  OpenRig's or another seat's, and name local seats, so they're never sent. */
function closingWords(repo: QueueRepository, item: QueueItem): string {
  if (item.resolution) return item.resolution;
  const close = repo.closingTransition(item.qitemId, item.state);
  return close?.transitionNote && close.actorSession === item.destinationSession ? close.transitionNote : "Closed without a stated result.";
}

/** The hub items a binding's result never reached because someone else closed them first, for status. */
export function networkClosedElsewhere(db: Database.Database, bindingId: string): Array<{ hubItem: string; localItem: string; note: string | null }> {
  return (db.prepare("SELECT hub_qitem_id, local_qitem_id, last_error FROM network_receipts WHERE binding_id = ? AND outcome = 'closed_on_hub' ORDER BY settled_at, local_qitem_id")
    .all(bindingId) as Array<{ hub_qitem_id: string; local_qitem_id: string; last_error: string | null }>)
    .map((row) => ({ hubItem: row.hub_qitem_id, localItem: row.local_qitem_id, note: row.last_error }));
}

async function reportBack(deps: NetworkConnectorDeps, binding: NetworkBinding, hub: HubSession, now: () => Date, result: NetworkPassResult): Promise<void> {
  const open = deps.db.prepare(`SELECT * FROM network_receipts WHERE binding_id = ? AND settled_at IS NULL
    ORDER BY COALESCE(checked_at, ''), created_at LIMIT ?`).all(binding.id, deps.reportLimit ?? REPORT_LIMIT) as Receipt[];
  const mark = (column: "queued_sent_at" | "pickup_sent_at" | "settled_at", receipt: Receipt, outcome?: string, lastError: string | null = null) =>
    deps.db.prepare(`UPDATE network_receipts SET ${column} = ?, outcome = COALESCE(?, outcome), last_error = ? WHERE local_qitem_id = ?`)
      .run(now().toISOString(), outcome ?? null, lastError, receipt.local_qitem_id);
  for (const receipt of open) {
    deps.db.prepare("UPDATE network_receipts SET checked_at = ? WHERE local_qitem_id = ?").run(now().toISOString(), receipt.local_qitem_id);
    try {
      const local = deps.queueRepo.getById(receipt.local_qitem_id);
      const unknown = async (why: string) => {
        await hub.note(receipt.hub_qitem_id, why);
        mark("settled_at", receipt, "unknown");
        result.unknown++;
      };
      if (!local || receipt.outcome === "unknown") {
        await unknown(`This item's local record (${receipt.local_qitem_id}) is gone, so whether it ran is unknown. It won't be run again.`);
        continue;
      }
      if (!receipt.queued_sent_at) {
        await hub.note(receipt.hub_qitem_id, `Queued for the connected local seat as ${local.qitemId}. Not picked up yet.`);
        mark("queued_sent_at", receipt);
      }
      if (!receipt.pickup_sent_at && local.claimedAt) {
        await hub.note(receipt.hub_qitem_id, `Picked up by the local seat at ${local.claimedAt}.`);
        mark("pickup_sent_at", receipt);
        result.pickupsSent++;
      }
      const end = local.state === "handed-off" ? finalItem(deps.queueRepo, local) : local;
      if (!end) {
        await unknown(`This item was handed on from ${local.qitemId} without one successor here, so its outcome is unknown. It won't be run again.`);
        continue;
      }
      if (!FINAL.has(end.state)) continue;
      // The hub item closes the way the queue closes one: done with the local closure reason, or failed. A refusal, a
      // cancel or a failure never reads as success.
      const reason = end.state === "canceled" || end.closureReason === "canceled" ? "canceled"
        : end.state === "denied" || end.closureReason === "denied" ? "denied" : "no-follow-on";
      const state = end.state === "failed" ? "failed" as const : "done" as const;
      const closureReason = state === "failed" ? null : reason;
      const words = closingWords(deps.queueRepo, end);
      // A final check before the close: a hub item already closed, by our own close whose answer was lost or by someone
      // else, gets no write, so another actor's failure or cancel never becomes our done.
      let shown = await hub.show(receipt.hub_qitem_id);
      if (!HUB_CLOSED.has(shown.state)) {
        try {
          await hub.close(receipt.hub_qitem_id, { state, closureReason, resolution: words });
        } catch (error) {
          // Refused: closed by someone else between the check and the close. The readback says how.
          if (!(error instanceof HubError) || error.kind !== "refused") throw error;
        }
        shown = await hub.show(receipt.hub_qitem_id);
        if (!HUB_CLOSED.has(shown.state)) {
          deps.db.prepare("UPDATE network_receipts SET last_error = ? WHERE local_qitem_id = ?").run("The close didn't take: the hub item still reads open. Trying again.", receipt.local_qitem_id);
          continue;
        }
      }
      // It counts as our result only when the hub item shows our state, closure reason and resolution. Otherwise the
      // local result stays here, and status shows the hub item as closed elsewhere.
      if (shown.state !== state || shown.resolution !== words || (shown.closureReason ?? null) !== closureReason) {
        mark("settled_at", receipt, "closed_on_hub", `The hub item was closed elsewhere (${shown.state}${shown.closureReason ? `, ${shown.closureReason}` : ""}) before this result reached it. The result stays on ${local.qitemId}.`);
        deps.log?.(`network ${binding.id}: hub item ${receipt.hub_qitem_id} was closed elsewhere; its local result stays on ${local.qitemId}`);
        continue;
      }
      mark("settled_at", receipt, end.state);
      result.resultsSent++;
    } catch (error) {
      if (!(error instanceof HubError) || error.kind !== "refused") throw error;
      deps.db.prepare("UPDATE network_receipts SET last_error = ? WHERE local_qitem_id = ?").run(error.message.slice(0, 500), receipt.local_qitem_id);
    }
  }
}

export interface NetworkConnectorSnapshot {
  running: boolean;
  intervalMs: number;
  bindings: Array<{ id: string; nextPassAt: string | null; backoffMs: number; lastPass: NetworkPassResult | null }>;
}

/** The connector the daemon runs: one pass per active binding when it's due, one round at a time, off the event loop's
 *  hot path (the hub calls are async network I/O). Each pass is bounded by its deadline, and stop closes a pass in
 *  flight. A binding that fails backs off, doubling to a cap, with jitter. With no active binding it makes no network
 *  call at all. */
export class NetworkConnectorService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  private stopping: AbortController | null = null;
  private readonly due = new Map<string, { at: number; backoffMs: number; last: NetworkPassResult | null }>();
  readonly intervalMs: number;
  private readonly maxBackoffMs: number;

  constructor(private readonly deps: NetworkConnectorDeps, opts: { intervalMs?: number; maxBackoffMs?: number; random?: () => number } = {}) {
    this.intervalMs = opts.intervalMs ?? 30_000;
    this.maxBackoffMs = Math.max(this.intervalMs, opts.maxBackoffMs ?? 300_000);
    this.random = opts.random ?? Math.random;
  }
  private readonly random: () => number;

  start(): void {
    this.stopped = false;
    this.stopping = new AbortController();
    // A credential whose binding isn't active has nothing left to do here: one a stop left before its row, or one
    // whose removal failed when its binding ended.
    const swept = this.deps.bindings.sweepCredentials();
    if (swept.removed.length) this.deps.log?.(`network connector: removed the credentials of ended bindings ${swept.removed.join(", ")}`);
    if (swept.failed.length) this.deps.log?.(`network connector: couldn't remove the credentials of ended bindings ${swept.failed.join(", ")}`);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  /** One round: a pass for each active binding that's due. Exposed for tests and status. */
  async round(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const at = (this.deps.now ?? (() => new Date()))().getTime();
      const active = this.deps.bindings.active();
      for (const id of [...this.due.keys()]) if (!active.some((b) => b.id === id)) this.due.delete(id);
      for (const binding of active) {
        if (this.stopped) break;
        const due = this.due.get(binding.id);
        if (due && due.at > at) continue;
        const pass = await runNetworkBindingPass(this.deps, binding, { signal: this.stopping?.signal });
        const failing = pass.error === "unavailable" || pass.error === "refused" || pass.error === "credential" || pass.error === "local";
        const backoffMs = failing ? Math.min(this.maxBackoffMs, (due?.backoffMs ?? this.intervalMs) * 2) : this.intervalMs;
        const jitter = 1 + (this.random() * 0.4 - 0.2);
        this.due.set(binding.id, { at: at + Math.round(backoffMs * jitter), backoffMs, last: pass });
      }
    })();
    try { await this.inFlight; } finally { this.inFlight = null; }
  }

  snapshot(): NetworkConnectorSnapshot {
    return {
      running: !this.stopped,
      intervalMs: this.intervalMs,
      bindings: [...this.due.entries()].map(([id, d]) => ({ id, nextPassAt: new Date(d.at).toISOString(), backoffMs: d.backoffMs, lastPass: d.last })),
    };
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.round().catch((error) => this.deps.log?.(`network connector round failed: ${(error as Error).message}`))
        .finally(() => this.schedule(Math.min(this.intervalMs, 5_000)));
    }, ms);
    this.timer.unref?.();
  }
}

export { HubError };
