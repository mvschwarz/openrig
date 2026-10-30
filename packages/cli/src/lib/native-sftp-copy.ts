import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readlink, rename, symlink, utimes } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CopyPlan, FileCopyResult } from "./file-transfer.js";
import { SftpClient, type SftpAttrs } from "./sftp-protocol.js";
import { looksLikePermissionGate } from "../cross-host-executor.js";

interface Endpoint {
  paths: typeof path.posix;
  stat(file: string): Promise<SftpAttrs | undefined>;
  names(file: string): Promise<string[]>;
  link(file: string): Promise<string>;
  mkdir(file: string): Promise<void>;
  symlink(target: string, file: string): Promise<void>;
  read(file: string): AsyncIterable<Buffer>;
  write(file: string, data: AsyncIterable<Buffer>): Promise<void>;
  times(file: string, attrs: SftpAttrs): Promise<void>;
  rename(src: string, dst: string, replacing: boolean): Promise<void>;
}
const local: Endpoint = {
  paths: path,
  async stat(file) {
    try { const s = await lstat(file); return { size: s.size, mode: s.mode, atime: Math.floor(s.atimeMs / 1000), mtime: Math.floor(s.mtimeMs / 1000) }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  },
  names: readdir, link: readlink,
  async mkdir(file) { await mkdir(file); },
  async symlink(target, file) { await symlink(target, file); },
  read: file => createReadStream(file),
  async write(file, data) {
    const handle = await open(file, "wx");
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
  async times(file, attrs) { if (attrs.atime !== undefined && attrs.mtime !== undefined) await utimes(file, attrs.atime, attrs.mtime); },
  async rename(src, dst) { await rename(src, dst); },
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
      link: file => client!.readlink(file), mkdir: file => client!.mkdir(file), symlink: (target, file) => client!.symlink(target, file),
      read: file => client!.read(file), write: (file, data) => client!.write(file, data),
      times: (file, attrs) => client!.setTimes(file, attrs), rename: (src, dst, replacing) => client!.rename(src, dst, replacing),
    };
    const source = plan.src.kind === "local" ? local : remote;
    const destination = plan.dst.kind === "local" ? local : remote;
    const copy = async (src: string, dst: string): Promise<void> => {
      const attrs = await source.stat(src), existing = await destination.stat(dst);
      if (!attrs) throw new Error(`Source not found: ${src}`);
      if (kind(attrs) === 0o040000) {
        if (existing && kind(existing) !== 0o040000) throw new Error(`Destination is not an ordinary directory: ${dst}`);
        if (!existing) { changes.push(`cd ${dst}`); if (!plan.dryRun) await destination.mkdir(dst); }
        const names = await source.names(src);
        if (destination === local && process.platform === "win32" && new Set(names.map(name => name.toLowerCase())).size !== names.length) {
          throw new Error(`Directory contains names that collide on Windows: ${src}`);
        }
        for (const name of names) {
          // A remote directory entry must remain exactly one native filename.
          if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name)
            || (destination === local && process.platform === "win32" && (/[\x01-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)))) {
            throw new Error(`Unrepresentable directory entry: ${JSON.stringify(name)}`);
          }
          await copy(source.paths.join(src, name), destination.paths.join(dst, name));
        }
        if (!plan.dryRun) await destination.times(dst, attrs);
        return;
      }
      const isLink = kind(attrs) === 0o120000;
      if (!isLink && kind(attrs) !== 0o100000) throw new Error(`Unsupported special file: ${src}`);
      if (existing && kind(existing) === 0o040000) throw new Error(`Cannot replace directory with file: ${dst}`);
      const target = isLink ? await source.link(src) : undefined;
      if (isLink ? kind(existing) === 0o120000 && target === await destination.link(dst)
        : kind(existing) === 0o100000 && attrs.size === existing?.size && attrs.mtime === existing?.mtime) return;
      changes.push(`${isLink ? "cL" : ">f"} ${dst}`);
      if (!isLink) { filesTransferred++; bytesTransferred += attrs.size ?? 0; }
      if (plan.dryRun) return;
      staged = destination.paths.join(destination.paths.dirname(dst), `.openrig-copy-${randomUUID()}`);
      if (isLink) await destination.symlink(target!, staged);
      else { await destination.write(staged, source.read(src)); await destination.times(staged, attrs); }
      await destination.rename(staged, dst, existing !== undefined);
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
    return { ok: false, failedStep, transport: "sftp", exitCode: transportExit ?? 1, stdout: changes.join("\n"), stderr: [stderr, message].filter(Boolean).join("\n"), ...(staged ? { hint: `Staging path may contain incomplete data: ${staged}; existing destination was not removed.` } : {}) };
  } finally { await client?.close(); }
}
