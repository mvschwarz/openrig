import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? (process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/OpenSSH/sftp-server.exe") : "/usr/lib/openssh/sftp-server");
const remotePath = (file: string) => process.platform === "win32" ? "/" + file.replaceAll("\\", "/") : file;

it.skipIf(!existsSync(server))("counts actual binary bytes when the remote omits optional source size", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-no-size-"));
  const source = path.join(root, "source"), destination = path.join(root, "destination"), bytes = Buffer.from([0, 1, 255, 128, 10, 0]);
  const lstat = SftpClient.prototype.lstat;
  const spy = vi.spyOn(SftpClient.prototype, "lstat").mockImplementation(async function (file) {
    const attrs = await lstat.call(this, file); return file === remotePath(source) && attrs ? { ...attrs, size: undefined } : attrs;
  });
  try {
    await writeFile(source, bytes);
    const result = await runNativeSftpCopy({ src: { kind: "remote", path: remotePath(source), host: { id: "owned", target: "owned", transport: "ssh" } },
      dst: { kind: "local", path: destination }, dryRun: false }, () => spawn(server, [], { stdio: "pipe", windowsHide: true }));
    expect(result.ok, result.stderr).toBe(true); expect(result.bytesTransferred).toBe(bytes.length);
    expect(await readFile(destination)).toEqual(bytes);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!existsSync(server)).each([
  ["upload", "short"], ["upload", "long"], ["download", "short"], ["download", "long"],
] as const)("rejects changed source size (%s, %s) before publishing the real SFTP stage", async (direction, change) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-source-size-"));
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  let changed = false;
  const mutate = async () => { if (!changed) { changed = true; await writeFile(source, change === "short" ? "few" : "more bytes than the captured source size".repeat(4)); } };
  const read = SftpClient.prototype.read, write = SftpClient.prototype.write;
  const spy = direction === "upload"
    ? vi.spyOn(SftpClient.prototype, "write").mockImplementation(async function (file, chunks) { await mutate(); return write.call(this, file, chunks); })
    : vi.spyOn(SftpClient.prototype, "read").mockImplementation(async function* (file) { await mutate(); yield* read.call(this, file); });
  try {
    await writeFile(source, "captured source version"); await writeFile(destination, "retain original target");
    const local = (file: string) => ({ kind: "local" as const, path: file });
    const remote = (file: string) => ({ kind: "remote" as const, path: remotePath(file), host: { id: "owned", target: "owned", transport: "ssh" as const } });
    const result = await runNativeSftpCopy({ src: direction === "upload" ? local(source) : remote(source),
      dst: direction === "upload" ? remote(destination) : local(destination), dryRun: false },
    () => spawn(server, [], { stdio: "pipe", windowsHide: true }));
    expect(changed).toBe(true);
    expect(result.ok).toBe(false); expect(result.stderr).toContain("Source byte count differs from captured size during copy");
    expect(result.failedStep).toBe(direction === "upload" ? "local-copy-failed" : "remote-command-failed");
    expect(await readFile(destination, "utf8")).toBe("retain original target");
    expect(result.hint).toContain("Staging path");
    expect((await readdir(root)).filter(name => name.startsWith(".openrig-copy-"))).toHaveLength(1);
  } finally { spy.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
