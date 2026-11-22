import { QUEUE_TRANSFER_COLUMNS } from "./queue-transfer-export.js";
import { checkQueueTransferSize, queueTransferDigest, QUEUE_TRANSFER_FORMAT, QUEUE_TRANSFER_MAX_BYTES,
  type QueueTransferJson, type QueueTransferObject } from "./queue-transfer-format.js";

type ParseCode = "format_unsupported" | "digest_mismatch" | "origin_identity_missing" | "selection_not_shown" | "archive_invalid";

export class QueueTransferParseError extends Error {
  constructor(readonly code: ParseCode, message: string) { super(message); }
}

const invalid = () => new QueueTransferParseError("archive_invalid", "Malformed queue transfer envelope");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const name = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value && !value.includes("\0");
const names = (value: unknown): value is string[] => Array.isArray(value) && value.every(name);
const state = (value: unknown): value is QueueState => value === "pending" || value === "in-progress" || value === "blocked" ||
  value === "done" || value === "handed-off" || value === "canceled" || value === "denied" || value === "failed";
type QueueState = "pending" | "in-progress" | "blocked" | "done" | "handed-off" | "canceled" | "denied" | "failed";

function json(value: unknown, depth = 0): value is QueueTransferJson {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)) return true;
  return Array.isArray(value) ? value.every(entry => json(entry, depth + 1)) :
    object(value) && Object.values(value).every(entry => json(entry, depth + 1));
}

const wire = (column: string) => column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const requiredText = new Set(["qitem_id", "ts_created", "ts_updated", "priority", "body", "source_session", "destination_session",
  "ts", "state", "phase", "wake_kind", "action_id", "action_verb", "acted_at", "erased_at", "rig_id", "rig_name", "members_digest", "verified_at"]);
function projection(value: unknown, fields: readonly string[]): value is QueueTransferObject {
  return object(value) && fields.every(field => {
    const entry = value[wire(field)];
    if (field === "transition_id") return Number.isSafeInteger(entry);
    if (field === "notify_attempted") return entry === 0 || entry === 1;
    return typeof entry === "string" || (entry === null && !requiredText.has(field));
  });
}

function entries(value: unknown, fields: readonly string[], parent: string): QueueTransferObject[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((entry: unknown) => {
    if (!projection(entry, fields) || entry.qitemId !== parent) throw invalid();
    return entry;
  });
}

function parseRow(value: unknown) {
  if (!projection(value, QUEUE_TRANSFER_COLUMNS.queue_items) || !name(value.qitemId) || !name(value.sourceSession) ||
      !name(value.destinationSession) || !state(value.state) || typeof value.body !== "string") throw invalid();
  const transitions = entries(value.transitions, [...QUEUE_TRANSFER_COLUMNS.queue_transitions, "archived_at"], value.qitemId);
  const wakes = entries(value.wakeEvidence, QUEUE_TRANSFER_COLUMNS.queue_transition_wakes, value.qitemId);
  const actions = entries(value.missionControlActions, QUEUE_TRANSFER_COLUMNS.mission_control_actions, value.qitemId);
  const transitionIds = new Set(transitions.map(transition => transition.transitionId));
  if (transitionIds.size !== transitions.length || transitions.some(t => !Number.isSafeInteger(t.transitionId) || !state(t.state)) ||
      actions.some(a => !name(a.actionId))) throw invalid();
  const text = (entry: QueueTransferJson | undefined) => typeof entry === "string" ? entry : null;
  const chain = value.chainOfRecord === null ? [] : parseJson(text(value.chainOfRecord) ?? "");
  if (!names(chain)) throw invalid();
  return { qitemId: value.qitemId, state: value.state, erased: value.contentErasedAt !== null,
    sourceSession: value.sourceSession, destinationSession: value.destinationSession, returnRoute: text(value.returnRoute),
    closureTarget: text(value.closureTarget), evidenceRef: text(value.evidenceRef), blockedOn: text(value.blockedOn),
    references: [text(value.replyTo), text(value.handedOffFrom), text(value.handedOffTo), ...chain],
    missingTransitions: wakes.filter(w => !transitionIds.has(w.transitionId)).map(w => String(w.transitionId)),
    actionIds: actions.flatMap(a => name(a.actionId) ? [a.actionId] : []) };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch (error) {
    if (error instanceof SyntaxError) throw invalid();
    throw error;
  }
}

