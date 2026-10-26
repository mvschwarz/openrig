// Slack slice 05 (#1679): `rig slack post-open-asks`. Enabling Slack seeds the asks already open as history (enable never
// replays a backlog), so a person who turns Slack on doesn't see the decisions already waiting for them. This command is
// the deliberate way to show them, run after enable; ordinary enable is unchanged.
// - Each open ask's current episode is offered once more through ordinary delivery: the delivery rules at its recorded
//   level, quiet hours, digest, recipient, channel and thread rules, and the current posting floor. Nothing is raised, and
//   no new row, timer or service is made. Its decision id is fixed (`re-present:<notificationKey>`), so a second run or a
//   restart converges on one post, and the gateway checks the ask is still current when it posts.
// - Before that id is used, the episode's own receipts and pending decisions are reconciled: a posted ask isn't posted
//   again, and an ask that ordinary delivery still owns (a decision waiting in the buffer, a quiet hold, a digest) is
//   reported, not offered a second time. Only an ask enable seeded is offered; one ordinary delivery hasn't reached yet is
//   left to its sweep.
// - Each ask's outcome is reported from what its row records, never from the dispatch: a dispatch accepted is "queued,
//   awaiting receipt" until the receipt exists. Nothing claims exactly once.
// - A record it can't read (the dispatch buffer, the seen store, the attempt record) is never taken as absent: the ask is
//   reported as state unavailable and isn't offered, or as uncertain once offered.

import path from "node:path";
import type { QueueRepository } from "../../queue-repository.js";
import type { DispatchResult } from "../dispatcher.js";
import { DispatchBuffer } from "../dispatch-buffer.js";
import type { LoadResult } from "../human-registry.js";
import { makeQueuePorts } from "./queue-access.js";
import { SeenStore } from "./state-store.js";
import { OUTBOUND_OP, toPayload, type OutboundPostPayload } from "./outbound-driver.js";
import type { OwnerNotificationLevel } from "../../queue-transition-log.js";
import { DISPOSITION_PREFIX as QUIET_RELEASE_DISPOSITION, hasToken, parseQuietHoldNote, type ReleaseDisposition } from "../../policies/quiet-release.js";
import { DELIVERY_DEFERRAL_ARMED_PREFIX } from "../../policies/delivery-deferral.js";

export const RE_PRESENT_DECISION_PREFIX = "re-present:";
const REQUESTED = "slack-re-present-requested";
const DISPOSITION = "slack-re-present-disposition";
const UNAVAILABLE = "slack-re-present-state-unavailable";
const SEEDED_AT_ENABLE = "seeded-at-enable";

export type OpenAskOutcome =
  | "posted" | "already-posted" | "queued" | "held" | "below-floor"
  | "no-longer-active" | "superseded" | "recipient-changed"
  | "state-unavailable" | "transport-failed" | "uncertain";

export interface OpenAskResult {
  qitemId: string;
  notificationKey: string;
  recipient: string;
  summary: string | null;
  outcome: OpenAskOutcome;
  detail?: string;
  /** This run offered it again (its row carries the request). */
  reshown: boolean;
}

export interface PostOpenAsksResult {
  asks: OpenAskResult[];
  counts: Partial<Record<OpenAskOutcome, number>>;
}

/** The re-present decision for one episode: fixed, so a second run or a replay converges on it. */
export const rePresentDecisionId = (notificationKey: string): string => `${RE_PRESENT_DECISION_PREFIX}${notificationKey}`;

/** The gateway's record that a re-shown ask didn't post: it's no longer this person's current ask, or the state it is
 *  decided from couldn't be read before any attempt. Either way it's not posted, and the row says why. */
export function noteRePresentNotPosted(queueRepo: QueueRepository, qitemId: string, notificationKey: string,
  verdict: { kind: "disposition"; reason: ReleaseDisposition } | { kind: "unavailable"; detail: string }): void {
  const note = verdict.kind === "disposition"
    ? `${DISPOSITION} notification_key=${notificationKey} reason=${verdict.reason}`
    : `${UNAVAILABLE} notification_key=${notificationKey} detail=${verdict.detail.replace(/\s+/g, " ").trim()}`;
  queueRepo.update({ qitemId, actorSession: "daemon@kernel", transitionNote: note });
}

const DISPOSITION_OUTCOME: Record<ReleaseDisposition, { outcome: OpenAskOutcome; detail?: string }> = {
  "row-not-active": { outcome: "no-longer-active" },
  superseded: { outcome: "superseded", detail: "the row has a newer ask since" },
  "recipient-changed": { outcome: "recipient-changed" },
  "below-posting-threshold": { outcome: "below-floor", detail: "the posting floor was raised before it posted" },
};

