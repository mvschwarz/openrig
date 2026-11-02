import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import type { CopyPlan } from "../src/lib/file-transfer.js";
import { planFileCopy } from "../src/lib/file-transfer.js";

const server = process.env.OPENRIG_TEST_SFTP_SERVER ?? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "OpenSSH", "sftp-server.exe");
describe.skipIf(process.platform !== "win32" || !existsSync(server))("native recursive SFTP copy", () => {
  it("previews directory time drift and restores parent times after copying children", async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"openrig-sftp-directory-"));
    const source=path.join(root,"source"), destination=path.join(root,"destination");
    const start=()=>spawn(server,[],{stdio:"pipe",windowsHide:true});
    try {
      for(const base of [source,destination])await mkdir(path.join(base,"nested"),{recursive:true});
      await writeFile(path.join(source,"nested","new.txt"),"directory metadata acceptance\n");
      for(const [base,time] of [[source,1400000000],[destination,1500000000]] as const){
        await utimes(path.join(base,"nested"),time,time);await utimes(base,time,time);
      }
      const plan:CopyPlan={src:{kind:"remote",path:"/"+source.replaceAll("\\","/")+"/",host:{id:"fixture",target:"fixture",transport:"ssh"}},dst:{kind:"local",path:destination},dryRun:true};
      const preview=await runNativeSftpCopy(plan,start);
      expect(preview.ok,preview.stderr).toBe(true);
      expect(preview.stdout.split("\n").filter(line=>line.startsWith(".d..t"))).toHaveLength(2);
      expect(Math.floor((await lstat(destination)).mtimeMs/1000)).toBe(1500000000);
      expect(await readdir(path.join(destination,"nested"))).toEqual([]);
      const copied=await runNativeSftpCopy({...plan,dryRun:false},start);
      expect(copied.ok,copied.stderr).toBe(true);expect(copied.filesTransferred).toBe(1);
      for(const directory of [destination,path.join(destination,"nested")])expect(Math.floor((await lstat(directory)).mtimeMs/1000)).toBe(1400000000);
      const repeated=await runNativeSftpCopy(plan,start);
      expect(repeated.ok,repeated.stderr).toBe(true);expect(repeated.stdout).toBe("");expect(repeated.filesTransferred).toBe(0);
    }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
  });
  it("preserves remote readonly state and repairs metadata-only drift without retransferring bytes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-mode-"));
    const source = path.join(root, "source.txt"), destination = path.join(root, "destination.txt");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    try {
      await writeFile(source, "owned readonly bytes\n"); await chmod(source, 0o444);
      const plan: CopyPlan = { src: { kind: "remote", path: "/" + source.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } }, dst: { kind: "local", path: destination }, dryRun: false };
      const first = await runNativeSftpCopy(plan, start);
      expect(first.ok, first.stderr).toBe(true);
      expect((await lstat(destination)).mode & 0o200).toBe(0);
      await chmod(destination, 0o666);
      const preview = await runNativeSftpCopy({ ...plan, dryRun: true }, start);
      expect(preview.stdout).toContain(".f...p");
      expect((await lstat(destination)).mode & 0o200).not.toBe(0);
      const repaired = await runNativeSftpCopy(plan, start);
      expect(repaired.ok, repaired.stderr).toBe(true);
      expect(repaired.filesTransferred).toBe(0);
      expect(repaired.bytesTransferred).toBe(0);
      expect((await lstat(destination)).mode & 0o200).toBe(0);
      expect(await readFile(destination, "utf8")).toBe("owned readonly bytes\n");
    } finally {
      await chmod(source, 0o666).catch(() => {}); await chmod(destination, 0o666).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it.each([false,true])("replaces an owned readonly destination while retaining its old hardlink (source readonly=%s)", async readonly => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-readonly-"));
    const source = path.join(root, "source.txt"), destination = path.join(root, "destination.txt"), alias = path.join(root, "retained-alias.txt");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    try {
      await writeFile(source, "owned new remote bytes\n");
      if (readonly) await chmod(source, 0o444);
      await writeFile(destination, "owned original\n");
      await link(destination, alias);
      await chmod(destination, 0o444);
      const result = await runNativeSftpCopy({
        src: { kind: "remote", path: "/" + source.replaceAll("\\", "/"), host: { id: "fixture", target: "fixture", transport: "ssh" } },
        dst: { kind: "local", path: destination }, dryRun: false,
      }, start);
      expect(result.ok, result.stderr).toBe(true);
      expect(await readFile(destination, "utf8")).toBe("owned new remote bytes\n");
      expect(Boolean((await lstat(destination)).mode & 0o200)).toBe(!readonly);
      expect(await readFile(alias, "utf8")).toBe("owned original\n");
      expect((await lstat(alias)).mode & 0o200).toBe(0);
      const staged = (await readdir(root)).filter(file => file.startsWith(".openrig-copy-"));
      expect(staged).toHaveLength(0);
    } finally {
      await chmod(destination, 0o666).catch(() => {});
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  it("uploads, downloads, previews and preserves extra files through the real subsystem", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openrig-sftp-copy-"));
    const source = path.join(root, "source"), remote = path.join(root, "remote space 中文"), download = path.join(root, "download");
    const start = () => spawn(server, [], { stdio: "pipe", windowsHide: true });
    const planned = planFileCopy(source + path.sep, "fixture:/" + remote.replaceAll("\\", "/"), {
      dryRun: true, registryLoader: () => ({ ok: true, registry: { hosts: [{ id: "fixture", target: "fixture", transport: "ssh" }] } }),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    const plan: CopyPlan = planned.plan;
    try {
      await mkdir(source); await mkdir(remote); await mkdir(download);
      await mkdir(path.join(source, "nested"));
      await writeFile(path.join(source, "nested", "日本語.txt"), "actual native transfer\n");
      await writeFile(path.join(remote, "extra.txt"), "retain");
      const preview = await runNativeSftpCopy(plan, start);
      expect(preview.ok, preview.stderr).toBe(true);
      expect(preview.filesTransferred).toBe(1);
      expect(await readdir(remote)).toEqual(["extra.txt"]);
      plan.dryRun = false;
      const upload = await runNativeSftpCopy(plan, start);
      expect(upload.ok, upload.stderr).toBe(true);
      expect(await readFile(path.join(remote, "nested", "日本語.txt"), "utf8")).toBe("actual native transfer\n");
      expect((await runNativeSftpCopy(plan, start)).filesTransferred).toBe(0);
      // Same-size overwrite at a different timestamp must replace the entry.
      await writeFile(path.join(source, "nested", "日本語.txt"), "changed native transfer\n");
      const replacement = await runNativeSftpCopy(plan, start);
      expect(replacement.ok, replacement.stderr).toBe(true);
      const pull = await runNativeSftpCopy({ src: { ...plan.dst, path: plan.dst.path + "/" }, dst: { kind: "local", path: download }, dryRun: false }, start);
      expect(pull.ok, pull.stderr).toBe(true);
      expect(await readFile(path.join(download, "nested", "日本語.txt"), "utf8")).toBe("changed native transfer\n");
      expect(await readFile(path.join(download, "extra.txt"), "utf8")).toBe("retain");
      const missing = await runNativeSftpCopy({ ...plan, src: { kind: "local", path: path.join(root, "missing") } }, start);
      expect(missing.failedStep).toBe("remote-command-failed");
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  });
});
