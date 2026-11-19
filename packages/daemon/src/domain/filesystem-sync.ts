import { openSync, fsyncSync, closeSync } from "node:fs";
import { flushWindowsOwnedPath } from "./windows-owned-text.js";

/** Same durability barrier on each OS; never swallow a failed file or metadata flush. */
export function syncOwnedFilesystemPath(file: string, directory = false): void {
  if (process.platform === "win32") { flushWindowsOwnedPath(file, directory); return; }
  const fd = openSync(file, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
