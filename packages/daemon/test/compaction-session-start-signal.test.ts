// #3389: an accepted /compact is not a compaction. Claude Code holds a /compact the seat accepted behind the turn it is
// running, while the three post-compaction messages join that turn. The first step therefore waits for the seat's own
// report of its compaction (SessionStart, source compact, from this occupant, at or after this attempt's /compact write),
// goes ahead without it after a bound (fail open), owes the sequence once more if the report comes late, and keeps all of
// that across a daemon restart. The real enforcer, delivery guard and session transport over a fake tmux; the report is
// the injected `compactSignalSince`, which production reads from the persisted SessionStart hook events.
import {afterEach, expect, it, vi} from 'vitest';
import {mkdirSync, writeFileSync, rmSync, mkdtempSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ClaudeCompactionEnforcer, COMPACT_SIGNAL_WAIT_MS_DEFAULT, LATE_COMPACT_SIGNAL_WATCH_MS_DEFAULT, buildPostCompactTurnBoundaryPrompt, type CompactSignal} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';
import {createFullTestDb} from './helpers/test-app.js';
import {RigRepository} from '../src/domain/rig-repository.js';
import {SessionRegistry} from '../src/domain/session-registry.js';
import {EventBus} from '../src/domain/event-bus.js';
import {AgentActivityStore} from '../src/domain/agent-activity-store.js';
import {QueueRepository} from '../src/domain/queue-repository.js';
import {createDb} from '../src/db/connection.js';
import {migrate} from '../src/db/migrate.js';
import {ALL_MIGRATIONS} from '../src/db/all-migrations.js';
import {reportRestoreDeliveryFailure} from '../src/domain/compaction-restore-notice.js';
import type {RestoreDeliveryFailure} from '../src/domain/claude-compaction-enforcer.js';

