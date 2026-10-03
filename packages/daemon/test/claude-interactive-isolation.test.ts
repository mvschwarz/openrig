import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {TmuxAdapter,type TmuxFileOps} from '../src/adapters/tmux.js';
const run=promisify(execFile);
const q=(v:string)=>"'"+v.replaceAll("'","'\"'\"'")+"'";
async function until(f:()=>boolean){for(let i=0;i<240;i++){if(f())return;await new Promise(r=>setTimeout(r,25));}throw Error('private pane did not produce receipt');}
let hasTmux=false;
try{execFileSync('tmux',['-V'],{stdio:'ignore'});hasTmux=true;}catch{/* optional dependency */}
describe.skipIf(!hasTmux || process.platform==='win32')('classic Claude pane-shell isolation',()=>{
it.each(['return','exit','errexit'])('keeps pane environment, lifetime and history after sourced %s',async(kind)=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'claude-isolation-'));const socket=path.join(root,'tmux');const status=path.join(root,'status');const before=path.join(root,'before');const after=path.join(root,'after');const history=path.join(root,'history');const unreachable=path.join(root,'unreachable');
 const env={HOME:root,PATH:process.env.PATH!,TMPDIR:root,TERM:'xterm-256color'};
 const tm=async(args:string[])=>(await run('tmux',['-S',socket,'-f','/dev/null',...args],{env,timeout:8000})).stdout;
 const snapshot=`printf '%s|' "$$" "$FIXTURE_MUTATION" "$OPENRIG_HOME" "$PWD" "$-" "$HISTFILE"`;
 const rc=path.join(root,'bashrc');fs.writeFileSync(history,'prior-history-sentinel\n');
 fs.writeFileSync(rc,`cd ${q(root)}\nexport FIXTURE_MUTATION=parent OPENRIG_HOME=parent-home HISTFILE=${q(history)}\nHISTSIZE=1000\nHISTFILESIZE=1000\nset -o history\nhistory -r\nPS1='FIXTURE> '\n${snapshot} > ${q(before)}\nPROMPT_COMMAND='echo "$?" > ${status}'\n`);
 const writes:Array<{path:string,content:string,mode:number,uid:number}>=[];
 const ops:TmuxFileOps={tmpName:()=>path.join(root,'stage-'+randomUUID()),bufferName:()=>('fixture_'+randomUUID().replaceAll('-','')),writeFile:async(p,c,o)=>{await fs.promises.writeFile(p,c,{encoding:'utf8',...o});const st=fs.statSync(p);writes.push({path:p,content:c,mode:st.mode&0o777,uid:st.uid});},unlink:p=>fs.promises.unlink(p)};
 const transport=new TmuxAdapter(async cmd=>{if(!cmd.startsWith('tmux '))throw Error('unexpected fixture command');return(await run('/bin/sh',['-c',cmd.replace(/^tmux /,`tmux -S ${q(socket)} -f /dev/null `)],{env,timeout:8000})).stdout;},ops);
 try {
  await tm(['new-session','-d','-s','pane','/bin/bash --noprofile --rcfile '+q(rc)+' -i']);await until(()=>fs.existsSync(status)&&fs.existsSync(before));fs.unlinkSync(status);
  const rcInitial=fs.readFileSync(before,'utf8');fs.unlinkSync(before);
  // Capture the real comparison after Bash has finished rc processing. The
  // ordinary-input control allows only Bash's version-dependent stdin flag
  // transition here. The post-launch comparison below is exact, including flags.
  expect(await transport.sendText('pane',`${snapshot} > ${q(before)}`)).toEqual({ok:true});expect(await transport.sendKeys('pane',['Enter'])).toEqual({ok:true});await until(()=>fs.existsSync(before)&&fs.existsSync(status));
  const initial=fs.readFileSync(before,'utf8');const rcFields=rcInitial.split('|');const steadyFields=initial.split('|');
  expect(steadyFields.filter((_,i)=>i!==4)).toEqual(rcFields.filter((_,i)=>i!==4));expect(steadyFields[4]).toContain('i');expect(new Set(steadyFields[4].replace('s',''))).toEqual(new Set(rcFields[4].replace('s','')));
  console.log('CLAUDE_STARTUP_CONTROL='+JSON.stringify({kind,rcOptions:rcFields[4],steadyOptions:steadyFields[4],onlyPossibleStdinFlagDifferenceBeforeStagedLaunch:true}));
  fs.unlinkSync(status);writes.length=0;
  const body='#'+ 'x'.repeat(4096)+String.fromCharCode(10)+`export FIXTURE_MUTATION=child OPENRIG_HOME=child-home; cd /; `+(kind==='exit'?'exit 7':kind==='errexit'?`set -e; false; printf unexpected > ${q(unreachable)}`:':');
  expect(await transport.sendShellCommand('pane',body,undefined,{sourceInPane:true})).toEqual({ok:true});await until(()=>fs.existsSync(status));
  const exit=Number(fs.readFileSync(status,'utf8').trim());expect(exit).toBe(kind==='exit'?7:kind==='errexit'?1:0);expect(fs.existsSync(unreachable)).toBe(false);
  expect(writes).toHaveLength(2);const [script,payload]=writes;expect(Buffer.byteLength(script.content)).toBeGreaterThan(4096);expect(script.mode).toBe(0o600);expect(payload.mode).toBe(0o600);expect(script.uid).toBe(process.getuid!());expect(payload.uid).toBe(process.getuid!());
  expect(payload.content).toBe(`( . ${q(script.path)} )`);expect(Buffer.byteLength(payload.content)).toBeLessThan(512);expect(fs.existsSync(script.path)).toBe(false);expect(fs.existsSync(payload.path)).toBe(false);
  expect(fs.readFileSync(history,'utf8')).toBe('prior-history-sentinel'+String.fromCharCode(10));
  const probe=`${snapshot} > ${q(after)}; history -w`;
  expect(await transport.sendText('pane',probe)).toEqual({ok:true});expect(await transport.sendKeys('pane',['Enter'])).toEqual({ok:true});await until(()=>fs.existsSync(after));await until(()=>fs.readFileSync(history,'utf8').includes('history -w'));
  expect(fs.readFileSync(after,'utf8')).toBe(initial);
  const h=fs.readFileSync(history,'utf8');expect(h).toContain('prior-history-sentinel');expect(h).toContain(payload.content);expect(h).not.toContain('FIXTURE_MUTATION=child');expect(h).not.toContain('child-home');
  console.log('CLAUDE_ISOLATION='+JSON.stringify({kind,exit,sameShellPid:true,environmentUnchanged:true,cwdUnchanged:true,optionsUnchanged:true,historyFileUnchanged:true,priorHistoryPreserved:true,scriptBodyNotInParentHistory:true,scriptBytes:Buffer.byteLength(script.content),typedBytes:Buffer.byteLength(payload.content),scriptMode:script.mode,scriptUid:script.uid,consumedFilesRemoved:true}));
 } finally {await tm(['kill-server']).catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
},30000);

});