export function parseQueueTransfer(text: string, maxBytes = QUEUE_TRANSFER_MAX_BYTES) {
  checkQueueTransferSize(Buffer.byteLength(text), maxBytes);
  const archive = parseJson(text);
  if (!object(archive)) throw invalid();
  if (archive.format !== QUEUE_TRANSFER_FORMAT) throw new QueueTransferParseError("format_unsupported", "Expected openrig.queue-transfer/v2");
  const { origin, digest, scope } = archive;
  if (!object(origin) || !name(origin.hostId) || !name(origin.mintedAt)) {
    throw new QueueTransferParseError("origin_identity_missing", "Origin must name a host ID and minted-at value");
  }
  if (!object(digest) || digest.algorithm !== "sha256" || digest.coverage !== QUEUE_TRANSFER_FORMAT ||
      typeof digest.value !== "string" || !/^[0-9a-f]{64}$/.test(digest.value)) {
    throw new QueueTransferParseError("digest_mismatch", "Expected a SHA-256 digest covering the v2 archive");
  }
  if (!json(archive) || !name(archive.transferId) || !name(archive.createdAt) || !Array.isArray(archive.rows) ||
      "authorization" in archive || "authorizationDigest" in archive || "destination" in archive) throw invalid();
  if (queueTransferDigest(archive) !== digest.value) throw new QueueTransferParseError("digest_mismatch", "Archive content does not match its digest");
  if (!object(scope) || !name(scope.selectionShownAt) || !names(scope.qitemIds) || !names(scope.rigs) || !names(scope.missions) ||
      !names(scope.slices) || typeof scope.includeClosed !== "boolean" ||
      !(scope.kind === "host" || scope.kind === "qitems" || (scope.kind === "rig" && scope.rigs.length) ||
        (scope.kind === "mission" && scope.missions.length) || (scope.kind === "slice" && scope.slices.length))) {
    throw new QueueTransferParseError("selection_not_shown", "Archive must show its explicit source selection");
  }
  const rows = archive.rows.map(parseRow);
  const erasedIds: string[] = [];
  if (archive.erasedIds !== undefined) {
    if (!Array.isArray(archive.erasedIds)) throw invalid();
    for (const entry of archive.erasedIds) {
      if (!projection(entry, QUEUE_TRANSFER_COLUMNS.queue_erased_ids) || !name(entry.qitemId)) throw invalid();
      erasedIds.push(entry.qitemId);
    }
  }
  if (archive.erasedRigs !== undefined && (!Array.isArray(archive.erasedRigs) ||
      archive.erasedRigs.some(entry => !projection(entry, QUEUE_TRANSFER_COLUMNS.queue_erased_rigs)))) throw invalid();
  const selected = new Set([...rows.map(row => row.qitemId), ...erasedIds]);
  if (selected.size !== rows.length + erasedIds.length) throw invalid();
  if (scope.qitemIds.length !== selected.size || new Set(scope.qitemIds).size !== selected.size ||
      scope.qitemIds.some(id => !selected.has(id))) {
    throw new QueueTransferParseError("selection_not_shown", "Shown queue IDs do not match the archive");
  }
  const { kind, rigs, missions, slices, qitemIds, includeClosed, selectionShownAt } = scope;
  return { transferId: archive.transferId, origin: { hostId: origin.hostId, mintedAt: origin.mintedAt }, digest: digest.value,
    selection: { kind, rigs, missions, slices, qitemIds, includeClosed, selectionShownAt }, rows, erasedIds };
}

export type ParsedQueueTransfer = ReturnType<typeof parseQueueTransfer>;
