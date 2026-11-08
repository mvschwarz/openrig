// A daemon restart in the middle of a managed compaction: the restarted daemon (a second enforcer over the same instance
// home and seat) picks the attempt up from the record beside its map, as the context monitor reaches it.
import {afterEach, expect, it, vi} from 'vitest';
import {mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {ClaudeCompactionEnforcer, AUTO_PREP_WAIT_MS_DEFAULT, AUTO_RETRY_AFTER_STOP_MS_DEFAULT, RESTART_RECOVERY_WINDOW_MS_DEFAULT, buildPostCompactTurnBoundaryPrompt} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';
import {compactionRoutes} from '../src/routes/compaction.js';

const seat='writer@demo', high={sessionName:seat,runtime:'claude-code',usedPercentage:90};
const homes:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});

function fixture(){
 const home=mkdtempSync(join(tmpdir(),'compaction-restart-'));homes.push(home);
 let clock=10000,generation='generation-one';
 // Transport deadlines and the enforcer's injected sleeps must share the fixture clock.
 vi.spyOn(Date, 'now').mockImplementation(()=>clock);
 const db={prepare:()=>({get:()=>undefined,all:()=>[]})} as any;
 const writes:string[]=[];
 // onWrite sees each text as it is written; busy holds the seat non-idle; failCompact loses a /compact's result; box is
 // what the seat's input box reads.
 const hooks:{onWrite?:(text:string)=>void;busy?:boolean;failCompact?:boolean;box?:string}={};
 const policy={preparationRoot:'',enabled:true,thresholdPercent:80,preCompactInstruction:'Write a restore map.',compactInstruction:'',messageInline:'',messageFilePath:'',postRestoreAuditInstruction:''};
 const tmux={probeSession:vi.fn(async()=>({state:'present'})),sendKeys:vi.fn(async()=>({ok:true})),sendText:vi.fn(async(_:string,text:string)=>{
  writes.push(text);hooks.onWrite?.(text);
  return hooks.failCompact&&text.startsWith('/compact')?{ok:false,code:'tmux_error',message:'the result was lost'}:{ok:true};
 })};
 const guard=new SeatDeliveryGuard(db,()=>({nodeId:'node-one',session:seat,pane:'%1',occupant:generation}));
 Object.assign(tmux,{deliveryGuard:guard});
 const transport=new SessionTransport({db,rigRepo:{} as any,sessionRegistry:{} as any,tmuxAdapter:tmux as any,sleep:async(ms)=>{clock+=ms;},now:()=>new Date(clock),waitForIdlePollMs:5});
 (transport as any).getSessionMeta=()=>({runtime:'claude-code',attachmentType:'tmux',nodeId:'node-one',pane:'%1',occupant:generation,resumeToken:'native-one'});
 (transport as any).claudeDeliveryObservation=async()=>({state:'unknown',detail:'injected process observation'});
 (transport as any).classifySendReadiness=async()=>({state:hooks.busy?'running':'idle',reason:'fixture',evidenceSource:'fixture'});
 (transport as any).diagnoseProducerLink=async()=>'fixture';
 (transport as any).capture=async()=>({ok:true,sessionName:seat,content:'',inputBox:{status:hooks.box??'empty'}});
 const settings={resolveClaudeCompactionPolicy:()=>policy};
 // A daemon process: a new one shares the instance home, the seat and the clock, and nothing held in memory.
 const daemon=(instance=randomUUID(),options:NonNullable<ConstructorParameters<typeof ClaudeCompactionEnforcer>[2]>={})=>new ClaudeCompactionEnforcer(settings as any,transport,{openrigHome:home,daemonInstance:instance,now:()=>clock,sleep:async(ms)=>{clock+=ms;},resolveOccupantGeneration:()=>generation,...options});
 return{daemon,writes,policy,hooks,transport,home,now:()=>clock,advance:(ms:number)=>{clock+=ms;},generation:(g:string)=>{generation=g;}};
}
type F=ReturnType<typeof fixture>;
const compacts=(f:F)=>f.writes.filter(t=>t.startsWith('/compact'));
const prepPrompts=(f:F)=>f.writes.filter(t=>t.includes('Write a restore map.'));
const boundaries=(f:F)=>f.writes.filter(t=>t===buildPostCompactTurnBoundaryPrompt());
const restores=(f:F)=>f.writes.filter(t=>t.includes('restoring this Claude session after compaction'));
const audits=(f:F)=>f.writes.filter(t=>t.startsWith('Now audit your compaction restore'));
const recordFile=(e:ClaudeCompactionEnforcer)=>join(dirname(e.getPreparationState(seat)!.mapPath),'COMPACTION-STATE.json');
function completeMap(e:ClaudeCompactionEnforcer){
 const a=e.getPreparationState(seat)!;mkdirSync(dirname(a.mapPath),{recursive:true});
 writeFileSync(a.mapPath+'.tmp',`# Restore map\nCurrent work and next step.\n${a.marker}\n`);
 return a;
}
/** What the context monitor does for a seat whose sample is stale (an idle seat after /compact). */
async function staleTick(e:ClaudeCompactionEnforcer){
 if(e.hasPendingPostCompactStage(seat,{cwd:null,runtime:'claude-code'}))await e.drainPendingPostCompactStage({sessionName:seat,runtime:'claude-code'});
}
/** What rig compact --state returns for the seat, read through the route. */
async function stateOf(e:ClaudeCompactionEnforcer){
 const app=new Hono();
 app.use('*',async(c,next)=>{
  c.set('compactionEnforcer' as never,e);
  c.set('db' as never,{prepare:()=>({get:()=>({node_id:'node-one',runtime:'claude-code',cwd:null})})});
  await next();
 });
 app.route('/api/compaction',compactionRoutes());
 return(await app.request(`/api/compaction/state?session=${encodeURIComponent(seat)}`)).json();
}
async function compactedBy(f:F){
 const e=f.daemon();await e.maybeAutoCompact(high);completeMap(e);await e.maybeAutoCompact(high);
 expect(compacts(f)).toHaveLength(1);
 return e;
}

