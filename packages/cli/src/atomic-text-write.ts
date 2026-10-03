import { writeFileSync, unlinkSync, lstatSync, readlinkSync, statSync, chmodSync, chownSync, openSync, closeSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

/** Publish complete text while retaining the previous file on a failed staged write. */
export function writeTextAtomically(path: string, content: string, label = "file"): void {
  let target = path;
  // Follow file links just as writeFileSync did; rename the target,
  // never the link. A dangling final target is still created normally.
  for (let depth = 0; ; depth++) {
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (!entry?.isSymbolicLink()) break;
    if (depth >= 40) throw Object.assign(new Error(`Too many ${label} symlinks`), { code: "ELOOP" });
    target = resolve(dirname(target), readlinkSync(target));
  }
  const existing = statSync(target, { throwIfNoEntry: false });
  // Match direct writes: a writable directory must not bypass a read-only
  // target. Opening without truncation also checks native ACL permissions.
  if (existing) closeSync(openSync(target, "r+"));
  const temporary = join(dirname(target), `.openrig.tmp-${randomUUID()}`);
  let owned = false;
  let canFallBack = true;
  try {
    // Atomic replacement requires directory create/rename permission. Keep
    // staged bytes private until the original ownership and mode are restored.
    const fd = openSync(temporary, "wx", 0o600);
    owned = true;
    // A failed data write must never retry against the original file.
    canFallBack = false;
    try { writeFileSync(fd, content, "utf-8"); } finally { closeSync(fd); }
    canFallBack = true;
    if (existing && process.platform !== "win32") {
      const staged = statSync(temporary);
      if (staged.uid !== existing.uid || staged.gid !== existing.gid) {
        try { chownSync(temporary, existing.uid, existing.gid); }
        catch (error) {
          throw Object.assign(new Error(`Cannot preserve ${label} ownership at ${target}: ${(error as Error).message}`),
            { code: (error as NodeJS.ErrnoException).code });
        }
      }
    }
    // chown may clear permission bits, so apply the final mode afterward.
    chmodSync(temporary, existing ? existing.mode & 0o777 : 0o666 & ~process.umask());
    renameSync(temporary, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (canFallBack && (code === "EACCES" || code === "EPERM" || code === "EBUSY")) {
      // Preserve setups that permit writing the file but not replacing it,
      // such as an unwritable parent or a single-file bind mount.
      writeFileSync(target, content, "utf-8");
      return;
    }
    throw error;
  } finally {
    if (owned) try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ }
  }
}
