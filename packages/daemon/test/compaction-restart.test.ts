// A daemon restart in the middle of a managed compaction: the restarted daemon (a second enforcer over the same instance
// home and seat) picks the attempt up from the record beside its map, as the context monitor reaches it.
import {afterEach, expect, it, vi} from 'vitest';
import {mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClaudeCompactionEnforcer, RESTART_RECOVERY_WINDOW_MS_DEFAULT, buildPostCompactTurnBoundaryPrompt} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';

const seat='writer@demo', high={sessionName:seat,runtime:'claude-code',usedPercentage:90};
const homes:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const h of homes.splice(0))rmSync(h,{recursive:true,force:true});});

function fixture(){
 const home=mkdtempSync(join(tmpdir(),'compaction-restart-'));homes.push(home);
 let clock=10000,generation='generation-one';
 const db={prepare:()=>({get:()=>undefined,all:()=>[]})} as any;
 const writes:string[]=[];
 const policy={preparationRoot:'',enabled:true,thresholdPercent:80,preCompactInstruction:'Write a restore map.',compactInstruction:'',messageInline:'',messageFilePath:'',postRestoreAuditInstruction:''};
 const tmux={probeSession:vi.fn(async()=>({state:'present'})),sendText:vi.fn(async(_:string,text:string)=>{writes.push(text);return{ok:true};}),sendKeys:vi.fn(async()=>({ok:true}))};
 const guard=new SeatDeliveryGuard(db,()=>({nodeId:'node-one',session:seat,pane:'%1',occupant:generation}));
 Object.assign(tmux,{deliveryGuard:guard});
 const transport=new SessionTransport({db,rigRepo:{} as any,sessionRegistry:{} as any,tmuxAdapter:tmux as any,sleep:async(ms)=>{clock+=ms;},now:()=>new Date(clock),waitForIdlePollMs:5});
 (transport as any).getSessionMeta=()=>({runtime:'claude-code',attachmentType:'tmux',nodeId:'node-one',pane:'%1',occupant:generation,resumeToken:'native-one'});
 (transport as any).claudeDeliveryObservation=async()=>({state:'unknown',detail:'injected process observation'});
 (transport as any).classifySendReadiness=async()=>({state:'idle',reason:'fixture',evidenceSource:'fixture'});
 (transport as any).diagnoseProducerLink=async()=>'fixture';
 const settings={resolveClaudeCompactionPolicy:()=>policy};
 // A daemon process: a new one shares the instance home, the seat and the clock, and nothing held in memory.
 const daemon=(instance=randomUUID())=>new ClaudeCompactionEnforcer(settings as any,transport,{openrigHome:home,daemonInstance:instance,now:()=>clock,sleep:async(ms)=>{clock+=ms;},resolveOccupantGeneration:()=>generation});
 return{daemon,writes,policy,advance:(ms:number)=>{clock+=ms;},generation:(g:string)=>{generation=g;}};
}
type F=ReturnType<typeof fixture>;
const compacts=(f:F)=>f.writes.filter(t=>t.startsWith('/compact'));
const prepPrompts=(f:F)=>f.writes.filter(t=>t.includes('Write a restore map.'));
const boundaries=(f:F)=>f.writes.filter(t=>t===buildPostCompactTurnBoundaryPrompt());
const restores=(f:F)=>f.writes.filter(t=>t.includes('restoring this Claude session after compaction'));
const audits=(f:F)=>f.writes.filter(t=>t.startsWith('Now audit your compaction restore'));
function completeMap(e:ClaudeCompactionEnforcer){
 const a=e.getPreparationState(seat)!;mkdirSync(dirname(a.mapPath),{recursive:true});
 writeFileSync(a.mapPath+'.tmp',`# Restore map\nCurrent work and next step.\n${a.marker}\n`);
 return a;
}
/** What the context monitor does for a seat whose sample is stale (an idle seat after /compact). */
async function staleTick(e:ClaudeCompactionEnforcer){
 if(e.hasPendingPostCompactStage(seat,{cwd:null,runtime:'claude-code'}))await e.drainPendingPostCompactStage({sessionName:seat,runtime:'claude-code'});
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

it('an open record older than the recovery window is not resumed, and reads as stranded rather than idle',async()=>{
 const f=fixture();await compactedBy(f);f.advance(RESTART_RECOVERY_WINDOW_MS_DEFAULT+1);
 const restarted=f.daemon();await staleTick(restarted);
 expect(boundaries(f)).toHaveLength(0);
 expect(restarted.observedCompaction(seat)).toMatchObject({stage:'compacted',detail:expect.stringContaining('OpenRig restart')});
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
