import {afterEach, expect, it, vi} from 'vitest';
import {Hono} from 'hono';
import {execFileSync} from 'node:child_process';
import {compactionRoutes} from '../src/routes/compaction.js';
import {mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {ClaudeCompactionEnforcer, AUTO_PREP_WAIT_MS_DEFAULT} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';
import {TmuxAdapter} from '../src/adapters/tmux.js';
import {ContextMonitor} from '../src/domain/context-monitor.js';
const seat='writer@demo', input={sessionName:seat,runtime:'claude-code',usedPercentage:90};
const homes:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});
function fixture(manualPrepWaitMs=1000){
 const home=mkdtempSync(join(tmpdir(),'compaction-preparation-'));homes.push(home);
 let clock=10000,generation='generation-one',activity='idle';
 let onSleep:(()=>Promise<void>)|undefined;
 const db={prepare:()=>({get:()=>undefined,all:()=>[]})} as any;
 const writes:string[]=[],keys:string[][]=[];
 const policy={enabled:true,thresholdPercent:80,preCompactInstruction:'Write a restore map.',compactInstruction:'',messageInline:'',messageFilePath:'',postRestoreAuditInstruction:''};
 const tmux={probeSession:vi.fn(async()=>({state:'present'})),sendText:vi.fn(async(_:string,text:string)=>{writes.push(text);return{ok:true};}),sendKeys:vi.fn(async(_:string,k:string[])=>{keys.push(k);return{ok:true};})};
 const guard=new SeatDeliveryGuard(db,()=>({nodeId:'node-one',session:seat,pane:'%1',occupant:generation}));
 Object.assign(tmux,{deliveryGuard:guard});
 const transport=new SessionTransport({db,rigRepo:{} as any,sessionRegistry:{} as any,tmuxAdapter:tmux as any,sleep:async(ms)=>{clock+=ms;},now:()=>new Date(clock),waitForIdlePollMs:5});
 (transport as any).getSessionMeta=()=>({runtime:'claude-code',attachmentType:'tmux',nodeId:'node-one',pane:'%1',occupant:generation,resumeToken:'native-one'});
 (transport as any).claudeDeliveryObservation=async()=>({state:'unknown',detail:'injected process observation'});
 (transport as any).classifySendReadiness=async()=>({state:activity,reason:'fixture',evidenceSource:'fixture'});
 (transport as any).diagnoseProducerLink=async()=> 'fixture';
 const settings={resolveClaudeCompactionPolicy:()=>policy};
 const e=new ClaudeCompactionEnforcer(settings as any,transport,{openrigHome:home,manualPrepWaitMs,now:()=>clock,sleep:async(ms)=>{clock+=ms;await onSleep?.();},resolveOccupantGeneration:()=>generation});
 return{e,transport,tmux,guard,settings,onSleep:(fn:()=>Promise<void>)=>{onSleep=fn;},writes,keys,policy,home,clock:()=>clock,advance:(ms:number)=>{clock+=ms;},generation:(g:string)=>{generation=g;},activity:(s:string)=>{activity=s;}};
}
function publish(f:ReturnType<typeof fixture>,suffix=''){
 const a=f.e.getPreparationState(seat)!;mkdirSync(dirname(a.mapPath),{recursive:true});
 writeFileSync(a.mapPath+'.tmp',`# Restore map\nCurrent work and next step.\n${a.marker}${suffix}\n`);renameSync(a.mapPath+'.tmp',a.mapPath);
}
const compacts=(f:ReturnType<typeof fixture>)=>f.writes.filter(t=>t.startsWith('/compact'));
it('polls wait after delivered prep, ordinary real transport still circulates, exact map releases once',async()=>{
 const f=fixture();expect(AUTO_PREP_WAIT_MS_DEFAULT).toBe(25*60_000);
 await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(0);
 expect(f.e.getPreparationState(seat)).toMatchObject({status:'waiting',delivery:'delivered'});
 await f.transport.send(seat,'ordinary work');expect(f.writes).toContain('ordinary work');
 publish(f);await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(1);
});
it('ignores old maps, wrong-attempt/occupant markers, partial final and staging writes',async()=>{
 const f=fixture();writeFileSync(join(f.home,'RESTORE-MAP-old.md'),'old');await f.e.maybeAutoCompact(input);
 const a=f.e.getPreparationState(seat)!;mkdirSync(dirname(a.mapPath),{recursive:true});
 for(const text of ['partial',a.marker.replace(a.attemptId,'wrong-attempt'),a.marker.replace(a.occupantGeneration!,'wrong-occupant')]){
  writeFileSync(a.mapPath,text);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(0);
 }
 writeFileSync(a.mapPath+'.tmp',`# map\n${a.marker}\n`);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(0);
 renameSync(a.mapPath+'.tmp',a.mapPath);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(1);
});
for(const end of ['expiry','cancel','disable','replacement'])it(`${end} disarms; a late map cannot compact or start automatic prep again`,async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);
 await f.e.maybeAutoCompact({...input,usedPercentage:20});
 if(end==='expiry')f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);
 if(end==='cancel')f.e.cancelPreparation(seat);
 if(end==='disable')f.policy.enabled=false;
 if(end==='replacement')f.generation('generation-two');
 f.e.reconcilePreparations();publish(f);f.policy.enabled=true;
 await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);
 expect(compacts(f)).toHaveLength(0);expect(f.writes).toHaveLength(1);expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
});
it('deadline begins when prep delivery returns, not before its await',async()=>{
 const f=fixture();const original=f.tmux.sendKeys.getMockImplementation()!;f.tmux.sendKeys.mockImplementationOnce(async(...args)=>{f.advance(60000);return original(...args);});
 await f.e.maybeAutoCompact(input);const a=f.e.getPreparationState(seat)!;expect(a.deadlineAt).toBe(f.clock()+AUTO_PREP_WAIT_MS_DEFAULT);
});
it('late successful prep transport completion cannot revive cancellation',async()=>{
 const f=fixture();let release!:()=>void;f.tmux.sendText.mockImplementationOnce(async()=>{await new Promise<void>(r=>release=r);return{ok:true};});
 const pending=f.e.maybeAutoCompact(input);await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 f.e.cancelPreparation(seat);release();await pending;publish(f);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(0);expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
});
it('unanswered manual preparation expires within its original budget and is not latent',async()=>{
 const f=fixture();const r=await f.e.triggerManualCompact(input,{operatorInitiated:true});expect(r).toMatchObject({triggered:false,reason:'preparation_incomplete'});expect(compacts(f)).toHaveLength(0);
 publish(f);await f.e.maybeAutoCompact(input);expect(compacts(f)).toHaveLength(0);
});
it('explicit retry has a fresh attempt; one-use skip bypasses map only',async()=>{
 const f=fixture();await f.e.triggerManualCompact(input,{operatorInitiated:true});const old=f.e.getPreparationState(seat)!.attemptId;
 const r=await f.e.triggerManualCompact(input,{operatorInitiated:true,skipMap:true});expect(r.triggered).toBe(true);expect(f.e.getPreparationState(seat)!.attemptId).not.toBe(old);expect(compacts(f)).toHaveLength(1);
});
it('skip-map still respects a positive permission prompt',async()=>{
 const f=fixture();f.activity('needs_input');const r=await f.e.triggerManualCompact(input,{operatorInitiated:true,skipMap:true});expect(r.triggered).toBe(false);expect(compacts(f)).toHaveLength(0);
});
it('manual map wait holds no input lease: ordinary delivery completes before map publication',async()=>{
 const f=fixture();f.onSleep(async()=>{
  expect(f.guard.ownsLifecycle('node-one')).toBe(false);
  expect((await f.transport.send(seat,'ordinary during preparation')).ok).toBe(true);
  publish(f);
 });
 expect((await f.e.triggerManualCompact(input,{operatorInitiated:true})).triggered).toBe(true);
 expect(f.writes.indexOf('ordinary during preparation')).toBeLessThan(f.writes.findIndex(t=>t.startsWith('/compact')));
 expect(compacts(f)).toHaveLength(1);
});
it('definite prep preflight failures retry boundedly; transport uncertainty never replays',async()=>{
 const f=fixture();const send=vi.spyOn(f.transport,'send');send.mockResolvedValue({ok:false,sessionName:seat,sent:false,reason:'session_missing'});
 for(let i=0;i<5;i++)await f.e.maybeAutoCompact(input);expect(send).toHaveBeenCalledTimes(3);expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
 const g=fixture();const uncertain=vi.spyOn(g.transport,'send').mockRejectedValue(new Error('response lost'));
 for(let i=0;i<4;i++)await g.e.maybeAutoCompact(input);expect(uncertain).toHaveBeenCalledTimes(1);expect(g.e.getPreparationState(seat)?.delivery).toBe('uncertain');
});
it('cancel between compact paste and Enter prevents execution and later replay',async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);publish(f);
 const original=f.tmux.sendText.getMockImplementation()!;f.tmux.sendText.mockImplementationOnce(async(...args)=>{const r=await original(...args);f.e.cancelPreparation(seat);return r;});
 const enters=f.keys.length;await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);expect(f.keys).toHaveLength(enters);expect(compacts(f)).toHaveLength(1);
});
it('existing context poll reconciles expiry even with no fresh usage',async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);
 const monitor=new ContextMonitor({prepare:()=>({all:()=>[]})} as any,{} as any,undefined,f.e);await monitor.pollOnce();expect(f.e.getPreparationState(seat)?.status).toBe('stopped');expect(compacts(f)).toHaveLength(0);
});

