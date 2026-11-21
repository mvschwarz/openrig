import { expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import { SftpClient } from "../src/lib/sftp-protocol.js";

const server=process.env.OPENRIG_TEST_SFTP_SERVER??(process.platform==="win32"?path.join(process.env.SystemRoot??"C:/Windows","System32/OpenSSH/sftp-server.exe"):"/usr/lib/openssh/sftp-server");
const remote=(file:string)=>process.platform==="win32"?"/"+file.replaceAll("\\","/"):file;
async function cleanup(root:string){
  const canonical=await realpath(root),temporary=await realpath(os.tmpdir());
  if(path.dirname(canonical)!==temporary||!path.basename(canonical).startsWith("openrig-dir-"))throw new Error("Unexpected directory-metadata fixture root");
  await rm(canonical,{recursive:true,force:true});
}

it.skipIf(!existsSync(server)).each(["time-noop","type-change"])("refuses unqualified directory finalization before replacing the original file (%s)",async mode=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"openrig-dir-metadata-")),source=path.join(root,"source"),destination=path.join(root,"destination");
  const original=SftpClient.prototype.setTimes;
  const spy=vi.spyOn(SftpClient.prototype,"setTimes").mockImplementation(async function(file,attrs){
    if(mode==="time-noop")return;
    await original.call(this,file,attrs);
    const native=process.platform==="win32"?file.replace(/^\/(?=[A-Za-z]:)/,""):file;
    await rmdir(native);await writeFile(native,"foreign staged entry");
  });
  try{
    await mkdir(source);await utimes(source,1400000000,1400000000);await writeFile(destination,"retain original target");
    const result=await runNativeSftpCopy({src:{kind:"local",path:source},dst:{kind:"remote",path:remote(destination),host:{id:"owned",target:"owned",transport:"ssh"}},dryRun:false},()=>spawn(server,[],{stdio:"pipe",windowsHide:true}));
    expect(result.ok).toBe(false);expect(result.stderr).toContain("SFTP directory metadata was not preserved");
    expect(await readFile(destination,"utf8")).toBe("retain original target");expect(result.hint).toContain("Staging path");
    expect((await readdir(root)).filter(name=>name.startsWith(".openrig-copy-"))).toHaveLength(1);
  }finally{spy.mockRestore();await cleanup(root);}
});

it.skipIf(process.platform==="win32"||!existsSync(server))("rejects a POSIX directory mode setter that only installs timestamps",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"openrig-dir-mode-")),source=path.join(root,"source"),destination=path.join(root,"destination");
  const original=SftpClient.prototype.setTimes;
  const spy=vi.spyOn(SftpClient.prototype,"setTimes").mockImplementation(async function(file,attrs){await original.call(this,file,{atime:attrs.atime,mtime:attrs.mtime});});
  try{
    await mkdir(source);await chmod(source,0o500);await writeFile(destination,"retain original target");
    const result=await runNativeSftpCopy({src:{kind:"local",path:source},dst:{kind:"remote",path:destination,host:{id:"owned",target:"owned",transport:"ssh"}},dryRun:false},()=>spawn(server,[],{stdio:"pipe"}));
    expect(result.ok).toBe(false);expect(result.stderr).toContain("SFTP directory metadata was not preserved");expect(await readFile(destination,"utf8")).toBe("retain original target");
  }finally{spy.mockRestore();await chmod(source,0o700);await cleanup(root);}
});

it.skipIf(process.platform==="win32"||!existsSync(server)).each([false,true])("restores or reports unconfirmed permissions after a failed initial access change (restore ignored=%s)",async ignored=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"openrig-dir-borrow-")),source=path.join(root,"source"),destination=path.join(root,"destination");
  const original=SftpClient.prototype.setTimes;
  const spy=vi.spyOn(SftpClient.prototype,"setTimes").mockImplementation(async function(file,attrs){
    const mode=(attrs.mode??0)&0o7777;
    await original.call(this,file,{...attrs,mode:mode===0o700||ignored?0o040711:attrs.mode});
  });
  try{
    await mkdir(source);await writeFile(path.join(source,"child"),"not published");await mkdir(destination);await chmod(destination,0o500);
    const result=await runNativeSftpCopy({src:{kind:"local",path:source+path.sep},dst:{kind:"remote",path:destination,host:{id:"owned",target:"owned",transport:"ssh"}},dryRun:false},()=>spawn(server,[],{stdio:"pipe"}));
    expect(result.ok).toBe(false);expect(await readdir(destination)).toEqual([]);
    expect((await lstat(destination)).mode&0o7777).toBe(ignored?0o711:0o500);
    expect(result.stderr).toContain(ignored?"original permissions could not be restored":"SFTP directory metadata was not preserved");
  }finally{spy.mockRestore();await chmod(destination,0o700);await cleanup(root);}
});
