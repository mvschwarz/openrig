import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import { windowsTileAttachArgv, windowsSshTileAttachArgv, isWindowsTileAttachArgv } from '../src/domain/terminal/windows-tile-attach.js';
import { buildGridRoot } from '../src/domain/terminal/herdr-adapter.js';
import { buildRexGrid } from '../src/domain/terminal/rex-layout.js';
import { composeView } from '../src/domain/terminal/view-composer.js';
import {writeWindowsNodeFixture} from '../../../scripts/windows-node-fixture.mjs';
import { bindNativeSessionName } from '../src/domain/terminal/native-session-name.js';
import { readWindowsTileAttachArgv } from '../src/domain/terminal/windows-tile-attach.js';
import { powershellQuote } from '../src/adapters/windows-launch.js';

test('mapped view recovery uses the same canonical verified wrapper and rejects altered binding data', () => {
 const logical='owned|logical',binding=bindNativeSessionName(logical);
 const view=composeView('v',[{seat:logical,label:'Logical label',tmuxSession:logical,host:null,readOnly:true,alive:true}],{resolveHost:()=>null,localPlatform:'win32',localTmux:'C:/owned/psmux.exe',localTmuxServer:['-L','owned-home']});
 const pane=view.opened[0],argv=pane.attachArgv!;
 assert.equal(pane.label,'Logical label');
 assert.equal(pane.recoveryCommand,'& '+argv.map(powershellQuote).join(' '));
 assert.equal(readWindowsTileAttachArgv(argv)?.session,logical);
 assert.ok(isWindowsTileAttachArgv(argv));
 const code=Buffer.from(argv[5]!, 'base64').toString('utf16le'),match=code.match(/ '([A-Za-z0-9+/]+={0,2})'$/)!;
 const payload=JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
 assert.equal(payload.nativeBinding.physical,binding.physical);
 payload.nativeBinding.marker='foreign';
 const altered=[...argv];altered[5]=Buffer.from(code.replace(match[1],Buffer.from(JSON.stringify(payload),'utf8').toString('base64')),'utf16le').toString('base64');
 assert.equal(isWindowsTileAttachArgv(altered),false);
});