for(const mapBeforeRise of [true,false])it(`threshold dip retains the same attempt and deadline (map before rise: ${mapBeforeRise})`,async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);const original=f.e.getPreparationState(seat)!;
 f.advance(1000);await f.e.maybeAutoCompact({...input,usedPercentage:20});
 expect(f.e.getPreparationState(seat)).toMatchObject({attemptId:original.attemptId,deadlineAt:original.deadlineAt,status:'waiting'});
 if(mapBeforeRise)publish(f);
 await f.e.maybeAutoCompact(input);
 if(!mapBeforeRise){expect(compacts(f)).toHaveLength(0);expect(f.writes).toHaveLength(1);publish(f);await f.e.maybeAutoCompact(input);}
 await f.e.maybeAutoCompact(input);
 expect(f.e.getPreparationState(seat)).toMatchObject({attemptId:original.attemptId,deadlineAt:original.deadlineAt,status:'compact-sent'});
 expect(f.writes.filter(t=>!t.startsWith('/compact'))).toHaveLength(1);expect(compacts(f)).toHaveLength(1);
});
for(const boundary of ['writeFile','load-buffer','key-list'])it(`actual tmux adapter checks cancellation after ${boundary} await`,async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);publish(f);
 const commands:string[][]=[];let pasted=false,unlinked=false;
 const adapter=new TmuxAdapter(async()=>{throw new Error('unexpected shell execution');},{
  writeFile:async()=>{if(boundary==='writeFile')f.e.cancelPreparation(seat);},
  unlink:async()=>{unlinked=true;},tmpName:()=>'/tmp/injected-payload',bufferName:()=> 'injected-buffer',
 },async argv=>{
  commands.push(argv);
  if(argv[1]==='list-panes'){
   if(pasted && boundary==='key-list')f.e.cancelPreparation(seat);
   return '%1|0|/tmp|80|24|1';
  }
  if(argv[1]==='load-buffer' && boundary==='load-buffer')f.e.cancelPreparation(seat);
  if(argv[1]==='paste-buffer')pasted=true;
  return '';
 });
 adapter.deliveryGuard=f.guard;(f.transport as any).tmuxAdapter=adapter;
 await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);
 expect(commands.filter(c=>c[1]==='paste-buffer')).toHaveLength(boundary==='key-list'?1:0);
 expect(commands.filter(c=>c[1]==='send-keys')).toHaveLength(0);
 expect(unlinked).toBe(true);expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
});

