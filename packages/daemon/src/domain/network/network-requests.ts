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
import { QueueRepositoryError, type QueueItem, type QueueRepository } from "../queue-repository.js";
import { OPENRIG_SENDER } from "../../lib/pane-envelope.js";
import { NetworkBindingError, readNetworkCredential, type NetworkBinding, type NetworkBindingStore } from "./network-bindings.js";
import { connectMcpHub, HubError, type HubConnect, type HubItem, type HubSession, type HubTeam } from "./hub-client.js";
import type { NetworkWait } from "../queue-waiting.js";

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
  body_sha256: string; created_at: string; hub_created_at: string | null; checked_at: string | null;
  settled_at: string | null; outcome: string | null; last_error: string | null;
  requester_local_qitem_id?: string | null;
  requester_hub_qitem_id?: string | null;
  remote_wait?: string | null;
}

const HUB_TIMEOUT_MS = 30_000;
/** Open requests read per pass, the least recently read first, so a long backlog still gives every request a turn. */
const REQUEST_LIMIT = 50;
/** The states a hub item ends in. A handed-off one ends at its successor, which is followed while it can be read. */
const HUB_FINAL = new Set(["done", "canceled", "denied", "failed"]);
const LOCAL_CLOSED = new Set(["done", "canceled", "denied", "failed", "handed-off"]);
/** The closure reasons a local done close takes from the hub's. Any other reads as no-follow-on, with the hub's reason in
 *  the note: escalation and handed_off_to need a closure target here, which a hub item can't give. */
const CLOSURE_REASONS = new Set(["no-follow-on", "canceled", "denied"]);
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
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** A hub URL as queue text and whoami show it. A query string or a fragment can carry a credential the person pasted, so
 *  both are hidden there, as rig network status hides them; the full URL stays only in the binding, the connection and
 *  the receipt. A URL with only a query reads as it always has, so request items recorded before still match. */
export function shownHubUrl(hubUrl: string): string {
  try {
    const url = new URL(hubUrl);
    const hidden = [url.search && "query", url.hash && "fragment"].filter(Boolean).join(" and ");
    if (!hidden) return hubUrl;
    url.search = "";
    url.hash = "";
    return `${url.toString()} (${hidden} hidden)`;
  } catch {
    return hubUrl;
  }
}

/** How a hub URL was shown before fragments were hidden: the query hidden, a fragment left in. Request items recorded
 *  then carry it in their head, and still read back; nothing new is written this way. */
function priorShownHubUrl(hubUrl: string): string {
  try {
    const url = new URL(hubUrl);
    if (!url.search) return hubUrl;
    url.search = "";
    return `${url.toString()} (query hidden)`;
  } catch {
    return hubUrl;
  }
}

/** The local item's text around the request, built from the receipt's fields, so the request reads back out of the local
 *  item: the receipt keeps only its hash, and erasing the local item erases the only copy. */
const requestHead = (r: Pick<RequestRow, "peer" | "hub_url" | "hub_seat" | "hub_qitem_id">, shown = shownHubUrl): string =>
  `To ${r.peer} through the network hub ${shown(r.hub_url)}, as ${r.hub_seat} (hub item ${r.hub_qitem_id}).\n\n`;
const requestFoot = (requestId: string): string =>
  `\n\n---\nWhen the hub item closes, OpenRig closes this item with its answer and says who gave it. Read it with rig queue show ${requestId}.`;
const summaryLead = (peer: string): string => `To ${peer} via network hub`;

/** What a create sends: the request's body and summary, read from its local item. Null when that text is gone (the item
 *  was erased) or isn't the request the receipt names; such a request is never sent. */
function requestPayload(local: QueueItem, receipt: RequestRow): { body: string; summary: string | null } | null {
  const foot = requestFoot(receipt.local_qitem_id), all = local.body ?? "";
  // Today's head, or the one written before fragments were hidden (the same text for a URL without a fragment).
  const head = [requestHead(receipt), requestHead(receipt, priorShownHubUrl)].find((h) => all.startsWith(h));
  if (!head || all.length < head.length + foot.length || !all.endsWith(foot)) return null;
  const body = all.slice(head.length, all.length - foot.length);
  if (sha256(body) !== receipt.body_sha256) return null;
  const lead = `${summaryLead(receipt.peer)}: `;
  return { body, summary: local.summary?.startsWith(lead) ? local.summary.slice(lead.length) : null };
}

