import { constants as bufferConstants } from "node:buffer";
import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import Database from "better-sqlite3";
import { resolveDaemonDbPath } from "./daemon-db-path.js";
import { FilePathSafetyError, readAllowlistFromEnv, resolveAllowedFile } from "./domain/files/path-safety.js";
import { QUEUE_TRANSFER_MAX_BYTES } from "./domain/queue-transfer-format.js";
import { QueueTransferStaging } from "./domain/queue-transfer-staging.js";

type Destination = { readonly home: string; readonly dbPath?: string };

function withStaging<T>(destination: Destination, readonly: boolean, run: (store: QueueTransferStaging) => T): T {
  const db = new Database(resolveDaemonDbPath(destination.dbPath, destination.home), { readonly, fileMustExist: true });
  try {
    const roots = readAllowlistFromEnv();
    return run(new QueueTransferStaging(db, ref => {
      if (!isAbsolute(ref) || ref.includes("\0")) return false;
      for (const root of roots) {
        const inside = relative(root.canonicalPath, ref);
        if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) continue;
        try {
          resolveAllowedFile(roots, root.name, inside);
          return true;
        } catch (error) {
          if (!(error instanceof FilePathSafetyError)) throw error;
        }
      }
      return false;
    }));
  } finally {
    db.close();
  }
}

export function importLocalQueue(destination: Destination, file: string, options: { readonly dryRun: boolean; readonly maxBytes?: number }) {
  const { dryRun, maxBytes = QUEUE_TRANSFER_MAX_BYTES } = options;
  const reject = (code: "archive_too_large" | "archive_invalid", message: string) => ({ status: "rejected" as const,
    dryRun, replayed: false, stage: null, archive: null, counts: null, warnings: [], wouldBecomeRunnable: [], refusals: [{ code, message }] });
  const tooLarge = () => reject("archive_too_large", `Archive exceeds ${maxBytes} bytes`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > bufferConstants.MAX_STRING_LENGTH) {
    return reject("archive_invalid", `--max-bytes must be an integer between 1 and ${bufferConstants.MAX_STRING_LENGTH}`);
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return reject("archive_invalid", "Archive must be a regular file");
    if (stat.size > maxBytes) return tooLarge();
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > maxBytes) return tooLarge();
    if (length !== stat.size) return reject("archive_invalid", "Archive size changed during read");
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return reject("archive_invalid", "Archive must be UTF-8 JSON");
    }
  } finally {
    closeSync(fd);
  }
  return withStaging(destination, dryRun, store => store.import(text, { dryRun, maxBytes }));
}

export function listLocalQueueStages(destination: Destination) {
  return withStaging(destination, true, store => store.list());
}

export function discardLocalQueueStage(destination: Destination, importId: string) {
  return withStaging(destination, false, store => store.discard(importId));
}
