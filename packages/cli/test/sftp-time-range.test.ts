import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import { readWindowsEntryTimes } from "@openrig/daemon/windows-owned-files";

it.skipIf(process.platform !== "win32")("reads native time range and rejects a changed file identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-native-entry-times-"));
  try {
    const file = path.join(root, "entry"); await writeFile(file, "owned");
    for (const seconds of [-1, 0, 2147483648, 4294967295, 4294967296]) {
      await utimes(file, new Date(seconds * 1000), new Date(seconds * 1000));
      const identity = await lstat(file);
      expect(readWindowsEntryTimes(file, identity)).toMatchObject({ atime: seconds, mtime: seconds });
      expect(() => readWindowsEntryTimes(file, { dev: identity.dev, ino: 0 })).toThrow("File identity changed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? (process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/OpenSSH/sftp-server.exe") : "/usr/lib/openssh/sftp-server");
it.skipIf(!existsSync(server)).each([-1, 0x100000000])("captures native source time before refusing SFTP range (%s)", async seconds => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-native-time-"));
  try {
    const source = path.join(root, "source"), destination = path.join(root, "destination");
    await writeFile(source, "new bytes"); await writeFile(destination, "retain original");
    await utimes(source, new Date(seconds * 1000), new Date(seconds * 1000));
    const result = await runNativeSftpCopy({ src: { kind: "local", path: source }, dst: { kind: "remote", path: process.platform === "win32" ? "/" + destination.replaceAll("\\", "/") : destination, host: { id: "owned", target: "owned", transport: "ssh" } }, dryRun: false }, () => spawn(server, [], { stdio: "pipe", windowsHide: true }));
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("SFTP v3 timestamps require integer seconds");
    expect(await readFile(destination, "utf8")).toBe("retain original");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(!existsSync(server)).each([-1, 0x100000000])("does not publish rounded or wrapped SFTP v3 timestamps (%s)", async seconds => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-time-range-"));
  const client = new SftpClient(spawn(server, [], { stdio: "pipe", windowsHide: true }));
  try {
    const destination = path.join(root, "destination");
    await writeFile(destination, "retain original"); await client.ready;
    const remote = process.platform === "win32" ? "/" + destination.replaceAll("\\", "/") : destination;
    const before = await client.lstat(remote);
    await expect(client.setTimes(remote, { atime: seconds, mtime: seconds })).rejects.toThrow("SFTP v3 timestamps require integer seconds from 0 to 4294967295");
    expect(await client.lstat(remote)).toEqual(before);
    expect(await readFile(destination, "utf8")).toBe("retain original");
  } finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