it('a restart after /compact still delivers the turn boundary, the restore request and the audit, with no second /compact',async()=>{
 const f=fixture();await compactedBy(f);
 const restarted=f.daemon();
 for(let i=0;i<4;i++)await staleTick(restarted);
 // What the seat receives first: the restore steps its predecessor owed.
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(audits(f)).toHaveLength(1);
 expect(compacts(f)).toHaveLength(1);
 expect(restarted.hasPendingPostCompactStage(seat,{cwd:null,runtime:'claude-code'})).toBe(false);
 // The record says it's done, so a further restart owes nothing.
 const again=f.daemon();await staleTick(again);expect(boundaries(f)).toHaveLength(1);
});

it('after a restart, rig compact --state shows an owed restore at first look, before any poll',async()=>{
 const f=fixture();await compactedBy(f);
 const restarted=f.daemon();
 expect((await stateOf(restarted)).owedRestore).toMatchObject({stage:'turn_boundary',held:false});
});

it('a restart between the turn boundary and the restore request resumes at the restore request',async()=>{
 const f=fixture();const first=await compactedBy(f);await staleTick(first);expect(boundaries(f)).toHaveLength(1);
 const restarted=f.daemon();await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);
});

it('a restart during an open preparation waits on it: no second preparation prompt, and the first map compacts once',async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);
 expect(prepPrompts(f)).toHaveLength(1);
 const attempt=first.getPreparationState(seat)!;
 const restarted=f.daemon();await restarted.maybeAutoCompact(high);await restarted.maybeAutoCompact(high);
 // What the seat receives first: no second request to write a map.
 expect(prepPrompts(f)).toHaveLength(1);
 expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:attempt.attemptId,status:'waiting'});
 completeMap(restarted);await restarted.maybeAutoCompact(high);
 expect(compacts(f)).toHaveLength(1);
});

it('a restart while a preparation retry is being written never sends that prompt again',async()=>{
 const f=fixture();const first=f.daemon();
 const send=f.transport.send.bind(f.transport);let refuse=true;
 // The first send is refused before any input, so the next poll retries it.
 vi.spyOn(f.transport,'send').mockImplementation(async(...args)=>{
  if(refuse){refuse=false;return{ok:false,sessionName:seat,sent:false,reason:'session_missing'} as any;}
  return send(...args);
 });
 await first.maybeAutoCompact(high);expect(prepPrompts(f)).toHaveLength(0);
 const record=recordFile(first);let atWrite='';
 f.hooks.onWrite=()=>{atWrite=readFileSync(record,'utf8');};
 await first.maybeAutoCompact(high);expect(prepPrompts(f)).toHaveLength(1);
 // The first daemon stopped as the retry's text was written: its record is as it stood then.
 writeFileSync(record,atWrite);
 const restarted=f.daemon();await restarted.maybeAutoCompact(high);await restarted.maybeAutoCompact(high);
 expect(prepPrompts(f)).toHaveLength(1);
});

it('a restart while /compact was being sent never sends it again, and still owes the restore steps',async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);
 const attempt=completeMap(first);
 // The first daemon published the map and began the send, then stopped before the result came back.
 renameSync(attempt.mapPath+'.tmp',attempt.mapPath);
 const record=join(dirname(attempt.mapPath),'COMPACTION-STATE.json');
 writeFileSync(record,JSON.stringify({...JSON.parse(readFileSync(record,'utf8')),compactSending:true}));
 const restarted=f.daemon();await staleTick(restarted);await restarted.maybeAutoCompact(high);
 expect(compacts(f)).toHaveLength(0);expect(boundaries(f)).toHaveLength(1);
});

it('a restart after a /compact whose result was lost owes its restore steps, and neither prepares nor compacts again',async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);completeMap(first);
 f.hooks.failCompact=true;await first.maybeAutoCompact(high);f.hooks.failCompact=false;
 expect(compacts(f)).toHaveLength(1);expect(first.getPreparationState(seat)).toMatchObject({status:'stopped',compact:'uncertain'});
 const restarted=f.daemon();await restarted.maybeAutoCompact(high);
 // What the seat receives first: the restore steps, not a second request to write a map.
 expect(prepPrompts(f)).toHaveLength(1);
 for(let i=0;i<3;i++)await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(compacts(f)).toHaveLength(1);
});

it('without a restart, a /compact whose result was lost gets its restore steps, and the stopped attempt is then cleared',async()=>{
 const f=fixture();const e=f.daemon();await e.maybeAutoCompact(high);completeMap(e);
 f.hooks.failCompact=true;await e.maybeAutoCompact(high);f.hooks.failCompact=false;
 expect(e.getPreparationState(seat)).toMatchObject({status:'stopped',compact:'uncertain'});
 for(let i=0;i<3;i++)await staleTick(e);
 // What the seat receives: the restore steps, with no second /compact.
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(audits(f)).toHaveLength(1);
 expect(compacts(f)).toHaveLength(1);
 // Finished, it no longer holds the seat's automatic compaction off.
 expect(e.getPreparationState(seat)).toBeNull();
});

