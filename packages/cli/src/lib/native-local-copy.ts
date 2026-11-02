import { chmod, cp, lstat, mkdir, readdir, readlink, realpath, rename, stat, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isWindowsDirectoryCaseSensitive, isWindowsDirectoryLink, replaceWindowsCopiedFile, windowsNamesCollide } from "@openrig/daemon/windows-owned-files";
import type { CopyPlan, FileCopyResult } from "./file-transfer.js";

/** Resolve existing parents too: a destination need not exist yet, but its
 * junction/short-name parent can already name a child of the source. */
async function physicalDestination(file: string): Promise<string> {
  try { return await realpath(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(file) === file) throw error;
    return path.join(await physicalDestination(path.dirname(file)), path.basename(file));
  }
}

/** Filesystem identity respects case-sensitive NTFS directories and aliases alike. */
async function rejectOverlap(src: string, target: string, directory: boolean): Promise<void> {
  // rsync skips equal regular-file/hardlink operands; only directory recursion
  // needs ancestor rejection. The ordinary same-file fast path performs no write.
  if (!directory) return;
  const source = await lstat(src, { bigint: true });
  if (source.ino === 0n) throw new Error("Source filesystem identity is unavailable; overlap cannot be checked");
  let candidate = await physicalDestination(target);
  for (;;) {
    try {
      const entry = await stat(candidate, { bigint: true });
      if (source.dev === entry.dev && source.ino === entry.ino) throw new Error("Source and destination overlap");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

/** Archive-style local copies without a shell or rsync. Extra destination files are retained. */
export async function runNativeLocalCopy(plan: CopyPlan): Promise<FileCopyResult> {
  let filesTransferred = 0;
  let bytesTransferred = 0;
  const changes: string[] = [];
  let staged: string | undefined;
  const stat = async (p: string) => lstat(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const copy = async (src: string, dst: string): Promise<void> => {
    const source = await lstat(src);
    const destination = await stat(dst);
    if (source.isDirectory()) {
      // Never traverse a destination junction/symlink when merging a directory.
      if (destination && !destination.isDirectory()) throw new Error(`Destination is not an ordinary directory: ${dst}`);
      if (!destination) {
        changes.push(`cd ${dst}`);
        if (!plan.dryRun) await mkdir(dst, { mode: source.mode });
      }
      else if (Math.floor(source.mtimeMs / 1000) !== Math.floor(destination.mtimeMs / 1000)) {
        changes.push(`.d..t. ${dst}`);
      }
      const names=await readdir(src);
      if(process.platform === "win32" && windowsNamesCollide(names)){
        let selected=dst;
        while(!await stat(selected)){
          const parent=path.dirname(selected);if(parent===selected)throw new Error("Cannot establish destination case sensitivity");selected=parent;
        }
        if(!isWindowsDirectoryCaseSensitive(selected))throw new Error(`Directory contains names that collide on Windows: ${src}`);
      }
      for (const name of names) await copy(path.join(src, name), path.join(dst, name));
      if (!plan.dryRun) await utimes(dst, source.atime, source.mtime);
      return;
    }
    if (!source.isFile() && !source.isSymbolicLink()) throw new Error(`Unsupported special file: ${src}`);
    if (destination?.isDirectory()) throw new Error(`Cannot replace directory with file: ${dst}`);
    const directoryLink = source.isSymbolicLink() && process.platform === "win32" ? isWindowsDirectoryLink(src) : undefined;
    const same = source.isSymbolicLink()
      ? destination?.isSymbolicLink() && await readlink(src) === await readlink(dst)
        && (directoryLink === undefined || directoryLink === isWindowsDirectoryLink(dst))
      : destination?.isFile() && source.size === destination.size
        && Math.floor(source.mtimeMs / 1000) === Math.floor(destination.mtimeMs / 1000);
    if (same) {
      if (source.isFile() && destination?.isFile()) {
        const mask = process.platform === "win32" ? 0o200 : 0o7777;
        if ((source.mode & mask) !== (destination.mode & mask)) {
          changes.push(`.f...p ${dst}`);
          if (!plan.dryRun) await chmod(dst, source.mode & 0o7777);
        }
      }
      return;
    }
    changes.push(`${source.isSymbolicLink() ? "cL" : ">f"} ${dst}`);
    if (!source.isSymbolicLink()) { filesTransferred++; bytesTransferred += source.size; }
    if (!plan.dryRun) {
      if (directoryLink !== undefined) {
        staged = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        await symlink(await readlink(src), staged, directoryLink ? "dir" : "file");
        await rename(staged, dst);
        staged = undefined;
        return;
      }
      if (process.platform === "win32" && source.isFile() && destination?.isFile()) {
        staged = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        await cp(src, staged, { force: false, errorOnExist: true, preserveTimestamps: true });
        replaceWindowsCopiedFile(dst, staged);
        staged = undefined;
        return;
      }
      // fs.cp overwrites the entry, preserving links rather than following their targets.
      await cp(src, dst, { force: true, preserveTimestamps: true, verbatimSymlinks: true });
    }
  };
  try {
    const src = path.resolve(plan.src.path);
    const dst = path.resolve(plan.dst.path);
    const source = await lstat(src);
    const destination = await stat(dst);
    const contentsOnly = plan.src.path.endsWith(path.sep) || plan.src.path.endsWith("/");
    const target = destination?.isDirectory() && !(source.isDirectory() && contentsOnly) ? path.join(dst, path.basename(src)) : dst;
    await rejectOverlap(src, target, source.isDirectory());
    await copy(src, target);
    return { ok: true, failedStep: "none", exitCode: 0, stdout: changes.join("\n"), stderr: "", filesTransferred, bytesTransferred, transport: "native-local" };
  } catch (error) {
    return { ok: false, failedStep: "local-copy-failed", exitCode: 1, stdout: changes.join("\n"), stderr: error instanceof Error ? error.message : String(error), transport: "native-local",
      ...(staged ? { hint: `Staging path may contain incomplete data: ${staged}; existing destination was not removed.` } : {}) };
  }
}
