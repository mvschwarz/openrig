import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm, readdir, chmod, link } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNativeLocalCopy } from '../src/lib/native-local-copy.js';
import { spawnSync } from 'node:child_process';

it.each([['file',false],['file',true],['link',false],['link',true]] as const)('replaces only an empty directory with a %s (nonempty=%s)',async(type,nonempty)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-copy-types-'));
  const src=path.join(root,'source'),dst=path.join(root,'destination'),entry=path.join(dst,'file');
  try{
    await mkdir(src);await mkdir(dst);await mkdir(entry);
    if(type==='file')await writeFile(path.join(src,'file'),'new bytes');
    else{await writeFile(path.join(src,'target'),'new bytes');await symlink('target',path.join(src,'file'),'file');}
    if(nonempty)await writeFile(path.join(entry,'retained'),'retain data');
    const plan={src:{kind:'local' as const,path:src+path.sep},dst:{kind:'local' as const,path:dst},dryRun:true};
    await runNativeLocalCopy(plan);expect((await lstat(entry)).isDirectory()).toBe(true);
    const result=await runNativeLocalCopy({...plan,dryRun:false});expect(result.ok,result.stderr).toBe(!nonempty);
    if(nonempty)expect(await readFile(path.join(entry,'retained'),'utf8')).toBe('retain data');
    else{expect((await lstat(entry)).isSymbolicLink()).toBe(type==='link');expect(await readFile(entry,'utf8')).toBe('new bytes');}
  }finally{await rm(root,{recursive:true,force:true});}
});

it.skipIf(process.platform==='win32')('keeps the original file if directory staging encounters an unsupported child',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-copy-directory-stage-failure-'));
  const src=path.join(root,'source'),dst=path.join(root,'destination'),entry=path.join(dst,'directory');
  try{
    await mkdir(src);await mkdir(dst);await mkdir(path.join(src,'directory'));await writeFile(path.join(src,'directory','a-file'),'new bytes');
    expect(spawnSync('mkfifo',[path.join(src,'directory','z-pipe')]).status).toBe(0);await writeFile(entry,'retained original bytes');
    const result=await runNativeLocalCopy({src:{kind:'local',path:src+path.sep},dst:{kind:'local',path:dst},dryRun:false});
    expect(result.ok).toBe(false);expect(result.stderr).toContain('Unsupported special file');
    expect(await readFile(entry,'utf8')).toBe('retained original bytes');expect(result.hint).toContain('Staging path');
    expect((await readdir(dst)).some(name=>name.startsWith('.openrig-replaced-'))).toBe(false);
  }finally{await rm(root,{recursive:true,force:true});}
});

it.each(['file','readonly-file','file-link','directory-link'] as const)('replaces a %s with a staged source directory without following links',async type=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-copy-directory-over-file-'));
  const src=path.join(root,'source'),dst=path.join(root,'destination'),entry=path.join(dst,'directory'),referent=path.join(root,'referent');
  try{
    await mkdir(src);await mkdir(dst);await mkdir(path.join(src,'directory'));await writeFile(path.join(src,'directory','child'),'new bytes');
    if(type==='directory-link'){await mkdir(referent);await writeFile(path.join(referent,'retained'),'retain referent');await symlink(referent,entry,'dir');}
    else if(type==='file-link'){await writeFile(referent,'retain referent');await symlink(referent,entry,'file');}
    else{await writeFile(entry,'old bytes');if(type==='readonly-file'){await link(entry,referent);await chmod(entry,0o444);}}
    const plan={src:{kind:'local' as const,path:src+path.sep},dst:{kind:'local' as const,path:dst},dryRun:true};
    const preview=await runNativeLocalCopy(plan);expect(preview.ok,preview.stderr).toBe(true);expect((await lstat(entry)).isDirectory()).toBe(false);
    expect(preview.stdout).not.toContain('.openrig-copy-');
    const result=await runNativeLocalCopy({...plan,dryRun:false});expect(result.ok,result.stderr).toBe(true);
    expect((await lstat(entry)).isDirectory()).toBe(true);expect(await readFile(path.join(entry,'child'),'utf8')).toBe('new bytes');
    expect(result.stdout).not.toContain('.openrig-copy-');expect((await readdir(dst)).some(name=>name.startsWith('.openrig-'))).toBe(false);
    if(type==='directory-link')expect(await readFile(path.join(referent,'retained'),'utf8')).toBe('retain referent');
    if(type==='file-link')expect(await readFile(referent,'utf8')).toBe('retain referent');
    if(type==='readonly-file'){expect(await readFile(referent,'utf8')).toBe('old bytes');expect((await lstat(referent)).mode&0o200).toBe(0);await chmod(referent,0o600);}
  }finally{await rm(root,{recursive:true,force:true});}
});
