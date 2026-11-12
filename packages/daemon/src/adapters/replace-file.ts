import fs from "node:fs";
import path from "node:path";

/**
 * Replace a file through exclusively created sibling staging and an atomic rename.
 * Preserve the source mode so read-only packaged assets can be provisioned repeatedly.
 * Never follow an existing temporary slot, and clean only this invocation's staging.
 * If staging creation fails, retain the prior in-place copy behavior and its error.
 */
export function replaceFile(src: string, dest: string): void {
  let staging: string;
  try {
    staging = fs.mkdtempSync(path.join(path.dirname(dest), ".openrig-asset-"));
  } catch {
    fs.copyFileSync(src, dest);
    return;
  }
  const tmp = path.join(staging, "asset");
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    try {
      fs.renameSync(tmp, dest);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // Windows refuses replacement of a readonly file. Change only the opened,
      // single-link destination, never a symlink target or another hardlink's attributes.
      const fd = fs.openSync(dest, "r");
      let prior: fs.BigIntStats;
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        const current = fs.lstatSync(dest, { bigint: true });
        if (!opened.isFile() || !current.isFile() || opened.nlink !== 1n
          || opened.dev !== current.dev || opened.ino !== current.ino || (opened.mode & 0o222n) !== 0n) throw error;
        prior = opened;
        fs.fchmodSync(fd, Number(opened.mode & 0o777n) | 0o200);
      } finally { fs.closeSync(fd); }
      // An open destination handle itself prevents replacement on Windows.
      try { fs.renameSync(tmp, dest); }
      catch (replacementError) {
        const restore = fs.openSync(dest, "r");
        try {
          const opened = fs.fstatSync(restore, { bigint: true });
          if (opened.dev === prior.dev && opened.ino === prior.ino && opened.nlink === 1n) {
            fs.fchmodSync(restore, Number(prior.mode & 0o777n));
          }
        } finally { fs.closeSync(restore); }
        throw replacementError;
      }
    }
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // A cleanup error must not replace a copy/rename error or undo a successful replacement.
    }
  }
}