const seat = 'writer@demo', high = {sessionName: seat, runtime: 'claude-code', usedPercentage: 90};
const POLL = 30_000;
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, {recursive: true, force: true}); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'compaction-signal-')); homes.push(home);
  let clock = 10_000, generation = 'generation-one', body = '';
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const db = {prepare: () => ({get: () => undefined, all: () => []})} as any;
  const writes: string[] = [];
  const policy = {preparationRoot: '', enabled: true, thresholdPercent: 80, preCompactInstruction: 'Write a restore map.', compactInstruction: '', messageInline: '', messageFilePath: '', postRestoreAuditInstruction: ''};
  const tmux = {
    probeSession: vi.fn(async () => ({state: 'present'})),
    sendKeys: vi.fn(async (_: string, keys: string[]) => { if (keys.includes('Enter')) body = ''; return {ok: true}; }),
    sendText: vi.fn(async (_: string, text: string) => { writes.push(text); body += text; return {ok: true}; }),
  };
  const guard = new SeatDeliveryGuard(db, () => ({nodeId: 'node-one', session: seat, pane: '%1', occupant: generation}));
  Object.assign(tmux, {deliveryGuard: guard});
  const transport = new SessionTransport({db, rigRepo: {} as any, sessionRegistry: {} as any, tmuxAdapter: tmux as any, sleep: async (ms) => { clock += ms; }, now: () => new Date(clock), waitForIdlePollMs: 5});
  (transport as any).getSessionMeta = () => ({runtime: 'claude-code', attachmentType: 'tmux', nodeId: 'node-one', pane: '%1', occupant: generation, resumeToken: 'native-one'});
  (transport as any).claudeDeliveryObservation = async () => ({state: 'unknown', detail: 'injected process observation'});
  (transport as any).classifySendReadiness = async () => ({state: 'idle', reason: 'fixture', evidenceSource: 'fixture'});
  (transport as any).diagnoseProducerLink = async () => 'fixture';
  (transport as any).capture = async () => ({ok: true, sessionName: seat, content: body, inputBox: {status: body ? 'typed' : 'empty'}});
  const settings = {resolveClaudeCompactionPolicy: () => policy};
  // The seat's own reports of a compaction, as the daemon would find them in its recorded SessionStart hook events.
  const signals: CompactSignal[] = [];
  // The reader is asked for one occupant generation, as the real store is: reports of another generation, or of none, are not
  // candidates, so they cannot stand in front of a later report from this occupant.
  const since = vi.fn((_session: string, sinceMs: number, generation: string): CompactSignal | null =>
    signals.filter((s) => s.observedAt >= sinceMs && s.generation === generation).sort((a, b) => a.observedAt - b.observedAt)[0] ?? null);
  // A daemon process: a new one shares the instance home, the seat, the clock and the recorded reports, and nothing in memory.
  const daemon = (options: NonNullable<ConstructorParameters<typeof ClaudeCompactionEnforcer>[2]> = {}) =>
    new ClaudeCompactionEnforcer(settings as any, transport, {openrigHome: home, daemonInstance: randomUUID(), now: () => clock, sleep: async (ms) => { clock += ms; },
      resolveOccupantGeneration: () => generation, compactSignalSince: since, ...options});
  return {daemon, transport, writes, policy, since, signals, home, now: () => clock, advance: (ms: number) => { clock += ms; }, generation: (g: string) => { generation = g; }};
}
type F = ReturnType<typeof fixture>;
const compacts = (f: F) => f.writes.filter((t) => t.startsWith('/compact'));
const boundaries = (f: F) => f.writes.filter((t) => t === buildPostCompactTurnBoundaryPrompt());
const restores = (f: F) => f.writes.filter((t) => t.includes('restoring this Claude session after compaction'));
const audits = (f: F) => f.writes.filter((t) => t.startsWith('Now audit your compaction restore'));
const sequences = (f: F) => ({boundaries: boundaries(f).length, restores: restores(f).length, audits: audits(f).length});
function completeMap(e: ClaudeCompactionEnforcer) {
  const a = e.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), {recursive: true});
  writeFileSync(a.mapPath + '.tmp', `# Restore map\nCurrent work and next step.\n${a.marker}\n`);
  return a;
}
/** What the context monitor does for a seat whose sample is stale (a seat in a turn that has not ended). */
async function tick(e: ClaudeCompactionEnforcer, ms = POLL) {
  const outcome = e.hasPendingPostCompactStage(seat, {cwd: null, runtime: 'claude-code'})
    ? await e.drainPendingPostCompactStage({sessionName: seat, runtime: 'claude-code'})
    : await e.drainPendingPreparedCompact({sessionName: seat, runtime: 'claude-code'});
  e.reconcilePreparations();
  return outcome;
}
const recordFiles = new WeakMap<ClaudeCompactionEnforcer, string>();
async function compact(f: F, options = {}) {
  const e = f.daemon(options); await e.maybeAutoCompact(high); const map = completeMap(e); await e.maybeAutoCompact(high);
  expect(compacts(f)).toHaveLength(1);
  recordFiles.set(e, join(dirname(map.mapPath), 'COMPACTION-STATE.json'));
  return e;
}
const recordOf = (e: ClaudeCompactionEnforcer) => JSON.parse(readFileSync(recordFiles.get(e)!, 'utf8'));

it('a /compact queued behind a busy turn: the three steps wait for the seat\'s report, then go once each', async () => {
  const f = fixture(); const e = await compact(f);
  // The turn goes on for minutes: every poll finds the steps owed and nothing reported.
  for (let i = 0; i < 6; i++) { f.advance(POLL); expect(await tick(e)).toMatchObject({triggered: false, reason: 'awaiting_compact_signal'}); }
  expect(sequences(f)).toEqual({boundaries: 0, restores: 0, audits: 0});
  expect(e.hasPendingPostCompactStage(seat, {cwd: null, runtime: 'claude-code'})).toBe(true);
  // The turn ends, /compact runs, the seat reports it.
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  expect(compacts(f)).toHaveLength(1);
  expect(e.hasPendingPostCompactStage(seat, {cwd: null, runtime: 'claude-code'})).toBe(false);
});

