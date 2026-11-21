// A bound seat asking a peer through its hub. The request is recorded here first, as a queue item under the seat's own
// request id, from the seat to OpenRig, parked on the hub item, and only then created on the hub. It's addressed to
// OpenRig, not the seat: the seat owes nothing on it, so it isn't one of the seat's obligations, and an idle seat isn't
// woken about a park it can't act on (a held row with no live wake reads unhealthy to the parked-owner consumer).
// The hub item's id is derived from what the request is (the seat's node, the hub, the participant and the request id),
// so a retry, a restart or a new binding for the same seat, hub and participant always names the same hub item, and the
// hub's same-id absorption keeps it one item. A create whose answer was lost is found again by that id on the connector's next pass, or created again
// under it. Each pass reads the open hub items and, when one closes, closes the local item with the hub's answer and who
// gave it. A hub item handed on to one this participant can't read stays open here: its answer isn't visible, which is
// not an answer.
import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { QueueRepositoryError, type QueueRepository } from "../queue-repository.js";
import { OPENRIG_SENDER } from "../../lib/pane-envelope.js";
import { NetworkBindingError, readNetworkCredential, type NetworkBinding, type NetworkBindingStore } from "./network-bindings.js";
import { connectMcpHub, HubError, type HubConnect, type HubItem, type HubSession, type HubTeam } from "./hub-client.js";

export interface NetworkRequestDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  bindings: NetworkBindingStore;
  home: string;
  connect?: HubConnect;
  now?: () => Date;
  /** How long a create or a team read may wait on the hub; a create past it reads unknown and the next pass checks it. */
  hubTimeoutMs?: number;
}

export type NetworkRequestState = "sent" | "unknown" | "refused";

export interface NetworkRequestResult {
  localQitemId: string;
  hubQitemId: string;
  peer: string;
  state: NetworkRequestState;
  message: string;
}

interface RequestRow {
  local_qitem_id: string; binding_id: string; node_id: string; hub_url: string; hub_seat: string; peer: string; hub_qitem_id: string;
  body: string; summary: string | null; created_at: string; hub_created_at: string | null; checked_at: string | null;
  settled_at: string | null; outcome: string | null; last_error: string | null;
}

const HUB_TIMEOUT_MS = 30_000;
/** Open requests read per pass, the least recently read first, so a long backlog still gives every request a turn. */
const REQUEST_LIMIT = 50;
/** The states a hub item ends in. A handed-off one ends at its successor, which is followed while it can be read. */
const HUB_FINAL = new Set(["done", "canceled", "denied", "failed"]);
const LOCAL_CLOSED = new Set(["done", "canceled", "denied", "failed", "handed-off"]);
/** The closure reasons a local done close takes from the hub's; any other reads as no-follow-on. */
const CLOSURE_REASONS = new Set(["no-follow-on", "canceled", "denied", "escalation"]);
const HANDED_ON_UNREADABLE = "The hub item was handed on to an item this connection can't read, so its answer isn't visible here. The outcome is unknown, and this item stays open.";
const BINDING_ENDED = "The network binding this request was sent through has ended, so its answer can't be read here. The outcome is unknown; this item stays open, and a new binding for the same seat, hub and participant picks it up again.";

/** The hub item for a request, by what it is. A retry, a restart or a new binding for the same seat, hub and
 *  participant names the same hub item. */
export function networkHubRequestId(binding: Pick<NetworkBinding, "nodeId" | "hubUrl" | "hubSeat">, requestId: string): string {
  return `qitem-netout-${createHash("sha256").update([binding.nodeId, binding.hubUrl, binding.hubSeat, requestId].join("\n")).digest("hex").slice(0, 20)}`;
}

/** What a request's local item waits on: the hub item, outside this daemon. */
export function networkRequestBlocker(hubQitemId: string): string {
  return `external:network-request/${hubQitemId}`;
}

/** The seat's current address: the node's latest session, as the connector reads it. */
function currentSession(db: Database.Database, nodeId: string): string | null {
  const row = db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(nodeId) as { session_name: string } | undefined;
  return row?.session_name ?? null;
}

