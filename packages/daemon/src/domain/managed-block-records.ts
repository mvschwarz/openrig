import { createHash } from "node:crypto";
import fs from "node:fs";
import nodePath from "node:path";
import type Database from "better-sqlite3";
import { frameManagedBlockBody, managedBlockStanding, mergeManagedBlock, type ManagedBlockMergeFsOps, type ManagedBlockStanding } from "./managed-blocks.js";

/** #2456: OpenRig's record of what it last wrote in each managed guidance block, so a later start, exact resume, handover
 *  or runtime switch can tell a block it wrote (refreshed when its source changes) from a block a person edited (kept). */
export interface ManagedBlockRecords {
  /** The hash of what OpenRig last wrote in this block of this file, or undefined when there's no record. Throws when the
   *  record can't be read, which is unknown, never "no record". */
  get(file: string, blockId: string): string | undefined;
  /** Record that OpenRig's block in this file now holds `body`. Throws when the record can't be saved. */
  set(file: string, blockId: string, body: string): void;
}

/** The hash a record keeps: sha256 of the body without the writer's framing, so framing never reads as an edit. */
export function managedBlockBodyHash(body: string): string {
  return createHash("sha256").update(frameManagedBlockBody(body)).digest("hex");
}

/** A guidance file's key: the file's own real path, so every link to one file names the same file; a file that doesn't
 *  exist yet is keyed by its folder's real path and its name. */
export function guidanceFileKey(file: string): string {
  const resolved = nodePath.resolve(file);
  try { return fs.realpathSync.native(resolved); } catch { /* not there yet */ }
  try { return nodePath.join(fs.realpathSync.native(nodePath.dirname(resolved)), nodePath.basename(resolved)); }
  catch { return resolved; }
}

/** Whether a database error is a schema without the records table (an older test or tool schema), which has no records. */
function noRecordsTable(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no such table: managed_block_writes");
}

/** The records kept in the daemon database (`managed_block_writes`). A database without that table has no records: reads
 *  find none and writes record nothing, so its blocks read as unrecorded. Any other failure is thrown, so a caller can
 *  name it instead of reading it as no record. */
export function managedBlockRecords(db: Pick<Database.Database, "prepare">, now: () => Date = () => new Date()): ManagedBlockRecords {
  return {
    get(file, blockId) {
      try {
        const row = db.prepare("SELECT body_sha256 FROM managed_block_writes WHERE path_key = ? AND block_id = ?")
          .get(guidanceFileKey(file), blockId) as { body_sha256: string } | undefined;
        return row?.body_sha256;
      } catch (err) {
        if (noRecordsTable(err)) return undefined;
        throw err;
      }
    },
    set(file, blockId, body) {
      try {
        db.prepare(`INSERT INTO managed_block_writes (path_key, block_id, body_sha256, written_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(path_key, block_id) DO UPDATE SET body_sha256 = excluded.body_sha256, written_at = excluded.written_at`)
          .run(guidanceFileKey(file), blockId, managedBlockBodyHash(body), now().toISOString());
      } catch (err) {
        if (!noRecordsTable(err)) throw err;
      }
    },
  };
}

/** Record a block just written. A record that can't be saved is named in `notes`; the write itself still counts. */
export function recordManagedBlockWrite(records: ManagedBlockRecords, targetPath: string, blockId: string, body: string, notes?: string[]): void {
  try { records.set(targetPath, blockId, body); }
  catch { notes?.push(`guidance_block_record_not_saved: ${targetPath}: ${blockId} was written, but its write record wasn't saved, so a later edit may read as unrecorded`); }
}

/** The note for a block left as it is, named for the seat and the person. */
export function keptGuidanceNote(standing: "edited" | "unrecorded", targetPath: string, blockId: string, sourcePath: string): string {
  return standing === "edited"
    ? `guidance_block_edited: ${targetPath}: ${blockId} was edited by hand since OpenRig wrote it, so it wasn't refreshed from ${sourcePath}`
    : `guidance_block_may_be_stale: ${targetPath}: ${blockId} differs from ${sourcePath} and OpenRig has no record of writing it, so it was left as it is`;
}

