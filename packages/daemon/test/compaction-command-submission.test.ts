// Managed /compact must stay short enough that Claude Code runs it as a command, reach the seat only when it
// is idle, and never be reported as more than OpenRig knows. Native evidence (Claude Code 2.1.282, idle
// seat, bracketed paste): 792 characters ran as a command, 850 arrived as pasted text. Real SessionTransport
// over a recording tmux; no tmux server, no Claude Code.
import {afterEach, expect, it, vi} from 'vitest';
import {Hono} from 'hono';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {compactionRoutes} from '../src/routes/compaction.js';
import {ClaudeCompactionEnforcer, AUTO_PREP_WAIT_MS_DEFAULT, MANAGED_COMPACT_COMMAND_MAX_CHARS, MANAGED_COMPACT_PREFIX, MANAGED_COMPACT_TRUST_NOTE, composeManagedCompactCommand, buildCompactCommand} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';

const seat = 'writer@demo', input = {sessionName: seat, runtime: 'claude-code', usedPercentage: 90};
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, {recursive: true, force: true}); });

function fixture(compactInstruction = '') {
  const policyRef = {compactInstruction};
  const home = mkdtempSync(join(tmpdir(), 'compaction-command-')); homes.push(home);
  let clock = 10_000, activity = 'idle';
  let onSleep: (() => void) | undefined;
  const generation = 'generation-one';
  const db = {prepare: () => ({get: () => undefined, all: () => []})} as any;
  // Every input event in order: a text write with its options, or a key.
  const events: Array<{kind: 'text'; text: string; bracketed: boolean} | {kind: 'keys'; keys: string[]}> = [];
  const policy = {enabled: true, thresholdPercent: 80, preCompactInstruction: 'Write a restore map.', get compactInstruction() { return policyRef.compactInstruction; }, messageInline: '', messageFilePath: '', postRestoreAuditInstruction: ''};
  const tmux = {
    probeSession: vi.fn(async () => ({state: 'present'})),
    sendText: vi.fn(async (_: string, text: string, _before?: unknown, options?: {bracketed?: boolean}) => { events.push({kind: 'text', text, bracketed: options?.bracketed !== false}); return {ok: true}; }),
    sendKeys: vi.fn(async (_: string, keys: string[]) => { events.push({kind: 'keys', keys}); return {ok: true}; }),
  };
  Object.assign(tmux, {deliveryGuard: new SeatDeliveryGuard(db, () => ({nodeId: 'node-one', session: seat, pane: '%1', occupant: generation}))});
  // The transport's idle wait runs on real time (Date.now deadlines), so its sleep is a real timer and never moves
  // the enforcer's clock: a fast machine must not spin the fake clock past the preparation deadline.
  const transport = new SessionTransport({db, rigRepo: {} as any, sessionRegistry: {} as any, tmuxAdapter: tmux as any, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(clock), waitForIdlePollMs: 5});
  (transport as any).getSessionMeta = () => ({runtime: 'claude-code', attachmentType: 'tmux', nodeId: 'node-one', pane: '%1', occupant: generation, resumeToken: 'native-one'});
  (transport as any).claudeDeliveryObservation = async () => ({state: 'unknown', detail: 'injected process observation'});
  (transport as any).classifySendReadiness = async () => ({state: activity, reason: 'fixture', evidenceSource: 'fixture'});
  (transport as any).diagnoseProducerLink = async () => 'fixture';
  const e = new ClaudeCompactionEnforcer({resolveClaudeCompactionPolicy: () => policy} as any, transport, {openrigHome: home, manualPrepWaitMs: 1000, compactSendIdleWaitMs: 20, now: () => clock, sleep: async (ms) => { clock += ms; onSleep?.(); }, resolveOccupantGeneration: () => generation});
  const stageMap = () => {
    const a = e.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), {recursive: true});
    writeFileSync(a.mapPath + '.tmp', `# Restore map\nCurrent work and next step.\n${a.marker}\n`);
  };
  const compactIndex = () => events.findIndex((ev) => ev.kind === 'text' && ev.text.startsWith('/compact'));
  const texts = () => events.filter((ev): ev is {kind: 'text'; text: string; bracketed: boolean} => ev.kind === 'text').map((ev) => ev.text);
  const compactText = () => (events[compactIndex()] as {text?: string} | undefined)?.text;
  return {e, transport, tmux, events, texts, compactText, policyRef, stageMap, compactIndex, onSleep: (fn: () => void) => { onSleep = fn; }, activity: (s: string) => { activity = s; }, advance: (ms: number) => { clock += ms; }};
}

const LONGEST_PATH = '/' + 'p'.repeat(4095); // PATH_MAX on Linux
const LONG_INSTRUCTION = 'Preserve the current task, queue ids, decisions and the next step. '.repeat(150);

