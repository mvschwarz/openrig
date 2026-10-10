// Actual route/reconciler/SQLite/inventory with synthetic activity/transport ports.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createFullTestDb } from './helpers/test-app.js';
import { RigRepository } from '../src/domain/rig-repository.js';
import { SessionRegistry } from '../src/domain/session-registry.js';
import { EventBus } from '../src/domain/event-bus.js';
import { AgentActivityStore } from '../src/domain/agent-activity-store.js';
import { SeatAttentionReconciler } from '../src/domain/seat-attention-reconciler.js';
import { SeatIdentityStore } from '../src/domain/seat-identity-store.js';
import { getNodeInventory, getNodeInventoryForRigs } from '../src/domain/node-inventory.js';
import { sessionAdminRoutes } from '../src/routes/sessions.js';
import { SeatStatusService } from '../src/domain/seat-status-service.js';
const databases: ReturnType<typeof createFullTestDb>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(kind: 'subset' | 'full' | 'startup' | 'identity', explicit: string | null = null) {
  const db = createFullTestDb(); databases.push(db);
  const repo = new RigRepository(db), registry = new SessionRegistry(db), bus = new EventBus(db);
  const rig = repo.createRig('attention-specimen');
  const node = repo.addNode(rig.id, 'worker', {role:'worker',runtime:'claude-code'});
  const name = 'worker@attention-specimen';
  const session = registry.registerSession(node.id, name);
  registry.updateStatus(session.id,'running');
  registry.updateStartupStatus(session.id,kind === 'startup' ? 'attention_required' : 'ready');
  registry.updateBinding(node.id,{tmuxSession:name,tmuxPane:'%991'});
  db.prepare('UPDATE nodes SET continuity_outcome = ? WHERE id = ?').run(explicit,node.id);
  if (kind === 'subset' || kind === 'full') {
    if (kind === 'full') bus.emit({type:'restore.started',rigId:rig.id,snapshotId:'synthetic-snapshot'});
    bus.emit({type:kind === 'full' ? 'restore.completed':'restore.subset_completed',rigId:rig.id,snapshotId:'synthetic-snapshot',result:{snapshotId:'synthetic-snapshot',preRestoreSnapshotId:null,rigResult:'partially_restored',nodes:[{nodeId:node.id,logicalId:'worker',status:'attention_required'}],warnings:[]}} as never);
  }
  const identities = new SeatIdentityStore(db);
  if (kind === 'identity') identities.upsert({nodeId:node.id,verdict:'mismatch',evidenceSource:'pane_process',reason:'process_identity_mismatch',evidence:{registeredPane:'%991',observedPid:991,observedCommand:'bash',matchedLayer:null},sessionName:name,observedAt:new Date().toISOString()});
  const sendVerify=vi.fn(async (): Promise<{ok:boolean; verified?:boolean}> => ({ok:false}));
  const clear = new SeatAttentionReconciler({db,sessionRegistry:registry,eventBus:bus,agentActivityStore:new AgentActivityStore({db,eventBus:bus}),sendVerify});
  const app = new Hono();
  app.use('*',async(c,next)=>{c.set('seatAttentionReconciler' as never,clear as never);c.set('terminalBearerToken' as never,null as never);await next();});
  app.route('/api/sessions',sessionAdminRoutes);
  const inventory=()=>{
    const i=getNodeInventory(db,rig.id)[0]!;
    return {startupStatus:i.startupStatus,sessionStatus:i.sessionStatus,restoreOutcome:i.restoreOutcome,continuityOutcome:i.continuityOutcome,lifecycleState:i.lifecycleState,occupantLifecycle:i.occupantLifecycle};
  };
  const post=async(reason?:string)=>{
    const r=await app.request(`/api/sessions/${encodeURIComponent(name)}/clear-attention`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(reason?{reason}:{})});
    return {status:r.status,body:await r.json() as any};
  };
  const events=()=>db.prepare("SELECT type,payload FROM events WHERE type IN ('seat.attention_cleared','restore.outcome_reconciled') ORDER BY seq").all().map((r:any)=>({type:r.type,payload:JSON.parse(r.payload)}));
  return {db,node,identities,name,inventory,post,events,sendVerify,repo,registry,bus,rig};
}
describe('bounded truthful-attention specimen projection',()=>{
  it.each([null,'failed','fresh'])('subset acknowledgment with explicit continuity %s',async explicit=>{
    const f=fixture('subset',explicit);
    const result=await f.post('operator reports this seat is working');
    const after=f.inventory(),events=f.events();
    expect(result.status).toBe(200);
    expect(result.body.clearedBy).toBe('operator_attestation');
    expect(result.body.derivedEvidence).toMatchObject({source:'operator_attestation',runtimeCwdVerified:false});
    expect(after.restoreOutcome).toBe('operator_recovered');
    expect(after.continuityOutcome).toBe(explicit);
    expect(after.lifecycleState).toBe('running');
    expect(events).toHaveLength(1);
    expect(f.sendVerify).not.toHaveBeenCalled();
    // A later real identity observation still down-ranks a previously acknowledged seat.
    f.identities.upsert({nodeId:f.node.id,verdict:'mismatch',evidenceSource:'pane_process',reason:'process_identity_mismatch',evidence:{registeredPane:'%991',observedPid:991,observedCommand:'bash',matchedLayer:null},sessionName:f.name,observedAt:new Date().toISOString()});
    expect(f.inventory().lifecycleState).toBe('attention_required');
  });
  it('a verified send clears subset attention without claiming continuity', async () => {
    const f = fixture('subset');
    f.sendVerify.mockResolvedValue({ok:true, verified:true});
    expect((await f.post()).status).toBe(200);
    expect(f.inventory()).toMatchObject({restoreOutcome:'operator_recovered',continuityOutcome:null,lifecycleState:'running'});
    expect(f.events()[0].payload.evidence).toMatchObject({source:'clear_attention_evidence',runtimeCwdVerified:false});
  });
  it.each(['full','identity'] as const)('%s class is not bypassed by reason',async kind=>{
    const f=fixture(kind),before=f.inventory(),result=await f.post('operator reports this seat is working');
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('not_demonstrably_responsive');
    expect(result.body.detail).toContain(kind==='full'?'restore_outcome':'pane_identity');
    expect(f.events()).toEqual([]);
    expect(f.sendVerify).not.toHaveBeenCalled();
    expect(f.inventory()).toEqual(before);
  });
  it.each(['startup','subset'] as const)('%s missing-evidence response identifies its class',async kind=>{
    const f=fixture(kind),result=await f.post();
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('not_demonstrably_responsive');
    expect(f.events()).toEqual([]);
  });
});

