import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const server = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "sftp-server.exe");
describe.skipIf(process.platform !== "win32" || !existsSync(server))("native OpenSSH SFTP protocol", () => {
  it("rejects malformed framing and terminates its owned transport", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.from([255,255,255,255]));setInterval(()=>{},1000)"], { stdio: "pipe" });
    const client = new SftpClient(child);
    try { await expect(client.ready).rejects.toThrow("Invalid SFTP packet length"); }
    finally { await client.close(); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("bounds a silent subsystem handshake", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume();setInterval(()=>{},1000)"], { stdio: "pipe" });
    const client = new SftpClient(child, 100);
    try { await expect(client.ready).rejects.toThrow("did not become ready"); }
    finally { await client.close(); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  it("writes, reads, lists and renames only an owned temporary tree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-protocol-"));
    const remoteRoot = "/" + root.replaceAll("\\", "/");
    const child = spawn(server, [], { stdio: "pipe", windowsHide: true });
    const client = new SftpClient(child);
    try {
      await client.ready;
      const rootAttrs = await client.lstat(remoteRoot);
      expect(rootAttrs?.mode! & 0o170000).toBe(0o040000);
      const file = remoteRoot + "/native 日本語.txt", renamed = remoteRoot + "/renamed.txt";
      const data = Buffer.from("native file 🙂\n");
      await client.write(file, (async function* () { yield data.subarray(0, 3); yield data.subarray(3); })());
      expect(await readFile(path.join(root, "native 日本語.txt"))).toEqual(data);
      const chunks: Buffer[] = []; for await (const chunk of client.read(file)) chunks.push(chunk);
      expect(Buffer.concat(chunks)).toEqual(data);
      expect(await client.readdir(remoteRoot)).toContain("native 日本語.txt");
      await client.setTimes(file, { atime: 1700000000, mtime: 1700000001 });
      expect((await client.lstat(file))?.mtime).toBe(1700000001);
      await client.rename(file, renamed, false);
      expect(await client.lstat(file)).toBeUndefined();
      await client.mkdir(remoteRoot + "/empty");
      expect(await client.readdir(remoteRoot + "/empty")).toEqual([]);
      await expect(client.write(renamed, (async function* () { yield data; })())).rejects.toThrow();
    } finally { await client.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
