// Quiet hours, custody: what an ask held for quiet hours looks like to the wake ladder, the stuck sweep and the waiting
// view. One read of the row's own notes and the watchdog jobs table, so the three agree:
// - held: the ask's current notification carries a quiet-hold note (or a release that was turned back because quiet
//   came on again), and its window's quiet-release job is active. The job owns the continuation: it isn't stuck, it
//   isn't picked up, and the ladder leaves it alone;
// - released: the release job dispatched it, its post hasn't landed yet, and the job is still live: waiting for transport;
// - orphaned: held or released, but no active release job for its window: nothing will release or redrive it, so the
//   sweep must find it.
// An ask that has posted, or whose release gave it a disposition, isn't quiet custody any more (null), and neither is
// any row without a quiet-hold note: digest-held and ordinary rows read exactly as before.
import type Database from "better-sqlite3";
import { HumanQuietStore } from "./gateway/human-quiet-windows.js";

export interface QuietHoldCustody {
  state: "held" | "released" | "orphaned";
  windowId: string;
  notificationKey: string;
  /** For `held`: when the person's quiet next ends (or next changes), from the resolver. */
  nextBoundary: string | null;
}

const token = (note: string, prefix: string, key: string) =>
  note.startsWith(`${prefix} `) && note.split(/\s+/).includes(`notification_key=${key}`);

export function quietHoldCustody(db: Database.Database, qitemId: string, now: Date = new Date()): QuietHoldCustody | null {
  try {
    const notes = (db.prepare("SELECT transition_note AS note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id")
      .all(qitemId) as Array<{ note: string | null }>).map((r) => r.note ?? "");
    if (!notes.some((n) => n.startsWith("delivery-decision: quiet-hold "))) return null;
    // The current notification's key: the latest owner notification, else the row itself (as the gateway keys it).
    const owner = db.prepare("SELECT transition_id AS id FROM queue_transitions WHERE qitem_id = ? AND owner_notification_level IS NOT NULL ORDER BY transition_id DESC LIMIT 1")
      .get(qitemId) as { id: number } | undefined;
    const key = owner ? `${qitemId}:${owner.id}` : qitemId;
    const hold = notes.map((n) => /^delivery-decision: quiet-hold window=(\S+) occurrence=\S+ revision=\d+ notification_key=(\S+)$/.exec(n))
      .find((m) => m?.[2] === key);
    if (!hold) return null;
    const windowId = hold[1]!;
    if (notes.some((n) => token(n, "slack-owner-notification-posted", key) || token(n, "quiet-release-disposition", key))) return null;
    // The latest release step decides between released (dispatched) and held again (returned).
    const lastStep = [...notes].reverse().find((n) => token(n, "quiet-release-dispatched", key) || token(n, "quiet-release-returned", key));
    const live = db.prepare("SELECT 1 FROM watchdog_jobs WHERE policy = 'quiet-release' AND state = 'active' AND spec_yaml LIKE ? LIMIT 1")
      .get(`%windowId: "${windowId}"%`);
    // Without a live job nothing redrives a release or releases a hold, whichever step it reached: orphaned.
    if (!live) return { state: "orphaned", windowId, notificationKey: key, nextBoundary: null };
    if (lastStep?.startsWith("quiet-release-dispatched ")) return { state: "released", windowId, notificationKey: key, nextBoundary: null };
    const entity = db.prepare("SELECT entity_id AS id FROM human_quiet_windows WHERE window_id = ?").get(windowId) as { id: string } | undefined;
    const nextBoundary = entity ? new HumanQuietStore(db).quietStateFor(entity.id, now).nextBoundary?.at ?? null : null;
    return { state: "held", windowId, notificationKey: key, nextBoundary };
  } catch {
    return null; // a schema without these tables (an older test database) has no quiet custody
  }
}