it('late completion of cancelled manual request cannot overwrite an explicit retry',async()=>{
 const f=fixture();const original=f.tmux.sendKeys.getMockImplementation()!;
 f.tmux.sendKeys.mockImplementationOnce(async(...args)=>{publish(f);return original(...args);});
 let release!:(value:any)=>void;
 vi.spyOn(f.transport,'waitUntilIdle').mockImplementationOnce(()=>new Promise(r=>{release=r;}));
 const old=f.e.triggerManualCompact(input,{operatorInitiated:true});
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
 const oldId=f.e.getPreparationState(seat)!.attemptId;
 f.e.cancelPreparation(seat);
 expect((await f.e.triggerManualCompact(input,{operatorInitiated:true,skipMap:true})).triggered).toBe(true);
 release({ok:true});const oldResult=await old;expect(oldResult.triggered).toBe(false);
 if(!oldResult.triggered)expect(oldResult.preparation).toMatchObject({attemptId:oldId,delivery:'delivered'});
 expect(f.e.getPreparationState(seat)).toMatchObject({status:'compact-sent'});
 expect(f.e.getPreparationState(seat)!.attemptId).not.toBe(oldId);
 expect(f.e.getManualCompactionState(seat)?.stage).toBe('compact-sent');
});

it('uncertain compact receipt never replays an already submitted command',async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);publish(f);
 const send=f.transport.send.bind(f.transport);
 vi.spyOn(f.transport,'send').mockImplementationOnce(async(...args)=>{await send(...args);throw new Error('receipt lost after input');});
 await f.e.maybeAutoCompact(input);f.advance(60_001);
 await f.e.maybeAutoCompact(input);await f.e.maybeAutoCompact(input);
 expect(compacts(f)).toHaveLength(1);expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
});