/** A hub item that was handed on there: handed off, or closed done by a handoff-and-complete. Its answer is its successor's. */
const handedOn = (item: HubItem): boolean => item.state === "handed-off" || (item.state === "done" && item.closureReason === "handed_off_to");

type CreateOutcome = { kind: "created"; item: HubItem } | { kind: "found"; item: HubItem } | { kind: "refused"; error: HubError }
  | { kind: "unknown"; error: HubError };

/** A requester question is confirmed only with the hub's persisted relation, including on same-id readback. */
function confirmedQuestion(receipt: RequestRow, item: HubItem, kind: "created" | "found"): CreateOutcome {
  if (receipt.requester_hub_qitem_id && item.requesterOf !== receipt.requester_hub_qitem_id) {
    return { kind: "unknown", error: new HubError("unavailable", "The hub did not confirm the question's original-work relation. No name-based fallback was sent.") };
  }
  return { kind, item };
}

/** Create the request on the hub under its derived id. A refusal with the hub's own code, or the hub holding a different
 *  request under that id, is definite; anything else (a timeout, a lost connection, an answer that can't be read) leaves
 *  the outcome unknown. A revoked credential is thrown, for the caller to handle. */
async function createOnHub(hub: HubSession, receipt: RequestRow, payload: { body: string; summary: string | null }): Promise<CreateOutcome> {
  try {
    const route = receipt.requester_hub_qitem_id ? { requesterOf: receipt.requester_hub_qitem_id } : { destination: receipt.peer };
    const created = await hub.create({ qitemId: receipt.hub_qitem_id, ...route, body: payload.body, summary: payload.summary });
    if (created.createWarning) return { kind: "refused", error: new HubError("refused", "The hub already holds a different request under this id.", created.createWarning) };
    return confirmedQuestion(receipt, created, "created");
  } catch (error) {
    if (!(error instanceof HubError) || error.kind === "revoked") throw error;
    // The id is taken: another create of this request (a command retry and a pass can overlap) may have landed first and
    // been moved on there since. That isn't a refusal of this request, so it's read back by the same id; if it can't be
    // read, the outcome stays unknown, a refused credential included: the hub may hold the request all the same.
    if (error.kind === "refused" && error.code === "qitem_id_reuse") {
      try {
        return confirmedQuestion(receipt, await hub.show(receipt.hub_qitem_id), "found");
      } catch (shown) {
        if (!(shown instanceof HubError)) throw shown;
        return { kind: "unknown", error: shown };
      }
    }
    return { kind: error.kind === "refused" && error.code ? "refused" : "unknown", error };
  }
}

/** What stops a create just before it starts: the binding no longer active, or the local item closed or erased here. */
type CreateStop = "binding" | "closed" | "erased" | "requester";
type BeforeCreate = { kind: "ready"; payload: { body: string; summary: string | null } } | { kind: "stopped"; stop: CreateStop };

/** Read right before a remote create, never from a copy taken before an await: the binding the create goes through and the
 *  local item, with the request's payload from that item as it is now. A close, erasure or disconnect here meanwhile
 *  stops the create. */
function beforeCreate(deps: NetworkRequestDeps, bindingId: string, receipt: RequestRow, live: () => boolean): BeforeCreate {
  if (!live() || deps.bindings.get(bindingId)?.state !== "active") return { kind: "stopped", stop: "binding" };
  const local = deps.queueRepo.getById(receipt.local_qitem_id);
  if (local && LOCAL_CLOSED.has(local.state)) return { kind: "stopped", stop: "closed" };
  if (receipt.requester_local_qitem_id) {
    const work = deps.queueRepo.getById(receipt.requester_local_qitem_id);
    if (!work || LOCAL_CLOSED.has(work.state) || work.destinationSession !== currentSession(deps.db, receipt.node_id)) {
      return { kind: "stopped", stop: "requester" };
    }
  }
  const payload = local ? requestPayload(local, receipt) : null;
  return payload ? { kind: "ready", payload } : { kind: "stopped", stop: "erased" };
}

type Reached = CreateOutcome | { kind: "stopped"; stop: CreateStop };

