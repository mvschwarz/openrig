import type Database from "better-sqlite3";

/**
 * Slice 22 — a stream item's routing outcome from the automatic path, one per item.
 * - An accepted judgment with its fixed intended effect, inserted inside the classification's
 *   transaction (first write wins there). The effect is fixed at acceptance, so a retry applies the
 *   same operation, id, destination and source rather than deciding again.
 * - Or a deferral to intake: no classification, written with the automatic attempt's abstention, so
 *   intake has custody at once. It keeps the structured result (request, template, provenance).
 * Afterwards only the application record changes.
 */
export const DISPOSITIONS = ["create", "join", "duplicate", "no_action"] as const;
export interface StreamDispositionInput {
  disposition: typeof DISPOSITIONS[number] | "deferred";
  ownerSession: string | null;
  workQitemId: string | null;
  effect: { operation: "create" | "note" | "none"; qitemId: string | null; destination: string | null };
  templateDigest: string;
  templateText: string;
  /** The exact request body sent to the decision provider. */
  request: string;
  provenance: unknown;
  /** A deferral's reason and structured decision result (status, detail, answers). */
  reason: string | null;
  result: unknown;
}
export interface StreamDisposition extends StreamDispositionInput {
  streamItemId: string; projectId: string | null; acceptedBy: string; acceptedAt: string; appliedAt: string | null; applied: unknown;
}
type Row = {
  stream_item_id: string; project_id: string | null; disposition: StreamDispositionInput["disposition"]; accepted_by: string; owner_session: string | null;
  work_qitem_id: string | null; effect_operation: StreamDispositionInput["effect"]["operation"]; effect_qitem_id: string | null;
  effect_destination: string | null; template_digest: string; template_text: string; request_json: string; provenance_json: string;
  reason: string | null; result_json: string | null; accepted_at: string; applied_at: string | null; applied_json: string | null;
};

export class DispositionError extends Error {
  constructor(readonly code: "invalid_disposition" | "disposition_not_found" | "disposition_exists", message: string) { super(message); this.name = "DispositionError"; }
}
const ID = /^[A-Za-z0-9._:@-]{1,200}$/;
const invalid = (message: string) => new DispositionError("invalid_disposition", message);
const id = (v: unknown): v is string => typeof v === "string" && ID.test(v);
const optional = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null) return null;
  if (!id(v)) throw invalid(`${name} must be an id`);
  return v;
};

/** Checks a disposition's shape and that its effect matches what it says. `kind` selects acceptance or deferral. */
export function validateDisposition(x: unknown, classificationDestination: string | undefined, kind: "accepted" | "deferred" = "accepted"): StreamDispositionInput {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw invalid("disposition must be an object");
  const d = x as Record<string, unknown>, e = d.effect as Record<string, unknown> | undefined;
  if (kind === "deferred" ? d.disposition !== "deferred" : !DISPOSITIONS.includes(d.disposition as never))
    throw invalid(kind === "deferred" ? "a deferral's disposition is deferred" : `disposition is one of ${DISPOSITIONS.join(", ")}`);
  if (!e || typeof e !== "object" || !["create", "note", "none"].includes(e.operation as string)) throw invalid("effect.operation is create, note or none");
  const out: StreamDispositionInput = {
    disposition: d.disposition as StreamDispositionInput["disposition"],
    ownerSession: optional(d.ownerSession, "ownerSession"), workQitemId: optional(d.workQitemId, "workQitemId"),
    effect: { operation: e.operation as StreamDispositionInput["effect"]["operation"],
      qitemId: optional(e.qitemId, "effect.qitemId"), destination: optional(e.destination, "effect.destination") },
    templateDigest: String(d.templateDigest ?? ""), templateText: String(d.templateText ?? ""), request: String(d.request ?? ""),
    provenance: d.provenance ?? null, reason: typeof d.reason === "string" ? d.reason : null, result: d.result ?? null,
  };
  if (typeof d.templateDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(d.templateDigest)) throw invalid("templateDigest must be sha256:<hex>");
  if (typeof d.templateText !== "string" || !d.templateText || d.templateText.length > 64 * 1024) throw invalid("templateText must be the template's text, at most 64 KiB");
  if (typeof d.request !== "string" || !d.request || d.request.length > 32 * 1024) throw invalid("request must be the exact request sent, at most 32 KiB");
  if (JSON.stringify(out.provenance).length > 4096) throw invalid("provenance must be at most 4 KiB");
  const { disposition, ownerSession, workQitemId, effect } = out;
  const expected = disposition === "create" ? "create" : disposition === "join" ? "note" : "none";
  if (effect.operation !== expected) throw invalid(`a ${disposition} disposition has effect ${expected}`);
  if (disposition === "create" && (!ownerSession || !effect.qitemId || effect.destination !== ownerSession || classificationDestination !== ownerSession))
    throw invalid("create needs an owner, a derived effect qitemId, and the owner as both effect destination and classification destination");
  if (disposition === "join" && (!workQitemId || effect.qitemId !== workQitemId)) throw invalid("join needs the work qitem as its effect target");
  if (disposition === "duplicate" && !workQitemId) throw invalid("duplicate needs the work item it repeats");
  if (expected === "none" && (effect.qitemId || effect.destination)) throw invalid(`a ${disposition} disposition has no effect target`);
  if (disposition === "deferred" && (!out.reason || out.reason.length > 1000 || !out.result || typeof out.result !== "object" || JSON.stringify(out.result).length > 4096))
    throw invalid("a deferral needs a reason (at most 1,000 characters) and its structured result (at most 4 KiB)");
  return out;
}

