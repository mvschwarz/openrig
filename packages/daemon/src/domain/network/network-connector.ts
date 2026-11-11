// The outbound connector: for each active network binding, reach the hub as that participant, take the items addressed
// to it into the bound local seat's queue, and carry what happens locally back to the hub item.
//
// Honest stages, kept apart on the hub item:
// - a hub claim is the connector taking custody of the item, not the agent picking it up;
// - "picked up" is reported only once the local item is claimed;
// - the result is the local item's own closing outcome.
//
// Each hub item maps to one local item, under an id derived from the binding and the hub item. The queue's same-id
// absorption makes every retry land on that one item, so a lost response never starts a second run. An item whose local
// record is gone reads unknown and is never run again.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { QueueRepositoryError, type QueueItem, type QueueRepository } from "../queue-repository.js";
import { NetworkBindingError, readNetworkCredential, type NetworkBinding, type NetworkBindingStore } from "./network-bindings.js";
import { connectMcpHub, HubError, hubFailure, type HubConnect, type HubItem, type HubSession } from "./hub-client.js";

/** OpenRig's own sender: the connector creates the local item for the hub's requester, who is named in its body. */
const LOCAL_SOURCE = "daemon@kernel";
const PAGE = 25;
const MAX_PAGES = 8;

export function networkLocalItemId(bindingId: string, hubQitemId: string): string {
  return `qitem-net-${createHash("sha256").update(`${bindingId}\n${hubQitemId}`).digest("hex").slice(0, 20)}`;
}

export interface NetworkConnectorDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  bindings: NetworkBindingStore;
  home: string;
  connect?: HubConnect;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface NetworkPassResult {
  bindingId: string;
  taken: number;
  pickupsSent: number;
  resultsSent: number;
  unknown: number;
  /** Why the pass stopped early, if it did. `revoked` ended the binding; `no_session` left the hub's items pending. */
  error?: HubError["kind"] | "credential" | "no_session";
}

/** The seat's current address: the node's latest session, as the queue's other node lookups read it. */
function currentSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

interface Receipt {
  local_qitem_id: string; binding_id: string; hub_qitem_id: string; pickup_sent_at: string | null; result_sent_at: string | null; outcome: string | null;
}

const TERMINAL = new Set(["done", "canceled"]);

/** One pass for one binding. Never throws: a failure is recorded on the binding and returned. */
export async function runNetworkBindingPass(deps: NetworkConnectorDeps, binding: NetworkBinding): Promise<NetworkPassResult> {
  const now = deps.now ?? (() => new Date());
  const result: NetworkPassResult = { bindingId: binding.id, taken: 0, pickupsSent: 0, resultsSent: 0, unknown: 0 };
  const active = () => deps.bindings.get(binding.id)?.state === "active";
  let token: string;
  try {
    token = readNetworkCredential(deps.home, binding.id);
  } catch (error) {
    deps.bindings.recordError(binding.id, error instanceof NetworkBindingError ? error.message : String(error));
    return { ...result, error: "credential" };
  }

  let hub: HubSession | null = null;
  try {
    hub = await (deps.connect ?? connectMcpHub)(binding.hubUrl, token);
    // Work goes to the seat at its current address. With no session there's nobody to give it to, so nothing is taken.
    const destination = currentSession(deps.db, binding.nodeId);
    if (destination) {
      // What this binding already took (claimed on the hub, possibly before a restart) gets its local item first.
      for (const held of await hub.listOwned("in-progress", PAGE * MAX_PAGES)) {
        if (!active()) break;
        if (held.destinationSession === binding.hubSeat && await ensureLocal(deps, binding, hub, held, destination, now)) result.taken++;
      }
      // New work, a page at a time: a claim moves an item out of pending, so each page is new items.
      for (let page = 0; page < MAX_PAGES && active(); page++) {
        const pending = await hub.listOwned("pending", PAGE);
        for (const item of pending) {
          if (!active()) break;
          if (item.destinationSession !== binding.hubSeat) continue;
          try {
            await hub.claim(item.qitemId);
          } catch (error) {
            // Another claimant, or the item closed meanwhile: it isn't this binding's to take.
            if (hubFailure(error).kind === "refused") continue;
            throw error;
          }
          if (await ensureLocal(deps, binding, hub, item, destination, now)) result.taken++;
        }
        if (pending.length < PAGE) break;
      }
    }
    // Report back what happened locally, for every item this binding took. A revoked binding never gets here.
    await reportBack(deps, binding, hub, now, result);
    deps.bindings.recordContact(binding.id, now());
    if (!destination) {
      deps.bindings.recordError(binding.id, `${binding.localSession} has no session here, so its hub items stay pending until it has one.`);
      return { ...result, error: "no_session" };
    }
    return result;
  } catch (error) {
    const failure = hubFailure(error);
    if (failure.kind === "revoked") {
      try {
        deps.bindings.markRevoked(binding.id, failure.message);
      } catch (cleanup) {
        // The binding is revoked either way; only its credential's removal failed, and the error says how to retry.
        if (!(cleanup instanceof NetworkBindingError) || cleanup.code !== "credential_cleanup_failed") throw cleanup;
        deps.bindings.recordError(binding.id, cleanup.message);
      }
      deps.log?.(`network ${binding.id}: revoked by the hub; no new work comes in through it`);
    } else {
      deps.bindings.recordError(binding.id, failure.message);
    }
    return { ...result, error: failure.kind };
  } finally {
    await hub?.end();
  }
}

