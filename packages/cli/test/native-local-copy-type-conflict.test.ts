import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, lstat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runNativeLocalCopy } from '../src/lib/native-local-copy.js';

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