/** Called inside the classification's transaction (accepted) or the abstention's (deferred, no projectId). */
export function insertDisposition(db: Database.Database, projectId: string | null, streamItemId: string, d: StreamDispositionInput,
    acceptedAt: string, acceptedBy: string): void {
  const existing = getDisposition(db, streamItemId);
  if (existing) throw new DispositionError("disposition_exists", `stream item ${streamItemId} already has a ${existing.disposition} disposition`);
  // A deferral has no effect to apply; it's settled when written.
  const applied = d.disposition === "deferred" ? { at: acceptedAt, json: JSON.stringify({ operation: "none", outcome: "deferred_to_intake" }) } : null;
  db.prepare(`INSERT INTO stream_dispositions (stream_item_id, project_id, disposition, accepted_by, owner_session, work_qitem_id, effect_operation,
    effect_qitem_id, effect_destination, template_digest, template_text, request_json, provenance_json, reason, result_json, accepted_at, applied_at, applied_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(streamItemId, projectId, d.disposition, acceptedBy, d.ownerSession, d.workQitemId,
    d.effect.operation, d.effect.qitemId, d.effect.destination, d.templateDigest, d.templateText, d.request, JSON.stringify(d.provenance),
    d.reason, d.result === null ? null : JSON.stringify(d.result), acceptedAt, applied?.at ?? null, applied?.json ?? null);
}

function toDisposition(r: Row): StreamDisposition {
  return { streamItemId: r.stream_item_id, projectId: r.project_id, disposition: r.disposition, acceptedBy: r.accepted_by, ownerSession: r.owner_session,
    workQitemId: r.work_qitem_id, effect: { operation: r.effect_operation, qitemId: r.effect_qitem_id, destination: r.effect_destination },
    templateDigest: r.template_digest, templateText: r.template_text, request: r.request_json, provenance: JSON.parse(r.provenance_json),
    reason: r.reason, result: r.result_json === null ? null : JSON.parse(r.result_json),
    acceptedAt: r.accepted_at, appliedAt: r.applied_at, applied: r.applied_json === null ? null : JSON.parse(r.applied_json) };
}

export function getDisposition(db: Database.Database, streamItemId: string): StreamDisposition | null {
  const row = db.prepare(`SELECT * FROM stream_dispositions WHERE stream_item_id = ?`).get(streamItemId) as Row | undefined;
  return row ? toDisposition(row) : null;
}

/** Accepted but not yet applied, oldest first. Deferrals are settled when written and never listed. */
export function unappliedDispositions(db: Database.Database, limit: number): StreamDisposition[] {
  return (db.prepare(`SELECT * FROM stream_dispositions WHERE applied_at IS NULL ORDER BY accepted_at, stream_item_id LIMIT ?`)
    .all(limit) as Row[]).map(toDisposition);
}

/** Records the effect's outcome once; a repeat returns the first record unchanged. */
export function markApplied(db: Database.Database, streamItemId: string, applied: unknown, at: string): StreamDisposition {
  const text = JSON.stringify(applied ?? null);
  if (text.length > 4096) throw invalid("applied must be at most 4 KiB");
  return db.transaction(() => {
    const current = getDisposition(db, streamItemId);
    if (!current) throw new DispositionError("disposition_not_found", `no disposition for stream item ${streamItemId}`);
    if (current.appliedAt) return current;
    db.prepare(`UPDATE stream_dispositions SET applied_at = ?, applied_json = ? WHERE stream_item_id = ? AND applied_at IS NULL`).run(at, text, streamItemId);
    return getDisposition(db, streamItemId)!;
  })();
}
