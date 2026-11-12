import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";

const peer = `const u=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b},s=b=>{b=Buffer.from(b);return Buffer.concat([u(b.length),b])};let input=Buffer.alloc(0),listed=false;const name=Buffer.from(process.argv[1],'hex');const send=(t,b)=>process.stdout.write(Buffer.concat([u(b.length+1),Buffer.from([t]),b]));process.stdin.on('data',b=>{input=Buffer.concat([input,b]);while(input.length>=4&&input.length>=input.readUInt32BE()+4){const n=input.readUInt32BE(),p=input.subarray(4,n+4);input=input.subarray(n+4);const t=p[0],id=p.subarray(1,5);if(t===1)send(2,u(3));else if(t===11)send(102,Buffer.concat([id,s('owned')]));else if(t===19||t===12&&!listed){listed=true;send(104,Buffer.concat([id,u(1),s(name),s('owned'),u(0)]));}else send(101,Buffer.concat([id,u(t===4?0:1),s(''),s('')]));}});process.stdin.on('end',()=>process.exit(0));`;

it.each(["ff", "c0af", "eda080", "e282"])("rejects invalid SFTP text bytes without replacement decoding: %s", async hex => {
  const client = new SftpClient(spawn(process.execPath, ["-e", peer, hex], { stdio: "pipe", windowsHide: true }));
  try {
    await client.ready;
    await expect(client.readdir("/owned")).rejects.toThrow("SFTP text is not valid UTF-8");
    await expect(client.readlink("/owned/link")).rejects.toThrow("SFTP text is not valid UTF-8");
  } finally { await client.close(); }
});

it.each(["日本語", "\ufeffowned", "literal�", "emoji💾"])("preserves exact valid SFTP text, including a leading BOM: %s", async name => {
  const client = new SftpClient(spawn(process.execPath, ["-e", peer, Buffer.from(name).toString("hex")], { stdio: "pipe", windowsHide: true }));
  try { await client.ready; expect(await client.readdir("/owned")).toEqual([name]); expect(await client.readlink("/owned/link")).toBe(name); }
  finally { await client.close(); }
});

it.each(["\ud800", "\udc00"])("rejects unpaired UTF-16 text instead of changing its wire identity: %j", async invalid => {
  const client = new SftpClient(spawn(process.execPath, ["-e", peer, Buffer.from("owned").toString("hex")], { stdio: "pipe", windowsHide: true }));
  try {
    await client.ready;
    await expect(client.lstat("/owned/" + invalid)).rejects.toThrow("SFTP text cannot be encoded losslessly as UTF-8");
    await expect(client.symlink(invalid, "/owned/link")).rejects.toThrow("SFTP text cannot be encoded losslessly as UTF-8");
    expect(await client.readlink("/owned/link")).toBe("owned");
  } finally { await client.close(); }
});

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? "/usr/lib/openssh/sftp-server";
it.skipIf(process.platform === "win32" || !existsSync(server))("real POSIX invalid-byte names cannot silently alias a valid replacement-character file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-byte-names-"));
  const source = path.join(root, "source"), destination = path.join(root, "destination");
  try {
    await mkdir(source); await mkdir(destination);
    await writeFile(Buffer.concat([Buffer.from(source + "/"), Buffer.from([255])]), "invalid byte filename contents");
    await writeFile(path.join(source, "�"), "different valid filename contents");
    await writeFile(path.join(destination, "retained"), "retain target");
    const result = await runNativeSftpCopy({ src: { kind: "remote", path: source + "/", host: { id: "owned", target: "owned", transport: "ssh" } },
      dst: { kind: "local", path: destination }, dryRun: false }, () => spawn(server, [], { stdio: "pipe" }));
    expect(result.ok).toBe(false); expect(result.stderr).toContain("SFTP text is not valid UTF-8");
    expect(await readdir(destination)).toEqual(["retained"]); expect(await readFile(path.join(destination, "retained"), "utf8")).toBe("retain target");
  } finally { await rm(root, { recursive: true, force: true }); }
});