it('skip-map cannot bypass typing guard or a changed occupant',async()=>{
 for(const change of ['guard','occupant']){
  const f=fixture();const original=f.transport.waitUntilIdle.bind(f.transport);
  vi.spyOn(f.transport,'waitUntilIdle').mockImplementationOnce(async(...args)=>{
   const r=await original(...args);
   if(change==='guard')vi.spyOn(f.guard,'preference').mockReturnValue({nodeId:'node-one',desired:true,effective:true,pending:false});
   else f.generation('generation-two');
   return r;
  });
  const result=await f.e.triggerManualCompact(input,{operatorInitiated:true,skipMap:true});
  expect(result.triggered).toBe(false);expect(compacts(f)).toHaveLength(0);
  expect(result).toMatchObject({reason:change==='guard'?'typing_guard_enabled':'stale_generation'});
 }
});

it('a post-paste recipient conflict or unclassified transport failure does not replay prep',async()=>{
 for(const failure of [
  {ok:false,sessionName:seat,reason:'target_runtime_conflict',sent:true},
  {ok:false,sessionName:seat,reason:'guard_unavailable',sent:false},
 ]){
  const f=fixture();const send=vi.spyOn(f.transport,'send').mockResolvedValue(failure);
  for(let i=0;i<4;i++)await f.e.maybeAutoCompact(input);
  expect(send).toHaveBeenCalledTimes(1);
  expect(f.e.getPreparationState(seat)?.delivery).toBe('uncertain');
 }
});

it('manual started while auto was off still disarms on a subsequently observed disable',async()=>{
 const f=fixture();f.policy.enabled=false;
 f.onSleep(async()=>{
  f.policy.enabled=true;f.e.reconcilePreparations();
  f.policy.enabled=false;f.e.reconcilePreparations();publish(f);
 });
 expect(await f.e.triggerManualCompact(input,{operatorInitiated:true})).toMatchObject({triggered:false,reason:'disabled'});
 f.policy.enabled=true;await f.e.maybeAutoCompact(input);
 expect(compacts(f)).toHaveLength(0);expect(f.writes).toHaveLength(1);
});


it('manual preparation names the request and its existing UTC deadline, including time already spent',async()=>{
 const f=fixture(120_000);
 // Policy resolution consumes part of the already-started manual budget.
 vi.spyOn(f.settings,'resolveClaudeCompactionPolicy').mockImplementationOnce(()=>{f.advance(250);return f.policy;});
 const keys=f.tmux.sendKeys.getMockImplementation()!;
 f.tmux.sendKeys.mockImplementationOnce(async(...args)=>{f.advance(10_000);return keys(...args);});
 f.onSleep(async()=>{publish(f);});
 expect((await f.e.triggerManualCompact({...input,usedPercentage:4},{operatorInitiated:true})).triggered).toBe(true);
 const prompt=f.writes[0]!;
 expect(prompt).toContain('OpenRig manual compaction was requested');
 expect(prompt).not.toMatch(/automatic/i);
 expect(prompt).not.toContain('configured compaction threshold');
 expect(prompt).toContain('does not depend on the context threshold');
 expect(prompt).toContain('1970-01-01T00:02:10.000Z');
 expect(prompt).toContain('119750 ms remaining when this request was constructed');
 expect(prompt).toContain('not guaranteed remaining on receipt');
 expect(prompt).toContain('Delivery time, writing the complete restore map, and becoming idle share this deadline');
 expect(f.e.getPreparationState(seat)?.deadlineAt).toBe(130_000);
 expect(compacts(f)).toHaveLength(1);
});