it("without a restart, a manual /compact whose result was lost gets its restore on the operator's authority, with automatic compaction off",async()=>{
 const f=fixture();f.policy.enabled=false;const e=f.daemon();
 f.hooks.onWrite=(text)=>{if(text.includes('Write a restore map.'))completeMap(e);};
 f.hooks.failCompact=true;const outcome=await e.triggerManualCompact({...high,cwd:null},{operatorInitiated:true});f.hooks.failCompact=false;
 for(let i=0;i<3;i++)await staleTick(e);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(compacts(f)).toHaveLength(1);
 expect(outcome).toMatchObject({triggered:false,restoreOwed:true});
});

it('without a restart, the restore steps after a lost /compact result wait while the input box holds text, and say so',async()=>{
 const f=fixture();const e=f.daemon();await e.maybeAutoCompact(high);completeMap(e);
 f.hooks.failCompact=true;await e.maybeAutoCompact(high);f.hooks.failCompact=false;
 f.hooks.box='typed';for(let i=0;i<3;i++)await staleTick(e);
 // What the seat receives first: nothing whose Enter could submit the /compact text that may wait in its box.
 expect(boundaries(f)).toHaveLength(0);
 expect(e.observedCompaction(seat)?.detail).toContain('may have /compact text waiting');
 expect(e.getOwedRestore(seat)).toMatchObject({stage:'turn_boundary',held:true,inputBox:'typed'});
 // An empty box with the seat still busy: nothing is sent, and the step still reads as owed, not idle.
 f.hooks.box='empty';f.hooks.busy=true;await staleTick(e);f.hooks.busy=false;
 expect(boundaries(f)).toHaveLength(0);
 expect((await stateOf(e)).owedRestore).toMatchObject({stage:'turn_boundary',held:false,inputBox:'empty'});
 for(let i=0;i<3;i++)await staleTick(e);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(e.getOwedRestore(seat)).toBeNull();
});

it('after a restart, the restore steps after an in-flight /compact wait while the input box is unreadable, and rig compact --state says so',async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);
 const attempt=completeMap(first);renameSync(attempt.mapPath+'.tmp',attempt.mapPath);
 const record=recordFile(first);
 writeFileSync(record,JSON.stringify({...JSON.parse(readFileSync(record,'utf8')),compactSending:true}));
 f.hooks.box='unrecognized';
 const restarted=f.daemon();
 // A first look before any poll: the owed step shows, with the box not yet checked.
 expect((await stateOf(restarted)).owedRestore).toMatchObject({stage:'turn_boundary',held:false,inputBox:'not_checked'});
 for(let i=0;i<2;i++)await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(0);
 expect((await stateOf(restarted)).owedRestore).toMatchObject({stage:'turn_boundary',held:true,inputBox:'unrecognized',detail:expect.stringContaining('check the pane')});
 // A harness suggestion in the box isn't input.
 f.hooks.box='likely-suggestion';await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(1);
});

it('a restart after an automatic /compact waited for a busy seat and sent nothing owes no restore, and the map compacts once',async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);completeMap(first);
 f.hooks.busy=true;expect(await first.maybeAutoCompact(high)).toMatchObject({reason:'waiting_for_idle'});f.hooks.busy=false;
 expect(compacts(f)).toHaveLength(0);
 const restarted=f.daemon();await staleTick(restarted);
 // What the seat receives first: no restore steps for a compaction that never happened.
 expect(boundaries(f)).toHaveLength(0);
 await restarted.maybeAutoCompact(high);expect(compacts(f)).toHaveLength(1);
});

it("a restart as a manual /compact is written keeps its restore request's map and the operator's authority",async()=>{
 const f=fixture();f.policy.enabled=false;f.policy.preparationRoot=join(f.home,'maps');
 const first=f.daemon();let atWrite='';
 f.hooks.onWrite=(text)=>{
  if(text.includes('Write a restore map.'))completeMap(first);
  if(text.startsWith('/compact'))atWrite=readFileSync(recordFile(first),'utf8');
 };
 expect(await first.triggerManualCompact({...high,cwd:null},{operatorInitiated:true})).toMatchObject({triggered:true});
 const mapPath=first.getPreparationState(seat)!.mapPath;
 // The first daemon stopped as /compact was written; automatic compaction is off, so only the operator's request authorizes the restore.
 writeFileSync(recordFile(first),atWrite);
 const restarted=f.daemon();for(let i=0;i<3;i++)await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);
 expect(restores(f)[0]).toContain(mapPath);
});

it('a manual compaction asked for before the first poll after a restart neither prepares again nor replaces the owed restore',async()=>{
 const f=fixture();await compactedBy(f);
 const restarted=f.daemon();
 const outcome=await restarted.triggerManualCompact({...high,cwd:null},{operatorInitiated:true});
 expect(prepPrompts(f)).toHaveLength(1);
 expect(outcome).toMatchObject({triggered:false,reason:'already_in_progress'});
 await staleTick(restarted);expect(boundaries(f)).toHaveLength(1);
});

it('an open record older than the recovery window is not resumed: rig compact --state shows it, and a later compaction says it replaced it',async()=>{
 const f=fixture();await compactedBy(f);f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT+1);
 const restarted=f.daemon();
 // A first look at the seat after the restart, before any poll.
 const state=await stateOf(restarted);
 await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(0);
 expect(state.stranded).toMatchObject({phase:'turn_boundary',detail:expect.stringContaining('restore request naming mapPath')});
 expect(restarted.observedCompaction(seat)).toMatchObject({stage:'compacted',detail:expect.stringContaining('OpenRig restart')});
 await restarted.maybeAutoCompact(high);expect(prepPrompts(f)).toHaveLength(2);
 expect(restarted.getPreparationState(seat)?.supersedes).toMatchObject({mapPath:state.stranded.mapPath});
 expect(restarted.observedCompaction(seat)?.detail).toContain('replaces a compaction from before an OpenRig restart');
});