/** The latest delivery fact a row records for this episode, oldest notes first. A posted receipt wins whenever it is. */
function deliveryFact(notes: string[], key: string): { outcome: OpenAskOutcome; detail?: string } | null {
  if (notes.some((n) => hasToken(n, "slack-owner-notification-posted", key))) return { outcome: "posted" };
  for (const note of [...notes].reverse()) {
    if (hasToken(note, "slack-owner-notification-transport-failed", key)) {
      return { outcome: "transport-failed", detail: /\bclass=(\S+)/.exec(note)?.[1] };
    }
    if (parseQuietHoldNote(note)?.notificationKey === key || hasToken(note, "quiet-release-returned", key)) {
      return { outcome: "held", detail: "quiet hours: their release posts it when quiet hours end" };
    }
    if (note.startsWith("delivery-decision: digest") && note.split(/\s+/).includes(`notification_key=${key}`)) {
      return { outcome: "held", detail: `in the ${/\bwindow=(\S+)/.exec(note)?.[1] ?? "4h"} digest` };
    }
    if (hasToken(note, DELIVERY_DEFERRAL_ARMED_PREFIX, key)) {
      return { outcome: "held", detail: `deferred interrupt, fires at ${/\bfire_at=(\S+)/.exec(note)?.[1] ?? "its set time"}` };
    }
    if (hasToken(note, "slack-owner-notification-dropped", key)) return { outcome: "no-longer-active" };
    const disposition = hasToken(note, DISPOSITION, key) || hasToken(note, QUIET_RELEASE_DISPOSITION, key)
      ? /\breason=(\S+)/.exec(note)?.[1] as ReleaseDisposition | undefined : undefined;
    if (disposition && DISPOSITION_OUTCOME[disposition]) return DISPOSITION_OUTCOME[disposition];
    if (hasToken(note, UNAVAILABLE, key)) {
      return { outcome: "state-unavailable", detail: `not posted: ${note.slice(note.indexOf("detail=") + 7) || "the delivery state couldn't be read"}` };
    }
  }
  return null;
}

/** The person's delivery rules recorded the ask without posting it (the consult's log outcome writes no row note). */
const LOG_ONLY = { outcome: "below-floor" as const, detail: "the person's delivery rules record it without posting" };

export interface PostOpenAsksInput {
  queueRepo: QueueRepository;
  home: string;
  loadHumanRegistry: () => LoadResult;
  minimumLevelThatPosts: OwnerNotificationLevel;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => DispatchResult;
  /** Who asked, recorded on each re-shown ask's row. */
  actor: string;
  /** How long to wait for the re-shown asks' outcomes before reporting the rest as queued. */
  waitMs?: number;
  /** The seen store's path (the gateway's, by default). */
  seenPath?: string;
}