it('automatic preparation gives the post-delivery ceiling without a fabricated pre-send deadline',async()=>{
 const f=fixture();const keys=f.tmux.sendKeys.getMockImplementation()!;
 f.tmux.sendKeys.mockImplementationOnce(async(...args)=>{f.advance(60_000);return keys(...args);});
 await f.e.maybeAutoCompact(input);
 const prompt=f.writes[0]!;
 expect(prompt).toContain('OpenRig automatic compaction preparation is now required');
 expect(prompt).toContain('Current context usage is 90%; configured compaction threshold is 80%');
 expect(prompt).toContain('25-minute ceiling starts after preparation delivery returns');
 expect(prompt).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
 expect(f.e.getPreparationState(seat)?.deadlineAt).toBe(f.clock()+AUTO_PREP_WAIT_MS_DEFAULT);
 expect(prompt).toContain('Keep the normal ranked restore-map content');
 expect(prompt).toContain('atomically rename');
 expect(prompt).toContain(f.e.getPreparationState(seat)!.marker);
});

for(const expiry of ['missing map','idle after completed map'])it(`route reports incomplete preparation on ${expiry} expiry`,async()=>{
 const f=fixture();
 if(expiry==='idle after completed map')f.onSleep(async()=>{publish(f);f.activity('busy');});
 vi.spyOn(f.transport,'resolveSessions').mockResolvedValue({ok:true,sessions:[seat]} as any);
 const app=new Hono();
 app.use('*',async(c,next)=>{
  c.set('compactionEnforcer' as never,f.e);
  c.set('sessionTransport' as never,f.transport);
  c.set('contextUsageStore' as never,{getForNode:()=>({availability:'known',usedPercentage:4})});
  c.set('db' as never,{prepare:()=>({get:()=>({node_id:'node-one',runtime:'claude-code'})})});
  await next();
 });
 app.route('/api/compaction',compactionRoutes());
 const response=await app.request('/api/compaction/trigger',{
  method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:seat}),
 });
 const body=await response.json();
 expect(response.status).toBe(409);
 expect(body.reason).toBe('preparation_incomplete');
 expect(body.error).toContain('Preparation (restore map and idle wait) did not finish in time');
 expect(body.error).not.toContain('restore map was not completed');
 expect(body.error).toContain('managed compaction is disarmed');
 expect(f.e.getPreparationState(seat)?.status).toBe('stopped');
 expect(compacts(f)).toHaveLength(0);
});

function routeFixture(f:ReturnType<typeof fixture>, cwd?:string){
 vi.spyOn(f.transport,'resolveSessions').mockResolvedValue({ok:true,sessions:[seat]} as any);
 const app=new Hono();
 app.use('*',async(c,next)=>{
  c.set('compactionEnforcer' as never,f.e);
  c.set('sessionTransport' as never,f.transport);
  c.set('contextUsageStore' as never,{getForNode:()=>({availability:'known',usedPercentage:4})});
  c.set('db' as never,{prepare:()=>({get:()=>({node_id:'node-one',runtime:'claude-code',cwd})})});
  await next();
 });
 app.route('/api/compaction',compactionRoutes());
 return ()=>app.request('/api/compaction/trigger',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session:seat})});
}

