import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { frameManagedBlockBody } from "./managed-blocks.js";

/** #2456: OpenRig's record of what it last wrote in each managed guidance block, so a later start, exact resume or handover
 *  can tell a block it wrote (refreshed when its source changes) from a block a person edited (kept). */
export interface ManagedBlockRecords {
  /** The hash of what OpenRig last wrote in this block of this file, or undefined when there's no record. */
  get(file: string, blockId: string): string | undefined;
  /** Record that OpenRig's block in this file now holds `body`. */
  set(file: string, blockId: string, body: string): void;
}

/** The hash a record keeps: sha256 of the body without the writer's framing, so framing never reads as an edit. */
export function managedBlockBodyHash(body: string): string {
  return createHash("sha256").update(frameManagedBlockBody(body)).digest("hex");
}

/** A guidance file's key: its folder's real path and its name, so a link or a relative path names the same file whether
 *  or not the file exists yet. */
export function guidanceFileKey(file: string): string {
  const resolved = nodePath.resolve(file);
  try { return nodePath.join(fs.realpathSync.native(nodePath.dirname(resolved)), nodePath.basename(resolved)); }
  catch { return resolved; }
}

/** The records kept in the daemon database (`managed_block_writes`). A database without that table (an older test or
 *  tool schema) has no records: reads find none and writes record nothing, so its blocks read as unrecorded. */
export function managedBlockRecords(db: Pick<Database.Database, "prepare">, now: () => Date = () => new Date()): ManagedBlockRecords {
  return {
    get(file, blockId) {
      try {
        const row = db.prepare("SELECT body_sha256 FROM managed_block_writes WHERE path_key = ? AND block_id = ?")
          .get(guidanceFileKey(file), blockId) as { body_sha256: string } | undefined;
        return row?.body_sha256;
      } catch { return undefined; }
    },
    set(file, blockId, body) {
      try {
        db.prepare(`INSERT INTO managed_block_writes (path_key, block_id, body_sha256, written_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(path_key, block_id) DO UPDATE SET body_sha256 = excluded.body_sha256, written_at = excluded.written_at`)
          .run(guidanceFileKey(file), blockId, managedBlockBodyHash(body), now().toISOString());
      } catch { /* a write that fails records nothing, and the block later reads as unrecorded, never as current */ }
    },
  };
}