it('a compaction that ran at once is reported before the first poll: the steps go with no extra wait', async () => {
  const f = fixture(); const e = await compact(f);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  await tick(e); expect(sequences(f)).toEqual({boundaries: 1, restores: 0, audits: 0});
  await tick(e); await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it('a report older than the /compact write, or from another occupant, releases nothing', async () => {
  const f = fixture(); f.advance(5 * POLL);
  f.signals.push({observedAt: f.now() - 1, generation: 'generation-one'}); // a compaction from before this write
  const e = await compact(f);
  f.signals.push({observedAt: f.now(), generation: 'generation-two'});     // another occupant's
  f.signals.push({observedAt: f.now(), generation: null});                  // a report that names no occupant
  for (let i = 0; i < 3; i++) { f.advance(POLL); expect(await tick(e)).toMatchObject({reason: 'awaiting_compact_signal'}); }
  expect(sequences(f)).toEqual({boundaries: 0, restores: 0, audits: 0});
});

it('no report at all: after the bound the steps go ahead as before (fail open), once each', async () => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT - POLL); expect(await tick(e)).toMatchObject({reason: 'awaiting_compact_signal'});
  expect(boundaries(f)).toHaveLength(0);
  f.advance(POLL);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  expect(recordOf(e)).toMatchObject({compactSignalFellBackAt: expect.any(Number)});
});

it('a report that comes after the fallback sequence owes the sequence once more, and a repeat of it owes nothing', async () => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  // The turn finally ends and /compact runs; the report is posted by two hooks (the managed and the plugin route).
  f.advance(20 * POLL);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'}, {observedAt: f.now() + 3, generation: 'generation-one'});
  for (let i = 0; i < 6; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
  // Read again on later polls: the same report, nothing owed.
  for (let i = 0; i < 4; i++) { f.advance(POLL); await tick(e); }
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
  expect(compacts(f)).toHaveLength(1);
});

it('a report that arrives while the fallback sequence is still going owes the sequence once more after it, not inside it', async () => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  await tick(e); expect(sequences(f)).toEqual({boundaries: 1, restores: 0, audits: 0});
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  await tick(e); expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 0});
  for (let i = 0; i < 6; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
});

it('a report after the watch ends, or for a seat that has a new occupant, owes nothing', async () => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  f.advance(LATE_COMPACT_SIGNAL_WATCH_MS_DEFAULT);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 3; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});

  const g = fixture(); const ge = await compact(g);
  g.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(ge);
  g.generation('generation-two');
  g.signals.push({observedAt: g.now(), generation: 'generation-one'});
  for (let i = 0; i < 3; i++) await tick(ge);
  expect(sequences(g)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it('a restart while the steps wait keeps the wait: nothing goes early, the bound runs from the original write, and a report releases them', async () => {
  const f = fixture(); const first = await compact(f);
  f.advance(4 * 60_000); await tick(first);
  expect(recordOf(first)).toMatchObject({compactWriteAt: expect.any(Number)});
  // A new daemon process, minutes later: nothing in memory, the record beside the map.
  const restarted = f.daemon();
  expect(await tick(restarted)).toMatchObject({reason: 'awaiting_compact_signal'});
  expect(sequences(f)).toEqual({boundaries: 0, restores: 0, audits: 0});
  // 6 more minutes make 10 from the write, not 10 from the restart.
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT - 4 * 60_000);
  for (let i = 0; i < 4; i++) await tick(restarted);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});

  const g = fixture(); const gFirst = await compact(g);
  g.advance(60_000); await tick(gFirst);
  const gRestarted = g.daemon();
  g.signals.push({observedAt: g.now(), generation: 'generation-one'});
  for (let i = 0; i < 4; i++) await tick(gRestarted);
  expect(sequences(g)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it('a restart after the fallback sequence still owes the sequence once more to a late report', async () => {
  const f = fixture(); const first = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(first);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  const restarted = f.daemon();
  await tick(restarted); expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  f.advance(15 * POLL);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 6; i++) await tick(restarted);
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
  for (let i = 0; i < 3; i++) await tick(f.daemon());
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
});

