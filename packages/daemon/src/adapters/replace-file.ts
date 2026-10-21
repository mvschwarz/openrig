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
    staging = fs.mkdtempSync(`${dest}.tmp-`);
  } catch {
    fs.copyFileSync(src, dest);
    return;
  }
  const tmp = path.join(staging, "asset");
  try {
    fs.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(tmp, dest);
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {
      // A cleanup error must not replace a copy/rename error or undo a successful replacement.
    }
  }
}