/** The participant's token, once the binding can carry a request: active, its plain-http choice recorded where needed. */
function usableToken(deps: Pick<NetworkRequestDeps, "home">, binding: NetworkBinding): string {
  if (binding.state !== "active") throw new NetworkBindingError("binding_not_active", `${binding.id} is ${binding.state}, so nothing can be sent through it.`, 409);
  if (binding.unencrypted && !binding.allowHttp) {
    throw new NetworkBindingError("http_not_allowed", `${binding.hubUrl} is plain http and this binding has no --allow-http choice, so its token isn't sent.`, 409);
  }
  return readNetworkCredential(deps.home, binding.id);
}

/** A hub failure as the routes report it. */
function hubRefusal(error: unknown): unknown {
  if (!(error instanceof HubError)) return error;
  if (error.kind === "unavailable") return new NetworkBindingError("hub_unavailable", error.message, 503);
  if (error.kind === "revoked") return new NetworkBindingError("hub_revoked", error.message, 502);
  return new NetworkBindingError("hub_refused", error.code ? `${error.message} (${error.code})` : error.message, 502);
}

/** One call on the hub as this binding's participant, bounded: past the deadline the connection closes and the call
 *  reads unavailable. */
async function withHub<T>(deps: Pick<NetworkRequestDeps, "connect" | "hubTimeoutMs">, binding: NetworkBinding, token: string,
  use: (hub: HubSession) => Promise<T>): Promise<T> {
  const timeoutMs = deps.hubTimeoutMs ?? HUB_TIMEOUT_MS;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  timer.unref?.();
  let hub: HubSession | null = null;
  try {
    hub = await (deps.connect ?? connectMcpHub)(binding.hubUrl, token, deadline.signal);
    return await use(hub);
  } catch (error) {
    if (deadline.signal.aborted) throw new HubError("unavailable", `The hub didn't answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${timeoutMs} ms`}.`);
    throw error;
  } finally {
    clearTimeout(timer);
    await hub?.end();
  }
}

/** The peers this binding's participant may address, as the hub's rig_team answers: a member grant names its rig, which
 *  is the rig part of the participant's own hub address. */
export async function listNetworkPeers(deps: Pick<NetworkRequestDeps, "home" | "connect" | "hubTimeoutMs">, binding: NetworkBinding)
  : Promise<{ bindingId: string; hubSeat: string; team: HubTeam }> {
  const token = usableToken(deps, binding);
  const rig = binding.hubSeat.slice(binding.hubSeat.lastIndexOf("@") + 1);
  try {
    return { bindingId: binding.id, hubSeat: binding.hubSeat, team: await withHub(deps, binding, token, (hub) => hub.team(rig || undefined)) };
  } catch (error) {
    throw hubRefusal(error);
  }
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Send a request to a peer through the binding's hub. It's recorded first, as an item from the seat to OpenRig under
 *  `requestId`, parked on the hub item; then created on the hub. A create the hub refused closes the local item failed
 *  with the hub's words; one whose outcome isn't known stays parked, and the connector's next pass finds or creates it by
 *  its id. The same `requestId` with the same request returns where it stands; with another request it's refused. */
export async function originateNetworkRequest(deps: NetworkRequestDeps, binding: NetworkBinding,
  input: { peer: unknown; requestId: unknown; body: unknown; summary?: unknown }): Promise<NetworkRequestResult> {
  const now = deps.now ?? (() => new Date());
  const peer = text(input.peer);
  const requestId = text(input.requestId);
  const body = typeof input.body === "string" ? input.body : "";
  const summary = text(input.summary) || null;
  if (!peer) throw new NetworkBindingError("invalid_peer", "Name the peer as rig network peers lists it.");
  if (!requestId || /\s/.test(requestId)) throw new NetworkBindingError("invalid_request_id", "Give the request an id of your own with no spaces, unique to this request; retry only with the same id.");
  if (!body.trim()) throw new NetworkBindingError("invalid_body", "The request needs a body: what to do and what to return.");
  const token = usableToken(deps, binding);
  const session = currentSession(deps.db, binding.nodeId);
  if (!session) throw new NetworkBindingError("no_session", `${binding.localSession} has no session here, so there's no seat to record the request for.`, 409);
  const hubId = networkHubRequestId(binding, requestId);
  const reused = () => new NetworkBindingError("request_id_reused",
    `${requestId} already names another request or item here. Use a new id for a new request; the same id retries only the same request.`, 409);

  const existing = deps.db.prepare("SELECT * FROM network_requests WHERE local_qitem_id = ?").get(requestId) as RequestRow | undefined;
  if (existing) {
    if (existing.node_id !== binding.nodeId || existing.hub_url !== binding.hubUrl || existing.hub_seat !== binding.hubSeat
      || existing.peer !== peer || existing.body !== body) throw reused();
    if (existing.outcome === "refused") return result(existing, "refused", `The hub refused this request earlier: ${existing.last_error ?? "no reason recorded"}. ${requestId} is closed failed.`);
    if (existing.hub_created_at) {
      return result(existing, "sent", `${requestId} was already sent to ${peer} as hub item ${hubId}. Its answer comes back to ${requestId}: read it with rig queue show ${requestId}.`);
    }
    if (existing.settled_at) {
      return result(existing, "unknown", `${requestId} was settled (${existing.outcome}) before the hub confirmed hub item ${hubId}, so nothing more is read for it. ${existing.last_error ?? ""}`.trim());
    }
  } else {
    // Recorded first: the seat's request, held by OpenRig until the answer closes it. Nothing wakes anyone for it.
    try {
      const local = await deps.queueRepo.create({
        qitemId: requestId,
        sourceSession: session,
        destinationSession: OPENRIG_SENDER,
        summary: summary ? `To ${peer} via network hub: ${summary}` : `To ${peer} via network hub`,
        body: [
          `To ${peer} through the network hub ${binding.hubUrl}, as ${binding.hubSeat} (hub item ${hubId}).`,
          "",
          body,
          "",
          "---",
          `When the hub item closes, OpenRig closes this item with its answer and says who gave it. Read it with rig queue show ${requestId}.`,
        ].join("\n"),
        tags: [`network-binding:${binding.id}`, `network-peer:${peer}`, `network-hub-item:${hubId}`, "network-direction:outbound"],
        nudge: false,
      });
      if (local.createWarning) throw reused();
      const blocker = networkRequestBlocker(hubId);
      if (local.state !== "blocked" || local.blockedOn !== blocker) {
        if (LOCAL_CLOSED.has(local.state)) throw reused();
        deps.queueRepo.update({ qitemId: requestId, actorSession: session, state: "blocked", blockedOn: blocker,
          transitionNote: `Waiting on ${peer}'s answer through the network hub (hub item ${hubId}).` });
      }
    } catch (error) {
      if (error instanceof QueueRepositoryError && (error.code === "qitem_id_reuse" || error.code === "qitem_erased")) throw reused();
      throw error;
    }
    deps.db.prepare(`INSERT INTO network_requests (local_qitem_id, binding_id, node_id, hub_url, hub_seat, peer, hub_qitem_id, body, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .run(requestId, binding.id, binding.nodeId, binding.hubUrl, binding.hubSeat, peer, hubId, body, summary, now().toISOString());
  }
  const receipt = deps.db.prepare("SELECT * FROM network_requests WHERE local_qitem_id = ?").get(requestId) as RequestRow;

  try {
    await withHub(deps, binding, token, (hub) => hub.create({ qitemId: hubId, destination: peer, body, summary }));
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    // A definite answer: the credential was refused, or the hub refused this create with its own code. Anything else
    // (a timeout, a lost connection, an answer that can't be read) leaves the outcome unknown, and the next pass checks.
    if (error.kind === "revoked" || (error.kind === "refused" && error.code)) {
      refuse(deps, receipt, error, now);
      return result(receipt, "refused", `The hub refused it: ${error.message}${error.code ? ` (${error.code})` : ""}. ${requestId} is closed failed with that reason.`);
    }
    deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(error.message.slice(0, 500), requestId);
    return result(receipt, "unknown", `${requestId} is recorded, and whether the hub has it yet is unknown (${error.message}). The connector checks hub item ${hubId} on its next pass and creates it there under the same id if it's missing. Retry only with the same --id.`);
  }
  deps.db.prepare("UPDATE network_requests SET hub_created_at = ?, last_error = NULL WHERE local_qitem_id = ?").run(now().toISOString(), requestId);
  return result(receipt, "sent", `Sent to ${peer} as hub item ${hubId}. Its answer comes back to ${requestId}: read it with rig queue show ${requestId}.`);
}

function result(receipt: RequestRow, state: NetworkRequestState, message: string): NetworkRequestResult {
  return { localQitemId: receipt.local_qitem_id, hubQitemId: receipt.hub_qitem_id, peer: receipt.peer, state, message };
}

/** The hub refused the request: the local item closes failed with the hub's words, and nothing more is read. */
function refuse(deps: NetworkRequestDeps, receipt: RequestRow, error: HubError, now: () => Date): void {
  const why = `${error.message}${error.code ? ` (${error.code})` : ""}`.slice(0, 500);
  const local = deps.queueRepo.getById(receipt.local_qitem_id);
  if (local && !LOCAL_CLOSED.has(local.state)) {
    deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, state: "failed",
      resolution: `The network hub refused this request: ${why}`, transitionNote: `Refused by the network hub ${receipt.hub_url} (hub item ${receipt.hub_qitem_id}).` });
  }
  settle(deps, receipt, "refused", now, why);
}