/** The request's hub item, read before any create. With `showFirst` (a request the hub may already hold), it's shown by
 *  its id first, and only a refusal with qitem_not_found, for a request the hub never confirmed, goes on to the create
 *  under that id; any other answer to the show (unavailable whatever its code, out of scope, unreadable) leaves the
 *  outcome unknown. The command's
 *  retry and the connector's pass both go through here. A revoked credential is thrown. */
async function reachOnHub(deps: NetworkRequestDeps, hub: HubSession, bindingId: string, receipt: RequestRow, showFirst: boolean,
  live: () => boolean = () => true): Promise<Reached> {
  if (showFirst) {
    try {
      return confirmedQuestion(receipt, await hub.show(receipt.hub_qitem_id), "found");
    } catch (error) {
      if (!(error instanceof HubError) || error.kind === "revoked") throw error;
      if (receipt.hub_created_at || error.kind !== "refused" || error.code !== "qitem_not_found") return { kind: "unknown", error };
    }
  }
  if (receipt.requester_hub_qitem_id && !await hub.offers("rig_queue_create", "requesterOf")) {
    return { kind: "unknown", error: new HubError("unavailable", "This hub no longer advertises requester questions; no create or name-based fallback was sent.") };
  }
  const ready = beforeCreate(deps, bindingId, receipt, live);
  if (ready.kind === "stopped") return ready;
  return createOnHub(hub, receipt, ready.payload);
}

/** Why a create didn't start, on the receipt. A close or erasure here settles the request; an ended binding leaves it open
 *  for a new binding for the same seat, hub and participant to take over. */
function stopBeforeCreate(deps: NetworkRequestDeps, receipt: RequestRow, stop: CreateStop, now: () => Date): void {
  if (stop === "requester") refuse(deps, receipt, new HubError("refused", "The original work is no longer active for this seat; no requester question was sent.", "requester_unreachable"), now);
  else if (stop === "closed") settle(deps, receipt, "local_closed", now);
  else if (stop === "erased") settle(deps, receipt, "unknown", now, "The request's text is gone here, so it can't be sent.");
  else noteError(deps, receipt, "The binding wasn't active at the create, so nothing was sent through it.");
}

/** Send a request to a peer through the binding's hub. It's recorded first, as an item from the seat to OpenRig under
 *  `requestId`, parked on the hub item; then created on the hub. A create the hub refused closes the local item failed
 *  with the hub's words; one whose outcome isn't known stays parked, and the connector's next pass finds or creates it by
 *  its id. The same `requestId` with the same request returns where it stands; with another request it's refused. A local
 *  item closed or erased here since it was recorded starts no peer work. */
