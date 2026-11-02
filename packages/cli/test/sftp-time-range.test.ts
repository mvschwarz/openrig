import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? (process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/OpenSSH/sftp-server.exe") : "/usr/lib/openssh/sftp-server");
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
