// A daemon restart in the middle of a managed compaction: the restarted daemon (a second enforcer over the same instance
// home and seat) picks the attempt up from the record beside its map, as the context monitor reaches it.
import {afterEach, expect, it, vi} from 'vitest';
import {mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {ClaudeCompactionEnforcer, RESTART_RECOVERY_WINDOW_MS_DEFAULT, buildPostCompactTurnBoundaryPrompt} from '../src/domain/claude-compaction-enforcer.js';
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
