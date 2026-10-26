import type { DaemonClient } from "../client.js";

/**
 * Slice 22 — what became of a stream observation, for its poster: `rig stream show <id>`.
 *
 * Derived each time from existing records, never stored: the automatic path's disposition (accepted, or
 * deferred to intake), intake's classification, and each linked work row's current state and closure, followed through handoffs.
 * Classification, queue persistence, custody and completion stay distinct, and a closed row is reported
 * as its owner's outcome, not as proof a fix shipped. Readers' recorded actions (act, decline, duplicate) are shown beside
 * it; when nothing automatic linked work, the newest reader-linked work decides the stage.
 */

type Get = Pick<DaemonClient, "get">;
type Disposition = { disposition: string; acceptedBy: string; acceptedAt: string; ownerSession: string | null; workQitemId: string | null;
  effect: { operation: string; qitemId: string | null }; reason: string | null; appliedAt: string | null; applied: Record<string, unknown> | null };
type Classification = { streamItemId: string; classifierSession: string; classificationDestination: string | null; action: string | null;
  classifierVersion: string | null; tsProjected: string };
type QueueRow = { qitemId: string; destinationSession: string; state: string; closureReason: string | null; closureTarget: string | null;
  resolution: string | null; evidenceRef: string | null; tsUpdated: string };
type Work = { qitemId: string; owner?: string; state: string; closedToward?: string | null; handedOnFrom?: string[]; unknown?: string };
type ReaderAction = { actionId?: string; readerSession: string; action: string; workQitemId: string | null; duplicateOf: string | null; reason: string | null; actedAt: string };

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

async function routed(client: Get, streamItemId: string) {
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
    path: c.classifierVersion?.includes("+decide:") ? "automatic" : c.classifierVersion?.endsWith("+experiment") ? "experiment" : "intake" };
  if (!d && !notFound && !c) return { stage: "unavailable", summary: "This daemon doesn't serve stream routing records." };

  const note = "A closed work row reports its owner's outcome; it isn't proof that a fix shipped.";
  if (!d || d.disposition === "deferred") {
    const deferred = d && { at: d.acceptedAt, by: d.acceptedBy, reason: d.reason };
    if (!c) return deferred
      ? { stage: "deferred_to_intake", summary: `The automatic path deferred it to intake (${d!.reason}). Intake hasn't recorded a decision yet.`, deferred }
      : { stage: "awaiting_intake", summary: "No routing decision is recorded yet." };
    return { stage: "decided_by_intake", summary: `${classification?.path === "experiment" ? `An advisory experiment run by ${c.classifierSession}` : `Intake (${c.classifierSession})`} recorded ${c.action ?? "a classification"}${c.classificationDestination ? ` for ${c.classificationDestination}` : ""}. Work it opened by hand isn't linked here.`,
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

/** Stages where no automatic work is live (none linked, or its effect ended with intake); a reader's linked work decides them. */
const READER_DECIDES = ["awaiting_intake", "deferred_to_intake", "decided_by_intake", "no_action", "with_intake", "unavailable"];

export async function streamOutcome(client: Get, streamItemId: string) {
  const [base, actionsRes] = await Promise.all([routed(client, streamItemId),
    client.get<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}/actions`)]);
  if (actionsRes.status !== 200 || !object(actionsRes.data) || !Array.isArray(actionsRes.data.current)) return { ...base, readers: "unavailable" };
  const current = actionsRes.data.current as ReaderAction[];
  if (!current.length) return base;
  const readers = current.map(a => ({ reader: a.readerSession, action: a.action, at: a.actedAt, ...(a.workQitemId ? { work: a.workQitemId } : {}),
    ...(a.duplicateOf ? { duplicateOf: a.duplicateOf } : {}), ...(a.reason ? { reason: a.reason } : {}) }));
  // Newest first; within the same millisecond, record order (the monotonic action id) decides.
  const acted = current.filter(a => a.action === "act" && a.workQitemId)
    .sort((a, b) => b.actedAt.localeCompare(a.actedAt) || (b.actionId ?? "").localeCompare(a.actionId ?? ""));
  const auto = READER_DECIDES.includes(base.stage) ? undefined : (base as { work?: Work[] }).work?.[0];
  // Work is compared by its current row, handoffs followed, so one handed-on chain isn't parallel work. A link whose
  // current row is unknown keeps its own id.
  const followed = new Map<string, Work>();
  for (const id of new Set(acted.map(a => a.workQitemId!))) followed.set(id, await work(client, id));
  const key = (w: Work, linkedId: string) => w.unknown ? linkedId : w.qitemId;
  const lineages = new Set([...[...followed].map(([id, w]) => key(w, id)), ...(auto ? [key(auto, auto.handedOnFrom?.[0] ?? auto.qitemId)] : [])]);
  const parallel = lineages.size > 1 ? { parallelWork: [...lineages] } : {};
  if (!acted.length || !READER_DECIDES.includes(base.stage)) return { ...base, readers, ...parallel };
  // Nothing automatic linked work: the newest reader-linked work is what the poster follows.
  const by = acted[0]!;
  const row = followed.get(by.workQitemId!)!;
  const moved = row.handedOnFrom ? `, handed on to ${row.qitemId}` : "";
  const why = `${(row.unknown ?? "").replace(/_/g, " ")}${row.closedToward ? `; closed toward ${row.closedToward}` : ""}`;
  return { ...base, readers, ...parallel, work: [row],
    stage: row.unknown ? "work_unknown" : OPEN.includes(row.state) ? "work_open" : "work_closed",
    summary: row.unknown ? `${by.readerSession} linked ${by.workQitemId}${moved}; its current state is unknown (${why}).`
      : `${by.readerSession} linked ${by.workQitemId}${moved}; it's ${row.state}${row.owner && row.owner !== by.readerSession ? ` and now with ${row.owner}` : ""}.`,
    ...(row.unknown || OPEN.includes(row.state) ? {} : { note: "A closed work row reports its owner's outcome; it isn't proof that a fix shipped." }) };
}