it("a record in a shape this daemon doesn't write is ignored, so it can't hold up the seat's compaction",async()=>{
 const f=fixture();const first=f.daemon();await first.maybeAutoCompact(high);
 const record=recordFile(first);
 // As a newer daemon might leave it, before a rollback.
 writeFileSync(record,JSON.stringify({...JSON.parse(readFileSync(record,'utf8')),phase:'a_later_stage'}));
 const restarted=f.daemon();await restarted.maybeAutoCompact(high);
 expect(prepPrompts(f)).toHaveLength(2);
 expect(restarted.hasPendingPostCompactStage(seat,{cwd:null,runtime:'claude-code'})).toBe(false);
});

it("another occupant's record is left alone",async()=>{
 const f=fixture();await compactedBy(f);f.generation('generation-two');
 const restarted=f.daemon();await staleTick(restarted);await restarted.maybeAutoCompact({...high,usedPercentage:20});
 expect(boundaries(f)).toHaveLength(0);expect(restarted.observedCompaction(seat)).toBeNull();
});

it("an enforcer in the same daemon process never treats that process's own record as a predecessor's",async()=>{
 const f=fixture();const first=f.daemon('one-process');
 await first.maybeAutoCompact(high);completeMap(first);await first.maybeAutoCompact(high);
 expect(compacts(f)).toHaveLength(1);
 const second=f.daemon('one-process');await staleTick(second);
 expect(boundaries(f)).toHaveLength(0);
});


it('shows the exact restore refusal, retries it, and clears the failure when the owed stage advances',async()=>{
 const f=fixture(),notice=vi.fn();
 const e=f.daemon(undefined,{onRestoreDeliveryFailure:notice});
 await e.maybeAutoCompact(high);completeMap(e);await e.maybeAutoCompact(high);
 const send=vi.spyOn(f.transport,'send');
 send.mockResolvedValue({ok:false,sessionName:seat,sent:false,reason:'target_activity_unknown',activity:{state:'unknown',reason:'no_activity_signal',evidenceSource:'pane_heuristic',sampledAt:new Date().toISOString(),evidence:'PRIVATE PANE TEXT'}});
 for(let i=0;i<3;i++){f.advance(30000);await staleTick(e);}
 const state=await stateOf(e);
 expect(state.owedRestore).toMatchObject({stage:'turn_boundary',lastDelivery:{ok:false,reason:'target_activity_unknown',activity:{state:'unknown',reason:'no_activity_signal',evidenceSource:'pane_heuristic'},failures:3}});
 expect(state.owedRestore.lastDelivery.at).toBe(new Date(f.now()).toISOString());
 expect(JSON.stringify(state)).not.toContain('PRIVATE PANE TEXT');
 expect(e.observedCompaction(seat)?.detail).toContain('target_activity_unknown');
 expect(notice).toHaveBeenCalledWith(expect.objectContaining({sessionName:seat,attemptId:state.preparation.attemptId}));
 // The diagnostic survives a restart; the existing poll still owns its retry.
 const restarted=f.daemon();expect(restarted.hasPendingPostCompactStage(seat,{runtime:'claude-code'})).toBe(true);
 expect((await stateOf(restarted)).owedRestore.lastDelivery.reason).toBe('target_activity_unknown');
 send.mockRestore();await staleTick(restarted);
 expect((await stateOf(restarted)).owedRestore).toMatchObject({stage:'restore_prompt'});
 expect((await stateOf(restarted)).owedRestore.lastDelivery).toBeUndefined();
 expect(compacts(f)).toHaveLength(1);
});

it('shows a thrown restore error by class without exposing its message or ending the pending stage',async()=>{
 const f=fixture(),e=await compactedBy(f);
 vi.spyOn(f.transport,'send').mockRejectedValue(new TypeError('PRIVATE ERROR MESSAGE'));
 await expect(staleTick(e)).rejects.toThrow(TypeError);
 const state=await stateOf(e);
 expect(state.owedRestore).toMatchObject({stage:'turn_boundary',lastDelivery:{ok:false,errorClass:'TypeError'}});
 expect(JSON.stringify(state)).not.toContain('PRIVATE ERROR MESSAGE');
 e.cancelPreparation(seat);expect(e.getOwedRestore(seat)).toBeNull();
});


it('a busy restore waits without holding the stage or notifying its owner',async()=>{
 const f=fixture(),notice=vi.fn(async()=>{});
 const e=f.daemon(undefined,{onRestoreDeliveryFailure:notice});
 await e.maybeAutoCompact(high);completeMap(e);await e.maybeAutoCompact(high);
 await staleTick(e);await staleTick(e);
 expect(e.getOwedRestore(seat)?.stage).toBe('compliance_prompt');
 vi.spyOn(Date,'now').mockImplementation(f.now);f.hooks.busy=true;
 for(let i=0;i<3;i++){await staleTick(e);f.advance(20000);}
 expect(e.getOwedRestore(seat)).toMatchObject({stage:'compliance_prompt',held:false,lastDelivery:{reason:'wait_for_idle_timeout',activity:{state:'running'},failures:0}});
 expect(e.getOwedRestore(seat)?.detail).toContain('waiting: seat busy');
 expect(notice).not.toHaveBeenCalled();
 f.hooks.busy=false;await staleTick(e);
 expect(e.getOwedRestore(seat)).toBeNull();expect(compacts(f)).toHaveLength(1);
});

