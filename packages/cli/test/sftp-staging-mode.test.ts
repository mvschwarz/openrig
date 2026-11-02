import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { mkdtemp, rm, mkdir, chmod, writeFile, readFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import type { CopyPlan } from "../src/lib/file-transfer.js";

const server=process.env.OPENRIG_TEST_SFTP_SERVER ?? '/usr/lib/openssh/sftp-server';
it.skipIf(process.platform==='win32'||!existsSync(server))('creates owner-accessible SFTP staging entries before bytes, independent of server umask',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-staging-mode-'));
  const child=spawn('/bin/sh',['-c','umask 000; exec "$1"','owned-sftp',server],{stdio:'pipe'});
  const client=new SftpClient(child);
  try {
    await client.ready;
    const directory=root+'/directory',file=directory+'/file';
    await client.mkdir(directory);
    expect((await client.lstat(directory))!.mode!&0o777).toBe(0o700);
    await client.write(file,(async function*(){
      // OPEN has completed, but no source bytes have been yielded yet.
      expect((await client.lstat(file))!.mode!&0o777).toBe(0o600);
      yield Buffer.from('owned file contents');
    })());
    expect((await client.lstat(file))!.mode!&0o777).toBe(0o600);
    await client.setTimes(file,{mode:0o640});
    await client.setTimes(directory,{mode:0o750});
    expect((await client.lstat(file))!.mode!&0o777).toBe(0o640);
    expect((await client.lstat(directory))!.mode!&0o777).toBe(0o750);
  }finally{await client.close();await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform==='win32'||!existsSync(server)).each(['upload','download'] as const)('finishes a readonly directory %s after staging its file restrictively',async direction=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-readonly-directory-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination');
  const stagedModes:number[]=[];
  const start=()=>{
    const child=spawn('/bin/sh',['-c','umask 000; exec "$1"','owned-sftp',server],{stdio:'pipe'});
    child.stdout.on('data',()=>{
      if(existsSync(destination))for(const name of readdirSync(destination))if(name.startsWith('.openrig-copy-')){
        try{stagedModes.push(lstatSync(path.join(destination,name)).mode&0o777);}catch{/* rename already completed */}
      }
    });
    return child;
  };
  try{
    await mkdir(source);await writeFile(path.join(source,'file'),'owned bytes');await chmod(path.join(source,'file'),0o640);await chmod(source,0o555);
    const local=(file:string)=>({kind:'local' as const,path:file});
    const remote=(file:string)=>({kind:'remote' as const,path:file,host:{id:'owned',target:'owned',transport:'ssh' as const}});
    const plan:CopyPlan={src:direction==='upload'?local(source):remote(source),dst:direction==='upload'?remote(destination):local(destination),dryRun:false};
    const result=await runNativeSftpCopy(plan,start);expect(result.ok,result.stderr).toBe(true);
    expect(stagedModes[0]).toBe(0o600);
    expect(await readFile(path.join(destination,'file'),'utf8')).toBe('owned bytes');
    expect((await lstat(destination)).mode&0o777).toBe(0o555);
    expect((await lstat(path.join(destination,'file'))).mode&0o777).toBe(0o640);
  }finally{
    await chmod(source,0o700).catch(()=>{});await chmod(destination,0o700).catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});