test.skipIf(process.platform !== 'win32')('native tile returns an attach refusal instead of reporting a later successful detach', () => {
 const root=fs.mkdtempSync(join(tmpdir(),'native tile refusal-'));
 try {
  const log=join(root,'calls.jsonl');
  const tmux=writeWindowsNodeFixture(root,'tmux',"import fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(process.env.TEST_TILE_LOG,JSON.stringify(a)+'\\n');if(a[2]!=='-t'||a[3]!=='=owned')process.exit(9);if(a[4]==='display-message')console.log('500 $1:owned');else if(a[4]==='show-environment')console.log('OPENRIG_NODE_ID=owned-node');else if(a[4]==='attach')process.exit(7);else process.exit(8);");
  const argv=windowsTileAttachArgv(tmux,['-L','owned-server'],'owned',true,2);
  const run=spawnSync(argv[0],argv.slice(1),{env:{...process.env,TEST_TILE_LOG:log},encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(run.status,7,run.stderr);
  assert.match(run.stderr,/Viewer attach failed \(exit 7\)/);
  const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(a=>a[4]),['display-message','show-environment','attach']);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
},15000);

test('Windows local platform never changes a POSIX SSH remote tile command', () => {
 const member={seat:'remote',label:'remote',tmuxSession:'seat@remote',host:'edge',readOnly:true,alive:true};
 const resolveHost=()=>({id:'edge',transport:'ssh',target:'fixture'});
 const native=composeView('v',[member],{resolveHost,localPlatform:'win32',localTmux:'C:/psmux/tmux.exe'});
 const posix=composeView('v',[member],{resolveHost,localPlatform:'linux'});
 assert.equal(native.opened[0].paneCommand,posix.opened[0].paneCommand);
 assert.ok(native.opened[0].paneCommand.includes('/bin/sh'));
 assert.ok(isWindowsTileAttachArgv(native.opened[0].attachArgv!));
 const root=buildGridRoot(native.opened).root;
 assert.equal(root.type,'pane');
 if(root.type==='pane')assert.notEqual(root.command[0],'sh');
 const rex=buildRexGrid(native.opened).root;
 assert.ok('block' in rex);
 if('block' in rex)assert.deepEqual(rex.block.options.command,native.opened[0].attachArgv);
});

test('Rex native grids preserve local argv and use native blank panes', () => {
 const members=Array.from({length:3},(_,i)=>({seat:'local'+i,label:'local'+i,tmuxSession:'local'+i,host:null,readOnly:true,alive:true}));
 const view=composeView('v',members,{resolveHost:()=>null,localPlatform:'win32',localTmux:'C:/owned/psmux.exe'});
 const grid=buildRexGrid(view.opened);
 const leaves:any[]=[];
 const visit=(node:any)=>{if(node.block)leaves.push(node.block);else{visit(node.split.before);visit(node.split.after);}};
 visit(grid.root);
 assert.equal(leaves.length,4);
 for(let i=0;i<3;i++)assert.deepEqual(leaves[i].options.command,view.opened[i].attachArgv);
 assert.deepEqual(leaves[3].options.command,[view.opened[0].attachArgv![0],'-NoLogo','-NoProfile']);
});

test.skipIf(process.platform !== 'win32')('native SSH tile forwards the exact remote command and exit without a local POSIX shell', () => {
 const root=fs.mkdtempSync(join(tmpdir(),'native ssh tile-'));
 try {
  const log=join(root,'argv.json');
  const ssh=writeWindowsNodeFixture(root,'ssh',"import fs from 'node:fs';fs.writeFileSync(process.env.TEST_TILE_LOG,JSON.stringify(process.argv.slice(2)));process.exit(7);");
  const destination="user@host 'quote'", command="/bin/sh -c 'printf \"remote $VALUE\"' # 中文 \\";
  const argv=windowsSshTileAttachArgv(destination,command,ssh);
  assert.ok(isWindowsTileAttachArgv(argv));
  const modified=[...argv];modified[5]=Buffer.from(Buffer.from(argv[5]!, 'base64').toString('utf16le')+'\nWrite-Output forged','utf16le').toString('base64');
  assert.equal(isWindowsTileAttachArgv(modified),false);
  const member={seat:'remote',label:'remote',tmuxSession:'remote',host:'edge',readOnly:true,alive:true};
  const view=composeView('v',[member],{resolveHost:()=>({id:'edge',transport:'ssh',target:'fixture'}),localPlatform:'win32'});
  const grid=buildGridRoot([{...view.opened[0]!,attachArgv:argv}]).root;
  assert.equal(grid.type,'pane'); if(grid.type!=='pane')throw new Error('Expected one tile');
  const rex=buildRexGrid([{...view.opened[0]!,attachArgv:argv}]).root;
  assert.ok('block' in rex);if(!('block' in rex))throw new Error('Expected one Rex tile');
  for(const launch of [grid.command,rex.block.options.command]) {
   const run=spawnSync(launch[0],launch.slice(1),{env:{...process.env,TEST_TILE_LOG:log},encoding:'utf8',windowsHide:true,timeout:10000});
   assert.equal(run.status,7,run.stderr);
   assert.deepEqual(JSON.parse(fs.readFileSync(log,'utf8')),['-t',destination,command]);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
},15000);

test.skipIf(process.platform !== 'win32')('native tile preserves identity, argv and bounded replacement following', () => {
 const root=fs.mkdtempSync(join(tmpdir(),'native tile [owned]-'));
 try {
  const source = "import fs from 'node:fs';const a=process.argv.slice(2),mode=process.env.TEST_TILE_MODE;fs.appendFileSync(process.env.TEST_TILE_LOG,JSON.stringify(a)+'\\n');if(a[2]==='has-session'){if(a[4]!=='='+process.env.TEST_TILE_SESSION)process.exit(9);process.exit(mode==='initial-missing'?1:0);}if(a[2]!=='-t'||a[3]!=='='+process.env.TEST_TILE_SESSION)process.exit(9);let s=JSON.parse(fs.readFileSync(process.env.TEST_TILE_STATE));const cmd=a[4];if(cmd==='show-options'){console.log(mode==='binding-lost'&&s.attaches.length?'wrong-marker':process.env.TEST_TILE_BINDING);}else if(cmd==='display-message'){if(mode==='initial-missing'||mode==='missing'&&s.attaches.length)process.exit(1);console.log('500 '+(mode==='replacement'&&s.attaches.length?'$2':'$1')+':'+process.env.TEST_TILE_SESSION);}else if(cmd==='show-environment'){if(mode==='unmanaged')process.exit(1);console.log('OPENRIG_NODE_ID='+(mode==='foreign'&&s.attaches.length?'different-node':'original-node'));}else if(cmd==='attach'){s.attaches.push(a.at(-1));fs.writeFileSync(process.env.TEST_TILE_STATE,JSON.stringify(s));}else process.exit(8);";
  const tmux=writeWindowsNodeFixture(root,'tmux',source);
  const session="seat 'quote' \"double\" 中文 %PATH%",server='owned server;# "quote" \\slash\\ 中文\\';
  const binding=bindNativeSessionName(session);
  for(const mode of ['detach','single','replacement','foreign','missing','binding-lost','unmanaged','initial-missing']) {
   const state=join(root,mode+'.json'),log=join(root,mode+'.jsonl');fs.writeFileSync(state,JSON.stringify({attaches:[]}));
   const argv=windowsTileAttachArgv(tmux,['-L',server],session,mode==='detach',mode==='detach'?4:2,mode==='single');
   const run=spawnSync(argv[0],argv.slice(1),{env:{...process.env,TEST_TILE_MODE:mode,TEST_TILE_STATE:state,TEST_TILE_LOG:log,TEST_TILE_SESSION:binding.physical,TEST_TILE_BINDING:binding.marker},encoding:'utf8',windowsHide:true,timeout:15000});
   assert.equal(run.status,mode==='foreign'||mode==='initial-missing'?1:0,mode+': '+run.stderr+' calls='+fs.readFileSync(log,'utf8'));
   const attaches=JSON.parse(fs.readFileSync(state,'utf8')).attaches;
   assert.deepEqual(attaches,mode==='replacement'?['$1','$2']:mode==='initial-missing'?[]:['$1'],mode);
   const calls=fs.readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
   if(mode==='single')assert.equal(calls.filter(a=>a[4]==='display-message').length,1);
   for(const call of calls) {
    if(call[2]==='has-session')assert.deepEqual(call,['-L',server,'has-session','-t','='+binding.physical],mode);
    else assert.deepEqual(call.slice(0,4),['-L',server,'-t','='+binding.physical],mode);
   }
   for(const call of calls.filter(a=>a[4]==='attach')) {
    if(mode==='detach')assert.deepEqual(call.slice(5,7),['-r','-t']);
    else assert.deepEqual(call.slice(5,8),['-f','ignore-size','-t']);
   }
   if(mode==='foreign')assert.match(run.stdout,/Seat identity changed/);
   if(mode==='missing')assert.match(run.stdout,/No replacement/);
   if(mode==='unmanaged')assert.match(run.stdout,/No managed identity/);
  }
 } finally {fs.rmSync(root,{recursive:true,force:true});}
}, 30000);
