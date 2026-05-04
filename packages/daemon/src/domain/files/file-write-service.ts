// UI Enhancement Pack v0 — atomic file write + JSONL audit.
//
// Item 4: operator-actionable write surface for STEERING.md /
// PROGRESS.md / spec YAML / any allowlisted file. Honors the dashboard
// precedent's mtime + content-hash invariants (cited as retired-but-
// instructive from `services/dashboard/bin/server.py:1269-1289`;
// reimplemented fresh in TypeScript per current OpenRig conventions).
//
// Atomic-write semantics:
//   1. Resolve target path under allowlist root (path-safety from
//      file-allowlist.ts).
//   2. Re-stat file: if mtime != expectedMtime OR contentHash !=
//      expectedContentHash, reject with WriteConflictError carrying
//      the current mtime + contentHash for the UI to surface.
//   3. Write content to a temp file in the same directory.
//   4. fsync the temp file so the write is durable before the rename.
//   5. Atomic rename over the target path. On POSIX this is a single
//      inode swap, so other readers either see the old file or the
//      new file — never a partial write.
//   6. Compute new mtime + contentHash from the rename'd target.
//   7. Append one JSONL row to the audit file.
//
// The audit file is `~/.openrig/file-edit-audit.jsonl` by default
// (operator-overridable via env). Append-only; never rotates at v0
// per PRD § Item 4 (rotation is a future concern).

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveAllowedPath, type AllowlistRoot } from "./path-safety.js";

export interface FileWriteRequest {
  rootName: string;
  /** Relative path under the allowlist root; same shape as item 3 routes. */
  path: string;
  content: string;
  /** Caller-known mtime (ISO string) at the time of last read. */
  expectedMtime: string;
  /** Caller-known SHA-256 content hash (hex) at the time of last read. */
  expectedContentHash: string;
  /** Operator session that initiated the write (for the audit row). */
  actor: string;
}

export interface FileWriteResult {
  /** Resolved canonical absolute path that was written. */
  absolutePath: string;
  /** New mtime after the write (ISO string). */
  newMtime: string;
  /** New SHA-256 content hash (hex) after the write. */
  newContentHash: string;
  /** Byte-count delta (new - prev). */
  byteCountDelta: number;
}

export class WriteConflictError extends Error {
  constructor(
    public readonly currentMtime: string,
    public readonly currentContentHash: string,
    public readonly details: Record<string, unknown>,
  ) {
    super("file changed externally; refresh required before writing");
    this.name = "WriteConflictError";
  }
}

export class FileWriteError extends Error {
  constructor(
    public readonly code: "stat_failed" | "tmp_write_failed" | "rename_failed" | "audit_write_failed",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FileWriteError";
  }
}

export interface FileWriteServiceOpts {
  /** Allowlist roots resolved from env at startup (re-resolved per request is fine; cheap). */
  allowlist: AllowlistRoot[];
  /** Override default audit file location for tests. */
  auditFilePath?: string;
  /** Override Date.now() for tests (returns ISO timestamp). */
  now?: () => Date;
}

const DEFAULT_AUDIT_FILE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".openrig",
  "file-edit-audit.jsonl",
);

export class FileWriteService {
  private readonly allowlist: AllowlistRoot[];
  private readonly auditFilePath: string;
  private readonly now: () => Date;

  constructor(opts: FileWriteServiceOpts) {
    this.allowlist = opts.allowlist;
    this.auditFilePath = opts.auditFilePath ?? DEFAULT_AUDIT_FILE;
    this.now = opts.now ?? (() => new Date());
  }

  /**
   * Atomically write content to an allowlisted file. Throws
   * WriteConflictError on mtime/contentHash mismatch; throws
   * FileWriteError on stat / temp-write / rename / audit failures.
   * Returns FileWriteResult with the new mtime + contentHash on
   * success.
   */
  writeAtomic(req: FileWriteRequest): FileWriteResult {
    const target = resolveAllowedPath(this.allowlist, req.rootName, req.path);

    // Pre-write checks: re-stat + re-hash for conflict detection.
    let prevStat: fs.Stats;
    let prevContent: Buffer;
    try {
      prevStat = fs.statSync(target);
      prevContent = fs.readFileSync(target);
    } catch (err) {
      throw new FileWriteError(
        "stat_failed",
        `failed to read '${target}' for conflict detection: ${err instanceof Error ? err.message : String(err)}`,
        { target },
      );
    }
    const prevMtime = prevStat.mtime.toISOString();
    const prevContentHash = sha256Hex(prevContent);
    if (prevMtime !== req.expectedMtime || prevContentHash !== req.expectedContentHash) {
      throw new WriteConflictError(prevMtime, prevContentHash, {
        target,
        expectedMtime: req.expectedMtime,
        expectedContentHash: req.expectedContentHash,
      });
    }

    // Write to temp file in the SAME directory (so atomic rename
    // works across the same filesystem). Suffix with PID + random
    // so concurrent writes don't collide.
    const tmpName = `.openrig-write-${process.pid}-${Math.random().toString(36).slice(2, 10)}-${path.basename(target)}`;
    const tmpPath = path.join(path.dirname(target), tmpName);
    let tmpFd: number | null = null;
    try {
      tmpFd = fs.openSync(tmpPath, "w");
      fs.writeFileSync(tmpFd, req.content);
      fs.fsyncSync(tmpFd);
    } catch (err) {
      // Clean up temp file if it was partially created.
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new FileWriteError(
        "tmp_write_failed",
        `failed to write+fsync temp file at '${tmpPath}': ${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    } finally {
      try { if (tmpFd !== null) fs.closeSync(tmpFd); } catch { /* ignore */ }
    }

    try {
      fs.renameSync(tmpPath, target);
    } catch (err) {
      // Best-effort cleanup of the orphan temp file. We don't try to
      // restore the previous content because we never touched the
      // target (rename failed atomically).
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw new FileWriteError(
        "rename_failed",
        `failed to atomically rename '${tmpPath}' over '${target}': ${err instanceof Error ? err.message : String(err)}`,
        { target, tmpPath },
      );
    }

    // Re-stat to get the new mtime + content hash.
    const newStat = fs.statSync(target);
    const newContent = fs.readFileSync(target);
    const newMtime = newStat.mtime.toISOString();
    const newContentHash = sha256Hex(newContent);
    const byteCountDelta = newContent.byteLength - prevContent.byteLength;

    // Append the audit JSONL row. Failure here is logged but does
    // NOT undo the write — the user's edit landed; we don't want
    // audit-system flakes to revert canon edits.
    const auditRow = {
      ts: this.now().toISOString(),
      actor: req.actor,
      root: req.rootName,
      path: req.path,
      absolutePath: target,
      prevMtime,
      newMtime,
      prevContentHash,
      newContentHash,
      byteCountDelta,
    };
    try {
      this.appendAuditRow(auditRow);
    } catch (err) {
      throw new FileWriteError(
        "audit_write_failed",
        `write succeeded but audit append failed: ${err instanceof Error ? err.message : String(err)}`,
        { target, auditFilePath: this.auditFilePath, ...auditRow },
      );
    }

    return {
      absolutePath: target,
      newMtime,
      newContentHash,
      byteCountDelta,
    };
  }

  private appendAuditRow(row: Record<string, unknown>): void {
    fs.mkdirSync(path.dirname(this.auditFilePath), { recursive: true });
    fs.appendFileSync(this.auditFilePath, `${JSON.stringify(row)}\n`);
  }

  /** Test/debug helper: returns the configured audit file path. */
  getAuditFilePath(): string {
    return this.auditFilePath;
  }
}

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}