function settle(deps: NetworkRequestDeps, receipt: RequestRow, outcome: string, now: () => Date, lastError: string | null = null): void {
  deps.db.prepare("UPDATE network_requests SET settled_at = ?, outcome = ?, last_error = ? WHERE local_qitem_id = ?")
    .run(now().toISOString(), outcome, lastError, receipt.local_qitem_id);
}

/** One pass's reading of this binding's open requests, on the pass's hub session. Open requests of an ended binding for
 *  the same seat, hub and participant are taken over first. A refusal on one request is recorded on it and the rest go
 *  on; a hub that stops answering leaves the rest for the next pass; a revoked credential ends the pass, as the
 *  connector's own calls do. */
export async function reconcileNetworkRequests(deps: NetworkRequestDeps, binding: NetworkBinding, hub: HubSession,
  now: () => Date = deps.now ?? (() => new Date()), live: () => boolean = () => true): Promise<void> {
  deps.db.prepare(`UPDATE network_requests SET binding_id = ? WHERE node_id = ? AND hub_url = ? AND hub_seat = ? AND settled_at IS NULL AND binding_id != ?`)
    .run(binding.id, binding.nodeId, binding.hubUrl, binding.hubSeat, binding.id);
  const open = deps.db.prepare(`SELECT * FROM network_requests WHERE binding_id = ? AND settled_at IS NULL
    ORDER BY COALESCE(checked_at, ''), created_at LIMIT ?`).all(binding.id, REQUEST_LIMIT) as RequestRow[];
  for (const receipt of open) {
    if (!live()) break;
    deps.db.prepare("UPDATE network_requests SET checked_at = ? WHERE local_qitem_id = ?").run(now().toISOString(), receipt.local_qitem_id);
    const local = deps.queueRepo.getById(receipt.local_qitem_id);
    if (!local) { settle(deps, receipt, "unknown", now, "The local item is gone, so the answer has nowhere to land."); continue; }
    // Someone here closed it first: that disposition stands, and the hub item is left as it is.
    if (LOCAL_CLOSED.has(local.state)) { settle(deps, receipt, "local_closed", now); continue; }
    let shown: HubItem;
    try {
      shown = receipt.hub_created_at ? await hub.show(receipt.hub_qitem_id) : await createdOnHub(deps, hub, receipt, now);
    } catch (error) {
      if (!(error instanceof HubError) || error.kind === "revoked") throw error;
      if (error.kind === "refused" && !receipt.hub_created_at && error.code) { refuse(deps, receipt, error, now); continue; }
      deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(error.message.slice(0, 500), receipt.local_qitem_id);
      // The hub stopped answering partway: the rest wait for the next pass, and the work taken in this pass stands.
      if (error.kind === "unavailable") break;
      continue;
    }
    // A hub item handed on there: its answer is its successor's, followed while this participant can read it.
    let end: HubItem | null = shown;
    let stopped = false;
    for (let hop = 0; hop < 20 && end?.state === "handed-off"; hop++) {
      if (!end.successor) { end = null; break; }
      try { end = await hub.show(end.successor); } catch (error) {
        if (!(error instanceof HubError) || error.kind === "revoked") throw error;
        if (error.kind === "unavailable") {
          deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(error.message.slice(0, 500), receipt.local_qitem_id);
          stopped = true;
        }
        end = null;
      }
    }
    if (stopped) break;
    if (!end || end.state === "handed-off") {
      if (receipt.last_error !== HANDED_ON_UNREADABLE) {
        deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, transitionNote: HANDED_ON_UNREADABLE });
        deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(HANDED_ON_UNREADABLE, receipt.local_qitem_id);
      }
      continue;
    }
    if (!HUB_FINAL.has(end.state)) continue;
    // The local item closes the way the hub item did: failed as failed, a cancel or a refusal as itself, never as success.
    const state = end.state === "failed" ? "failed" as const : "done" as const;
    const closureReason = end.state === "canceled" ? "canceled" : end.state === "denied" ? "denied"
      : end.closureReason && CLOSURE_REASONS.has(end.closureReason) ? end.closureReason : "no-follow-on";
    deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, state, ...(state === "done" ? { closureReason } : {}),
      resolution: end.resolution || "Closed without a stated result.",
      transitionNote: `Answered by ${end.destinationSession || receipt.peer} via network hub ${receipt.hub_url} (hub item ${end.qitemId}).` });
    settle(deps, receipt, end.state, now);
  }
}

