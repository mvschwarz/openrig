import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { spawnSftpTransport, runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? (process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32/OpenSSH/sftp-server.exe") : "/usr/lib/openssh/sftp-server");
it.skipIf(!fs.existsSync(server)).each(["upload", "download"] as const)("real SFTP %s traverses the default transport pipe implementation", async direction => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-sftp-job-wire-"));
  const source = path.join(root, "source"), destination = path.join(root, "destination"), bytes = Buffer.from([0, 255, 128, 1, 10, 0]);
  const local = (file: string) => ({ kind: "local" as const, path: file });
  const remote = (file: string) => ({ kind: "remote" as const, path: process.platform === "win32" ? "/" + file.replaceAll("\\", "/") : file,
    host: { id: "owned", target: "owned", transport: "ssh" as const } });
  try {
    fs.writeFileSync(source, bytes);
    const result = await runNativeSftpCopy({ src: direction === "upload" ? local(source) : remote(source),
      dst: direction === "upload" ? remote(destination) : local(destination), dryRun: false }, () => spawnSftpTransport(server, []));
    expect(result.ok, result.stderr).toBe(true); expect(fs.readFileSync(destination)).toEqual(bytes);
    expect(result.bytesTransferred).toBe(bytes.length);
  } finally {
    for (const file of [source, destination]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
});

it.runIf(process.platform === "win32").each([0, 7, "timeout"] as const)("SFTP native transport retains descendants through %s", async mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-sftp-custody-"));
  const receiver = path.join(root, "receiver.cjs"), receipt = path.join(root, "child.pid");
  const childCode = `require('fs').writeFileSync(${JSON.stringify(receipt)},String(process.pid));setInterval(()=>{},1000);`;
  fs.writeFileSync(receiver, `const fs=require('fs');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,windowsHide:true,stdio:'ignore'}).unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(receipt)})){clearInterval(timer);${mode === "timeout" ? "setInterval(()=>{},1000);" : `console.error('owned SFTP exit');process.exit(${mode});`}}},10);`);
  let pid = 0;
  const child = spawnSftpTransport(process.execPath, [receiver]);
  const closed = new Promise<number | null>((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  let client: SftpClient | undefined;
  try {
    if (mode === "timeout") {
      client = new SftpClient(child, 2500);
      await expect(client.ready).rejects.toThrow("SFTP subsystem did not become ready");
    } else { child.stdin.end(); child.stdout.resume(); child.stderr.resume(); }
    const code = await closed;
    if (mode !== "timeout") expect(code).toBe(mode);
    pid = Number(fs.readFileSync(receipt, "utf8")); expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }, { timeout: 3000 }).toBe(false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await client?.close();
    if (!pid && fs.existsSync(receipt)) pid = Number(fs.readFileSync(receipt, "utf8"));
    if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(pid); } catch { /* already ended */ }
    for (const file of [receiver, receipt]) if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(root);
  }
}, 10000);

it("SFTP transport preserves binary stdin/stdout and native argv without a shell", async () => {
  const values = ["", 'quote"word', "中文", "end\\", "%PATH%!&|"];
  const bytes = Buffer.from([0, 1, 255, 128, 10, 0]);
  const code = "const chunks=[];process.stdin.on('data',b=>chunks.push(b));process.stdin.on('end',()=>{process.stderr.write(JSON.stringify(process.argv.slice(1)));process.stdout.write(Buffer.concat(chunks));});";
  const child = spawnSftpTransport(process.execPath, ["-e", code, ...values]);
  const out: Buffer[] = [], err: Buffer[] = [];
  child.stdout.on("data", chunk => out.push(chunk)); child.stderr.on("data", chunk => err.push(chunk));
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  child.stdin.end(bytes); expect(await closed).toBe(0);
  expect(Buffer.concat(out)).toEqual(bytes); expect(JSON.parse(Buffer.concat(err).toString("utf8"))).toEqual(values);
});

it.runIf(process.platform === "win32")("classifies native missing SSH before Job creation as ssh-missing", async () => {
  const result = await runNativeSftpCopy({ src: { kind: "remote", path: "/owned", host: { id: "owned", target: "owned", transport: "ssh" } },
    dst: { kind: "local", path: path.join(os.tmpdir(), "unused-sftp-destination") }, dryRun: true },
  () => spawnSftpTransport("openrig-absent-ssh-" + randomUUID(), []));
  expect(result).toMatchObject({ ok: false, failedStep: "ssh-missing" });
});