export async function originateNetworkRequest(deps: NetworkRequestDeps, binding: NetworkBinding,
  input: { peer?: unknown; requesterOf?: unknown; requestId: unknown; body: unknown; summary?: unknown;
    /** The route records the actual caller; direct/internal callers keep the binding seat as before. */
    caller?: Pick<Parameters<QueueRepository["create"]>[0], "sourceSession" | "identityProvenance" | "identityPrincipal" | "returnRoute" | "returnRouteBasis" | "tags"> }): Promise<NetworkRequestResult> {
  const now = deps.now ?? (() => new Date());
  if (input.requesterOf !== undefined && !text(input.requesterOf)) {
    throw new NetworkBindingError("invalid_request_route", "--requester-of needs a non-empty work id; it never falls back to a named peer.");
  }
  const requesterLocal = text(input.requesterOf) || null;
  const peer = text(input.peer) || (requesterLocal ? `requester of ${requesterLocal}` : "");
  const requestId = text(input.requestId);
  const body = typeof input.body === "string" ? input.body : "";
  const summary = text(input.summary) || null;
  if (!peer) throw new NetworkBindingError("invalid_peer", "Name the peer as rig network peers lists it.");
  if (requesterLocal && text(input.peer)) throw new NetworkBindingError("invalid_request_route", "Choose a peer or --requester-of, not both.");
  if (!requestId || /\s/.test(requestId)) throw new NetworkBindingError("invalid_request_id", "Give the request an id of your own with no spaces, unique to this request; retry only with the same id.");
  if (!body.trim()) throw new NetworkBindingError("invalid_body", "The request needs a body: what to do and what to return.");
  const token = usableToken(deps, binding);
  const session = currentSession(deps.db, binding.nodeId);
  if (!session) throw new NetworkBindingError("no_session", `${binding.localSession} has no session here, so there's no seat to record the request for.`, 409);
  const hubId = networkHubRequestId(binding, requestId);
  const bodySha = sha256(body);
  const reused = () => new NetworkBindingError("request_id_reused",
    `${requestId} already names another request or item here. Use a new id for a new request; the same id retries only the same request.`, 409);

  const existing = deps.db.prepare("SELECT * FROM network_requests WHERE local_qitem_id = ?").get(requestId) as RequestRow | undefined;
  if (existing) {
    if (existing.node_id !== binding.nodeId || existing.hub_url !== binding.hubUrl || existing.hub_seat !== binding.hubSeat
      || existing.peer !== peer || existing.body_sha256 !== bodySha || (existing.requester_local_qitem_id ?? null) !== requesterLocal) throw reused();
    if (existing.outcome === "refused") return result(existing, "refused", `The hub refused this request earlier: ${existing.last_error ?? "no reason recorded"}. ${requestId} is closed failed.`);
    if (existing.hub_created_at) {
      // Already closed here: a row parked on it now would never wake, so the wait hint would mislead.
      const closed = LOCAL_CLOSED.has(deps.queueRepo.getById(requestId)?.state ?? "");
      return result(existing, "sent", `${requestId} was already sent to ${peer} as hub item ${hubId}. ${closed
        ? `It has closed, so nothing more will wake you for it: read its outcome with rig queue show ${requestId}.`
        : `Its answer comes back to ${requestId}: read it with rig queue show ${requestId}.${WAIT_HINT}`}`);
    }
    if (existing.settled_at) {
      return result(existing, "unknown", `${requestId} was settled (${existing.outcome}) before the hub confirmed hub item ${hubId}, so nothing more is read for it. ${existing.last_error ?? ""}`.trim());
    }
  } else {
    let requesterHub: string | null = null;
    const waitVersion = (work: QueueItem) => `network-requester-state:${sha256(JSON.stringify([work.state, work.blockedOn, work.destinationSession]))}`;
    let firstWaitVersion: string | undefined;
    if (requesterLocal) {
      // Discovery precedes even the local receipt: old hubs may silently ignore unknown arguments.
      try {
        if (!await withHub(deps, binding, token, hub => hub.offers("rig_queue_create", "requesterOf"))) {
          throw new NetworkBindingError("requester_question_unsupported", "This network's hub does not support asking the requester. No question or wait was written; no name-based fallback was sent.", 409);
        }
      } catch (error) { throw hubRefusal(error); }
      const work = deps.queueRepo.getById(requesterLocal);
      const taken = deps.db.prepare("SELECT binding_id, hub_qitem_id FROM network_receipts WHERE local_qitem_id = ? AND settled_at IS NULL")
        .get(requesterLocal) as { binding_id: string; hub_qitem_id: string } | undefined;
      const origin = taken ? deps.bindings.get(taken.binding_id) : null;
      if (!work || LOCAL_CLOSED.has(work.state) || work.destinationSession !== session || !taken || !origin
        || origin.nodeId !== binding.nodeId || origin.hubUrl !== binding.hubUrl || origin.hubSeat !== binding.hubSeat) {
        throw new NetworkBindingError("requester_unreachable", "Name active network work this seat owns through this binding. No question or wait was written.", 409);
      }
      if (/^(fold:|auth:|external:)/.test(requestId)) throw new NetworkBindingError("invalid_request_id", "A question receipt needs an ordinary item id, not a gate reference.");
      requesterHub = taken.hub_qitem_id;
      firstWaitVersion = waitVersion(work);
    }
    // Recorded first: the seat's request, held by OpenRig until the answer closes it. Nothing wakes anyone for it.
    try {
      const local = await deps.queueRepo.create({
        qitemId: requestId,
        sourceSession: input.caller?.sourceSession ?? session,
        identityProvenance: input.caller?.identityProvenance,
        identityPrincipal: input.caller?.identityPrincipal,
        returnRoute: input.caller?.returnRoute,
        returnRouteBasis: input.caller?.returnRouteBasis,
        destinationSession: OPENRIG_SENDER,
        summary: summary ? `${summaryLead(peer)}: ${summary}` : summaryLead(peer),
        body: `${requestHead({ peer, hub_url: binding.hubUrl, hub_seat: binding.hubSeat, hub_qitem_id: hubId })}${body}${requestFoot(requestId)}`,
        tags: [`network-binding:${binding.id}`, `network-peer:${peer}`, `network-hub-item:${hubId}`, "network-direction:outbound",
          ...(requesterLocal ? ["network-requester-question", firstWaitVersion!] : []), ...(input.caller?.tags ?? [])],
        nudge: false,
      });
      if (local.createWarning) throw reused();
      // Idempotent create returns the original row: recovery must use its first observed work state.
      firstWaitVersion = (local.tags ?? []).find(tag => tag.startsWith("network-requester-state:"));
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
    if (requesterLocal) {
      // Establish the receipt and its initial wait together. Recovery (including an overlapping create that lost
      // this insert) must not replay the mutation over a dependency the owner selected later.
      const committed = deps.db.transaction(() => {
        const inserted = deps.db.prepare(`INSERT INTO network_requests (local_qitem_id, binding_id, node_id, hub_url, hub_seat, peer, hub_qitem_id, body_sha256, created_at, requester_local_qitem_id, requester_hub_qitem_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(requestId, binding.id, binding.nodeId, binding.hubUrl, binding.hubSeat, peer, hubId, bodySha, now().toISOString(), requesterLocal, requesterHub);
        if (inserted.changes === 0) return [];
        const work = deps.queueRepo.getById(requesterLocal);
        if (work && !LOCAL_CLOSED.has(work.state) && work.destinationSession === session && work.blockedOn !== requestId
          && firstWaitVersion === waitVersion(work)) {
          return deps.queueRepo.updateWithinTransaction({ qitemId: work.qitemId, actorSession: session, state: "blocked", blockedOn: requestId,
            transitionNote: "Waiting on the requester's explicit answer through the network question receipt." }).persistedEvents;
        }
        return [];
      })();
      deps.queueRepo.notifyCommitted(committed);
    } else {
      deps.db.prepare(`INSERT INTO network_requests (local_qitem_id, binding_id, node_id, hub_url, hub_seat, peer, hub_qitem_id, body_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(requestId, binding.id, binding.nodeId, binding.hubUrl, binding.hubSeat, peer, hubId, bodySha, now().toISOString());
    }
  }
  const receipt = deps.db.prepare("SELECT * FROM network_requests WHERE local_qitem_id = ?").get(requestId) as RequestRow;

  // The payload comes from the local item, so a retry sends what the first attempt recorded, summary included.
  const local = deps.queueRepo.getById(requestId);
  const payload = local && !LOCAL_CLOSED.has(local.state) ? requestPayload(local, receipt) : null;
  if (!payload) {
    const closedHere = !!local && LOCAL_CLOSED.has(local.state);
    settle(deps, receipt, closedHere ? "local_closed" : "unknown", now, closedHere ? null : "The request's text is gone here, so it can't be sent.");
    return result(receipt, "unknown", `${requestId} was ${closedHere ? "closed" : "erased"} here before the hub confirmed hub item ${hubId}, so it isn't sent.`);
  }
  /** A refused credential when the hub may hold the request anyway: it stays open and unknown, said once, for a new
   *  binding for the same seat, hub and participant to read. */
  const keptOpen = (error: HubError): NetworkRequestResult => {
    const note = `The hub refused this binding's credential, so whether it holds hub item ${hubId} is unknown. This item stays open; a new binding for the same seat, hub and participant reads it.`;
    if (receipt.last_error !== note && writeLocal(deps, receipt, now, () => deps.queueRepo.update({ qitemId: requestId, actorSession: OPENRIG_SENDER, transitionNote: note }))) noteError(deps, receipt, note);
    return result(receipt, "unknown", `${note} (${error.message})`);
  };
  // A request recorded before whose create wasn't confirmed: its hub item is shown first, as the connector's pass does.
  let outcome: Reached;
  try {
    outcome = await withHub(deps, binding, token, (hub) => reachOnHub(deps, hub, binding.id, receipt, !!existing));
  } catch (error) {
    if (!(error instanceof HubError)) throw error;
    // The credential refused: nothing can be sent through this binding. For a new request whose own create was refused
    // that's definite. One whose earlier create wasn't confirmed may still be on the hub, so it stays open and unknown.
    if (error.kind === "revoked" && existing) return keptOpen(error);
    outcome = error.kind === "revoked" ? { kind: "refused", error } : { kind: "unknown", error };
  }
  if (outcome.kind === "stopped") {
    stopBeforeCreate(deps, receipt, outcome.stop, now);
    if (outcome.stop === "requester") return result(receipt, "refused", "The original work is no longer active for this seat; no requester question was sent.");
    return result(receipt, "unknown", outcome.stop === "binding"
      ? `${binding.id} wasn't active when ${requestId} was to be created on the hub, so nothing was sent. A new binding for the same seat, hub and participant picks it up.`
      : `${requestId} was ${outcome.stop === "closed" ? "closed" : "erased"} here before the hub confirmed hub item ${hubId}, so it isn't sent.`);
  }
  if (outcome.kind === "refused") {
    refuse(deps, receipt, outcome.error, now);
    return result(receipt, "refused", `The hub refused it: ${outcome.error.message}${outcome.error.code ? ` (${outcome.error.code})` : ""}. ${requestId} is closed failed with that reason.`);
  }
  if (outcome.kind === "unknown") {
    // A credential refused while reading back a taken id: the hub may already hold this request, even on a first try.
    if (outcome.error.kind === "revoked") return keptOpen(outcome.error);
    deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(outcome.error.message.slice(0, 500), requestId);
    return result(receipt, "unknown", `${requestId} is recorded, and whether the hub has it yet is unknown (${outcome.error.message}). The connector checks hub item ${hubId} on its next pass and creates it there under the same id if it's missing. Retry only with the same --id.${WAIT_HINT}`);
  }
  deps.db.prepare("UPDATE network_requests SET hub_created_at = ?, last_error = NULL WHERE local_qitem_id = ?").run(now().toISOString(), requestId);
  return result(receipt, "sent", `${outcome.kind === "found" ? `${requestId} is already on the hub as hub item ${hubId}` : `Sent to ${peer} as hub item ${hubId}`}. `
    + `Its answer comes back to ${requestId}: read it with rig queue show ${requestId}.${WAIT_HINT}`);
}

/** The local item belongs to OpenRig, so its close wakes no seat (it owes nothing on it): say how to be woken, where the
 *  sender reads the outcome. Guidance only; nothing is created for the seat. */
const WAIT_HINT = " Nothing wakes you when it closes: to be woken, park a row of your own on it (rig network request --help shows how).";

function result(receipt: RequestRow, state: NetworkRequestState, message: string): NetworkRequestResult {
  return { localQitemId: receipt.local_qitem_id, hubQitemId: receipt.hub_qitem_id, peer: receipt.peer, state, message };
}

function settle(deps: NetworkRequestDeps, receipt: RequestRow, outcome: string, now: () => Date, lastError: string | null = null): void {
  deps.db.prepare("UPDATE network_requests SET settled_at = ?, outcome = ?, last_error = ? WHERE local_qitem_id = ?")
    .run(now().toISOString(), outcome, lastError, receipt.local_qitem_id);
}

function noteError(deps: NetworkRequestDeps, receipt: RequestRow, message: string): void {
  deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(message.slice(0, 500), receipt.local_qitem_id);
}

/** Only the hub's explicit wait travels. Arbitrary notes and question text never enter the receipt. */
async function retainNetworkWait(deps: NetworkRequestDeps, binding: NetworkBinding, hub: HubSession, receipt: RequestRow,
  shown: HubItem, now: () => Date, live: () => boolean): Promise<void> {
  if (!Object.hasOwn(receipt, "remote_wait")) return; // Older minimal databases have no requester-question schema.
  let wait: NetworkWait | null = shown.state === "blocked"
    ? { kind: "another-request", hubQitemId: null, localQitemId: null, blockerState: null, observedAt: now().toISOString() } : null;
  if (wait && shown.blockedOn) {
    try {
      const question = await hub.show(shown.blockedOn);
      if (question.requesterOf === shown.qitemId && question.destinationSession === binding.hubSeat) {
        const taken = deps.db.prepare("SELECT local_qitem_id FROM network_receipts WHERE binding_id = ? AND hub_qitem_id = ?")
          .get(binding.id, question.qitemId) as { local_qitem_id: string } | undefined;
        wait = { ...wait, kind: "requester-question", hubQitemId: question.qitemId,
          localQitemId: taken?.local_qitem_id ?? null, blockerState: question.state };
      }
    } catch (error) {
      // An unreadable blocker is an honest generic wait, never an excuse to expose its id or settle this work.
      if (!(error instanceof HubError) || error.kind === "revoked" || !live()) throw error;
    }
  }
  if (!live()) return;
  let prior: NetworkWait | null = null;
  try { prior = JSON.parse(receipt.remote_wait ?? "null") as NetworkWait | null; } catch { /* replace an unreadable cache */ }
  const state = (value: NetworkWait | null) => value ? { ...value, observedAt: undefined } : null;
  if (JSON.stringify(state(prior)) !== JSON.stringify(state(wait))) {
    if (!writeLocal(deps, receipt, now, () => deps.queueRepo.update({ qitemId: receipt.local_qitem_id, actorSession: OPENRIG_SENDER,
      transitionNote: wait?.kind === "requester-question" ? "The network work is waiting on a question to its requester."
        : wait ? "The network work is waiting on another request; its details are not visible here." : "The network work is no longer blocked on another request." }))) return;
  }
  deps.db.prepare("UPDATE network_requests SET remote_wait = ? WHERE local_qitem_id = ? AND settled_at IS NULL")
    .run(wait ? JSON.stringify(wait) : null, receipt.local_qitem_id);
  receipt.remote_wait = wait ? JSON.stringify(wait) : null;
}

/** A write to the local item that can't stop a pass. If the queue refuses it because someone here closed the item
 *  meanwhile, that close stands and the request settles as theirs; any other refusal is recorded on the receipt, and the
 *  next pass tries again. */
function writeLocal(deps: NetworkRequestDeps, receipt: RequestRow, now: () => Date, write: () => void): boolean {
  try {
    write();
    return true;
  } catch (error) {
    if (!(error instanceof QueueRepositoryError)) throw error;
    const local = deps.queueRepo.getById(receipt.local_qitem_id);
    if (!local || LOCAL_CLOSED.has(local.state)) settle(deps, receipt, local ? "local_closed" : "unknown", now);
    else noteError(deps, receipt, error.message);
    return false;
  }
}

/** The hub refused the request: the local item closes failed with the hub's words, and nothing more is read. */
function refuse(deps: NetworkRequestDeps, receipt: RequestRow, error: HubError, now: () => Date): void {
  const why = `${error.message}${error.code ? ` (${error.code})` : ""}`.slice(0, 500);
  const local = deps.queueRepo.getById(receipt.local_qitem_id);
  if (local && !LOCAL_CLOSED.has(local.state) && !writeLocal(deps, receipt, now, () => deps.queueRepo.update({ qitemId: local.qitemId,
    actorSession: OPENRIG_SENDER, expectState: local.state, state: "failed", resolution: `The network hub refused this request: ${why}`,
    transitionNote: `Refused by the network hub ${shownHubUrl(receipt.hub_url)} (hub item ${receipt.hub_qitem_id}).` }))) return;
  settle(deps, receipt, "refused", now, why);
}

/** One pass's reading of this binding's open requests, on the pass's hub session. Open requests of an ended binding for
 *  the same seat, hub and participant are taken over first. A refusal on one request is recorded on it and the rest go
 *  on; a hub that stops answering leaves the rest for the next pass; a revoked credential ends the pass, as the
 *  connector's own calls do. A local write the queue refuses never stops the pass. Returns the hub's unavailable answer
 *  that stopped the reading, if one did, for the pass to report and back off on. */
export async function reconcileNetworkRequests(deps: NetworkRequestDeps, binding: NetworkBinding, hub: HubSession,
  now: () => Date = deps.now ?? (() => new Date()), live: () => boolean = () => true): Promise<HubError | null> {
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
    // Only a confirmed not-found means a create never landed. Any other refusal of the show (out of scope after a lost
    // reply, say) is recorded, and the request is neither created again nor closed on it.
    const reached = await reachOnHub(deps, hub, binding.id, receipt, true, live);
    if (reached.kind === "stopped") {
      stopBeforeCreate(deps, receipt, reached.stop, now);
      if (reached.stop === "binding") break;
      continue;
    }
    if (reached.kind === "refused") { refuse(deps, receipt, reached.error, now); continue; }
    if (reached.kind === "unknown") {
      // A refused credential ends the pass, as on any other call: the connector marks the binding revoked.
      if (reached.error.kind === "revoked") throw reached.error;
      noteError(deps, receipt, reached.error.message);
      // The hub stopped answering partway: the rest wait for the next pass, and the work taken in this pass stands.
      if (reached.error.kind === "unavailable") return reached.error;
      continue;
    }
    const shown = reached.item;
    if (!receipt.hub_created_at) {
      deps.db.prepare("UPDATE network_requests SET hub_created_at = ?, last_error = NULL WHERE local_qitem_id = ?").run(now().toISOString(), receipt.local_qitem_id);
    }
    // A hub item handed on there: its answer is its successor's, followed while this participant can read it.
    let end: HubItem | null = shown;
    let stopped: HubError | null = null;
    for (let hop = 0; hop < 20 && end && handedOn(end); hop++) {
      if (!end.successor) { end = null; break; }
      try { end = await hub.show(end.successor); } catch (error) {
        if (!(error instanceof HubError) || error.kind === "revoked") throw error;
        if (error.kind === "unavailable") { noteError(deps, receipt, error.message); stopped = error; }
        end = null;
      }
    }
    if (!end || handedOn(end)) {
      await retainNetworkWait(deps, binding, hub, receipt, shown, now, live);
      if (stopped) return stopped;
      if (receipt.last_error !== HANDED_ON_UNREADABLE && writeLocal(deps, receipt, now,
        () => deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, transitionNote: HANDED_ON_UNREADABLE }))) {
        noteError(deps, receipt, HANDED_ON_UNREADABLE);
      }
      continue;
    }
    await retainNetworkWait(deps, binding, hub, receipt, end, now, live);
    if (!live()) return null;
    if (!HUB_FINAL.has(end.state)) continue;
    // The local item closes the way the hub item did: failed as failed, a cancel or a refusal as itself, never as success.
    // A reason the local queue takes only with a target here (escalation) is named in the note, and the close is no-follow-on.
    const state = end.state === "failed" ? "failed" as const : "done" as const;
    const closureReason = end.state === "canceled" ? "canceled" : end.state === "denied" ? "denied"
      : end.closureReason && CLOSURE_REASONS.has(end.closureReason) ? end.closureReason : "no-follow-on";
    const named = state === "done" && end.closureReason && end.closureReason !== closureReason ? `; closed there as ${end.closureReason}` : "";
    const answeredBy = end.destinationSession || receipt.peer, endItem = end;
    if (writeLocal(deps, receipt, now, () => deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, expectState: local.state,
      state, ...(state === "done" ? { closureReason } : {}), resolution: endItem.resolution || "Closed without a stated result.",
      transitionNote: `Answered by ${answeredBy} via network hub ${shownHubUrl(receipt.hub_url)} (hub item ${endItem.qitemId})${named}.` }))) {
      settle(deps, receipt, end.state, now);
    }
  }
  return null;
}

