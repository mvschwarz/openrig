import Database from "better-sqlite3";
import { resolveDaemonDbPath } from "./daemon-db-path.js";
import { buildQueueTransfer } from "./domain/queue-repository.js";
import type { QueueExportSelection } from "./domain/queue-transfer-export.js";

export function exportLocalQueue(source: { readonly home: string; readonly dbPath?: string }, selection: QueueExportSelection) {
  const db = new Database(resolveDaemonDbPath(source.dbPath, source.home), { readonly: true, fileMustExist: true });
  try {
    return buildQueueTransfer(db, selection);
  } finally {
    db.close();
  }
}