describe('restore proof binding in the inventory batch', () => {
  const proof = {tmux:true, fgProcess:'claude', resumeTokenUsed:true, paneState:'usable'};
  function receipt(f: ReturnType<typeof fixture>, rigId = f.rig.id, nodeId = f.node.id) {
    const start = f.bus.emit({type:'restore.started',rigId,snapshotId:'s1',intendedRoster:[{nodeId,logicalId:'worker'}]});
    f.bus.emit({type:'restore.completed',rigId,snapshotId:'s1',result:{snapshotId:'s1',preRestoreSnapshotId:null,rigResult:'partially_restored',nodes:[{nodeId,logicalId:'worker',status:'attention_required'}],warnings:[]}});
    return start.seq;
  }
  function reconcile(f: ReturnType<typeof fixture>, attemptId: number, overrides: Record<string, unknown> = {}) {
    f.bus.emit({type:'restore.outcome_reconciled',rigId:f.rig.id,nodeId:f.node.id,attemptId,from:'attention_required',to:'operator_recovered',evidence:proof,...overrides} as never);
  }
  function both(f: ReturnType<typeof fixture>) {
    const local = getNodeInventory(f.db, f.rig.id)[0]!;
    const fleet = getNodeInventoryForRigs(f.db,new Set([f.rig.id])).get(f.rig.id)![0]!;
    expect(fleet).toEqual(local);
    return local;
  }
  it('retains strict resumed proof and passes it unchanged through seat status', () => {
    const f=fixture('startup');
    f.db.prepare("UPDATE sessions SET startup_status='ready'").run();
    reconcile(f,receipt(f));
    expect(both(f)).toMatchObject({restoreOutcome:'operator_recovered',continuityOutcome:'resumed',lifecycleState:'running'});
    const status=new SeatStatusService({rigRepo:f.repo}).getStatus(f.name);
    expect(status).toMatchObject({ok:true,status:{continuity_outcome:'resumed',restore_outcome:'operator_recovered'}});
  });
  it.each([
    undefined, null, [], 'strict', {source:'strict'}, {runtimeCwdVerified:true},
    {...proof,tmux:false}, {...proof,resumeTokenUsed:false}, {...proof,paneState:'unknown'},
    {...proof,fgProcess:'bash'}, {...proof,tmux:'true'}, {...proof,fgProcess:'codex'},
  ].map(evidence => [evidence]))('does not infer continuity from absent, malformed or incomplete evidence: %j', evidence => {
    const f=fixture('subset');
    reconcile(f,receipt(f),{evidence});
    expect(both(f)).toMatchObject({restoreOutcome:'operator_recovered',continuityOutcome:null,lifecycleState:'running'});
  });
  it.each(['zero','missing','wrong-rig','wrong-node','superseded','wrong-from','missing-completion','wrong-snapshot','wrong-column'] as const)(
    'does not infer continuity from an unbound receipt: %s', kind => {
      const f=fixture('subset');
      const id=receipt(f,kind==='wrong-rig'?'other-rig':f.rig.id,kind==='wrong-node'?'other-node':f.node.id);
      if (kind==='superseded') f.bus.emit({type:'restore.started',rigId:f.rig.id,snapshotId:'s2'});
      if (kind==='missing-completion') f.db.prepare("DELETE FROM events WHERE type='restore.completed'").run();
      if (kind==='wrong-snapshot') f.db.prepare("UPDATE events SET payload=json_set(payload,'$.snapshotId','other') WHERE type='restore.completed'").run();
      reconcile(f,kind==='zero'?0:kind==='missing'?999999:id,kind==='wrong-from'?{from:'failed'}:{});
      if (kind==='wrong-column') f.db.prepare("UPDATE events SET node_id='other-node' WHERE type='restore.outcome_reconciled'").run();
      expect(both(f)).toMatchObject({restoreOutcome:'operator_recovered',continuityOutcome:null,lifecycleState:'running'});
    },
  );
  it('does not let another rig overwrite this node or donate proof in the fleet batch', () => {
    const f=fixture('subset');
    reconcile(f,receipt(f));
    f.bus.emit({type:'restore.outcome_reconciled',rigId:'other-rig',nodeId:f.node.id,attemptId:0,from:'failed',to:'operator_recovered',evidence:{source:'operator_attestation'}});
    expect(both(f).continuityOutcome).toBe('resumed');
  });
  it('never borrows an older strict proof when a newer acknowledgment wins', () => {
    const f=fixture('subset'), id=receipt(f);
    reconcile(f,id);
    reconcile(f,0,{evidence:{source:'operator_attestation',runtimeCwdVerified:false}});
    expect(both(f).continuityOutcome).toBeNull();
    expect(new SeatStatusService({rigRepo:f.repo}).getStatus(f.name)).toMatchObject({ok:true,status:{session_status:'running',continuity_outcome:null}});
  });
  it('keeps newer failures and newer reconciliations ordered per node', () => {
    const f=fixture('subset');
    reconcile(f,receipt(f));
    f.bus.emit({type:'restore.subset_completed',rigId:f.rig.id,snapshotId:'s2',result:{snapshotId:'s2',preRestoreSnapshotId:null,rigResult:'failed',nodes:[{nodeId:f.node.id,logicalId:'worker',status:'failed'}],warnings:[]}});
    expect(both(f)).toMatchObject({restoreOutcome:'failed',continuityOutcome:'failed',lifecycleState:'attention_required'});
    reconcile(f,0,{from:'failed',evidence:{source:'clear_attention_evidence',kind:'fresh_activity',state:'idle'}});
    expect(both(f)).toMatchObject({restoreOutcome:'operator_recovered',continuityOutcome:null,lifecycleState:'running'});
  });
  it('does not use a corrupt receipt or later completion to fill an earlier attempt', () => {
    const f=fixture('subset'), id=receipt(f);
    f.db.prepare("UPDATE events SET payload='{' WHERE type='restore.completed'").run();
    reconcile(f,id);
    expect(both(f).continuityOutcome).toBeNull();
    f.bus.emit({type:'restore.started',rigId:f.rig.id,snapshotId:'s2'});
    f.bus.emit({type:'restore.completed',rigId:f.rig.id,snapshotId:'s2',result:{snapshotId:'s2',preRestoreSnapshotId:null,rigResult:'failed',nodes:[{nodeId:f.node.id,logicalId:'worker',status:'failed'}],warnings:[]}});
    reconcile(f,id);
    expect(both(f).continuityOutcome).toBeNull();
  });
  it('preserves explicit historical outcomes and applicable identity downranking', () => {
    const f=fixture('subset');
    reconcile(f,receipt(f));
    for (const explicit of ['failed','fresh','resumed','rebuilt','forked']) {
      f.db.prepare('UPDATE nodes SET continuity_outcome=? WHERE id=?').run(explicit,f.node.id);
      expect(both(f).continuityOutcome).toBe(explicit);
    }
    f.identities.upsert({nodeId:f.node.id,verdict:'mismatch',evidenceSource:'pane_process',reason:'process_identity_mismatch',evidence:{registeredPane:'%991',observedPid:991,observedCommand:'bash',matchedLayer:null},sessionName:f.name,observedAt:new Date().toISOString()});
    expect(both(f).lifecycleState).toBe('attention_required');
  });
});
