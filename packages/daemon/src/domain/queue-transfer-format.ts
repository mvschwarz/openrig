import { createHash } from "node:crypto";

export const QUEUE_TRANSFER_FORMAT = "openrig.queue-transfer/v2";
export const QUEUE_TRANSFER_MAX_BYTES = 16 * 1024 * 1024;

export type QueueTransferJson = null | boolean | number | string | readonly QueueTransferJson[] | QueueTransferObject;
export type QueueTransferObject = { readonly [key: string]: QueueTransferJson };

export class QueueTransferError extends Error {
  constructor(readonly code: "archive_too_large" | "origin_identity_missing" | "selection_not_found" | "selection_invalid", detail: string) {
    super(`${code}: ${detail}`);
  }
}

export function checkQueueTransferSize(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) throw new QueueTransferError("archive_too_large", `archive exceeds ${maxBytes} bytes`);
}

export function canonicalQueueJson(value: QueueTransferJson): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalQueueJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalQueueJson(entry)}`).join(",")}}`;
}

export function queueTransferDigest({ digest: _digest, ...body }: QueueTransferObject): string {
  return createHash("sha256").update(canonicalQueueJson(body)).digest("hex");
}

export function sealQueueTransfer(body: QueueTransferObject, maxBytes: number): string {
  const value = queueTransferDigest(body);
  const archive = canonicalQueueJson({ ...body, digest: { algorithm: "sha256", value, coverage: QUEUE_TRANSFER_FORMAT } });
  checkQueueTransferSize(Buffer.byteLength(archive), maxBytes);
  return archive;
}
