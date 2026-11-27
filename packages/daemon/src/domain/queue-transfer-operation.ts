import type Database from "better-sqlite3";
import type { ParsedQueueTransfer } from "./queue-transfer-parse.js";
import type { TransferAuthorization } from "./queue-transfer-records.js";
import { parseSessionName } from "./session-name.js";

export type TransferActor = {
  readonly actorSession: string;
  readonly identityProvenance?: string | null;
  readonly identityPrincipal?: string | null;
};

export class QueueTransferOperationError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 500, readonly detail: object = {}) {
    super(code);
  }
}

export function assertTransferSchema(db: Database.Database): void {
  const tables = db.prepare<[], number>(`SELECT count(*) FROM sqlite_master WHERE type = 'table'
    AND name IN ('queue_transfer_staging', 'queue_transfer_ledger')`).pluck().get();
  if (tables !== 2) throw new QueueTransferOperationError("schema_unsupported", 400, { message: "this database predates queue transfer activation" });
}

export function assertAuthorization(archive: ParsedQueueTransfer, authorization: TransferAuthorization, destinationHostId: string | undefined): void {
  const { origin, destination } = authorization;
  const sources = new Set<string>();
  const selection = new Set(archive.selection.qitemIds);
  const invalidMapping = destination.seatMapping.some(({ from, to }) => {
    const parts = from.split("@");
    const bare = parts.slice(0, 2).join("@");
    if (sources.has(bare) || parseSessionName(bare).kind !== "canonical" || parseSessionName(to).kind !== "canonical" ||
        to.split("@").length !== 2 || (parts.length !== 2 && !(parts.length === 3 && parts[2] === origin.hostId))) return true;
    sources.add(bare);
    return false;
  });
  if (archive.digest !== authorization.archiveDigest || archive.origin.hostId !== origin.hostId || archive.origin.mintedAt !== origin.mintedAt ||
      destination.hostId !== destinationHostId || destination.hostId === origin.hostId || invalidMapping ||
      authorization.dispositions?.some(entry => !selection.has(entry.qitemId))) throw new QueueTransferOperationError("authorization_mismatch", 409);
}

export const transferSelection = (archive: ParsedQueueTransfer) => [
  ...archive.rows.map(({ qitemId, state }) => ({ qitemId, state })),
  ...archive.erasedIds.map(qitemId => ({ qitemId, state: "erased" as const })),
];
