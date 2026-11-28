import type Database from "better-sqlite3";
import type { ParsedQueueTransfer } from "./queue-transfer-parse.js";
import { recordDigest, type TransferAuthorization } from "./queue-transfer-records.js";
import { reviewQueueTransfer } from "./queue-transfer-review.js";

type Mapping = ReadonlyArray<TransferAuthorization["destination"]["seatMapping"][number]>;
const fields = ["destinationSession", "sourceSession", "returnRoute", "blockedOn"] as const;
export type TransferRemap = { readonly qitemId: string; readonly field: typeof fields[number]; readonly from: string; readonly to: string };

export function mappingDigest(mapping: Mapping): string {
  return recordDigest([...mapping].sort((a, b) => a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export function applyTransferMapping<T extends { readonly qitemId: string }>(row: T, originHostId: string, mapping: Mapping) {
  const remapped: TransferRemap[] = [];
  const overrides: Partial<Record<typeof fields[number], string>> = {};
  for (const field of fields) {
    const from: unknown = Reflect.get(row, field);
    if (typeof from !== "string" || (field === "blockedOn" && /^(qitem-|external:|fold:|auth:)/.test(from))) continue;
    const parts = from.split("@");
    if (!parts[0] || !parts[1] || (parts.length !== 2 && !(parts.length === 3 && parts[2] === originHostId))) continue;
    const bare = parts.slice(0, 2).join("@");
    const to = (mapping.find(entry => entry.from === `${bare}@${originHostId}`) ?? mapping.find(entry => entry.from === bare))?.to;
    if (to && to !== from) {
      overrides[field] = to;
      remapped.push({ qitemId: row.qitemId, field, from, to });
    }
  }
  return { row: { ...row, ...overrides }, remapped };
}

export function transferReadiness(db: Database.Database, archive: ParsedQueueTransfer, mapping: Mapping) {
  const rows = archive.rows.map(row => applyTransferMapping(row, archive.origin.hostId, mapping).row);
  const review = reviewQueueTransfer(db, { ...archive, rows }, new Map());
  const runnable = new Set(review.projectedRunnable);
  const unresolved = rows.filter(row => !row.erased && (row.state === "pending" || row.state === "in-progress") && !runnable.has(row.qitemId));
  return { ...review, unresolved: unresolved.map(row => row.qitemId) };
}
