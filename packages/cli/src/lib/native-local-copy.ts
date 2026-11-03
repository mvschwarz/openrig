import { chmod, cp, lstat, lutimes, mkdir, readdir, readlink, realpath, rename, rmdir, stat, symlink, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyWindowsFileNew, createWindowsCopiedDirectory, finishWindowsCopiedDirectory, isWindowsDirectoryCaseSensitive, isWindowsDirectoryLink, prepareWindowsDirectoryMerge, replaceWindowsCopiedFile, windowsNamesCollide, type WindowsCopiedDirectorySecurity } from "@openrig/daemon/windows-owned-files";
import type { CopyPlan, FileCopyResult } from "./file-transfer.js";
import { moveLocalEntryNoReplace } from './local-entry-move.js';
import { readWindowsEntryTimes } from "@openrig/daemon/windows-owned-files";

async function entryStat(file: string) {
  const info = await lstat(file);
  if (process.platform === "win32") {
    const times = readWindowsEntryTimes(file, info);
    info.atimeMs = times.atimeMs; info.mtimeMs = times.mtimeMs;
    info.atime = new Date(times.atimeMs); info.mtime = new Date(times.mtimeMs);
  }
  return info;
}

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
export async function runNativeLocalCopy(plan: CopyPlan, moveEntry = moveLocalEntryNoReplace): Promise<FileCopyResult> {
  let filesTransferred = 0;
  let bytesTransferred = 0;
  const changes: string[] = [];
  let staged: string | undefined;
  let directoryReplacementAttempted = false;
  let retainedOriginal: string | undefined;
  let originalConfirmed = false;
  const stat = async (p: string) => entryStat(p).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const copy = async (src: string, dst: string): Promise<void> => {
    const source = await entryStat(src);
    const destination = await stat(dst);
    if (source.isDirectory()) {
      // Never traverse a destination junction/symlink when merging a directory.
      if (destination && !destination.isDirectory()) {
        if (!destination.isFile() && !destination.isSymbolicLink()) throw new Error(`Unsupported destination type: ${dst}`);
        const directoryStage = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        const firstChange = changes.length;
        try { await copy(src, directoryStage); }
        catch (error) { staged ??= directoryStage; throw error; }
        for (let i = firstChange; i < changes.length; i++) changes[i] = changes[i]!.replace(directoryStage, dst);
        if (plan.dryRun) return;
        staged = directoryStage;
        const original = path.join(path.dirname(dst), `.openrig-replaced-${randomUUID()}`);
        retainedOriginal = original; originalConfirmed = false;
        await moveEntry(dst, original); originalConfirmed = true;
        try { await moveEntry(directoryStage, dst); staged = undefined; }
        catch (error) {
          originalConfirmed = false;
          try { await moveEntry(original, dst); retainedOriginal = undefined; }
          catch (restore) { throw new AggregateError([error, restore], `Directory replacement failed and original recovery is unconfirmed: ${dst}`); }
          throw error;
        }
        originalConfirmed = false;
        await unlink(original); retainedOriginal = undefined;
        return;
      }
      // Validate merge inputs before changing an existing directory ACL. New
      // directories must check their own actual case policy after creation.
      const names=await readdir(src);
      const checkNames = async () => {
        if(process.platform !== "win32" || !windowsNamesCollide(names))return;
        let selected=dst;
        while(!await stat(selected)){
          const parent=path.dirname(selected);if(parent===selected)throw new Error("Cannot establish destination case sensitivity");selected=parent;
        }
        if(!isWindowsDirectoryCaseSensitive(selected))throw new Error(`Directory contains names that collide on Windows: ${src}`);
      };
      if(destination || plan.dryRun)await checkNames();
      let directorySecurity: WindowsCopiedDirectorySecurity | undefined;
      if (!destination) {
        changes.push(`cd ${dst}`);
        if (!plan.dryRun) {
          if (process.platform === "win32") directorySecurity = createWindowsCopiedDirectory(src, dst);
          else await mkdir(dst, { mode: 0o700 });
          await checkNames();
        }
      }
      else {
        const timeChanged = Math.floor(source.mtimeMs / 1000) !== Math.floor(destination.mtimeMs / 1000);
        // NTFS directory readonly is Explorer state, not directory access.
        const securityChange = process.platform === "win32" ? prepareWindowsDirectoryMerge(src, dst, plan.dryRun) : undefined;
        directorySecurity = securityChange?.security;
        const modeChanged = securityChange?.changed ?? ((source.mode & 0o7777) !== (destination.mode & 0o7777));
        if (timeChanged || modeChanged) changes.push(`.d..${timeChanged ? "t" : "."}${modeChanged ? "p" : "."} ${dst}`);
      }
      const borrowedMode = !plan.dryRun && process.platform !== "win32" && destination && names.length
        && (destination.mode & 0o700) !== 0o700 ? destination.mode & 0o7777 : undefined;
      if (borrowedMode !== undefined) await chmod(dst, borrowedMode | 0o700);
      let childError: unknown;
      try {
        for (const name of names) await copy(path.join(src, name), path.join(dst, name));
      } catch (error) { childError = error; }
      try {
        if (!plan.dryRun) {
          // Apply after recursion: restrictive source permissions must not prevent
          // child creation, and mkdir's umask must not change the final mode.
          if (process.platform !== "win32") await chmod(dst, source.mode & 0o7777);
          let timestampError: unknown;
          try { await utimes(dst, source.atime, source.mtime); } catch (error) { timestampError = error; }
          try { if (directorySecurity) finishWindowsCopiedDirectory(dst, directorySecurity); }
          catch (error) { if (timestampError) throw new AggregateError([timestampError, error], `Directory timestamps and protected DACL finalization failed: ${dst}`); throw error; }
          if (timestampError) throw timestampError;
        }
      } catch (error) {
        if (borrowedMode !== undefined) {
          try { await chmod(dst, borrowedMode); }
          catch (restore) { throw new AggregateError([childError, error, restore].filter(Boolean), `Directory metadata failed and original permissions could not be restored: ${dst}`); }
        }
        if (childError) throw new AggregateError([childError, error], `Copy and directory metadata finalization failed: ${dst}`);
        throw error;
      }
      if (childError) throw childError;
      return;
    }
    if (!source.isFile() && !source.isSymbolicLink()) throw new Error(`Unsupported special file: ${src}`);
    const replacingDirectory = destination?.isDirectory() === true;
    if (replacingDirectory && (await readdir(dst)).length) throw new Error(`Cannot replace nonempty directory with file: ${dst}`);
    const directoryLink = source.isSymbolicLink() && process.platform === "win32" ? isWindowsDirectoryLink(src) : undefined;
    const same = source.isSymbolicLink()
      ? destination?.isSymbolicLink() && await readlink(src) === await readlink(dst)
        && (directoryLink === undefined || directoryLink === isWindowsDirectoryLink(dst))
      : destination?.isFile() && source.size === destination.size
        && Math.floor(source.mtimeMs / 1000) === Math.floor(destination.mtimeMs / 1000);
    if (same) {
      if (source.isSymbolicLink() && destination
        && Math.floor(source.mtimeMs / 1000) !== Math.floor(destination.mtimeMs / 1000)) {
        changes.push(`.L..t. ${dst}`);
        if (!plan.dryRun) await lutimes(dst, source.atime, source.mtime);
      }
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
      if (replacingDirectory) {
        staged = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        if (source.isSymbolicLink()) {
          await symlink(await readlink(src), staged, directoryLink ? "dir" : "file");
          await lutimes(staged, source.atime, source.mtime);
        } else { if (process.platform === "win32") copyWindowsFileNew(src, staged); else await cp(src, staged, { force: false, errorOnExist: true }); await utimes(staged, source.atime, source.mtime); }
        // Nonrecursive removal is the final emptiness check; a newly added
        // child makes it fail without deleting that child's data.
        directoryReplacementAttempted = true;
        await rmdir(dst);
        try { await moveEntry(staged, dst); }
        catch (error) {
          try {
            await mkdir(dst, { mode: 0o700 });
            if (process.platform !== "win32") await chmod(dst, destination!.mode & 0o7777);
            await utimes(dst, destination!.atime, destination!.mtime);
          } catch (restore) { throw new AggregateError([error, restore], `Replacement failed and empty directory recovery is unconfirmed: ${dst}`); }
          throw error;
        }
        staged = undefined;
        return;
      }
      if (directoryLink !== undefined) {
        staged = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        await symlink(await readlink(src), staged, directoryLink ? "dir" : "file");
        await lutimes(staged, source.atime, source.mtime);
        await rename(staged, dst);
        staged = undefined;
        return;
      }
      if (process.platform === "win32" && source.isFile() && destination?.isFile()) {
        staged = path.join(path.dirname(dst), `.openrig-copy-${randomUUID()}`);
        copyWindowsFileNew(src, staged);
        await utimes(staged, source.atime, source.mtime);
        replaceWindowsCopiedFile(dst, staged);
        staged = undefined;
        return;
      }
      // fs.cp overwrites the entry, preserving links rather than following their targets.
      if (process.platform === "win32" && source.isFile() && !destination) copyWindowsFileNew(src, dst);
      else await cp(src, dst, { force: true, verbatimSymlinks: true });
      if (source.isSymbolicLink()) await lutimes(dst, source.atime, source.mtime);
      else await utimes(dst, source.atime, source.mtime);
    }
  };
  try {
    const src = path.resolve(plan.src.path);
    const dst = path.resolve(plan.dst.path);
    const source = await entryStat(src);
    const destination = await stat(dst);
    const contentsOnly = plan.src.path.endsWith(path.sep) || plan.src.path.endsWith("/");
    const target = destination?.isDirectory() && !(source.isDirectory() && contentsOnly) ? path.join(dst, path.basename(src)) : dst;
    await rejectOverlap(src, target, source.isDirectory());
    await copy(src, target);
    return { ok: true, failedStep: "none", exitCode: 0, stdout: changes.join("\n"), stderr: "", filesTransferred, bytesTransferred, transport: "native-local" };
  } catch (error) {
    return { ok: false, failedStep: "local-copy-failed", exitCode: 1, stdout: changes.join("\n"), stderr: error instanceof Error ? error.message : String(error), transport: "native-local",
      ...(staged || retainedOriginal ? { hint: [staged ? `Staging path may contain incomplete data: ${staged}; ${directoryReplacementAttempted ? "inspect the destination after the attempted empty-directory replacement." : "inspect the destination before retrying."}` : "",
        retainedOriginal ? `${originalConfirmed ? "Original entry retained at" : "Original recovery path (existence unconfirmed)"}: ${retainedOriginal}` : ""].filter(Boolean).join(" ") } : {}) };
  }
}
