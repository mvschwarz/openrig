import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import { windowsTileAttachArgv } from '../src/domain/terminal/windows-tile-attach.js';
import { composeView } from '../src/domain/terminal/view-composer.js';
import {writeWindowsNodeFixture} from '../../../scripts/windows-node-fixture.mjs';

test('Windows local platform never changes a POSIX SSH remote tile command', () => {
 const member={seat:'remote',label:'remote',tmuxSession:'seat@remote',host:'edge',readOnly:true,alive:true};
 const resolveHost=()=>({id:'edge',transport:'ssh',target:'fixture'});
 const native=composeView('v',[member],{resolveHost,localPlatform:'win32',localTmux:'C:/psmux/tmux.exe'});
 const posix=composeView('v',[member],{resolveHost,localPlatform:'linux'});
 assert.equal(native.opened[0].paneCommand,posix.opened[0].paneCommand);
 assert.ok(native.opened[0].paneCommand.includes('/bin/sh'));
});

test.skipIf(process.platform !== 'win32')('native tile preserves identity, argv and bounded replacement following', () => {
 const root=fs.mkdtempSync(join(tmpdir(),'native tile [owned]-'));
 try {
  const source = "import fs from 'node:fs';const a=process.argv.slice(2),mode=process.env.TEST_TILE_MODE;fs.appendFileSync(process.env.TEST_TILE_LOG,JSON.stringify(a)+'\\n');let s=JSON.parse(fs.readFileSync(process.env.TEST_TILE_STATE));const cmd=a[2];if(cmd==='display-message'){if(mode==='initial-missing'||mode==='missing'&&s.attaches.length)process.exit(1);console.log('500 '+(mode==='replacement'&&s.attaches.length?'$2':'$1')+':'+process.env.TEST_TILE_SESSION);}else if(cmd==='show-environment'){if(mode==='unmanaged')process.exit(1);console.log('OPENRIG_NODE_ID='+(mode==='foreign'&&s.attaches.length?'different-node':'original-node'));}else if(cmd==='attach'){s.attaches.push(a.at(-1));fs.writeFileSync(process.env.TEST_TILE_STATE,JSON.stringify(s));}else process.exit(8);";
  const tmux=writeWindowsNodeFixture(root,'tmux',source);
  const session="seat 'quote' \"double\" 中文 %PATH%",server='owned server;# "quote" \\slash\\ 中文\\';
  for(const mode of ['detach','replacement','foreign','missing','unmanaged','initial-missing']) {
   const state=join(root,mode+'.json'),log=join(root,mode+'.jsonl');fs.writeFileSync(state,JSON.stringify({attaches:[]}));
   const argv=windowsTileAttachArgv(tmux,['-L',server],session,mode==='detach',mode==='detach'?4:2);
   const run=spawnSync(argv[0],argv.slice(1),{env:{...process.env,TEST_TILE_MODE:mode,TEST_TILE_STATE:state,TEST_TILE_LOG:log,TEST_TILE_SESSION:session},encoding:'utf8',windowsHide:true,timeout:15000});
   assert.equal(run.status,mode==='foreign'?1:0,mode+': '+run.stderr);
   const attaches=JSON.parse(fs.readFileSync(state,'utf8')).attaches;
   assert.deepEqual(attaches,mode==='replacement'?['$1','$2']:mode==='initial-missing'?['='+session]:['$1'],mode);
   const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
   for(const call of calls)assert.deepEqual(call.slice(0,2),['-L',server],mode);
   for(const call of calls.filter(a=>a[2]==='attach')) {
    if(mode==='detach')assert.deepEqual(call.slice(3,5),['-r','-t']);
    else assert.deepEqual(call.slice(3,6),['-f','ignore-size','-t']);
   }
   if(mode==='foreign')assert.match(run.stdout,/Seat identity changed/);
   if(mode==='missing')assert.match(run.stdout,/No replacement/);
   if(mode==='unmanaged')assert.match(run.stdout,/No managed identity/);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
}, 30000);
