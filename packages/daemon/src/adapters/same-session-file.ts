import { statSync } from "node:fs";

/** Native aliases must identify the same existing file, not merely have
 * case-folded spellings. POSIX and unavailable-file checks remain exact. */
export function sameSessionFile(left: string | undefined, right: string): boolean {
  if (left === right) return true;
  if (process.platform !== "win32" || !left) return false;
  try {
    const a = statSync(left, { bigint: true }), b = statSync(right, { bigint: true });
    return a.isFile() && b.isFile() && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}