it.each(['unresolved','rejected'])('owner notice starts after the lifecycle lease ends and a notice left %s does not hold the drain',async(mode)=>{
 const f=fixture(),held:boolean[]=[];
 const e=f.daemon(undefined,{onRestoreDeliveryFailure:async()=>{
  held.push(f.transport.deliveryGuard!.ownsLifecycle('node-one'));
  if(mode==='rejected')throw new RangeError('PRIVATE NOTICE ERROR');
  await new Promise<void>(()=>{});
 }});
 await e.maybeAutoCompact(high);completeMap(e);await e.maybeAutoCompact(high);
 vi.spyOn(f.transport,'send').mockResolvedValue({ok:false,sessionName:seat,sent:false,reason:'target_activity_unknown'});
 await staleTick(e);await staleTick(e);
 for(let i=0;i<10;i++)await Promise.resolve();
 expect(held).toEqual([false]);
 if(mode==='rejected')expect(e.getOwedRestore(seat)?.lastDelivery?.noticeErrorClass).toBe('RangeError');
 expect(readFileSync(recordFile(e),'utf8')).not.toContain('PRIVATE NOTICE ERROR');
});


it('a restart retains a completed automatic map after its prep deadline and the delayed compact still owes restore', async () => {
 const f=fixture(),first=f.daemon();await first.maybeAutoCompact(high);const a=completeMap(first);
 f.hooks.busy=true;f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);
 const restarted=f.daemon();await restarted.maybeAutoCompact(high);
 expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:a.attemptId,status:'waiting'});
 expect(prepPrompts(f)).toHaveLength(1);expect(compacts(f)).toHaveLength(0);
 f.hooks.busy=false;await restarted.maybeAutoCompact(high);
 expect(compacts(f)).toHaveLength(1);expect(prepPrompts(f)).toHaveLength(1);
 for(let i=0;i<4;i++)await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(1);expect(restores(f)).toHaveLength(1);expect(audits(f)).toHaveLength(1);
});
it('#2682: a fresh below-threshold sample ends a held attempt; a restart does not bring it back, and a busy seat gets no fresh request until it is idle',async()=>{
 const f=fixture();const e=f.daemon();
 await e.maybeAutoCompact(high);completeMap(e);
 f.hooks.busy=true;
 f.advance(AUTO_PREP_WAIT_MS_DEFAULT+11*60_000);e.reconcilePreparations();
 const held=e.getPreparationState(seat)!;
 expect(held).toMatchObject({status:'waiting',prepared:true,preparedReason:'map_complete_seat_never_idle'});
 await e.maybeAutoCompact({...high,usedPercentage:30});
 expect(e.getPreparationState(seat)).toMatchObject({attemptId:held.attemptId,status:'stopped',reason:'below_threshold_while_prepared'});
 const record=JSON.parse(readFileSync(recordFile(e),'utf8'));
 expect(record).toMatchObject({phase:'ended',reason:'below_threshold_while_prepared',delivery:'delivered',endedAt:expect.any(Number)});
 expect(record.prepared).toBeUndefined();
 f.hooks.busy=false;f.advance(60_000);
 const restarted=f.daemon();
 // The monitor's drain for an idle seat whose sample is stale: nothing is resumed, nothing is sent.
 expect(await restarted.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code'})).toMatchObject({triggered:false,reason:'no_pending_stage'});
 expect(restarted.getPreparationState(seat)).toBeNull();
 // Past the retry cooldown, a busy seat is not asked again; once it is idle it gets one fresh request, never the old map.
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT);f.hooks.busy=true;
 expect(await restarted.maybeAutoCompact(high)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(f)).toHaveLength(1);expect(restarted.getPreparationState(seat)).toBeNull();
 f.hooks.busy=false;
 expect(await restarted.maybeAutoCompact(high)).toEqual({triggered:true});
 expect(prepPrompts(f)).toHaveLength(2);expect(compacts(f)).toHaveLength(0);
 expect(restarted.getPreparationState(seat)!.attemptId).not.toBe(held.attemptId);
});

// #2682: a context drop while the daemon was down. The monitor's drain for a stale sample passes the seat's last known
// usage and conversation; a held map whose context has since dropped, or whose conversation changed, never compacts.
const hs={...high,sessionId:'conversation-one'};
/** An automatic attempt held with its map complete on a busy seat, as the first daemon left it. */
async function heldBy(f:F){
 const e=f.daemon();await e.maybeAutoCompact(hs);completeMap(e);
 f.hooks.busy=true;f.advance(AUTO_PREP_WAIT_MS_DEFAULT+11*60_000);e.reconcilePreparations();
 const held=e.getPreparationState(seat)!;
 expect(held).toMatchObject({status:'waiting',prepared:true});
 return held;
}
const staleDrain=(e:ClaudeCompactionEnforcer,lastUsedPercentage:number,sessionId='conversation-one')=>
 e.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code',lastUsedPercentage,sessionId});

it('#2682 S1a: a restart between a fresh dip and the deadline: the stale drain sends no /compact, and the attempt is never held',async()=>{
 const f=fixture();const e=f.daemon();await e.maybeAutoCompact(hs);const a=completeMap(e);
 expect(await e.maybeAutoCompact({...hs,usedPercentage:30})).toEqual({triggered:false,reason:'below_threshold'});
 expect(JSON.parse(readFileSync(recordFile(e),'utf8')).belowSince).toEqual(expect.any(Number));
 f.advance(11*60_000);
 const restarted=f.daemon();
 // The seat is idle with an empty box; its newest sample (30%) is no longer fresh.
 expect(await staleDrain(restarted,30)).toMatchObject({triggered:false});
 expect(compacts(f)).toHaveLength(0);
 f.hooks.busy=true;f.advance(AUTO_PREP_WAIT_MS_DEFAULT+AUTO_RETRY_AFTER_STOP_MS_DEFAULT);restarted.reconcilePreparations();
 const state=restarted.getPreparationState(seat)!;
 expect(state).toMatchObject({attemptId:a.attemptId,status:'stopped',reason:'map_complete_seat_never_idle'});
 expect(state.prepared).toBeUndefined();
 f.hooks.busy=false;await staleDrain(restarted,30);
 expect(compacts(f)).toHaveLength(0);
});