/** The note for a block a start replaced although OpenRig had no record of writing it. */
export function refreshedUnrecordedGuidanceNote(targetPath: string, blockId: string, sourcePath: string): string {
  return `guidance_block_refreshed_unrecorded: ${targetPath}: ${blockId} was replaced from ${sourcePath}; OpenRig had no record of writing it, as for every block written before records were kept`;
}

/** #2456: what to do with one block, from the file's text, the source's text and the record:
 *  - write it when it's absent (unless `onlyIfPresent`), current, OpenRig's own last write, or (`unrecorded: "refresh"`,
 *    a start, as starts always replaced) different with no record, which is named;
 *  - keep it, named, when a person edited it since OpenRig wrote it, or (`"keep"`, exact resume and handover) when it
 *    differs with no record;
 *  - keep it, named, when it differs and its record can't be read (`unknown`): that's never read as no record. */
export function decideManagedBlock(content: string, blockId: string, source: string, records: ManagedBlockRecords, targetPath: string,
  opts: { unrecorded: "keep" | "refresh"; onlyIfPresent?: boolean; sourcePath?: string }): { standing: ManagedBlockStanding | "unknown"; write: boolean; note?: string } {
  let recorded: string | undefined;
  let unreadable = false;
  try { recorded = records.get(targetPath, blockId); } catch { unreadable = true; }
  const standing = managedBlockStanding(content, blockId, source, recorded, managedBlockBodyHash);
  const named = opts.sourcePath ?? "its source";
  if (standing === "absent") return { standing, write: !opts.onlyIfPresent };
  if (unreadable && standing === "unrecorded") {
    return { standing: "unknown", write: false,
      note: `guidance_block_record_unreadable: ${targetPath}: ${blockId} wasn't refreshed from ${named} because OpenRig couldn't read its write record` };
  }
  if (standing === "edited" || (standing === "unrecorded" && opts.unrecorded === "keep")) {
    return { standing, write: false, note: keptGuidanceNote(standing, targetPath, blockId, named) };
  }
  if (standing === "unrecorded") return { standing, write: true, note: refreshedUnrecordedGuidanceNote(targetPath, blockId, named) };
  return { standing, write: true };
}

/** #2456: the one write of a managed guidance block that every adapter's guidance merge goes through. Without `records` it's
 *  the plain merge, as before. With them, `decideManagedBlock` decides; a kept block is named in `warnings` and nothing is
 *  written. A written block is recorded at once, so a later failure in the same start can't lose its record. Returns
 *  whether the block was written. */
export function writeManagedGuidanceBlock(files: ManagedBlockMergeFsOps, targetPath: string, blockId: string, content: string, opts: {
  records?: ManagedBlockRecords; unrecorded?: "keep" | "refresh"; onlyIfPresent?: boolean; sourcePath?: string;
  warnings?: string[]; replaceBlockIds?: string[];
}): boolean {
  const merge = () => mergeManagedBlock(files, targetPath, blockId, content, { warnings: opts.warnings, replaceBlockIds: opts.replaceBlockIds ?? [] });
  // Without records, the plain merge as before; a refresh-only call (`onlyIfPresent`) then writes nothing.
  if (!opts.records) {
    if (opts.onlyIfPresent) return false;
    merge();
    return true;
  }
  const existing = files.exists(targetPath) ? files.readFile(targetPath) : "";
  const decision = decideManagedBlock(existing, blockId, content, opts.records, targetPath,
    { unrecorded: opts.unrecorded ?? "refresh", onlyIfPresent: opts.onlyIfPresent, sourcePath: opts.sourcePath });
  if (decision.note) opts.warnings?.push(decision.note);
  if (!decision.write) return false;
  merge();
  recordManagedBlockWrite(opts.records, targetPath, blockId, content, opts.warnings);
  return true;
}