it('without a report source the steps follow the accepted /compact at once, as before', async () => {
  const f = fixture(); const e = await compact(f, {compactSignalSince: undefined});
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it('a report source that throws is no report: the bound still releases the steps', async () => {
  const f = fixture(); const e = await compact(f, {compactSignalSince: () => { throw new Error('events table unreadable'); }});
  expect(await tick(e)).toMatchObject({reason: 'awaiting_compact_signal'});
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

// A report that carries no generation, or a retired occupant's, is stored as such. It must not be the one the lookup returns:
// asked for this occupant's reports, the lookup skips it, so a later valid report still releases the steps (and, after the
// fallback, still owes the second sequence).
it('a persisted report with no generation does not hide a persisted current-occupant report (the real store)', async () => {
  const f = fixture();
  const db = createFullTestDb();
  try {
    const repo = new RigRepository(db);
    const rig = repo.createRig('demo');
    const node = repo.addNode(rig.id, 'writer', {runtime: 'claude-code'});
    const registry = new SessionRegistry(db);
    const session = registry.registerSession(node.id, seat);
    registry.updateStatus(session.id, 'running');
    registry.updateBinding(node.id, {tmuxSession: seat, attachmentType: 'tmux'});
    const store = new AgentActivityStore({db, eventBus: new EventBus(db), now: () => new Date(f.now())});
    const e = await compact(f, {compactSignalSince: (sessionName: string, sinceMs: number, generation: string) => store.findCompactSessionStart({sessionName, sinceMs, generation})});
    f.advance(POLL);
    expect(store.recordHookEvent({runtime: 'claude-code', sessionName: seat, hookEvent: 'SessionStart', subtype: 'compact', occurredAt: new Date(f.now()).toISOString()}).ok).toBe(true);
    f.advance(1);
    expect(store.recordHookEvent({runtime: 'claude-code', sessionName: seat, hookEvent: 'SessionStart', subtype: 'compact', generation: 'generation-one', occurredAt: new Date(f.now()).toISOString()}).ok).toBe(true);
    for (let i = 0; i < 4; i++) await tick(e);
    expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  } finally {
    db.close();
  }
});

it.each([null, 'generation-retired'])('a nonmatching report (%s) does not hide this occupant\'s report, before the fallback', async (generation) => {
  const f = fixture(); const e = await compact(f);
  f.advance(POLL);
  f.signals.push({observedAt: f.now(), generation});
  f.advance(1);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  // The one report that released the steps owes nothing more, however long it stays on record.
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  f.advance(POLL);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it.each([null, 'generation-retired'])('a nonmatching report (%s) does not hide a late report of this occupant after the fallback', async (generation) => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  f.advance(POLL);
  f.signals.push({observedAt: f.now(), generation});
  f.advance(1);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 6; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
});

it('a nonmatching report alone, before or after the fallback, releases nothing and owes nothing', async () => {
  const f = fixture(); const e = await compact(f);
  f.signals.push({observedAt: f.now(), generation: null}, {observedAt: f.now(), generation: 'generation-retired'});
  await tick(e); expect(sequences(f)).toEqual({boundaries: 0, restores: 0, audits: 0});
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  f.advance(POLL); f.signals.push({observedAt: f.now(), generation: 'generation-retired'});
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});

it('a reader\'s answer with no generation, or older than the write, is no answer', async () => {
  const f = fixture();
  const e = await compact(f, {compactSignalSince: (_s: string, sinceMs: number) => ({observedAt: sinceMs + 1, generation: ''} as CompactSignal)});
  for (let i = 0; i < 3; i++) { f.advance(POLL); expect(await tick(e)).toMatchObject({reason: 'awaiting_compact_signal'}); }
  const g = fixture();
  const ge = await compact(g, {compactSignalSince: (_s: string, sinceMs: number) => ({observedAt: sinceMs - 1, generation: 'generation-one'})});
  for (let i = 0; i < 3; i++) { g.advance(POLL); expect(await tick(ge)).toMatchObject({reason: 'awaiting_compact_signal'}); }
  expect(sequences(f)).toEqual({boundaries: 0, restores: 0, audits: 0});
  expect(sequences(g)).toEqual({boundaries: 0, restores: 0, audits: 0});
});

// PR review findings (#3399), each proved against the code as it was before its fix.

it('after a no-launch adoption, a report that carries the launch generation releases the steps (adopted occupant)', async () => {
  const f = fixture();
  const db = createFullTestDb();
  try {
    const repo = new RigRepository(db);
    const rig = repo.createRig('demo');
    const node = repo.addNode(rig.id, 'writer', {runtime: 'claude-code'});
    const registry = new SessionRegistry(db);
    const session = registry.registerSession(node.id, seat);
    registry.updateStatus(session.id, 'running');
    registry.updateBinding(node.id, {tmuxSession: seat, attachmentType: 'tmux'});
    const launch = registry.currentOccupantTenure(node.id)!.generationUuid;
    // A reconcile adopts the live process: a new generation, though the process's hooks still carry the one it launched with.
    const adopted = registry.mintOccupantTenure(node.id, 'adopt').generationUuid;
    expect(adopted).not.toBe(launch);
    expect(registry.currentOccupantGenerationForSession(seat)).toBe(adopted);
    const store = new AgentActivityStore({db, eventBus: new EventBus(db), now: () => new Date(f.now()),
      resolveOccupantGeneration: (id) => registry.currentOccupantTenure(id)?.generationUuid ?? null,
      isRegisteredOccupantGeneration: (id, g) => registry.isOccupantGenerationRegistered(id, g),
      isOccupantContinuedByAdoption: (id, g) => registry.isOccupantContinuedByAdoption(id, g)});
    const e = await compact(f, {resolveOccupantGeneration: (name: string) => registry.currentOccupantGenerationForSession(name),
      compactSignalSince: (sessionName: string, sinceMs: number, generation: string) => store.findCompactSessionStart({sessionName, sinceMs, generation})});
    f.advance(POLL);
    expect(store.recordHookEvent({runtime: 'claude-code', sessionName: seat, hookEvent: 'SessionStart', subtype: 'compact', generation: launch, occurredAt: new Date(f.now()).toISOString()}).ok).toBe(true);
    for (let i = 0; i < 4; i++) await tick(e);
    expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
    // Once a later launch has replaced the launched occupant, its reports are no longer this occupant's.
    const relaunched = registry.mintOccupantTenure(node.id, 'fresh').generationUuid;
    expect(store.findCompactSessionStart({sessionName: seat, sinceMs: 0, generation: relaunched})).toBeNull();
  } finally {
    db.close();
  }
});

it('waiting for the seat\'s report is not a restore-delivery failure: nothing is recorded or reported while it waits', async () => {
  const f = fixture();
  const failures: unknown[] = [];
  const e = await compact(f, {onRestoreDeliveryFailure: async (failure: unknown) => { failures.push(failure); }});
  for (let i = 0; i < 6; i++) { f.advance(POLL); expect(await tick(e)).toMatchObject({reason: 'awaiting_compact_signal'}); }
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(failures).toEqual([]);
  expect(e.getOwedRestore(seat)).toMatchObject({stage: 'turn_boundary', held: false, detail: expect.stringContaining('reports its compaction')});
  expect(e.getOwedRestore(seat)?.lastDelivery).toBeUndefined();
});

it('an operator-initiated manual compaction keeps its authority across a restart: its late report still owes the sequence when automatic compaction is off', async () => {
  const f = fixture(); f.policy.enabled = false;
  const first = f.daemon();
  expect(await first.triggerManualCompact({sessionName: seat, runtime: 'claude-code', usedPercentage: null}, {skipMap: true, operatorInitiated: true}))
    .toMatchObject({triggered: true});
  expect(compacts(f)).toHaveLength(1);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(first);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  const restarted = f.daemon();
  await tick(restarted);
  f.advance(POLL);
  f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 6; i++) await tick(restarted);
  expect(sequences(f)).toEqual({boundaries: 2, restores: 2, audits: 2});
});

it('a cancel after the fallback sequence ends the late-report watch, also across a restart', async () => {
  const f = fixture(); const e = await compact(f);
  f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  e.cancelPreparation(seat);
  f.advance(POLL); f.signals.push({observedAt: f.now(), generation: 'generation-one'});
  for (let i = 0; i < 4; i++) await tick(e);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
  const restarted = f.daemon();
  for (let i = 0; i < 4; i++) await tick(restarted);
  expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
});


it('a late signal re-owes the same attempt: repeated failure reopens only its system completion, preserving owner closure and sending no wake', async () => {
  const db = createDb(); migrate(db, ALL_MIGRATIONS);
  try {
    const queueSend = vi.fn(async () => ({ok: true, verified: true}));
    const queue = new QueueRepository(db, new EventBus(db), {validateRig: () => true, loadHumanRegistry: () => ({ok: true, entities: []}), transport: {send: queueSend}});
    const complete = vi.fn(async (receipt: RestoreDeliveryFailure) => reportRestoreDeliveryFailure(db, queue, receipt, {completed: true}));
    const failure = vi.fn(async (receipt: RestoreDeliveryFailure) => reportRestoreDeliveryFailure(db, queue, receipt));
    const f = fixture(); const e = await compact(f, {onRestoreDeliveryComplete: complete, onRestoreDeliveryFailure: failure});
    const attemptId = e.getPreparationState(seat)!.attemptId;
    const id = `qitem-compaction-restore-${attemptId}`;
    await queue.create({qitemId: id, sourceSession: seat, destinationSession: 'owner@demo', summary: 'restore owed', body: 'restore owed', nudge: false});
    f.advance(COMPACT_SIGNAL_WAIT_MS_DEFAULT);
    for (let i = 0; i < 4; i++) await tick(e);
    expect(sequences(f)).toEqual({boundaries: 1, restores: 1, audits: 1});
    expect(queue.getById(id)?.state).toBe('done');
    const firstClose = queue.closingTransition(id, 'done')!;
    expect(firstClose.actorSession).toBe('system:compaction');
    expect(complete).toHaveBeenCalledTimes(1);
    vi.spyOn(f.transport, 'send').mockResolvedValue({ok: false, reason: 'target_needs_input'});
    f.advance(20 * POLL);
    f.signals.push({observedAt: f.now(), generation: 'generation-one'});
    await tick(e); // This poll reseeds; the next polls attempt delivery.
    expect(e.hasPendingPostCompactStage(seat)).toBe(true);
    await tick(e); await tick(e); await Promise.resolve();
    expect(recordOf(e).attemptId).toBe(attemptId);
    expect(failure).toHaveBeenCalled();
    expect(queue.getById(id)).toMatchObject({state: 'pending', summary: expect.stringContaining('target_needs_input')});
    expect(queue.listTransitions(id)).toContainEqual(firstClose);
    expect(queue.listTransitions(id).at(-1)?.transitionNote).toContain('re-owed');
    queue.update({qitemId: id, actorSession: 'owner@demo', state: 'done', closureReason: 'no-follow-on', resolution: 'Owner handled this restore', transitionNote: 'Owner handled this restore'});
    const ownerClosed = queue.listTransitions(id);
    await tick(e); await tick(e); await Promise.resolve();
    expect(queue.getById(id)?.state).toBe('done');
    expect(queue.listTransitions(id)).toEqual(ownerClosed);
    expect(queueSend).not.toHaveBeenCalled();
    expect(queue.list({destinationSession: 'owner@demo', state: 'done'})).toHaveLength(1);
  } finally { db.close(); }
});
