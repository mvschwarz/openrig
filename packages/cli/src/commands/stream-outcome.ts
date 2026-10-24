import type { DaemonClient } from "../client.js";

/**
 * Slice 22 — what became of a stream observation, for its poster: `rig stream show <id>`.
 *
 * Derived each time from existing records, never stored: the automatic path's disposition (accepted, or
 * deferred to intake), intake's classification, and each linked work row's current state and closure, followed through handoffs.
 * Classification, queue persistence, custody and completion stay distinct, and a closed row is reported
 * as its owner's outcome, not as proof a fix shipped.
 */

type Get = Pick<DaemonClient, "get">;
type Disposition = { disposition: string; acceptedBy: string; acceptedAt: string; ownerSession: string | null; workQitemId: string | null;
  effect: { operation: string; qitemId: string | null }; reason: string | null; appliedAt: string | null; applied: Record<string, unknown> | null };
type Classification = { streamItemId: string; classifierSession: string; classificationDestination: string | null; action: string | null;
  classifierVersion: string | null; tsProjected: string };
type QueueRow = { qitemId: string; destinationSession: string; state: string; closureReason: string | null; closureTarget: string | null;
  resolution: string | null; evidenceRef: string | null; tsUpdated: string };
type Work = { qitemId: string; owner?: string; state: string; closedToward?: string | null; handedOnFrom?: string[]; unknown?: string };

const OPEN = ["pending", "in-progress", "blocked"];
const HOPS = 8;
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);

/** A row's current work: a handed-on or superseded row is followed to its successor (the row recording it as handedOffFrom).
 *  When the current row can't be read or found, `unknown` says why; unknown is never reported as closed. */
async function work(client: Get, qitemId: string): Promise<Work> {
  const via: string[] = [];
  for (let id = qitemId; ;) {
    const trail = via.length ? { handedOnFrom: [...via] } : {};
    const res = await client.get<QueueRow>(`/api/queue/${encodeURIComponent(id)}`);
    if (res.status >= 400 || !object(res.data))
      return { qitemId: id, state: res.status === 404 ? "missing" : "unavailable", ...trail, unknown: res.status === 404 ? "row_missing" : "row_read_failed" };
    const r = res.data;
    const current = { qitemId: id, owner: r.destinationSession, state: r.state, updatedAt: r.tsUpdated, ...trail };
    if (OPEN.includes(r.state)) return current;
    const closed = { ...current, closure: r.closureReason, closedToward: r.closureTarget, resolution: r.resolution, evidence: r.evidenceRef };
    if (r.state !== "handed-off" && r.closureReason !== "handed_off_to" && r.closureReason !== "superseded") return closed;
    if (via.length >= HOPS) return { ...closed, unknown: "too_many_handoffs" };
    // An older daemon ignores the filter and lists other rows; only a row naming this one as its origin counts.
    const next = await client.get<unknown>(`/api/queue/list?handedOffFrom=${encodeURIComponent(id)}&limit=5&compact=1`);
    const successor = next.status === 200 && Array.isArray(next.data) ? next.data.find(x => object(x) && x.handedOffFrom === id) : undefined;
    if (!successor || typeof successor.qitemId !== "string")
      return { ...closed, unknown: next.status === 200 ? "successor_not_recorded" : "successor_read_failed" };
    via.push(id); id = successor.qitemId;
  }
}

export async function streamOutcome(client: Get, streamItemId: string) {
  const id = encodeURIComponent(streamItemId);
  const [dispositionRes, classificationRes] = await Promise.all([
    client.get<unknown>(`/api/projects/dispositions/${id}`),
    client.get<Classification[]>(`/api/projects/list?streamItemId=${id}&limit=1`),
  ]);
  const d = dispositionRes.status === 200 && object(dispositionRes.data) ? dispositionRes.data as Disposition : null;
  const notFound = dispositionRes.status === 404 && object(dispositionRes.data) && dispositionRes.data.error === "disposition_not_found";
  // An older daemon ignores the filter and returns some other classification; only this item's counts.
  const c = classificationRes.status === 200 && Array.isArray(classificationRes.data)
    ? classificationRes.data.find(x => x?.streamItemId === streamItemId) ?? null : null;
  const classification = c && { by: c.classifierSession, at: c.tsProjected, action: c.action, destination: c.classificationDestination,
    path: c.classifierVersion?.includes("+decide:") ? "automatic" : "intake" };
  if (!d && !notFound && !c) return { stage: "unavailable", summary: "This daemon doesn't serve stream routing records." };

  const note = "A closed work row reports its owner's outcome; it isn't proof that a fix shipped.";
  if (!d || d.disposition === "deferred") {
    const deferred = d && { at: d.acceptedAt, by: d.acceptedBy, reason: d.reason };
    if (!c) return deferred
      ? { stage: "deferred_to_intake", summary: `The automatic path deferred it to intake (${d!.reason}). Intake hasn't recorded a decision yet.`, deferred }
      : { stage: "awaiting_intake", summary: "No routing decision is recorded yet." };
    return { stage: "decided_by_intake", summary: `Intake (${c.classifierSession}) recorded ${c.action ?? "a classification"}${c.classificationDestination ? ` for ${c.classificationDestination}` : ""}. Work it opened by hand isn't linked here.`,
      classification, ...(deferred ? { deferred } : {}) };
  }

  const accepted = { disposition: d.disposition, by: d.acceptedBy, at: d.acceptedAt };
  const linked = d.effect.qitemId ?? d.workQitemId;
  const rows = linked ? [await work(client, linked)] : [];
  if (d.disposition === "no_action") return { stage: "no_action", summary: `${d.acceptedBy} recorded that no work is warranted.`, accepted, classification };
  if (d.disposition === "duplicate") return { stage: "duplicate", summary: `${d.acceptedBy} recorded it as a duplicate of ${d.workQitemId}.`, accepted, classification, work: rows, note };
  if (!d.appliedAt) return { stage: "effect_pending", summary: `Accepted as ${d.disposition} by ${d.acceptedBy}; the effect hasn't been applied yet (the next intake wake applies it).`, accepted, classification, work: rows };
  const outcome = String(d.applied?.outcome ?? "");
  if (["handed_to_intake", "target_missing", "target_closed"].includes(outcome))
    return { stage: "with_intake", summary: `Accepted as ${d.disposition}, but applying it ended ${outcome.replace(/_/g, " ")}; intake has it.`, accepted, application: d.applied, classification, work: rows };
  const row = rows[0];
  const moved = row?.handedOnFrom ? `, handed on to ${row.qitemId}` : "";
  if (!row || row.unknown) {
    const why = `${(row?.unknown ?? "no_linked_row").replace(/_/g, " ")}${row?.closedToward ? `; closed toward ${row.closedToward}` : ""}`;
    return { stage: "work_unknown", summary: `${d.disposition === "join" ? "Joined to" : "Opened"} ${linked}${moved}; its current state is unknown (${why}).`,
      accepted, application: d.applied, classification, work: rows };
  }
  return { stage: OPEN.includes(row.state) ? "work_open" : "work_closed",
    summary: d.disposition === "join"
      ? `Joined to ${linked}${moved}, which is ${row.state}${row.owner ? ` (owner ${row.owner})` : ""}.`
      : `Opened ${linked} for ${d.ownerSession}${moved}; it's ${row.state}${row.owner && row.owner !== d.ownerSession ? ` and now with ${row.owner}` : ""}.`,
    accepted, application: d.applied, classification, work: rows, note };
}