it('#2682 S1b: a held attempt, a restart, and a stale sample below the threshold at the drain: it stops, with no /compact',async()=>{
 const f=fixture();const held=await heldBy(f);
 f.hooks.busy=false;f.advance(11*60_000);
 const restarted=f.daemon();
 expect(await staleDrain(restarted,20)).toMatchObject({triggered:false});
 expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:held.attemptId,status:'stopped',reason:'below_threshold_while_prepared'});
 expect(compacts(f)).toHaveLength(0);
 expect(JSON.parse(readFileSync(join(dirname(held.mapPath),'COMPACTION-STATE.json'),'utf8'))).toMatchObject({phase:'ended',reason:'below_threshold_while_prepared'});
});

it('#2682 S1c: a held attempt, a restart, and another conversation at the drain: it stops, with no /compact',async()=>{
 const f=fixture();const held=await heldBy(f);
 f.hooks.busy=false;f.advance(11*60_000);
 const restarted=f.daemon();
 expect(await staleDrain(restarted,90,'conversation-two')).toMatchObject({triggered:false});
 expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:held.attemptId,status:'stopped',reason:'below_threshold_while_prepared'});
 expect(compacts(f)).toHaveLength(0);
});

it('#2682 S1d: a held attempt, a restart, and a stale sample still above with the same conversation: the /compact goes at the window',async()=>{
 const f=fixture();const held=await heldBy(f);
 f.hooks.busy=false;f.advance(11*60_000);
 const restarted=f.daemon();
 expect(await staleDrain(restarted,90)).toEqual({triggered:true});
 expect(compacts(f)).toHaveLength(1);
 expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:held.attemptId,status:'compact-sent'});
});

it('#2682 S1e: a held attempt, a restart, and a stale sample 15 points above the map: it retires as stale, with no /compact; 14 above still sends',async()=>{
 for(const [growth,sends] of [[15,false],[14,true]] as const){
  const f=fixture();const held=await heldBy(f);
  const mapAt=JSON.parse(readFileSync(join(dirname(held.mapPath),'COMPACTION-STATE.json'),'utf8')).mapUsedPercentage;
  expect(mapAt).toEqual(expect.any(Number));
  f.hooks.busy=false;f.advance(11*60_000);
  const restarted=f.daemon();
  const out=await staleDrain(restarted,mapAt+growth);
  if(sends){expect(out).toEqual({triggered:true});expect(compacts(f)).toHaveLength(1);continue;}
  expect(out).toMatchObject({triggered:false});
  expect(restarted.getPreparationState(seat)).toMatchObject({attemptId:held.attemptId,status:'stopped',reason:'prepared_map_stale'});
  expect(compacts(f)).toHaveLength(0);
 }
});

it('#2682 S1f: an armed map not yet held, a stale sample of another conversation at the drain, then an unknown one: no /compact with the old map, in process or after a restart',async()=>{
 for(const variant of ['in-process','restart'] as const){
  const f=fixture();let e=f.daemon();
  await e.maybeAutoCompact(hs);const a=completeMap(e);
  expect(e.getPreparationState(seat),variant).toMatchObject({status:'waiting'});
  expect(e.getPreparationState(seat)!.prepared,variant).toBeUndefined();
  f.advance(60_000);
  if(variant==='restart')e=f.daemon();
  expect(await staleDrain(e,90,'conversation-two'),variant).toEqual({triggered:false,reason:'preparation_stopped'});
  expect(e.getPreparationState(seat),variant).toMatchObject({attemptId:a.attemptId,status:'stopped',reason:'below_threshold_while_prepared'});
  // The next sample names no conversation (unknown is not a mismatch): it must not reach the old map.
  await e.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code',lastUsedPercentage:90});
  expect(compacts(f),variant).toHaveLength(0);
 }
});

/** An automatic attempt whose request was delivered and which ended with no map at its deadline, past the retry cooldown. */
async function endedPastCooldown(f:F,e:ClaudeCompactionEnforcer){
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:true});
 f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);e.reconcilePreparations();
 expect(e.getPreparationState(seat)).toMatchObject({status:'stopped',reason:'preparation_incomplete',delivery:'delivered'});
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT+1);
}

it('#2682 S2: the ended-attempt idle gate reads a busy seat once and returns at once, without waiting inside the poll',async()=>{
 const f=fixture();const e=f.daemon();await endedPastCooldown(f,e);
 const wait=vi.spyOn(f.transport,'waitUntilIdle');
 f.hooks.busy=true;const before=f.now();
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(f.now()-before).toBeLessThan(1000);
 expect(wait).toHaveBeenCalledTimes(1);
 expect(prepPrompts(f)).toHaveLength(1);
 f.hooks.busy=false;
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:true});
 expect(prepPrompts(f)).toHaveLength(2);
});

it('#2682 n2: a momentarily unknown occupant generation does not erase the ended attempt: the busy seat is still held off after',async()=>{
 const f=fixture();const e=f.daemon();
 await endedPastCooldown(f,e);
 // Neither the occupant resolver nor the binding names the occupant for one poll.
 f.hooks.busy=true;f.generation(null as unknown as string);
 expect(await e.maybeAutoCompact(hs)).toMatchObject({triggered:false});
 f.generation('generation-one');
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(f)).toHaveLength(1);
});