/** Show the open asks again: reconcile each, offer the ones enable seeded, then report every ask's outcome. */
export async function postOpenAsks(input: PostOpenAsksInput): Promise<PostOpenAsksResult> {
  const { queueRepo } = input;
  const ports = makeQueuePorts(queueRepo, { loadHumanRegistry: input.loadHumanRegistry });
  const episodes = await ports.listOpenAsks({ minimumLevel: input.minimumLevelThatPosts });
  const seen = new SeenStore(input.seenPath ?? path.join(input.home, "state", "slack-outbound-seen.jsonl"));
  const attempted = new SeenStore(path.join(input.home, "state", "slack-attempted-decisions.jsonl"));
  const notesOf = (qitemId: string) => queueRepo.listTransitions(qitemId).map((t) => t.transitionNote ?? "");
  const message = (error: unknown) => (error as Error).message;
  /** A decision for this episode still waiting in the gateway's buffer (any id): ordinary delivery owns it. Strict reads:
   *  a buffer or attempt record that can't be read is "can't tell", never "none" (an absent file is "none"). */
  const pendingFor = (key: string): { outcome: OpenAskOutcome; detail: string } | { unreadable: string } | null => {
    let decisions: ReturnType<DispatchBuffer["pendingStrict"]>;
    try {
      decisions = new DispatchBuffer(input.home).pendingStrict();
    } catch (error) {
      return { unreadable: message(error) };
    }
    const pending = decisions.filter((d) => ((d.payload ?? {}) as OutboundPostPayload).notificationKey === key);
    if (pending.length === 0) return null;
    let tried: Map<string, string>;
    try {
      tried = attempted.statuses();
    } catch (error) {
      return { outcome: "uncertain", detail: `an earlier decision for it is waiting, and whether it reached Slack can't be read (${message(error)})` };
    }
    return pending.some((d) => tried.has(d.decisionId) || tried.has(`${d.decisionId}:part:1`))
      ? { outcome: "uncertain", detail: "an earlier attempt may already be in Slack; delivery checks Slack before it posts again" }
      : { outcome: "queued", detail: "an earlier decision for it is waiting for delivery" };
  };
  const notOffered = (what: string, error: string) => ({ outcome: "state-unavailable" as const,
    detail: `not offered: the gateway's ${what} couldn't be read (${error}), so whether it already has this ask can't be told` });

  const results: OpenAskResult[] = [];
  const reshown: Array<{ result: OpenAskResult; from: number }> = [];
  let statuses: Map<string, string> | { unreadable: string };
  try { statuses = seen.statuses(); } catch (error) { statuses = { unreadable: message(error) }; }
  for (const { item, posted, eligible } of episodes) {
    const key = item.notificationKey ?? item.qitemId;
    const result: OpenAskResult = { qitemId: item.qitemId, notificationKey: key, recipient: item.destinationSession ?? "",
      summary: item.summary ?? null, outcome: "uncertain", reshown: false };
    results.push(result);
    if (posted) { Object.assign(result, { outcome: "already-posted" }); continue; }
    if (!eligible) {
      Object.assign(result, { outcome: "below-floor", detail: item.ownerNotificationLevel === "RECORD"
        ? "asked at RECORD: it waits on Steering and the Feed without a Slack post"
        : `recorded at ${item.ownerNotificationLevel ?? "no level"}, below the posting floor ${input.minimumLevelThatPosts}` });
      continue;
    }
    const notes = notesOf(item.qitemId);
    const fact = deliveryFact(notes, key);
    const pending = pendingFor(key);
    if (pending && "unreadable" in pending) {
      Object.assign(result, fact && fact.outcome !== "state-unavailable" ? fact : notOffered("dispatch buffer", pending.unreadable));
      continue;
    }
    if (pending) {
      Object.assign(result, fact?.outcome === "transport-failed"
        ? { outcome: "transport-failed", detail: `${fact.detail ?? "failed"}; kept for another try when the gateway next starts` }
        : pending);
      continue;
    }
    if (fact && fact.outcome !== "state-unavailable") { Object.assign(result, fact); continue; }
    if (!(statuses instanceof Map)) { Object.assign(result, notOffered("seen store", statuses.unreadable)); continue; }
    const status = statuses.get(key);
    if (status === "log-class-contained") { Object.assign(result, LOG_ONLY); continue; }
    if (status === undefined) {
      Object.assign(result, { outcome: "queued", detail: "ordinary delivery hasn't offered it yet; its next sweep does" });
      continue;
    }
    if (status !== SEEDED_AT_ENABLE && fact?.outcome !== "state-unavailable") {
      Object.assign(result, { outcome: "uncertain", detail: `the gateway marked it ${status} without a matching record on its row` });
      continue;
    }
    // Enable seeded it (or an earlier run couldn't read its state): offer it once more, as itself.
    const res = input.dispatch(OUTBOUND_OP, item.destinationSession ?? "", toPayload(item), { decisionId: rePresentDecisionId(key) });
    if (!res.ok) {
      Object.assign(result, { outcome: "transport-failed", detail: `the gateway didn't take it: ${res.error}` });
      continue;
    }
    // Written after the dispatch is accepted and before delivery can record anything (it awaits first), so the row reads
    // in order: the request, then what became of it.
    const from = queueRepo.listTransitions(item.qitemId).length;
    queueRepo.update({ qitemId: item.qitemId, actorSession: "daemon@kernel",
      transitionNote: `${REQUESTED} notification_key=${key} by=${input.actor.replace(/\s+/g, "_")}` });
    Object.assign(result, { reshown: true, outcome: "queued", detail: undefined });
    reshown.push({ result, from });
  }

  // What became of each re-shown ask: only what its row records after this run's request counts.
  const settle = (): boolean => {
    let open = false;
    let latest: Map<string, string> | null;
    try { latest = seen.statuses(); } catch { latest = null; }
    for (const { result, from } of reshown) {
      const fact = deliveryFact(notesOf(result.qitemId).slice(from), result.notificationKey);
      const found = fact ? null : pendingFor(result.notificationKey);
      const pending = found && "unreadable" in found
        ? { outcome: "uncertain" as const, detail: `the gateway's dispatch buffer couldn't be read (${found.unreadable}), so its outcome isn't known yet` }
        : found;
      const settled = fact ?? pending ?? (latest?.get(result.notificationKey) === "log-class-contained" ? LOG_ONLY
        : { outcome: "uncertain" as const, detail: latest ? "delivery finished with it but its row records no outcome"
          : "delivery finished with it, its row records no outcome, and the seen store couldn't be read" });
      Object.assign(result, { outcome: settled.outcome, detail: settled.detail });
      if (!fact && pending) open = true;
    }
    return open;
  };
  const deadline = Date.now() + (input.waitMs ?? 0);
  while (settle() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200));

  const counts: Partial<Record<OpenAskOutcome, number>> = {};
  for (const r of results) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
  return { asks: results, counts };
}
