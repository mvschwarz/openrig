import { createHash } from "node:crypto";
import { canonicalQueueJson, type QueueTransferJson } from "./queue-transfer-format.js";
import { isTransferObject } from "./queue-transfer-parse.js";

export const AUTHORIZATION_KIND = "openrig.queue-transfer.authorization/v1";
export const RECEIPT_KIND = "openrig.queue-transfer.receipt/v1";
export const ACTIVATION_KIND = "openrig.queue-transfer.activation/v1";
export const RECONCILIATION_KIND = "openrig.queue-transfer.reconciliation/v1";

type ReadField<T> = (value: unknown, invalid: (field: string) => never, field: string) => T;
const isString = (value: unknown): value is string => typeof value === "string";
export const isTransferDigest = (value: unknown): value is string => isString(value) && /^[0-9a-f]{64}$/.test(value);
const checked = <T>(guard: (value: unknown) => value is T): ReadField<T> => (value, invalid, field) =>
  guard(value) ? value : invalid(field);
const oneOf = <const T extends string>(...choices: T[]): ReadField<T> => (value, invalid, field) =>
  choices.find(choice => choice === value) ?? invalid(field);
const object = <T>(fields: { [K in keyof T]: ReadField<T[K]> }): ReadField<T> => (value, invalid, field) => {
  if (!isTransferObject(value)) return invalid(field);
  const result: Partial<T> = {};
  for (const key in fields) {
    const parsed = fields[key](value[key], invalid, field ? `${field}.${key}` : key);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result as T;
};
const array = <T>(read: ReadField<T>): ReadField<T[]> => (value, invalid, field) =>
  Array.isArray(value) ? value.map((entry: unknown, index) => read(entry, invalid, `${field}.${index}`)) : invalid(field);
const optional = <T>(read: ReadField<T>): ReadField<T | undefined> => (value, invalid, field) =>
  value === undefined ? undefined : read(value, invalid, field);
const nullable = <T>(read: ReadField<T>): ReadField<T | null> => (value, invalid, field) =>
  value === null ? null : read(value, invalid, field);
const text = checked((value): value is string => isString(value) && value.trim().length > 0 && !value.includes("\0"));
const string = checked(isString);
const digest = checked(isTransferDigest);
const origin = object({ hostId: text, mintedAt: text });
const destination = object({ hostId: text, mappingDigest: digest });
const method = oneOf("online-handshake", "operator-attestation");
const sourceState = oneOf("relinquished", "isolated");
const archivedState = oneOf("pending", "in-progress", "blocked", "done", "failed", "denied", "canceled", "handed-off", "erased");
const selection = array(object({ qitemId: text, state: archivedState }));
const count = checked((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
const ids = array(text);
const details = array(object({ qitemId: text, kind: text, detail: string }));
const mapping = array(object({ from: text, to: text }));

const authorizationReader = object({
  kind: oneOf(AUTHORIZATION_KIND), operationId: text, archiveDigest: digest, origin,
  destination: object({ hostId: text, authorizedAt: text, seatMapping: mapping }),
  intervention: object({ kind: method, actor: text, recordedAt: text, limits: string }),
  dispositions: optional(array(object({ qitemId: text, text }))),
});
const receiptReader = object({
  kind: oneOf(RECEIPT_KIND), transferId: text, archiveDigest: digest, authorizationDigest: digest, origin, destination,
  sourceState, method, intervention: text, limits: string, recordedAt: text, actor: text, rowsDigest: digest,
  note: string, workflowState: optional(array(object({ qitemId: text, instanceId: text }))), selection: optional(selection),
});
const activationReader = object({
  kind: oneOf(ACTIVATION_KIND), operationId: text, transferId: text, importId: text,
  archiveDigest: digest, authorizationDigest: digest, mappingDigest: digest, origin, destination,
  recordedAt: text, actor: text, sourceState, method, status: oneOf("activated"), replayed: checked((value): value is boolean => typeof value === "boolean"),
  rows: object({
    total: count, created: count, runnable: ids, terminal: ids, erased: ids,
    projectedToPending: array(object({ qitemId: text, previouslyClaimedBy: text })),
    blocked: array(object({ qitemId: text, blockedOn: nullable(text), wait: oneOf("restored_continuation", "transferred_blocked") })),
    remapped: array(object({ qitemId: text, field: oneOf("sourceSession", "destinationSession", "returnRoute", "blockedOn"), from: text, to: text })),
  }),
  waits: object({ restoredContinuations: ids, transferredBlocked: ids }),
  unresolvedContinuations: details, remainingOnSource: details,
  history: object({ transitionsImported: count, wakeEvidenceImportedNotScheduled: count, missionControlActionsImported: count }),
  warnings: array(object({ code: text, qitemId: optional(text), reference: optional(text), message: optional(string) })),
});

type OptionalFields<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
  & { [K in keyof T as undefined extends T[K] ? K : never]?: T[K] };
export type TransferAuthorization = OptionalFields<ReturnType<typeof authorizationReader>>;
export type TransferReceipt = OptionalFields<ReturnType<typeof receiptReader>>;
type Activation = ReturnType<typeof activationReader>;
export type TransferActivation = Omit<Activation, "warnings"> & { warnings: OptionalFields<Activation["warnings"][number]>[] };

export class QueueTransferRecordError extends Error {
  constructor(readonly code: "authorization_invalid" | "receipt_invalid" | "activation_result_invalid", detail: string) {
    super(detail);
  }
}

function parse<T>(read: ReadField<T>, value: unknown, code: QueueTransferRecordError["code"]): T {
  return read(value, field => { throw new QueueTransferRecordError(code, field || "record"); }, "");
}

export const parseAuthorization = (value: unknown): TransferAuthorization => parse(authorizationReader, value, "authorization_invalid");
export function parseReceipt(value: unknown): TransferReceipt {
  const receipt = parse(receiptReader, value, "receipt_invalid");
  if ((receipt.sourceState === "relinquished") !== (receipt.method === "online-handshake")) {
    throw new QueueTransferRecordError("receipt_invalid", "sourceState and method disagree");
  }
  return receipt;
}
export const parseActivationResult = (value: unknown): TransferActivation => parse(activationReader, value, "activation_result_invalid");

export function recordDigest(value: QueueTransferJson): string {
  return createHash("sha256").update(canonicalQueueJson(value)).digest("hex");
}

export function authorizationDigest({ dispositions, ...authorization }: TransferAuthorization): string {
  return recordDigest(dispositions === undefined ? authorization : { ...authorization, dispositions });
}

export function rowsDigest(rows: readonly { readonly qitemId: string; readonly state: string }[]): string {
  const sorted = [...rows].sort((a, b) => a.qitemId < b.qitemId ? -1 : a.qitemId > b.qitemId ? 1 : 0);
  return recordDigest(sorted.map(({ qitemId, state }) => [qitemId, state]));
}
