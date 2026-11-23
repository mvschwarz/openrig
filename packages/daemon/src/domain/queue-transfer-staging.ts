import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { QueueTransferError } from "./queue-transfer-format.js";
import { parseQueueTransfer, QueueTransferParseError, type ParsedQueueTransfer } from "./queue-transfer-parse.js";
import { reviewQueueTransfer, type TransferRefusal, type TransferWarning } from "./queue-transfer-review.js";

type StoredManifest = {
  readonly importId: string;
  readonly originHostId: string;
  readonly originMintedAt: string;
  readonly digest: string;
  readonly rowCount: number;
  readonly selectionJson: string;
  readonly status: "staged" | "activated" | "discarded" | "rejected";
  readonly stagedAt: string;
  readonly updatedAt: string;
};
const columns = `import_id AS importId, origin_host_id AS originHostId, origin_minted_at AS originMintedAt,
  digest, row_count AS rowCount, selection_json AS selectionJson, status, staged_at AS stagedAt, updated_at AS updatedAt`;
function manifest({ selectionJson, originHostId, originMintedAt, ...row }: StoredManifest) {
  const selection: unknown = JSON.parse(selectionJson);
  return { ...row, origin: { hostId: originHostId, mintedAt: originMintedAt }, selection };
}

type Report = {
  readonly status: "not_ready_for_activation" | "rejected";
  readonly dryRun: boolean;
  readonly replayed: boolean;
  readonly stage: ReturnType<typeof manifest> | null;
  readonly archive: Pick<ParsedQueueTransfer, "origin" | "selection" | "digest" | "transferId"> | null;
  readonly counts: { readonly open: number; readonly terminal: number; readonly erased: number } | null;
  readonly warnings: readonly TransferWarning[];
  readonly refusals: readonly TransferRefusal[];
  readonly wouldBecomeRunnable: readonly string[];
};

export class QueueTransferStaging {
  constructor(private readonly db: Database.Database, private readonly evidenceExists: (ref: string) => boolean | undefined = () => undefined) {}

  list() {
    return this.db.prepare<[], StoredManifest>(`SELECT ${columns} FROM queue_transfer_staging ORDER BY staged_at, import_id`).all().map(manifest);
  }

  discard(importId: string) {
    const record = this.db.prepare<[string, string], StoredManifest>(`UPDATE queue_transfer_staging
      SET envelope = NULL, status = 'discarded', updated_at = ? WHERE import_id = ? AND status = 'staged'
      RETURNING ${columns}`).get(new Date().toISOString(), importId);
    return record ? manifest(record) : null;
  }

  import(text: string, { dryRun = false, maxBytes }: { readonly dryRun?: boolean; readonly maxBytes?: number } = {}): Report {
    let parsed: ParsedQueueTransfer;
    try {
      parsed = parseQueueTransfer(text, maxBytes);
    } catch (error) {
      if (!(error instanceof QueueTransferParseError) && !(error instanceof QueueTransferError && error.code === "archive_too_large")) throw error;
      const code = error instanceof QueueTransferParseError ? error.code : "archive_too_large";
      return { status: "rejected", dryRun, replayed: false, stage: null, archive: null, counts: null,
        wouldBecomeRunnable: [], warnings: [], refusals: [{ code, message: error.message }] };
    }
    const { rows, erasedIds: _erasedIds, ...archive } = parsed;
    const evidence = new Map(rows.flatMap(row => row.evidenceRef ? [[row.qitemId, this.evidenceExists(row.evidenceRef)] as const] : []));
    const envelope = dryRun ? null : Buffer.from(text);
    const operation = this.db.transaction((): Report => {
      const content = { hostId: archive.origin.hostId, mintedAt: archive.origin.mintedAt, digest: archive.digest };
      const existing = this.db.prepare<[typeof content], StoredManifest>(`SELECT ${columns} FROM queue_transfer_staging
        WHERE origin_host_id = @hostId AND origin_minted_at = @mintedAt AND digest = @digest`).get(content);
      const { counts, warnings, refusals, projectedRunnable } = reviewQueueTransfer(this.db, parsed, evidence);
      if (existing?.status === "activated") refusals.push({ code: "already_activated" });
      const summary = { archive, dryRun, counts, warnings, refusals, wouldBecomeRunnable: refusals.length ? [] : projectedRunnable };
      if (refusals.length) return { ...summary, status: "rejected", replayed: !!existing, stage: existing ? manifest(existing) : null };
      if (existing || envelope === null) return { ...summary, status: "not_ready_for_activation", replayed: !!existing,
        stage: existing ? manifest(existing) : null };
      const record = { ...content, importId: `import-${randomUUID()}`, rowCount: rows.length,
        selectionJson: JSON.stringify(archive.selection), stagedAt: new Date().toISOString(), envelope };
      this.db.prepare(`INSERT INTO queue_transfer_staging (import_id, origin_host_id, origin_minted_at, digest,
        envelope, selection_json, row_count, status, staged_at, updated_at)
        VALUES (@importId, @hostId, @mintedAt, @digest, @envelope, @selectionJson, @rowCount, 'staged', @stagedAt, @stagedAt)`).run(record);
      return { ...summary, status: "not_ready_for_activation", replayed: false, stage: { importId: record.importId,
        origin: archive.origin, digest: archive.digest, rowCount: record.rowCount, selection: archive.selection,
        status: "staged", stagedAt: record.stagedAt, updatedAt: record.stagedAt } };
    });
    return dryRun ? operation() : operation.immediate();
  }
}