it('#2682 n3: a cancel after a submitted /compact leaves an ended record, and a restart does not hold a busy seat off for it',async()=>{
 const f=fixture();const e=await compactedBy(f);e.cancelPreparation(seat);
 expect(JSON.parse(readFileSync(recordFile(e),'utf8'))).toMatchObject({phase:'ended',delivery:'delivered'});
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT+1);
 const restarted=f.daemon();f.hooks.busy=true;
 expect(await restarted.maybeAutoCompact(hs)).toEqual({triggered:true});
 expect(prepPrompts(f)).toHaveLength(2);
});

it('#2682 P1: a fresh high sample from another conversation, in process or after a restart, or after a dip and a climb back, sends no /compact with the old map',async()=>{
 const other={...high,sessionId:'conversation-two'};
 for(const variant of ['armed','held','held-restart','dip-climb','dip-climb-restart'] as const){
  const f=fixture();let e=f.daemon();
  await e.maybeAutoCompact(hs);const a=completeMap(e);
  if(variant.startsWith('dip-climb')){
   expect(await e.maybeAutoCompact({...hs,usedPercentage:30})).toEqual({triggered:false,reason:'below_threshold'});
   // Back above before the deadline, on a busy seat: no window for the /compact.
   f.hooks.busy=true;await e.maybeAutoCompact(hs);
   if(variant==='dip-climb-restart'){e=f.daemon();await e.maybeAutoCompact(hs);}
   f.advance(AUTO_PREP_WAIT_MS_DEFAULT+11*60_000);e.reconcilePreparations();
   // The attempt that dipped is never held, so its pre-dip map stops at the idle grace as before.
   const state=e.getPreparationState(seat)!;
   expect(state,variant).toMatchObject({attemptId:a.attemptId,status:'stopped',reason:'map_complete_seat_never_idle'});
   expect(state.prepared,variant).toBeUndefined();
   f.hooks.busy=false;await e.maybeAutoCompact(hs);await e.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code',lastUsedPercentage:90,sessionId:'conversation-one'});
   expect(compacts(f),variant).toHaveLength(0);
   continue;
  }
  if(variant!=='armed'){
   f.hooks.busy=true;f.advance(AUTO_PREP_WAIT_MS_DEFAULT+11*60_000);e.reconcilePreparations();
   expect(e.getPreparationState(seat),variant).toMatchObject({status:'waiting',prepared:true});
   f.hooks.busy=false;f.advance(11*60_000);
   if(variant==='held-restart')e=f.daemon();
  }
  // The /clear and its low sample were missed; the seat is idle with an empty box.
  expect(await e.maybeAutoCompact(other),variant).toMatchObject({triggered:false});
  expect(compacts(f),variant).toHaveLength(0);
  expect(e.getPreparationState(seat),variant).toMatchObject({attemptId:a.attemptId,status:'stopped'});
  // An unknown conversation is not a mismatch: on a fresh copy of the armed case, it compacts with the map as before.
  if(variant==='armed'){
   const g=fixture();const d=g.daemon();await d.maybeAutoCompact(hs);completeMap(d);
   expect(await d.maybeAutoCompact({...high,sessionId:null})).toEqual({triggered:true});
   expect(compacts(g)).toHaveLength(1);
  }
 }
 // The low sample of the /clear seen, but from the new conversation: it ends the armed attempt too, so a later high sample
 // whose conversation reads unknown never compacts with the old conversation's map.
 {
  const h=fixture();const c=h.daemon();await c.maybeAutoCompact(hs);const b=completeMap(c);
  expect(await c.maybeAutoCompact({...other,usedPercentage:20})).toMatchObject({triggered:false});
  expect(c.getPreparationState(seat)).toMatchObject({attemptId:b.attemptId,status:'stopped'});
  await c.maybeAutoCompact({...high,sessionId:null});
  expect(compacts(h)).toHaveLength(0);
 }
 // A request that never went out was made in no conversation: the attempt takes the sample's conversation, and a request
 // and map made in the new one are kept, with one request and the /compact.
 const g=fixture();const d=g.daemon();
 vi.spyOn(g.transport,'send').mockResolvedValueOnce({ok:false,sent:false,reason:'mid_work'} as any);
 expect(await d.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'send_failed'});
 expect(d.getPreparationState(seat)).toMatchObject({status:'sending',delivery:'not_sent'});
 expect(await d.maybeAutoCompact(other)).toEqual({triggered:true});
 completeMap(d);
 expect(await d.maybeAutoCompact(other)).toEqual({triggered:true});
 expect(prepPrompts(g)).toHaveLength(1);
 expect(compacts(g)).toHaveLength(1);
});

it('#2682 P2a: an ended attempt, an idle read, then a stale observation, then a busy seat: no fresh request on the busy poll',async()=>{
 const f=fixture();const e=f.daemon();await endedPastCooldown(f,e);
 expect(await e.maybeAutoCompact({...hs,isObservationCurrent:()=>false})).toEqual({triggered:false,reason:'stale_observation'});
 f.hooks.busy=true;
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(f)).toHaveLength(1);
});