it('preparation receipt: later permission refusal discloses the delivered prep and its exact attempt',async()=>{
 const f=fixture();f.onSleep(async()=>{publish(f);f.activity('needs_input');});
 const res=await routeFixture(f)();const body=await res.json();
 expect(res.status).toBe(409);expect(body.reason).toBe('target_needs_input');
 expect(body.preparation).toMatchObject({attemptId:f.e.getPreparationState(seat)!.attemptId,delivery:'delivered'});
 expect(body.error).toContain('Preparation was sent');expect(body.error).not.toContain('could not be sent');
 expect(body.error).toContain('disarmed');expect(compacts(f)).toHaveLength(0);expect(f.writes).toHaveLength(1);
});
it('preparation receipt: lost send reply is uncertainty, not an unsent refusal',async()=>{
 const f=fixture();vi.spyOn(f.transport,'send').mockRejectedValueOnce(new Error('receipt lost'));
 const body=await (await routeFixture(f)()).json();
 expect(body.preparation.delivery).toBe('uncertain');expect(body.error).toContain('may have reached');
 expect(body.error).not.toContain('Preparation was sent');expect(compacts(f)).toHaveLength(0);
});
it('preparation receipt: positive permission prompt before prep is an unsent refusal',async()=>{
 const f=fixture();f.activity('needs_input');
 const body=await (await routeFixture(f)()).json();
 expect(body.preparation.delivery).toBe('not_sent');expect(body.error).toContain('could not be sent');
 expect(f.writes).toHaveLength(0);
});
it('registered cwd: manual route selects a self-ignoring map inside the launch workspace',async()=>{
 const f=fixture();const cwd=join(f.home,'code repo');mkdirSync(cwd);
 execFileSync('git',['-c','init.templateDir=','init','--quiet',cwd]);
 f.onSleep(async()=>{publish(f);});
 expect((await routeFixture(f,cwd)()).status).toBe(200);
 const a=f.e.getPreparationState(seat)!;
 expect(a.mapPath).toBe(join(cwd,'.openrig','compaction','preparation',seat,a.attemptId,'RESTORE-MAP.md'));
 expect(readFileSync(join(cwd,'.openrig','compaction','.gitignore'),'utf8')).toBe('*\n');
 expect(f.writes[0]).toContain(JSON.stringify(a.mapPath));expect(compacts(f)).toHaveLength(1);
 // The map and the ignore file itself stay out of an ordinary git add -A.
 execFileSync('git',['-C',cwd,'add','-A']);
 expect(execFileSync('git',['-C',cwd,'ls-files'],{encoding:'utf8'})).toBe('');
});
it('registered cwd: automatic monitor forwards the launch workspace and isolates sibling maps',async()=>{
 const f=fixture();const cwd=join(f.home,'code repo');mkdirSync(cwd);
 const usage={availability:'known',fresh:true,usedPercentage:90};
 const db={prepare:()=>({all:()=>[{node_id:'node-one',session_id:1,session_name:seat,runtime:'claude-code',cwd,startup_status:'ready'}]})};
 const store={readAndNormalize:()=>usage,persist:()=>{}};
 const monitor=new ContextMonitor(db as any,store as any,undefined,f.e);
 await monitor.pollOnce();
 const a=f.e.getPreparationState(seat)!;
 expect(a.mapPath).toBe(join(cwd,'.openrig','compaction','preparation',seat,a.attemptId,'RESTORE-MAP.md'));
 await f.e.maybeAutoCompact({...input,sessionName:'sibling@demo',cwd} as any);
 const b=f.e.getPreparationState('sibling@demo')!;
 expect(b.mapPath).not.toBe(a.mapPath);expect(compacts(f)).toHaveLength(0);
});
it('registered cwd: absent, relative or unwritable cwd preserves the legacy map location',async()=>{
 for(const cwd of [undefined,'relative',join('/dev/null','unwritable')]){
  const f=fixture();await f.e.maybeAutoCompact({...input,cwd} as any);
  expect(f.e.getPreparationState(seat)!.mapPath).toBe(join(f.home,'compaction','preparation',seat,f.e.getPreparationState(seat)!.attemptId,'RESTORE-MAP.md'));
  expect(f.writes).toHaveLength(1);
 }
});

it('preparation contract: prompt qualifies later refusal and the shipped skill follows its named map',async()=>{
 const f=fixture();await f.e.maybeAutoCompact(input);
 expect(f.writes[0]).toContain('This preparation turn does not guarantee /compact');
 const skill=readFileSync(new URL('../assets/plugins/openrig-core/skills/claude-compaction-restore/SKILL.md',import.meta.url),'utf8');
 expect(skill).toContain('exact path named in OpenRig');
 expect(skill).toContain('Do not substitute the seat folder');
 expect(skill).toContain('Only when none names a path');
});

it('preparation receipt: unknown activity at the final short send is not an unsent refusal',async()=>{
 const f=fixture(10_000);f.onSleep(async()=>{publish(f);});
 const wait=f.transport.waitUntilIdle.bind(f.transport);
 vi.spyOn(f.transport,'waitUntilIdle').mockImplementationOnce(async(...args)=>{
  const result=await wait(...args);f.activity('unknown');return result;
 });
 const body=await (await routeFixture(f)()).json();
 expect(body.reason).toBe('target_activity_unknown');
 expect(body.preparation.delivery).toBe('delivered');expect(body.error).toContain('Preparation was sent');
 expect(body.error).not.toContain('Refused:');expect(compacts(f)).toHaveLength(0);expect(f.writes).toHaveLength(1);
});