it('the composed command stays within the budget, under the observed 792-character boundary', () => {
  const typicalPath = '/srv/work/team/dev-seat/.openrig/compaction/preparation/dev-seat@example-rig/0b8f3c2e-5d1a-4e7b-9c3f-2a6d8e4f1b7c/RESTORE-MAP.md';
  // The exported builder, given the map sentence as its instruction the way callers used to pass it.
  expect(buildCompactCommand(` Restore from this attempt's map: ${typicalPath}.`).length).toBeLessThanOrEqual(600);
  for (const compactInstruction of ['', 'Preserve the current task and next step.', LONG_INSTRUCTION]) {
    for (const mapPath of [null, typicalPath, LONGEST_PATH]) {
      const {command} = composeManagedCompactCommand({compactInstruction, mapPath});
      expect(command.length, `${compactInstruction.length}-char instruction, ${mapPath?.length ?? 0}-char path`).toBeLessThanOrEqual(MANAGED_COMPACT_COMMAND_MAX_CHARS);
      // #928: the hooks recognise a managed compaction by this prefix at the start of the arguments.
      expect(command.startsWith(`/compact ${MANAGED_COMPACT_PREFIX}`)).toBe(true);
    }
  }
  expect(MANAGED_COMPACT_COMMAND_MAX_CHARS).toBeLessThan(792);
  // The default case keeps the map path in the command.
  expect(composeManagedCompactCommand({compactInstruction: '', mapPath: typicalPath})).toMatchObject({mapPathInCommand: true, instructionInCommand: true});

});

it('what does not fit moves to the restore map: the full trust note always, a long policy instruction when needed', async () => {
  const f = fixture(LONG_INSTRUCTION);
  await f.e.maybeAutoCompact(input);
  const prep = (f.events[0] as {text: string}).text;
  expect(prep).toContain(MANAGED_COMPACT_TRUST_NOTE);
  expect(prep).toContain('too long for the /compact command, so it travels in this map');
  expect(prep).toContain(LONG_INSTRUCTION.trim().slice(0, 200));
  f.stageMap();
  await f.e.maybeAutoCompact(input);
  const command = (f.events[f.compactIndex()] as {text: string}).text;
  expect(command.length).toBeLessThanOrEqual(MANAGED_COMPACT_COMMAND_MAX_CHARS);
  expect(command).not.toContain('Preserve the current task');
  expect(command).toContain(f.e.getPreparationState(seat)!.mapPath);
});

it('a short policy instruction stays in the command and is not repeated in the map', async () => {
  const f = fixture('Preserve the current task and next step.');
  await f.e.maybeAutoCompact(input);
  expect((f.events[0] as {text: string}).text).not.toContain('too long for the /compact command');
  f.stageMap();
  await f.e.maybeAutoCompact(input);
  const command = (f.events[f.compactIndex()] as {text: string}).text;
  expect(command).toMatch(/Preserve the current task and next step\.$/);
  // Still pasted the normal way: bracketed paste is proven to work under the boundary.
  expect(f.events[f.compactIndex()]).toMatchObject({bracketed: true});
});

it('automatic: a map that is ready while the seat is mid-turn waits for idle instead of sending, within the existing deadline', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  f.activity('running');
  const real = f.transport.send.bind(f.transport);
  const results: unknown[] = [];
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; });
  const busy = await f.e.maybeAutoCompact(input);
  // The real transport's answer for a busy seat, as the enforcer classified it.
  console.log('transport result for /compact at a busy seat:', JSON.stringify(results[0]));
  expect(results[0]).toMatchObject({ok: false, sent: false, waitedMs: expect.any(Number)});
  expect(busy).toEqual({triggered: false, reason: 'waiting_for_idle'});
  expect(f.compactIndex()).toBe(-1);
  // Still armed: not stopped, nothing sent.
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'waiting', compact: 'not_sent'});
  f.activity('idle');
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: true});
  expect(f.compactIndex()).toBeGreaterThan(-1);
});

it('automatic: a seat that never goes idle is disarmed by the existing preparation deadline, never sent to', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  f.activity('running');
  await f.e.maybeAutoCompact(input);
  f.advance(AUTO_PREP_WAIT_MS_DEFAULT + 1);
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', reason: 'preparation_incomplete', compact: 'not_sent'});
  expect(f.compactIndex()).toBe(-1);
});

it('state: after the command is sent it reads submitted_unconfirmed; delivery stays the preparation prompt\'s', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'waiting', delivery: 'delivered', compact: 'not_sent'});
  f.stageMap();
  await f.e.maybeAutoCompact(input);
  const state = f.e.getPreparationState(seat)!;
  expect(state).toMatchObject({status: 'compact-sent', delivery: 'delivered', compact: 'submitted_unconfirmed'});
});

