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
type Strict = NonNullable<ConstructorParameters<typeof SeatAttentionReconciler>[0]['reconcileRestoreOutcome']>;
function fixture(kind: 'subset' | 'full' | 'startup' | 'identity', explicit: string | null = null, strict?: Strict) {
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
  const clear = new SeatAttentionReconciler({db,sessionRegistry:registry,eventBus:bus,agentActivityStore:new AgentActivityStore({db,eventBus:bus}),sendVerify,
    ...(strict ? {reconcileRestoreOutcome:strict} : {})});
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
  return {db,node,identities,name,inventory,post,events,sendVerify,repo,registry,bus,rig,clear};
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
  // A full restore's attention is acknowledged on --reason instead (below); its recovery is never claimed.
  it.each(['identity'] as const)('%s class is not bypassed by reason',async kind=>{
    const f=fixture(kind),before=f.inventory(),result=await f.post('operator reports this seat is working');
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('not_demonstrably_responsive');
    expect(result.body.detail).toContain('pane_identity');
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

// #2473 (Root's disposition, section 3): when the strict reconciler can't settle a full restore's attention, the
// person's --reason acknowledges that attempt's attention for that occupant, never as a recovery.
describe('full-restore acknowledgement when recovery cannot be proven', () => {
  type F = ReturnType<typeof fixture>;
  const unproven = {code:'process_lineage_mismatch', detail:'the process list could not be read'};
  const reason = 'checked the pane: the conversation is there';
  const proof = {tmux:true, fgProcess:'claude', resumeTokenUsed:true, paneState:'usable' as const};
  const strictSays = (result: Awaited<ReturnType<Strict>>, during?: () => void) => vi.fn(async () => { during?.(); return result; });
  const unsure = (during?: () => void) => strictSays({ok:false, ...unproven}, during);
  const attempt = (f: F) => (f.db.prepare("SELECT seq FROM events WHERE type='restore.started' ORDER BY seq LIMIT 1").get() as {seq:number}).seq;
  const acks = (f: F) => f.db.prepare("SELECT payload FROM events WHERE type='restore.outcome_acknowledged' ORDER BY seq").all()
    .map((r:any)=>JSON.parse(r.payload));
  const entry = (f: F) => {
    const local = getNodeInventory(f.db, f.rig.id).find(e => e.nodeId === f.node.id)!;
    expect(getNodeInventoryForRigs(f.db, new Set([f.rig.id])).get(f.rig.id)!.find(e => e.nodeId === f.node.id)).toEqual(local);
    return local;
  };
  const restore = (f: F, nodeId: string, status = 'attention_required') => {
    f.bus.emit({type:'restore.started', rigId:f.rig.id, snapshotId:'s2', intendedRoster:[{nodeId, logicalId:'worker'}]});
    f.bus.emit({type:'restore.completed', rigId:f.rig.id, snapshotId:'s2', result:{snapshotId:'s2', preRestoreSnapshotId:null,
      rigResult:'partially_restored', nodes:[{nodeId, logicalId:'worker', status}], warnings:[]}} as never);
  };

  it.each([['an unreadable process list', () => unsure()], ['no strict reconciler', () => undefined]] as const)(
    'without --reason, %s leaves the attention and says how to acknowledge it', async (_case, strict) => {
      const f = fixture('full', null, strict()), before = f.inventory();
      const result = await f.post();
      expect(result.status).toBe(422);
      expect(result.body.detail).toContain('--reason "<what you saw>" acknowledges this attention without claiming the conversation resumed');
      expect(acks(f)).toEqual([]);
      expect(f.inventory()).toEqual(before);
      expect(before.lifecycleState).toBe('attention_required');
    });

  it.each([['an unreadable process list', () => unsure(), unproven],
    ['no strict reconciler', () => undefined, {code:'strict_reconciler_unavailable', detail:'the strict restore reconciler is unavailable'}]] as const)(
    'with --reason, %s is acknowledged as unproven and never recorded as a recovery', async (_case, strict, expected) => {
      const f = fixture('full', null, strict()), sessionId = f.registry.getSessionsForRig(f.rig.id)[0]!.id;
      const result = await f.post(reason);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ok:true, clearedBy:'operator_attestation', clearedClasses:['restore_outcome'],
        acknowledgment:{attemptId:attempt(f), from:'attention_required', unproven:expected}});
      expect(acks(f)).toEqual([{type:'restore.outcome_acknowledged', rigId:f.rig.id, nodeId:f.node.id, attemptId:attempt(f),
        from:'attention_required', sessionId, reason, unproven:expected}]);
      expect(f.events()).toEqual([]);
      expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', continuityOutcome:null, lifecycleState:'running',
        restoreAcknowledgment:{attemptId:attempt(f), reason, unproven:expected}});
      expect(new SeatStatusService({rigRepo:f.repo}).getStatus(f.name)).toMatchObject({ok:true,
        status:{restore_outcome:'attention_required', continuity_outcome:null}});
      expect(f.sendVerify).not.toHaveBeenCalled();
      expect((await f.post(reason)).body.code).toBe('not_in_attention');
    });

  it('a successful native recovery is unchanged by --reason', async () => {
    let f!: F;
    f = fixture('full', null, vi.fn(async () => {
      f.bus.emit({type:'restore.outcome_reconciled', rigId:f.rig.id, nodeId:f.node.id, attemptId:attempt(f), from:'attention_required',
        to:'operator_recovered', evidence:proof});
      return {ok:true as const, attemptId:attempt(f), from:'attention_required' as const, to:'operator_recovered' as const, evidence:proof};
    }));
    const result = await f.post(reason);
    expect(result.body).toMatchObject({ok:true, clearedBy:'evidence', derivedEvidence:{source:'restore_runtime_truth'}});
    expect(result.body.acknowledgment).toBeUndefined();
    expect(acks(f)).toEqual([]);
    expect(entry(f)).toMatchObject({restoreOutcome:'operator_recovered', continuityOutcome:'resumed', lifecycleState:'running'});
    expect(entry(f).restoreAcknowledgment).toBeUndefined();
  });

  it('the strict check still runs on activity after an acknowledgement, and its proof settles the attempt', async () => {
    const strict = unsure(), f = fixture('full', null, strict);
    await f.post(reason);
    expect(await f.clear.onSeatActivity(f.name, 'running')).toBe(false);
    expect(strict).toHaveBeenCalledTimes(2);
    f.bus.emit({type:'restore.outcome_reconciled', rigId:f.rig.id, nodeId:f.node.id, attemptId:attempt(f), from:'attention_required',
      to:'operator_recovered', evidence:proof});
    expect(entry(f)).toMatchObject({restoreOutcome:'operator_recovered', continuityOutcome:'resumed', lifecycleState:'running'});
    expect(entry(f).restoreAcknowledgment).toBeUndefined();
  });

  it.each([
    ['a newer occupant', (f: F) => { f.registry.registerSession(f.node.id, f.name); }],
    ['a changed binding', (f: F) => { f.registry.updateBinding(f.node.id, {tmuxSession:'another@attention-specimen', tmuxPane:'%991'}); }],
    ['a changed token', (f: F) => { f.db.prepare("UPDATE sessions SET resume_token='another-token' WHERE node_id=?").run(f.node.id); }],
    ['a restore that includes this seat', (f: F) => { f.bus.emit({type:'restore.started', rigId:f.rig.id, snapshotId:'s2',
      intendedRoster:[{nodeId:f.node.id, logicalId:'worker'}]}); }],
    ['a restore whose roster is not recorded', (f: F) => { f.bus.emit({type:'restore.started', rigId:f.rig.id, snapshotId:'s2'}); }],
  ] as const)('a change while the check ran is not acknowledged: %s', async (_case, change) => {
    let f!: F;
    f = fixture('full', null, unsure(() => change(f)));
    const result = await f.post(reason);
    expect(result.status).toBe(422);
    expect(result.body.detail).toContain('Not acknowledged: the seat changed while it was checked');
    expect(acks(f)).toEqual([]);
  });

  it('a pane the check rebinds itself does not block the acknowledgement', async () => {
    let f!: F;
    f = fixture('full', null, unsure(() => { f.registry.updateBinding(f.node.id, {tmuxSession:f.name, tmuxPane:'%992'}); }));
    expect((await f.post(reason)).status).toBe(200);
    expect(acks(f)).toHaveLength(1);
  });

  it('a positive binding mismatch is not acknowledged', async () => {
    const f = fixture('full', null, strictSays({ok:false, code:'binding_mismatch', detail:'Canonical binding does not match the latest session row.'}));
    const result = await f.post(reason);
    expect(result.status).toBe(422);
    expect(result.body.detail).toContain("Not acknowledged: the seat's binding disagrees with its latest session");
    expect(acks(f)).toEqual([]);
  });

  const identity = (f: F, reasonCode: 'process_identity_mismatch' | 'process_identity_ambiguous') => f.identities.upsert({nodeId:f.node.id,
    verdict:'mismatch', evidenceSource:'pane_process', reason:reasonCode,
    evidence:{registeredPane:'%991', observedPid:991, observedCommand:'bash', matchedLayer:null}, sessionName:f.name, observedAt:new Date().toISOString()});

  it('a positive pane-identity mismatch is not acknowledged', async () => {
    const f = fixture('full', null, unsure());
    identity(f, 'process_identity_mismatch');
    const result = await f.post(reason);
    expect(result.status).toBe(422);
    expect(result.body.detail).toContain('Not acknowledged: the pane identity is positively mismatched or missing. --reason cannot bypass this attention class');
    expect(acks(f)).toEqual([]);
  });

  it('a pane identity that could not be proven keeps its own class; the restore is still acknowledged', async () => {
    const f = fixture('full', null, unsure());
    identity(f, 'process_identity_ambiguous');
    const result = await f.post(reason);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({clearedClasses:['restore_outcome'], acknowledgment:{paneIdentity:'unverified', unproven}});
    expect(acks(f)).toHaveLength(1);
    expect(f.identities.getForNode(f.node.id)).toMatchObject({verdict:'mismatch', reason:'process_identity_ambiguous'});
  });

  it('a restore that leaves this seat out, started while the check ran, does not change what is acknowledged', async () => {
    let f!: F;
    f = fixture('full', null, unsure(() => { f.bus.emit({type:'restore.started', rigId:f.rig.id, snapshotId:'s2',
      intendedRoster:[{nodeId:'another-node', logicalId:'other'}]}); }));
    const result = await f.post(reason);
    expect(result.status).toBe(200);
    expect(result.body.acknowledgment).toMatchObject({attemptId:attempt(f)});
    expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', lifecycleState:'running', restoreAcknowledgment:{attemptId:attempt(f)}});
  });

  it('an earlier attempt, after a newer restore left this seat out, is acknowledged for that attempt', async () => {
    const f = fixture('full', null, strictSays({ok:false, code:'node_not_found', detail:'Node has no record in the latest restore.completed event.'}));
    const first = attempt(f), other = f.repo.addNode(f.rig.id, 'other', {role:'worker', runtime:'claude-code'});
    restore(f, other.id, 'resumed');
    expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', lifecycleState:'attention_required'});
    const result = await f.post(reason);
    expect(result.body).toMatchObject({ok:true, acknowledgment:{attemptId:first, unproven:{code:'node_not_found'}}});
    expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', lifecycleState:'running', restoreAcknowledgment:{attemptId:first}});
  });

  it('a newer restore that includes this seat replaces the acknowledged outcome', async () => {
    const strict = unsure(), f = fixture('full', null, strict);
    await f.post(reason);
    restore(f, f.node.id);
    expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', lifecycleState:'attention_required'});
    expect(entry(f).restoreAcknowledgment).toBeUndefined();
    expect((await f.post()).status).toBe(422);
    expect(strict).toHaveBeenCalledTimes(2);
  });

  it('a newer occupant after the acknowledgement keeps its own attention', async () => {
    const f = fixture('full', null, unsure());
    await f.post(reason);
    f.registry.updateStatus(f.registry.registerSession(f.node.id, f.name).id, 'running');
    expect(entry(f)).toMatchObject({restoreOutcome:'attention_required', lifecycleState:'attention_required'});
    expect(entry(f).restoreAcknowledgment).toBeUndefined();
  });
});