it('#2682 P2b: an ended attempt, an idle read, then a peer\'s turn before the send: the request waits for a real idle window, and goes once',async()=>{
 const f=fixture();const e=f.daemon();await endedPastCooldown(f,e);
 const read=f.transport.waitUntilIdle.bind(f.transport);
 // A peer's message starts a turn right after the gate's idle read.
 vi.spyOn(f.transport,'waitUntilIdle').mockImplementationOnce(async(...args)=>{const r=await read(...args);f.hooks.busy=true;return r;});
 expect(await e.maybeAutoCompact(hs)).toMatchObject({triggered:false});
 expect(prepPrompts(f)).toHaveLength(1);
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(f)).toHaveLength(1);
 f.hooks.busy=false;
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:true});
 expect(prepPrompts(f)).toHaveLength(2);
 f.hooks.busy=true;await e.maybeAutoCompact(hs);
 expect(prepPrompts(f)).toHaveLength(2);
 // A replacement that stops with its request never sent (each send found a turn begun) keeps the gate after a restart.
 const g=fixture();const d=g.daemon();await endedPastCooldown(g,d);
 const gateRead=g.transport.waitUntilIdle.bind(g.transport);
 vi.spyOn(g.transport,'waitUntilIdle').mockImplementation(async(...args)=>{const r=await gateRead(...args);g.hooks.busy=true;return r;});
 for(let i=0;i<3;i++){g.hooks.busy=false;await d.maybeAutoCompact(hs);}
 expect(d.getPreparationState(seat)).toMatchObject({status:'stopped',delivery:'not_sent'});
 expect(prepPrompts(g)).toHaveLength(1);
 vi.mocked(g.transport.waitUntilIdle).mockRestore();
 const restarted=g.daemon();g.hooks.busy=true;
 expect(await restarted.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(g)).toHaveLength(1);
});

it('#2682: an ended attempt whose conversation reads unknown keeps its gate when the unsent replacement moves to another conversation: a busy seat gets no second request',async()=>{
 const f=fixture();const e=f.daemon();
 expect(await e.maybeAutoCompact(high)).toEqual({triggered:true});
 f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);e.reconcilePreparations();
 expect(e.getPreparationState(seat)).toMatchObject({status:'stopped',delivery:'delivered'});
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT+1);
 vi.spyOn(f.transport,'send').mockResolvedValueOnce({ok:false,sent:false,reason:'mid_work'} as any);
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'send_failed'});
 expect(e.getPreparationState(seat)).toMatchObject({status:'sending',delivery:'not_sent'});
 await e.maybeAutoCompact({...high,usedPercentage:40,sessionId:'conversation-two'});
 f.hooks.busy=true;
 expect(await e.maybeAutoCompact({...high,sessionId:'conversation-two'})).toEqual({triggered:false,reason:'waiting_for_idle'});
 expect(prepPrompts(f)).toHaveLength(1);
});

/** An ended attempt whose conversation reads unknown, then its replacement refused before its request went out, made in
 *  conversation-one. */
async function unsentReplacementAfterUnknownEnded(f:F){
 const e=f.daemon();
 expect(await e.maybeAutoCompact(high)).toEqual({triggered:true});
 f.advance(AUTO_PREP_WAIT_MS_DEFAULT+1);e.reconcilePreparations();
 expect(e.getPreparationState(seat)).toMatchObject({status:'stopped',delivery:'delivered'});
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT+1);
 vi.spyOn(f.transport,'send').mockResolvedValueOnce({ok:false,sent:false,reason:'mid_work'} as any);
 expect(await e.maybeAutoCompact(hs)).toEqual({triggered:false,reason:'send_failed'});
 expect(e.getPreparationState(seat)).toMatchObject({status:'sending',delivery:'not_sent'});
 return e;
}

for(const restart of ['before','after'] as const){
 it(`#2682: a restart ${restart} the unsent replacement moves to another conversation keeps the gate of the ended attempt whose conversation reads unknown, as in memory: a busy seat in a third conversation gets no second request`,async()=>{
  const f=fixture();let e=await unsentReplacementAfterUnknownEnded(f);
  if(restart==='before')e=f.daemon();
  await e.maybeAutoCompact({...high,usedPercentage:40,sessionId:'conversation-two'});
  if(restart==='after')e=f.daemon();
  f.hooks.busy=true;
  expect(await e.maybeAutoCompact({...high,sessionId:'conversation-three'})).toEqual({triggered:false,reason:'waiting_for_idle'});
  expect(prepPrompts(f)).toHaveLength(1);
 });
}

it('#2682: a replacement that moved to another conversation and stopped with its request never sent keeps, after a restart, the gate of the ended attempt whose conversation reads unknown: a busy seat in a third conversation gets no request',async()=>{
 const f=fixture();const e=await unsentReplacementAfterUnknownEnded(f);
 await e.maybeAutoCompact({...high,usedPercentage:40,sessionId:'conversation-two'});
 vi.spyOn(f.transport,'send').mockResolvedValue({ok:false,sent:false,reason:'mid_work'} as any);
 for(let i=0;i<4&&e.getPreparationState(seat)?.status!=='stopped';i++)await e.maybeAutoCompact({...high,sessionId:'conversation-two'});
 expect(e.getPreparationState(seat)).toMatchObject({status:'stopped',delivery:'not_sent'});
 vi.mocked(f.transport.send).mockRestore();
 const restarted=f.daemon();f.hooks.busy=true;
 f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT+1);
 await restarted.maybeAutoCompact({...high,sessionId:'conversation-three'});
 expect(prepPrompts(f)).toHaveLength(1);
});

for(const otherUsage of [20,90,null] as (number|null)[]){
 for(const next of ['stale','fresh'] as const){
  it(`#2682: a stale sample of another known conversation (at ${otherUsage}) ends an automatic attempt whose request went out before its map is complete: a later ${next} sample whose conversation reads unknown never compacts with that map`,async()=>{
   const f=fixture();const e=f.daemon();
   expect(await e.maybeAutoCompact(hs)).toEqual({triggered:true});
   expect(await e.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code',lastUsedPercentage:otherUsage,sessionId:'conversation-two'}))
    .toEqual({triggered:false,reason:'preparation_stopped'});
   completeMap(e);
   if(next==='stale')await e.drainPendingPreparedCompact({sessionName:seat,runtime:'claude-code',lastUsedPercentage:90,sessionId:null});
   else await e.maybeAutoCompact({...high,sessionId:null});
   expect(compacts(f)).toHaveLength(0);
  });
 }
}
