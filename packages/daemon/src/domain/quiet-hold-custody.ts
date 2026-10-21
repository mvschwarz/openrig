// Quiet hours, custody: what an ask held for quiet hours looks like to the wake ladder, the stuck sweep and the waiting
// view. One read of the row's own notes and the watchdog jobs table, so the three agree:
// - held: the ask's current notification carries a quiet-hold note (or a release that was turned back because quiet
//   came on again), and its window's quiet-release job is active. The job owns what happens next: it isn't stuck, it
//   isn't picked up, and the ladder leaves it alone. Once quiet has ended, the job posts it at its next pass;
// - released: the release job dispatched it, its post hasn't landed yet, and the job is still live: waiting for transport;
// - release-failed: dispatched, and a post failure for the notification is recorded with no receipt: a failed delivery,
//   reported as one;
// - orphaned: held or released, but no active release job for its window: nothing will release or redrive it, so the
//   sweep must find it. The hold note and its job are written together, and the job retires only once every ask it
//   holds is resolved, so this happens only when a job is stopped or terminated from outside.
// An ask that has posted, or whose release gave it a disposition, isn't quiet custody any more (null), and neither is
// any row without a quiet-hold note: digest-held and ordinary rows read exactly as before, and so does an attempted
// ask kept in the dispatch buffer because quiet hours couldn't be read (it has no hold; it is ordinary in-flight work).
import type Database from "better-sqlite3";
import { HumanQuietStore } from "./gateway/human-quiet-windows.js";
import { hasToken, parseQuietHoldNote, releaseJobWindowSpec } from "./policies/quiet-release.js";

export interface QuietHoldCustody {
  state: "held" | "released" | "release-failed" | "orphaned";
  windowId: string;
  notificationKey: string;
  /** For `held` while quiet is on: when it ends. Never a later quiet's start. */
  nextBoundary: string | null;
  /** For `held`: quiet has ended, and the window's release job posts it at its next pass. */
  quietOver?: true;
  /** For `release-failed`: the failure class the gateway recorded. */
  failure?: string;
  /** Custody couldn't be read for a row known to carry a quiet hold: treated as held for this pass. */
  unreadable?: true;
}

export function quietHoldCustody(db: Database.Database, qitemId: string, now: Date = new Date()): QuietHoldCustody | null {
  let sawHold = false;
  try {
    const notes = (db.prepare("SELECT transition_note AS note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id")
      .all(qitemId) as Array<{ note: string | null }>).map((r) => r.note ?? "");
    if (!notes.some((n) => n.startsWith("delivery-decision: quiet-hold "))) return null;
    sawHold = true;
    // The current notification's key: the latest owner notification, else the row itself (as the gateway keys it).
    const owner = db.prepare("SELECT transition_id AS id FROM queue_transitions WHERE qitem_id = ? AND owner_notification_level IS NOT NULL ORDER BY transition_id DESC LIMIT 1")
      .get(qitemId) as { id: number } | undefined;
    const key = owner ? `${qitemId}:${owner.id}` : qitemId;
    const hold = notes.map(parseQuietHoldNote).find((h) => h?.notificationKey === key);
    if (!hold) return null;
    const windowId = hold.windowId;
    if (notes.some((n) => hasToken(n, "slack-owner-notification-posted", key) || hasToken(n, "quiet-release-disposition", key))) return null;
    const live = db.prepare("SELECT 1 FROM watchdog_jobs WHERE policy = 'quiet-release' AND state = 'active' AND spec_yaml LIKE ? LIMIT 1")
      .get(`%${releaseJobWindowSpec(windowId)}%`);
    // Without a live job nothing redrives a release or releases a hold, whichever step it reached: orphaned.
    if (!live) return { state: "orphaned", windowId, notificationKey: key, nextBoundary: null };
    // The latest release step decides: dispatched (released, or failed if its post failed since) or returned (held again).
    let step = -1;
    for (let i = notes.length - 1; i >= 0; i--) {
      if (hasToken(notes[i]!, "quiet-release-dispatched", key) || hasToken(notes[i]!, "quiet-release-returned", key)) { step = i; break; }
    }
    if (step >= 0 && notes[step]!.startsWith("quiet-release-dispatched ")) {
      // A post failure for this notification with no receipt (a receipt or disposition ended custody above) is still
      // unresolved, even one recorded before this dispatch: the gateway records a failure once per notification, so a
      // failed re-dispatch adds none. That is the ledger's rule too: failed until a receipt. A release still in flight
      // after an earlier failure therefore reads as failed until its post lands.
      const failed = notes.find((n) => hasToken(n, "slack-owner-notification-transport-failed", key));
      if (failed) {
        const failure = failed.split(/\s+/).find((t) => t.startsWith("class="))?.slice("class=".length) ?? "unknown";
        return { state: "release-failed", windowId, notificationKey: key, nextBoundary: null, failure };
      }
      return { state: "released", windowId, notificationKey: key, nextBoundary: null };
    }
    const entity = db.prepare("SELECT entity_id AS id FROM human_quiet_windows WHERE window_id = ?").get(windowId) as { id: string } | undefined;
    const quiet = entity ? new HumanQuietStore(db).quietStateFor(entity.id, now) : null;
    if (quiet && !quiet.active) return { state: "held", windowId, notificationKey: key, nextBoundary: null, quietOver: true };
    const nextBoundary = quiet?.active && quiet.nextBoundary.kind === "end" ? quiet.nextBoundary.at : null;
    return { state: "held", windowId, notificationKey: key, nextBoundary };
  } catch (error) {
    // A schema without these tables (an older database) has no quiet custody. Once a row is known to carry a quiet hold,
    // any other failure to read its custody is "can't tell", which must not read as "no quiet hold": that would let the
    // ladder escalate, and so post, during quiet. It reads as held for this pass; the ladder and sweep read it again.
    // Before a quiet-hold note has been seen, the row is ordinary as far as quiet hours know: it reads exactly as before.
    if (!sawHold || /no such table/.test((error as Error).message)) return null;
    return { state: "held", windowId: "unknown", notificationKey: qitemId, nextBoundary: null, unreadable: true };
  }
}

/** The waiting view's backstop for an ask in quiet custody; null when quiet custody doesn't own it (none, or orphaned). */
export function quietCustodyBackstop(owner: string, quiet: QuietHoldCustody | null):
  { owner: string; mechanism: string; dueAt: string | null; intervalSeconds: number | null; note: string } | null {
  if (!quiet || quiet.state === "orphaned") return null;
  const mechanism = `quiet-release:${quiet.windowId}`;
  if (quiet.state === "released") {
    return { owner, mechanism, dueAt: null, intervalSeconds: null, note: "Released when quiet ended; waiting for transport (the post)." };
  }
  if (quiet.state === "release-failed") {
    return { owner, mechanism, dueAt: null, intervalSeconds: null,
      note: `Released when quiet ended, but its post failed (${quiet.failure}); the release stays queued for redelivery.` };
  }
  if (quiet.unreadable) {
    return { owner, mechanism, dueAt: null, intervalSeconds: null,
      note: "Quiet-hours custody couldn't be read; the ask is treated as held for now, so it isn't escalated." };
  }
  if (quiet.quietOver) {
    return { owner, mechanism, dueAt: null, intervalSeconds: 60, note: "Quiet hours have ended; the window's release job posts it at its next pass." };
  }
  return { owner, mechanism, dueAt: quiet.nextBoundary, intervalSeconds: 60,
    note: `Held by quiet hours${quiet.nextBoundary ? ` until ${quiet.nextBoundary}` : ""}; the window's release job posts it when quiet ends.` };
}