/** A request whose create may not have reached the hub: found there by its id, or created again under it with the same
 *  body (the hub answers a create that already landed with the stored item). */
async function createdOnHub(deps: NetworkRequestDeps, hub: HubSession, receipt: RequestRow, now: () => Date): Promise<HubItem> {
  let shown: HubItem | null = null;
  try { shown = await hub.show(receipt.hub_qitem_id); } catch (error) {
    if (!(error instanceof HubError) || error.kind !== "refused") throw error;
  }
  if (!shown) shown = await hub.create({ qitemId: receipt.hub_qitem_id, destination: receipt.peer, body: receipt.body, summary: receipt.summary });
  deps.db.prepare("UPDATE network_requests SET hub_created_at = ?, last_error = NULL WHERE local_qitem_id = ?").run(now().toISOString(), receipt.local_qitem_id);
  return shown;
}

/** A binding the hub ended: each open request sent through it says once, on its local item, that its answer can't be read
 *  here. The requests stay open, so a new binding for the same seat, hub and participant takes them over. It never throws:
 *  it runs while the connector records the revoke, and a note that can't be written is tried again at the next revoke. */
export function noteEndedBindingRequests(deps: Pick<NetworkRequestDeps, "db" | "queueRepo">, binding: NetworkBinding, log?: (line: string) => void): void {
  try {
    const open = deps.db.prepare("SELECT * FROM network_requests WHERE binding_id = ? AND settled_at IS NULL").all(binding.id) as RequestRow[];
    for (const receipt of open) {
      if (receipt.last_error === BINDING_ENDED) continue;
      const local = deps.queueRepo.getById(receipt.local_qitem_id);
      if (local && !LOCAL_CLOSED.has(local.state)) deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, transitionNote: BINDING_ENDED });
      deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(BINDING_ENDED, receipt.local_qitem_id);
    }
  } catch (error) {
    log?.(`network ${binding.id}: couldn't note its open requests: ${error instanceof Error ? error.message : String(error)}`);
  }
}