it('state: a lost reply to the /compact send is uncertain', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  vi.spyOn(f.transport, 'send').mockRejectedValueOnce(new Error('receipt lost'));
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
});

it('route: --state says "submitted, unconfirmed" for the command and never that it ran', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  await f.e.maybeAutoCompact(input);
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('compactionEnforcer' as never, f.e); await next(); });
  app.route('/api/compaction', compactionRoutes());
  const body = await (await app.request(`/api/compaction/state?session=${encodeURIComponent(seat)}`)).json();
  expect(body.preparation).toMatchObject({compact: 'submitted_unconfirmed', delivery: 'delivered'});
  expect(body.compact).toMatch(/^submitted, unconfirmed: /);
  expect(body.compact).not.toMatch(/\bran\b|compacted|delivered/);
});

it('automatic: any send that reports nothing sent after an idle wait keeps the attempt armed, whatever its reason string', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  const real = f.transport.send.bind(f.transport);
  const notIdle = {ok: false, sessionName: seat, sent: false, reason: 'a_future_not_idle_reason', error: 'busy', activity: {state: 'running', reason: 'fixture', evidenceSource: 'fixture'}, waitedMs: 20, attempts: 3};
  const spy = vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => text.startsWith('/compact') ? notIdle as any : real(s, text, opts));
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: false, reason: 'waiting_for_idle'});
  console.log('not-idle send result as classified:', JSON.stringify(notIdle));
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'waiting', compact: 'not_sent'});
  spy.mockRestore();
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: true});
});

async function drainToRestore(f: ReturnType<typeof fixture>): Promise<string | undefined> {
  for (let i = 0; i < 6; i++) {
    await f.e.maybeAutoCompact({...input, usedPercentage: 10});
    const restore = f.texts().find((t) => t.startsWith('Please respond to this normal user message now by restoring'));
    if (restore) return restore;
  }
  return undefined;
}

it('a map path too long for the command still reaches the restore request, exactly', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  const attempt = f.e.getPreparationState(seat)!;
  // Simulate a deep workspace: the attempt's map path is longer than the command budget allows.
  const longPath = join(dirname(attempt.mapPath), ...Array.from({length: 6}, () => 'd'.repeat(95)), 'RESTORE-MAP.md');
  (f.e as any).pendingPreCompactPrep.get(seat).mapPath = longPath;
  mkdirSync(dirname(longPath), {recursive: true});
  writeFileSync(longPath + '.tmp', `# map\n${attempt.marker}\n`);
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: true});
  expect(f.compactText()).not.toContain(longPath);
  const restore = await drainToRestore(f);
  expect(restore).toContain(longPath);
});

it('the compaction instruction is fixed when preparation starts; a policy change mid-attempt does not mix in', async () => {
  const f = fixture('Keep the queue ids.');
  await f.e.maybeAutoCompact(input);
  f.policyRef.compactInstruction = 'A different instruction set later.';
  f.stageMap();
  await f.e.maybeAutoCompact(input);
  const command = f.compactText();
  expect(command).toContain('Keep the queue ids.');
  expect(command).not.toContain('A different instruction');
});

it('--skip-map with an instruction too long for the command carries the instruction through the restore request', async () => {
  const f = fixture(LONG_INSTRUCTION);
  expect(await f.e.triggerManualCompact({...input, usedPercentage: 40}, {operatorInitiated: true, skipMap: true})).toEqual({triggered: true, stage: 'compact-sent'});
  expect(f.compactText()).not.toContain('Preserve the current task');
  const restore = await drainToRestore(f);
  expect(restore).toContain(LONG_INSTRUCTION.trim().replace(/\s+/g, ' ').slice(0, 300));
});

it('a failed manual trigger reports the /compact result too', async () => {
  const f = fixture();
  f.onSleep(() => f.stageMap());
  const real = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => {
    if (text.startsWith('/compact')) throw new Error('receipt lost');
    return real(s, text, opts);
  });
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('compactionEnforcer' as never, f.e);
    c.set('sessionTransport' as never, f.transport);
    c.set('contextUsageStore' as never, {getForNode: () => ({availability: 'known', usedPercentage: 40})});
    c.set('db' as never, {prepare: () => ({get: () => ({node_id: 'node-one', runtime: 'claude-code', cwd: null})})});
    await next();
  });
  app.route('/api/compaction', compactionRoutes());
  (f.transport as any).resolveSessions = async () => ({ok: true, sessions: [seat]});
  const res = await app.request('/api/compaction/trigger', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({session: seat})});
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.preparation).toMatchObject({compact: 'uncertain'});
  expect(body.compact).toMatch(/^uncertain: /);
});
