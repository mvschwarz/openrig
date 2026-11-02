import { createReadStream } from "node:fs";
import { chmod, lstat, lutimes, stat, mkdir, open, readdir, readlink, rename, rmdir, symlink, utimes } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CopyPlan, FileCopyResult } from "./file-transfer.js";
import { SftpClient, type SftpAttrs } from "./sftp-protocol.js";
import { looksLikePermissionGate } from "../cross-host-executor.js";
import { isWindowsDirectoryCaseSensitive, isWindowsDirectoryLink, replaceWindowsCopiedFile, windowsNamesCollide } from "@openrig/daemon/windows-owned-files";

interface Endpoint {
  paths: typeof path.posix;
  stat(file: string): Promise<SftpAttrs | undefined>;
  followsDirectory(file: string): Promise<boolean | undefined>;
  names(file: string): Promise<string[]>;
  link(file: string): Promise<string>;
  mkdir(file: string): Promise<void>;
  rmdir(file: string): Promise<void>;
  symlink(target: string, file: string, directory?: boolean): Promise<void>;
  read(file: string): AsyncIterable<Buffer>;
  write(file: string, data: AsyncIterable<Buffer>): Promise<void>;
  times(file: string, attrs: SftpAttrs): Promise<void>;
  linkTimes?(file: string, attrs: SftpAttrs): Promise<void>;
  rename(src: string, dst: string, replacing: boolean): Promise<void>;
}
const local: Endpoint = {
  paths: path,
  async stat(file) {
    try { const s = await lstat(file); return { size: s.size, mode: s.mode, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  names: readdir, link: readlink,
  async followsDirectory(file) { try { return (await stat(file)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
  async mkdir(file) { await mkdir(file, { mode: 0o700 }); },
  rmdir,
  async symlink(target, file, directory) { await symlink(target, file, directory ? "dir" : "file"); },
  read: file => createReadStream(file),
  async write(file, data) {
    const handle = await open(file, "wx", 0o600);
    try {
      for await (const chunk of data) {
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (!bytesWritten) throw new Error("Local copy made no write progress");
          offset += bytesWritten;
        }
      }
    } finally { await handle.close(); }
  },
  async times(file, attrs) {
    if (attrs.atime !== undefined && attrs.mtime !== undefined) await utimes(file, attrs.atime, attrs.mtime);
    // Windows chmod preserves the representable read-only/writeable attribute;
    // it cannot install POSIX owner/group/execute permissions or replace a DACL.
    // A Windows directory readonly attribute is Explorer customization state,
    // not directory write permission. Do not pretend chmod can enforce it.
    if (attrs.mode !== undefined && !(process.platform === "win32" && kind(attrs) === 0o040000)) await chmod(file, attrs.mode & 0o7777);
  },
  async linkTimes(file, attrs) {
    // Never use SETSTAT/utimes for links: those follow the referent.
    if (attrs.atime !== undefined && attrs.mtime !== undefined) await lutimes(file, attrs.atime, attrs.mtime);
  },
  async rename(src, dst, replacing) {
    if (process.platform === "win32" && replacing && kind(await local.stat(src)) === 0o100000 && kind(await local.stat(dst)) === 0o100000) {
      try { replaceWindowsCopiedFile(dst, src); }
      catch (error) { throw Object.assign(error as Error, {path: dst, syscall: "replace"}); }
    }
    else await rename(src, dst);
  },
};
const kind = (attrs: SftpAttrs | undefined) => (attrs?.mode ?? 0) & 0o170000;

export function buildSftpArgv(plan: CopyPlan): string[] {
  const remote = plan.src.kind === "remote" ? plan.src : plan.dst;
  if (!remote.host) throw new Error("SFTP requires one remote endpoint");
  return ["-o", "ConnectTimeout=10", ...(remote.host.user ? ["-l", remote.host.user] : []), "-s", "--", remote.host.target, "sftp"];
}

/** Native OpenSSH subsystem transport. Never invokes a local or remote shell. */
export async function runNativeSftpCopy(plan: CopyPlan, start: (argv: string[]) => ChildProcessWithoutNullStreams = argv => spawn("ssh", argv, { stdio: "pipe", windowsHide: true })): Promise<FileCopyResult> {
  let client: SftpClient | undefined;
  let stderr = "", staged: string | undefined, filesTransferred = 0, bytesTransferred = 0;
  let spawnError: NodeJS.ErrnoException | undefined;
  let transportExit: number | null = null;
  let directoryReplacementAttempted = false;
  const changes: string[] = [];
  try {
    const child = start(buildSftpArgv(plan));
    child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
    child.once("exit", code => { transportExit = code; });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => { stderr = (stderr + text).slice(-65536); });
    client = new SftpClient(child);
    await client.ready;
    const remote: Endpoint = {
      paths: path.posix, stat: file => client!.lstat(file), names: file => client!.readdir(file),
      followsDirectory: async file => { const attrs=await client!.stat(file); return attrs ? kind(attrs) === 0o040000 : undefined; },
      link: file => client!.readlink(file), mkdir: file => client!.mkdir(file), rmdir: file => client!.rmdir(file), symlink: (target, file) => client!.symlink(target, file),
      read: file => client!.read(file), write: (file, data) => client!.write(file, data),
      times: (file, attrs) => client!.setTimes(file, attrs), rename: (src, dst, replacing) => client!.rename(src, dst, replacing),
      ...(client.extensionVersions.get("lsetstat@openssh.com") === "1"
        ? { linkTimes: (file: string, attrs: SftpAttrs) => client!.setLinkTimes(file, attrs) } : {}),
    };
    const source = plan.src.kind === "local" ? local : remote;
    const destination = plan.dst.kind === "local" ? local : remote;
    const copy = async (src: string, dst: string): Promise<void> => {
      const attrs = await source.stat(src), existing = await destination.stat(dst);
      if (!attrs) throw new Error(`Source not found: ${src}`);
      if (kind(attrs) === 0o040000) {
        if (existing && kind(existing) !== 0o040000) throw new Error(`Destination is not an ordinary directory: ${dst}`);
        if (!existing) { changes.push(`cd ${dst}`); if (!plan.dryRun) await destination.mkdir(dst); }
        else {
          const timeChanged = attrs.mtime !== undefined && attrs.mtime !== existing.mtime;
          const mask = destination === local && process.platform === "win32" ? 0 : 0o7777;
          const modeChanged = attrs.mode !== undefined && existing.mode !== undefined && (attrs.mode & mask) !== (existing.mode & mask);
          if (timeChanged || modeChanged) changes.push(`.d..${timeChanged ? "t" : "."}${modeChanged ? "p" : "."} ${dst}`);
        }
        const names = await source.names(src);
        if (destination === local && process.platform === "win32" && windowsNamesCollide(names)) {
          let selected=dst;
          while(!await local.stat(selected)){
            const parent=path.dirname(selected);if(parent===selected)throw new Error("Cannot establish destination case sensitivity");selected=parent;
          }
          if(!isWindowsDirectoryCaseSensitive(selected))throw new Error(`Directory contains names that collide on Windows: ${src}`);
        }
        const borrowedMode = !plan.dryRun && !(destination === local && process.platform === "win32")
          && existing?.mode !== undefined && names.length && (existing.mode & 0o700) !== 0o700 ? existing.mode & 0o7777 : undefined;
        if (borrowedMode !== undefined) await destination.times(dst, { mode: borrowedMode | 0o700 });
        let childError: unknown;
        try {
          for (const name of names) {
            // A remote directory entry must remain exactly one native filename.
            if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name)
              || (destination === local && process.platform === "win32" && (/[\x01-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) {
              throw new Error(`Unrepresentable directory entry: ${JSON.stringify(name)}`);
            }
            await copy(source.paths.join(src, name), destination.paths.join(dst, name));
          }
        } catch (error) { childError = error; }
        try {
          if (!plan.dryRun) await destination.times(dst, attrs);
        } catch (error) {
          if (borrowedMode !== undefined) {
            try { await destination.times(dst, { mode: borrowedMode }); }
            catch (restore) { throw new AggregateError([childError, error, restore].filter(Boolean), `Directory metadata failed and original permissions could not be restored: ${dst}`); }
          }
          if (childError) throw new AggregateError([childError, error], `Copy and directory metadata finalization failed: ${dst}`);
          throw error;
        }
        if (childError) throw childError;
        return;
      }
      const isLink = kind(attrs) === 0o120000;
      if (!isLink && kind(attrs) !== 0o100000) throw new Error(`Unsupported special file: ${src}`);
      const replacingDirectory = kind(existing) === 0o040000;
      if (replacingDirectory && (await destination.names(dst)).length) throw new Error(`Cannot replace nonempty directory with file: ${dst}`);
      const target = isLink ? await source.link(src) : undefined;
      const directory = isLink && destination === local && process.platform === "win32" ? await source.followsDirectory(src) : undefined;
      if (isLink && kind(existing) === 0o120000 && target === await destination.link(dst)) {
        if (directory === undefined || directory === isWindowsDirectoryLink(dst)) {
          if (destination.linkTimes && attrs.mtime !== undefined && attrs.mtime !== existing?.mtime) {
            changes.push(`.L..t. ${dst}`);
            if (!plan.dryRun) await destination.linkTimes(dst, attrs);
          }
          return;
        }
      }
      if (!isLink && kind(existing) === 0o100000 && attrs.size === existing?.size && attrs.mtime === existing?.mtime) {
        const mask = destination === local && process.platform === "win32" ? 0o200 : 0o7777;
        if (attrs.mode !== undefined && existing?.mode !== undefined && (attrs.mode & mask) !== (existing.mode & mask)) {
          changes.push(`.f...p ${dst}`);
          if (!plan.dryRun) await destination.times(dst, attrs);
        }
        return;
      }
      changes.push(`${isLink ? "cL" : ">f"} ${dst}`);
      if (!isLink) { filesTransferred++; bytesTransferred += attrs.size ?? 0; }
      if (plan.dryRun) return;
      staged = destination.paths.join(destination.paths.dirname(dst), `.openrig-copy-${randomUUID()}`);
      if (isLink) {
        // NTFS distinguishes directory and file links. Inspect only target type;
        // copy the original link text, never recursively copy its referent.
        await destination.symlink(target!, staged, directory);
        await destination.linkTimes?.(staged, attrs);
      }
      else { await destination.write(staged, source.read(src)); await destination.times(staged, attrs); }
      if (replacingDirectory) {
        directoryReplacementAttempted = true;
        await destination.rmdir(dst);
        try { await destination.rename(staged, dst, false); }
        catch (error) {
          try { await destination.mkdir(dst); await destination.times(dst, existing!); }
          catch (restore) { throw new AggregateError([error, restore], `Replacement failed and empty directory recovery is unconfirmed: ${dst}`); }
          throw error;
        }
      } else await destination.rename(staged, dst, existing !== undefined);
      staged = undefined;
    };
    const src = source.paths.normalize(plan.src.path), dst = destination.paths.normalize(plan.dst.path);
    const attrs = await source.stat(src), existing = await destination.stat(dst);
    if (!attrs) throw new Error(`Source not found: ${src}`);
    const contents = /[\\/]$/.test(plan.src.path) && kind(attrs) === 0o040000;
    await copy(src, kind(existing) === 0o040000 && !contents ? destination.paths.join(dst, source.paths.basename(src)) : dst);
    return { ok: true, failedStep: "none", transport: "sftp", exitCode: 0, stdout: changes.join("\n"), stderr, filesTransferred, bytesTransferred };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Node filesystem errors carry their local path and syscall. SFTP status
    // errors and transport errors do not: a local rename/open failure must not
    // send the operator looking for a problem on the remote host.
    const localError = error as NodeJS.ErrnoException | undefined;
    const localFilesystemFailure = typeof localError?.path === "string"
      && typeof localError.syscall === "string" && !localError.syscall.startsWith("spawn");
    const failedStep = spawnError?.code === "ENOENT" ? "ssh-missing" : localFilesystemFailure ? "local-copy-failed" : looksLikePermissionGate(stderr) ? "permission-gate" : transportExit === 255 ? "ssh-unreachable" : "remote-command-failed";
    return { ok: false, failedStep, transport: "sftp", exitCode: transportExit ?? 1, stdout: changes.join("\n"), stderr: [stderr, message].filter(Boolean).join("\n"), ...(staged ? { hint: `Staging path may contain incomplete data: ${staged}; ${directoryReplacementAttempted ? "inspect the destination after the attempted empty-directory replacement." : "existing destination was not removed."}` } : {}) };
  } finally { await client?.close(); }
}