/** A binding the hub ended: each open request sent through it says once, on its local item, that its answer can't be read
 *  here. The requests stay open, so a new binding for the same seat, hub and participant takes them over. It never throws:
 *  it runs while the connector records the revoke. A note that can't be written is skipped and the others go on. */
export function noteEndedBindingRequests(deps: Pick<NetworkRequestDeps, "db" | "queueRepo">, binding: NetworkBinding, log?: (line: string) => void): void {
  let open: RequestRow[];
  try {
    open = deps.db.prepare("SELECT * FROM network_requests WHERE binding_id = ? AND settled_at IS NULL").all(binding.id) as RequestRow[];
  } catch (error) {
    log?.(`network ${binding.id}: couldn't read its open requests: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  for (const receipt of open) {
    if (Object.hasOwn(receipt, "remote_wait")) deps.db.prepare("UPDATE network_requests SET remote_wait = NULL WHERE local_qitem_id = ?").run(receipt.local_qitem_id);
    if (receipt.last_error === BINDING_ENDED) continue;
    try {
      const local = deps.queueRepo.getById(receipt.local_qitem_id);
      if (local && !LOCAL_CLOSED.has(local.state)) deps.queueRepo.update({ qitemId: local.qitemId, actorSession: OPENRIG_SENDER, transitionNote: BINDING_ENDED });
      deps.db.prepare("UPDATE network_requests SET last_error = ? WHERE local_qitem_id = ?").run(BINDING_ENDED, receipt.local_qitem_id);
    } catch (error) {
      log?.(`network ${binding.id}: couldn't note request ${receipt.local_qitem_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
