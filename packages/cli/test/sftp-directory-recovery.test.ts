import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import { runNativeSftpCopy } from '../src/lib/native-sftp-copy.js';
const server=process.env.OPENRIG_TEST_SFTP_SERVER??(process.platform==='win32'?path.join(process.env.SystemRoot??'C:/Windows','System32/OpenSSH/sftp-server.exe'):'/usr/lib/openssh/sftp-server');
const proxy=fileURLToPath(new URL('./helpers/sftp-fault-proxy.cjs',import.meta.url));
it.skipIf(!existsSync(server)).each([
  ['backup','deny'],['backup','drop'],['install','deny'],['install','drop'],['install','interfere'],
  ['restore','drop'],['cleanup','drop'],
] as const)('reconciles source-directory replacement faults (%s, %s)',async(phase,action)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-sftp-recovery-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination'),entry=path.join(destination,'directory');
  const remote=(file:string)=>process.platform==='win32'?'/'+file.replaceAll('\\','/'):file;
  try{
    await mkdir(source);await mkdir(destination);await mkdir(path.join(source,'directory'));await writeFile(path.join(source,'directory','child'),'new directory bytes');await writeFile(entry,'original file bytes');
    const spec={server,phase,action,watched:remote(entry),nativeEntry:entry};
    const result=await runNativeSftpCopy({src:{kind:'local',path:source+path.sep},dst:{kind:'remote',path:remote(destination),host:{id:'owned',target:'owned',transport:'ssh'}},dryRun:false},()=>spawn(process.execPath,[proxy,JSON.stringify(spec)],{stdio:'pipe',windowsHide:true}));
    expect(result.ok).toBe(false);expect(result.exitCode).not.toBe(0);
    const names=await readdir(destination),backups=names.filter(name=>name.startsWith('.openrig-replaced-')),stages=names.filter(name=>name.startsWith('.openrig-copy-'));
    if(phase==='restore'){
      expect(await readFile(entry,'utf8')).toBe('original file bytes');expect(backups).toHaveLength(0);expect(stages).toHaveLength(1);expect(result.hint).toContain('existence unconfirmed');
    }else if(phase==='cleanup'){
      expect(await readFile(path.join(entry,'child'),'utf8')).toBe('new directory bytes');expect(backups).toHaveLength(0);expect(stages).toHaveLength(0);expect(result.hint).toContain('existence unconfirmed');
    }else if(phase==='backup'&&action==='deny'||phase==='install'&&action==='deny'){
      expect(await readFile(entry,'utf8')).toBe('original file bytes');expect(backups).toHaveLength(0);expect(stages).toHaveLength(1);
    }else{
      expect(backups).toHaveLength(1);expect(await readFile(path.join(destination,backups[0]!),'utf8')).toBe('original file bytes');expect(result.hint).toContain(backups[0]);
      if(action==='interfere'){expect(await readFile(entry,'utf8')).toBe('foreign writer bytes');expect(stages).toHaveLength(1);}
      else if(phase==='install'){expect((await lstat(entry)).isDirectory()).toBe(true);expect(await readFile(path.join(entry,'child'),'utf8')).toBe('new directory bytes');expect(stages).toHaveLength(0);}
      else{expect(existsSync(entry)).toBe(false);expect(stages).toHaveLength(1);expect(result.hint).toContain('existence unconfirmed');}
    }
    for(const stage of stages)expect(await readFile(path.join(destination,stage,'child'),'utf8')).toBe('new directory bytes');
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});}
},10000);