/** The local item for a hub item this binding holds: created once, or found again. Returns true when it was new. */
async function ensureLocal(deps: NetworkConnectorDeps, binding: NetworkBinding, hub: HubSession, item: HubItem, destination: string,
  now: () => Date): Promise<boolean> {
  const localId = networkLocalItemId(binding.id, item.qitemId);
  if (deps.db.prepare("SELECT 1 FROM network_receipts WHERE local_qitem_id = ?").get(localId)) return false;
  const full = item.body == null ? await hub.show(item.qitemId) : item;
  let outcome: string | null = null;
  try {
    await deps.queueRepo.create({
      qitemId: localId,
      sourceSession: LOCAL_SOURCE,
      destinationSession: destination,
      summary: full.summary ?? `${item.sourceSession} via the network hub`,
      body: [
        full.body ?? "",
        "",
        "---",
        `From ${item.sourceSession} through the network hub ${binding.hubUrl}, as ${binding.hubSeat} (hub item ${item.qitemId}).`,
        `Answer by closing this item with your result: rig queue update ${localId} --state done --closure-reason no-follow-on --resolution "<your answer>".`,
        "OpenRig returns the resolution to the hub item.",
      ].join("\n"),
      tags: [`network-binding:${binding.id}`, `network-hub-item:${item.qitemId}`],
    });
  } catch (error) {
    const code = error instanceof QueueRepositoryError ? error.code : null;
    // Its id was used before and its record erased: whether it ran is unknown, and it's never run again.
    if (code === "qitem_erased") outcome = "unknown";
    // The same id with another destination: the seat's address changed between attempts; the item already exists.
    else if (code !== "qitem_id_reuse" || !deps.queueRepo.getById(localId)) throw error;
  }
  const inserted = deps.db.prepare(`INSERT INTO network_receipts (local_qitem_id, binding_id, hub_qitem_id, created_at, outcome)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(localId, binding.id, item.qitemId, now().toISOString(), outcome).changes > 0;
  if (inserted) {
    await hub.note(item.qitemId, outcome === "unknown"
      ? `This item's local record (${localId}) is gone, so whether it ran is unknown. It won't be run again.`
      : `Queued for the connected local seat as ${localId}. Not picked up yet.`);
  }
  return inserted && outcome === null;
}

/** The item a local item ends at, following local handoffs. */
function finalItem(repo: QueueRepository, start: QueueItem): QueueItem {
  let current = start;
  for (let hop = 0; hop < 20 && current.state === "handed-off" && current.handedOffTo; hop++) {
    const next = repo.getById(current.handedOffTo);
    if (!next) break;
    current = next;
  }
  return current;
}

function closingWords(db: Database.Database, item: QueueItem): string {
  if (item.resolution) return item.resolution;
  const note = db.prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_note IS NOT NULL ORDER BY transition_id DESC LIMIT 1")
    .get(item.qitemId) as { transition_note: string } | undefined;
  return note?.transition_note ? `Closed without a resolution. Its last note: ${note.transition_note}` : "Closed without a stated result.";
}

async function reportBack(deps: NetworkConnectorDeps, binding: NetworkBinding, hub: HubSession, now: () => Date, result: NetworkPassResult): Promise<void> {
  const open = deps.db.prepare("SELECT * FROM network_receipts WHERE binding_id = ? AND result_sent_at IS NULL ORDER BY created_at")
    .all(binding.id) as Receipt[];
  const mark = (column: "pickup_sent_at" | "result_sent_at", receipt: Receipt, outcome?: string) =>
    deps.db.prepare(`UPDATE network_receipts SET ${column} = ?, outcome = COALESCE(?, outcome), last_error = NULL WHERE local_qitem_id = ?`)
      .run(now().toISOString(), outcome ?? null, receipt.local_qitem_id);
  for (const receipt of open) {
    try {
      const local = deps.queueRepo.getById(receipt.local_qitem_id);
      if (!local || receipt.outcome === "unknown") {
        // Already said on the hub when it was found gone at take time; otherwise say it now.
        if (receipt.outcome !== "unknown") {
          await hub.note(receipt.hub_qitem_id, `This item's local record (${receipt.local_qitem_id}) is gone, so its outcome is unknown. It won't be run again.`);
        }
        mark("result_sent_at", receipt, "unknown");
        result.unknown++;
        continue;
      }
      if (!receipt.pickup_sent_at && local.claimedAt) {
        await hub.note(receipt.hub_qitem_id, `Picked up by the local seat at ${local.claimedAt}.`);
        mark("pickup_sent_at", receipt);
        result.pickupsSent++;
      }
      const end = finalItem(deps.queueRepo, local);
      if (!TERMINAL.has(end.state)) continue;
      const closureReason = end.state === "canceled" ? "canceled" : end.closureReason === "denied" ? "denied" : "no-follow-on";
      try {
        await hub.close(receipt.hub_qitem_id, { closureReason, resolution: closingWords(deps.db, end) });
      } catch (error) {
        // A close whose answer was lost: the hub item is already closed, so it was sent.
        if (hubFailure(error).kind !== "refused" || !TERMINAL.has((await hub.show(receipt.hub_qitem_id)).state)) throw error;
      }
      mark("result_sent_at", receipt, end.state);
      result.resultsSent++;
    } catch (error) {
      const failure = hubFailure(error);
      if (failure.kind !== "refused") throw error;
      deps.db.prepare("UPDATE network_receipts SET last_error = ? WHERE local_qitem_id = ?").run(failure.message.slice(0, 500), receipt.local_qitem_id);
    }
  }
}

export interface NetworkConnectorSnapshot {
  running: boolean;
  intervalMs: number;
  bindings: Array<{ id: string; nextPassAt: string | null; backoffMs: number; lastPass: NetworkPassResult | null }>;
}

/** The connector the daemon runs: one pass per active binding when it's due, one round at a time, off the event loop's
 *  hot path (the hub calls are async network I/O). A binding that fails backs off, doubling to a cap, with jitter. With no
 *  active binding it makes no network call at all. */
export class NetworkConnectorService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
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
    // A credential whose binding isn't active has nothing left to do here: one a stop left before its row, or one
    // whose removal failed when its binding ended.
    const swept = this.deps.bindings.sweepCredentials();
    if (swept.removed.length) this.deps.log?.(`network connector: removed the credentials of ended bindings ${swept.removed.join(", ")}`);
    if (swept.failed.length) this.deps.log?.(`network connector: couldn't remove the credentials of ended bindings ${swept.failed.join(", ")}`);
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
        const pass = await runNetworkBindingPass(this.deps, binding);
        const failing = pass.error === "unavailable" || pass.error === "refused" || pass.error === "credential";
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
