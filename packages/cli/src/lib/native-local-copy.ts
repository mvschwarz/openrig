import { cp, lstat, mkdir, readdir, readlink, realpath, utimes } from "node:fs/promises";
import path from "node:path";
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

/** Archive-style local copies without a shell or rsync. Extra destination files are retained. */
export async function runNativeLocalCopy(plan: CopyPlan): Promise<FileCopyResult> {
  let filesTransferred = 0;
  let bytesTransferred = 0;
  const changes: string[] = [];
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
      for (const name of await readdir(src)) await copy(path.join(src, name), path.join(dst, name));
      if (!plan.dryRun) await utimes(dst, source.atime, source.mtime);
      return;
    }
    if (!source.isFile() && !source.isSymbolicLink()) throw new Error(`Unsupported special file: ${src}`);
    const same = source.isSymbolicLink()
      ? destination?.isSymbolicLink() && await readlink(src) === await readlink(dst)
      : destination?.isFile() && source.size === destination.size
        && Math.floor(source.mtimeMs / 1000) === Math.floor(destination.mtimeMs / 1000);
    if (same) return;
    changes.push(`${source.isSymbolicLink() ? "cL" : ">f"} ${dst}`);
    if (!source.isSymbolicLink()) { filesTransferred++; bytesTransferred += source.size; }
    if (!plan.dryRun) {
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
    const sourceIdentity = source.isDirectory() ? await realpath(src) : src;
    const targetIdentity = source.isDirectory() ? await physicalDestination(target) : target;
    const relative = path.relative(sourceIdentity, targetIdentity);
    if (sourceIdentity.toLowerCase() === targetIdentity.toLowerCase() || (source.isDirectory() && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))) {
      throw new Error("Source and destination overlap");
    }
    await copy(src, target);
    return { ok: true, failedStep: "none", exitCode: 0, stdout: changes.join("\n"), stderr: "", filesTransferred, bytesTransferred, transport: "native-local" };
  } catch (error) {
    return { ok: false, failedStep: "local-copy-failed", exitCode: 1, stdout: changes.join("\n"), stderr: error instanceof Error ? error.message : String(error), transport: "native-local" };
  }
}
