import { expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, lstatSync } from "node:fs";
import { mkdtemp, rm, mkdir, chmod, writeFile, readFile, lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SftpClient } from "../src/lib/sftp-protocol.js";
import { runNativeSftpCopy } from "../src/lib/native-sftp-copy.js";
import type { CopyPlan } from "../src/lib/file-transfer.js";

const server=process.env.OPENRIG_TEST_SFTP_SERVER ?? '/usr/lib/openssh/sftp-server';
it.skipIf(process.platform==='win32'||!existsSync(server)).each([['upload',false],['upload',true],['download',false],['download',true]] as const)('replaces a file only after directory staging succeeds (%s, failure=%s)',async(direction,fail)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-directory-stage-failure-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination'),entry=destination+'/directory';
  try{
    await mkdir(source);await mkdir(destination);await mkdir(source+'/directory');await writeFile(source+'/directory/a-file','new bytes');
    if(fail)expect(spawnSync('mkfifo',[source+'/directory/z-pipe']).status).toBe(0);await writeFile(entry,'retained original bytes');
    const local=(file:string)=>({kind:'local' as const,path:file});
    const remote=(file:string)=>({kind:'remote' as const,path:file,host:{id:'owned',target:'owned',transport:'ssh' as const}});
    const plan:CopyPlan={src:direction==='upload'?local(source+'/'):remote(source+'/'),dst:direction==='upload'?remote(destination):local(destination),dryRun:false};
    const result=await runNativeSftpCopy(plan,()=>spawn(server,[],{stdio:'pipe'}));expect(result.ok,result.stderr).toBe(!fail);
    if(fail){expect(result.stderr).toContain('Unsupported special file');expect(await readFile(entry,'utf8')).toBe('retained original bytes');expect(result.hint).toContain('Staging path');}
    else expect(await readFile(entry+'/a-file','utf8')).toBe('new bytes');
    expect((await readdir(destination)).some(name=>name.startsWith('.openrig-replaced-'))).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
});
it.skipIf(process.platform==='win32'||!existsSync(server)).each(['upload','download'] as const)('replaces an empty conflicting directory over SFTP (%s)',async direction=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-empty-directory-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination');
  try{
    await mkdir(source);await mkdir(destination);await mkdir(destination+'/file');await writeFile(source+'/file','owned bytes');
    const local=(file:string)=>({kind:'local' as const,path:file});
    const remote=(file:string)=>({kind:'remote' as const,path:file,host:{id:'owned',target:'owned',transport:'ssh' as const}});
    const plan:CopyPlan={src:direction==='upload'?local(source+'/'):remote(source+'/'),dst:direction==='upload'?remote(destination):local(destination),dryRun:false};
    const result=await runNativeSftpCopy(plan,()=>spawn(server,[],{stdio:'pipe'}));expect(result.ok,result.stderr).toBe(true);
    expect(await readFile(destination+'/file','utf8')).toBe('owned bytes');
  }finally{await rm(root,{recursive:true,force:true});}
});
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

it.skipIf(process.platform==='win32'||!existsSync(server)).each([
  ['upload',false],['upload',true],['download',false],['download',true],
] as const)('merges an existing readonly SFTP directory (%s, failure=%s)',async(direction,fail)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-readonly-merge-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination');
  const start=()=>spawn('/bin/sh',['-c','umask 000; exec "$1"','owned-sftp',server],{stdio:'pipe'});
  try{
    await mkdir(source);await mkdir(destination);await writeFile(path.join(source,'file'),'new contents');
    if(fail){await mkdir(path.join(destination,'file'));await writeFile(path.join(destination,'file','retained'),'retain conflict');}else await writeFile(path.join(destination,'retained'),'retain extra');
    await chmod(source,fail?0o750:0o555);await chmod(destination,0o555);
    const local=(file:string)=>({kind:'local' as const,path:file});
    const remote=(file:string)=>({kind:'remote' as const,path:file,host:{id:'owned',target:'owned',transport:'ssh' as const}});
    const plan:CopyPlan={src:direction==='upload'?local(source+'/'):remote(source+'/'),dst:direction==='upload'?remote(destination):local(destination),dryRun:true};
    await runNativeSftpCopy(plan,start);expect((await lstat(destination)).mode&0o777).toBe(0o555);
    const result=await runNativeSftpCopy({...plan,dryRun:false},start);expect(result.ok,result.stderr).toBe(!fail);
    expect((await lstat(destination)).mode&0o777).toBe(fail?0o750:0o555);
    if(fail)expect((await lstat(path.join(destination,'file'))).isDirectory()).toBe(true);
    else{expect(await readFile(path.join(destination,'file'),'utf8')).toBe('new contents');expect(await readFile(path.join(destination,'retained'),'utf8')).toBe('retain extra');}
  }finally{await chmod(source,0o700).catch(()=>{});await chmod(destination,0o700).catch(()=>{});await rm(root,{recursive:true,force:true});}
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
