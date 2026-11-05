import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import { runNativeLocalCopy } from '../src/lib/native-local-copy.js';
import { moveLocalEntryNoReplace } from '../src/lib/local-entry-move.js';

it.each(['refusal','occupied','occupied-directory','lost-backup','lost-install','lost-restore'] as const)('keeps local directory-exchange recovery data (%s)',async mode=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'openrig-local-recovery-'));
  const source=path.join(root,'source'),destination=path.join(root,'destination'),entry=path.join(destination,'directory');
  let injected=false;
  let occupiedInode:number|undefined;
  try{
    await mkdir(source);await mkdir(destination);await mkdir(path.join(source,'directory'));await writeFile(path.join(source,'directory','child'),'new directory bytes');await writeFile(entry,'original bytes');
    const move=async(src:string,dst:string)=>{
      const install=dst===entry&&path.basename(src).startsWith('.openrig-copy-');
      const backup=src===entry&&path.basename(dst).startsWith('.openrig-replaced-');
      const restore=dst===entry&&path.basename(src).startsWith('.openrig-replaced-');
      if(install&&mode==='lost-restore')throw Error('Injected install refusal before lost restore result');
      if(!injected&&install&&mode==='refusal'){injected=true;throw Error('Injected install refusal');}
      if(!injected&&install&&mode==='occupied'){injected=true;await writeFile(entry,'foreign writer bytes',{flag:'wx'});}
      if(!injected&&install&&mode==='occupied-directory'){injected=true;await mkdir(entry);occupiedInode=(await lstat(entry)).ino;}
      await moveLocalEntryNoReplace(src,dst);
      if(!injected&&(backup&&mode==='lost-backup'||install&&mode==='lost-install'||restore&&mode==='lost-restore')){injected=true;throw Error('Injected post-operation failure');}
    };
    const result=await runNativeLocalCopy({src:{kind:'local',path:source+path.sep},dst:{kind:'local',path:destination},dryRun:false},move);
    expect(injected).toBe(true);expect(result.ok).toBe(false);
    const names=await readdir(destination),backups=names.filter(name=>name.startsWith('.openrig-replaced-')),stages=names.filter(name=>name.startsWith('.openrig-copy-'));
    if(mode==='refusal'||mode==='lost-restore'){expect(await readFile(entry,'utf8')).toBe('original bytes');expect(backups).toHaveLength(0);expect(stages).toHaveLength(1);if(mode==='lost-restore')expect(result.hint).toContain('existence unconfirmed');}
    else{
      expect(backups).toHaveLength(1);expect(await readFile(path.join(destination,backups[0]!),'utf8')).toBe('original bytes');expect(result.hint).toContain(backups[0]);
      if(mode==='occupied')expect(await readFile(entry,'utf8')).toBe('foreign writer bytes');
      if(mode==='occupied-directory'){expect((await lstat(entry)).ino).toBe(occupiedInode);expect(await readdir(entry)).toEqual([]);}
      if(mode==='lost-install'){expect(await readFile(path.join(entry,'child'),'utf8')).toBe('new directory bytes');expect(stages).toHaveLength(0);}
      else expect(stages).toHaveLength(1);
    }
    for(const stage of stages)expect(await readFile(path.join(destination,stage,'child'),'utf8')).toBe('new directory bytes');
  }finally{await rm(root,{recursive:true,force:true});}
});
