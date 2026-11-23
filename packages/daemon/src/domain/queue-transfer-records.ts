import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalQueueJson, type QueueTransferJson } from "./queue-transfer-format.js";

export const AUTHORIZATION_KIND = "openrig.queue-transfer.authorization/v1";
export const RECEIPT_KIND = "openrig.queue-transfer.receipt/v1";
export const ACTIVATION_KIND = "openrig.queue-transfer.activation/v1";
export const RECONCILIATION_KIND = "openrig.queue-transfer.reconciliation/v1";

const text = z.string().refine(value => value.trim().length > 0 && !value.includes("\0"));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const origin = z.object({ hostId: text, mintedAt: text });
const destination = z.object({ hostId: text, mappingDigest: digest });
const method = z.enum(["online-handshake", "operator-attestation"]);
const sourceState = z.enum(["relinquished", "isolated"]);
const archivedState = z.enum(["pending", "in-progress", "blocked", "done", "failed", "denied", "canceled", "handed-off", "erased"]);
const selection = z.array(z.object({ qitemId: text, state: archivedState }));
const count = z.number().int().nonnegative();
const ids = z.array(text);
const details = z.array(z.object({ qitemId: text, kind: text, detail: z.string() }));
const mapping = z.array(z.object({ from: text, to: text }));

const authorizationSchema = z.object({
  kind: z.literal(AUTHORIZATION_KIND), operationId: text, archiveDigest: digest, origin,
  destination: z.object({ hostId: text, authorizedAt: text, seatMapping: mapping }),
  intervention: z.object({ kind: method, actor: text, recordedAt: text, limits: z.string() }),
  dispositions: z.array(z.object({ qitemId: text, text })).optional(),
});
const receiptSchema = z.object({
  kind: z.literal(RECEIPT_KIND), transferId: text, archiveDigest: digest, authorizationDigest: digest, origin, destination,
  sourceState, method, intervention: text, limits: z.string(), recordedAt: text, actor: text, rowsDigest: digest,
  note: z.string(), workflowState: z.array(z.object({ qitemId: text, instanceId: text })).optional(), selection: selection.optional(),
}).refine(value => (value.sourceState === "relinquished") === (value.method === "online-handshake"));
const activationSchema = z.object({
  kind: z.literal(ACTIVATION_KIND), operationId: text, transferId: text, importId: text,
  archiveDigest: digest, authorizationDigest: digest, mappingDigest: digest, origin, destination,
  recordedAt: text, actor: text, sourceState, method, status: z.literal("activated"), replayed: z.boolean(),
  rows: z.object({
    total: count, created: count, runnable: ids, terminal: ids, erased: ids,
    projectedToPending: z.array(z.object({ qitemId: text, previouslyClaimedBy: text })),
    blocked: z.array(z.object({ qitemId: text, blockedOn: text.nullable(), wait: z.enum(["restored_continuation", "transferred_blocked"]) })),
    remapped: z.array(z.object({ qitemId: text, field: z.enum(["sourceSession", "destinationSession", "returnRoute", "blockedOn"]), from: text, to: text })),
  }),
  waits: z.object({ restoredContinuations: ids, transferredBlocked: ids }),
  unresolvedContinuations: details, remainingOnSource: details,
  history: z.object({ transitionsImported: count, wakeEvidenceImportedNotScheduled: count, missionControlActionsImported: count }),
  warnings: z.array(z.object({ code: text, qitemId: text.optional(), reference: text.optional(), message: z.string().optional() })),
});

export type TransferAuthorization = z.infer<typeof authorizationSchema>;
export type TransferReceipt = z.infer<typeof receiptSchema>;
export type TransferActivation = z.infer<typeof activationSchema>;

export class QueueTransferRecordError extends Error {
  constructor(readonly code: "authorization_invalid" | "receipt_invalid" | "activation_result_invalid", detail: string) {
    super(detail);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, code: QueueTransferRecordError["code"]): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new QueueTransferRecordError(code, parsed.error.issues.map(issue => issue.path.join(".") || "record").join(", "));
  return parsed.data;
}

export const parseAuthorization = (value: unknown) => parse(authorizationSchema, value, "authorization_invalid");
export const parseReceipt = (value: unknown) => parse(receiptSchema, value, "receipt_invalid");
export const parseActivationResult = (value: unknown) => parse(activationSchema, value, "activation_result_invalid");

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
