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
import {ClaudeCompactionEnforcer, AUTO_PREP_WAIT_MS_DEFAULT, AUTO_RETRY_AFTER_STOP_MS_DEFAULT, MANAGED_COMPACT_COMMAND_MAX_CHARS, MANAGED_COMPACT_PREFIX, MANAGED_COMPACT_TRUST_NOTE, composeManagedCompactCommand, buildCompactCommand} from '../src/domain/claude-compaction-enforcer.js';
import {SessionTransport} from '../src/domain/session-transport.js';
import {SeatDeliveryGuard} from '../src/domain/seat-delivery-guard.js';

const seat = 'writer@demo', input = {sessionName: seat, runtime: 'claude-code', usedPercentage: 90};
const homes: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const h of homes.splice(0)) rmSync(h, {recursive: true, force: true}); });

function fixture(compactInstruction = '') {
  const policyRef = {compactInstruction};
  const home = mkdtempSync(join(tmpdir(), 'compaction-command-')); homes.push(home);
  let clock = 10_000, activity = 'idle';
  // What a runtime hook says, when it differs from the pane (null: the hook agrees with the pane).
  let hookActivity: string | null = null;
  let onSleep: (() => void) | undefined;
  // Runs on each text write after it is recorded; may return a receipt to use instead of ok.
  let onText: ((text: string) => {ok: boolean; code?: string; message?: string} | void) | undefined;
  // Runs before each key event is recorded as landed; may throw (an Enter whose outcome is lost).
  let onKeys: ((keys: string[]) => {ok: boolean; code?: string; message?: string} | void) | undefined;
  // When set, the seat-binding read throws (as a failing SQLite read would).
  let metaThrows = false;
  // When set, the pane reads as being in a tmux mode it cannot leave: the transport refuses before any input.
  let paneInMode = false;
  const generation = 'generation-one';
  const db = {prepare: () => ({get: () => undefined, all: () => []})} as any;
  // Every input event in order: a text write with its options, or a key.
  const events: Array<{kind: 'text'; text: string; bracketed: boolean} | {kind: 'keys'; keys: string[]}> = [];
  const policy = {enabled: true, thresholdPercent: 80, preCompactInstruction: 'Write a restore map.', get compactInstruction() { return policyRef.compactInstruction; }, messageInline: '', messageFilePath: '', postRestoreAuditInstruction: ''};
  const tmux = {
    probeSession: vi.fn(async () => ({state: 'present'})),
    isPaneInMode: vi.fn(async () => paneInMode),
    cancelPaneMode: vi.fn(async () => undefined),
    sendText: vi.fn(async (_: string, text: string, _before?: unknown, options?: {bracketed?: boolean}) => { events.push({kind: 'text', text, bracketed: options?.bracketed !== false}); return onText?.(text) ?? {ok: true}; }),
    sendKeys: vi.fn(async (_: string, keys: string[]) => { const receipt = onKeys?.(keys); events.push({kind: 'keys', keys}); return receipt ?? {ok: true}; }),
  };
  Object.assign(tmux, {deliveryGuard: new SeatDeliveryGuard(db, () => ({nodeId: 'node-one', session: seat, pane: '%1', occupant: generation}))});
  // The transport's idle wait runs on real time (Date.now deadlines), so its sleep is a real timer and never moves
  // the enforcer's clock: a fast machine must not spin the fake clock past the preparation deadline.
  const transport = new SessionTransport({db, rigRepo: {} as any, sessionRegistry: {} as any, tmuxAdapter: tmux as any, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => new Date(clock), waitForIdlePollMs: 5});
  (transport as any).getSessionMeta = () => { if (metaThrows) throw new Error('SQLITE_BUSY: database is locked'); return ({runtime: 'claude-code', attachmentType: 'tmux', nodeId: 'node-one', pane: '%1', occupant: generation, resumeToken: 'native-one'}); };
  (transport as any).claudeDeliveryObservation = async () => ({state: 'unknown', detail: 'injected process observation'});
  // A send that asks for pane-only readiness reads the pane; any other send may be decided by the hook.
  (transport as any).classifySendReadiness = async (q: {readinessFromPaneOnly?: boolean}) => ({state: !q.readinessFromPaneOnly && hookActivity !== null ? hookActivity : activity, reason: 'fixture', evidenceSource: 'fixture'});
  (transport as any).diagnoseProducerLink = async () => 'fixture';
  const e = new ClaudeCompactionEnforcer({resolveClaudeCompactionPolicy: () => policy} as any, transport, {openrigHome: home, manualPrepWaitMs: 1000, compactSendIdleWaitMs: 20, now: () => clock, sleep: async (ms) => { clock += ms; onSleep?.(); }, resolveOccupantGeneration: () => generation});
  const stageMap = () => {
    const a = e.getPreparationState(seat)!; mkdirSync(dirname(a.mapPath), {recursive: true});
    writeFileSync(a.mapPath + '.tmp', `# Restore map\nCurrent work and next step.\n${a.marker}\n`);
  };
  const compactIndex = () => events.findIndex((ev) => ev.kind === 'text' && ev.text.startsWith('/compact'));
  const texts = () => events.filter((ev): ev is {kind: 'text'; text: string; bracketed: boolean} => ev.kind === 'text').map((ev) => ev.text);
  const compactText = () => (events[compactIndex()] as {text?: string} | undefined)?.text;
  return {e, transport, tmux, events, texts, compactText, policyRef, stageMap, compactIndex, onSleep: (fn: () => void) => { onSleep = fn; }, onText: (fn: (text: string) => {ok: boolean; code?: string; message?: string} | void) => { onText = fn; }, onKeys: (fn: ((keys: string[]) => {ok: boolean; code?: string; message?: string} | void) | undefined) => { onKeys = fn; }, metaThrows: (v: boolean) => { metaThrows = v; }, paneInMode: (v: boolean) => { paneInMode = v; }, advance2: (ms: number) => { clock += ms; }, activity: (s: string) => { activity = s; }, hook: (s: string | null) => { hookActivity = s; }, advance: (ms: number) => { clock += ms; }};
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
  expect(results[0]).toMatchObject({ok: false, sent: false, inputPhase: 'not_reached', waitedMs: expect.any(Number)});
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

it('automatic: a known pre-input idle deferral (inputPhase not_reached) keeps the attempt armed, whatever its reason string', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  const real = f.transport.send.bind(f.transport);
  const notIdle = {ok: false, sessionName: seat, sent: false, inputPhase: 'not_reached', reason: 'a_future_not_idle_reason', error: 'busy', activity: {state: 'running', reason: 'fixture', evidenceSource: 'fixture'}, waitedMs: 20, attempts: 3};
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
    // Canonical-only fixture: no bindings table exists for alias normalization.
    c.set('db' as never, {prepare: (sql: string) => ({get: () => sql.includes('sqlite_master') ? undefined : ({node_id: 'node-one', runtime: 'claude-code', cwd: null})})});
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

it('a fresh idle hook while the pane still shows the seat working sends nothing; the attempt stays armed', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  f.hook('idle');       // the newest hook can predate the preparation turn's remaining work
  f.activity('running'); // the live pane shows the seat still working
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: false, reason: 'waiting_for_idle'});
  expect(f.compactIndex()).toBe(-1);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'waiting', compact: 'not_sent'});
  f.activity('idle');
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: true});
});

it('manual: a fresh idle hook while the pane shows work does not let /compact through either', async () => {
  const f = fixture();
  f.onSleep(() => f.stageMap());
  f.hook('idle');
  f.activity('running');
  vi.spyOn(f.transport, 'waitUntilIdle').mockResolvedValue({ok: true} as any); // the long wait passed on the hook
  const outcome = await f.e.triggerManualCompact({...input, usedPercentage: 40}, {operatorInitiated: true});
  expect(outcome).toMatchObject({triggered: false});
  expect(f.compactIndex()).toBe(-1);
});

// --- a failed or interrupted write is never retried and never reported as not sent -------------------------

const compactWrites = (f: ReturnType<typeof fixture>) => f.texts().filter((t) => t.startsWith('/compact')).length;
const entersAfterCompact = (f: ReturnType<typeof fixture>) => { const i = f.compactIndex(); return i < 0 ? 0 : f.events.slice(i + 1).filter((ev) => ev.kind === 'keys').length; };
function stateRoute(f: ReturnType<typeof fixture>) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('compactionEnforcer' as never, f.e); await next(); });
  app.route('/api/compaction', compactionRoutes());
  return async () => (await app.request(`/api/compaction/state?session=${encodeURIComponent(seat)}`)).json();
}

it('automatic: a failed paste after a successful idle wait disarms as uncertain and is never written again', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  // The adapter's real failure shape (TmuxResult: ok false, code, message), as classifyWriteError returns it.
  f.onText((text) => (text.startsWith('/compact') ? {ok: false, code: 'unknown', message: 'paste-buffer: lost reply'} : undefined));
  const real = f.transport.send.bind(f.transport);
  const results: unknown[] = [];
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => {
    try { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; }
    catch (e) { if (text.startsWith('/compact')) results.push({thrown: String(e), code: (e as any)?.code, inputWritten: (e as any)?.inputWritten}); throw e; }
  });
  const outcome = await f.e.maybeAutoCompact(input);
  // The exact transport result for the failed paste, as the enforcer classified it.
  console.log('F1 transport result:', JSON.stringify(results), 'outcome:', JSON.stringify(outcome), 'writes:', compactWrites(f));
  expect(outcome).not.toEqual({triggered: false, reason: 'waiting_for_idle'});
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  f.onText(() => undefined);
  for (let i = 0; i < 3; i++) await f.e.maybeAutoCompact(input);
  expect(compactWrites(f)).toBe(1);
});

for (const end of ['deadline', 'cancel'] as const) {
  it(`${end} in the gap between paste and Enter: one write, no Enter, and the state never says not sent`, async () => {
    const f = fixture();
    await f.e.maybeAutoCompact(input);
    f.stageMap();
    f.onText((text) => {
      if (!text.startsWith('/compact')) return;
      if (end === 'deadline') f.advance2(AUTO_PREP_WAIT_MS_DEFAULT + 1); else f.e.cancelPreparation(seat);
    });
    await f.e.maybeAutoCompact(input);
    expect(compactWrites(f)).toBe(1);
    expect(entersAfterCompact(f)).toBe(0);
    const state = f.e.getPreparationState(seat)!;
    expect(state.status).toBe('stopped');
    expect(state.compact).toBe('uncertain');
    const body = await stateRoute(f)();
    expect(body.compact).not.toMatch(/^not sent/);
    expect(body.compact).toMatch(/input box/);
    for (let i = 0; i < 3; i++) await f.e.maybeAutoCompact(input);
    expect(compactWrites(f)).toBe(1);
  });
}

it('deadline case before the first paste (not a transport refusal): zero writes and not sent', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  f.advance2(AUTO_PREP_WAIT_MS_DEFAULT + 1);
  await f.e.maybeAutoCompact(input);
  expect(compactWrites(f)).toBe(0);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'not_sent'});
  expect((await stateRoute(f)()).compact).toMatch(/^not sent/);
});

it('--skip-map: the restore request carries the overflow instruction and says no map is required when none was completed', async () => {
  const f = fixture(LONG_INSTRUCTION);
  expect(await f.e.triggerManualCompact({...input, usedPercentage: 40}, {operatorInitiated: true, skipMap: true})).toEqual({triggered: true, stage: 'compact-sent'});
  const restore = (await drainToRestore(f))!;
  expect(restore).toContain('Operator compaction instruction (too long for the /compact command');
  expect(restore).toContain('No restore map was required for this compaction (--skip-map)');
  expect(restore).not.toContain("This attempt's restore map is");
});

it('--skip-map with a completed map at the attempt path: the restore request names it', async () => {
  const f = fixture();
  f.onSleep(() => f.stageMap()); // the seat still writes its map
  f.onText((text) => { if (text.startsWith('/compact')) { const a = f.e.getPreparationState(seat)!; writeFileSync(a.mapPath, `# map\n${a.marker}\n`); } });
  expect(await f.e.triggerManualCompact({...input, usedPercentage: 40}, {operatorInitiated: true, skipMap: true})).toEqual({triggered: true, stage: 'compact-sent'});
  const mapPath = f.e.getPreparationState(seat)?.mapPath ?? (f.e as any).restoreCarry.get(seat)?.mapPath;
  const restore = (await drainToRestore(f))!;
  expect(restore).toContain(`This attempt's restore map is ${mapPath}`);
});

it('non-ASCII instruction and path stay within the budget, counted in UTF-16 code units', () => {
  const path = '/srv/работа/团队/チーム/seat-🚀/' + 'карта-地图-'.repeat(20) + '/RESTORE-MAP.md';
  const instruction = 'Сохрани текущую задачу и следующий шаг. 保留当前任务。 🚀 '.repeat(30);
  for (const mapPath of [null, path]) for (const compactInstruction of ['', 'Сохрани задачу 🚀', instruction]) {
    const {command} = composeManagedCompactCommand({compactInstruction, mapPath});
    expect(command.length).toBeLessThanOrEqual(MANAGED_COMPACT_COMMAND_MAX_CHARS);
    expect(command.startsWith(`/compact ${MANAGED_COMPACT_PREFIX}`)).toBe(true);
    // never splits a surrogate pair: whole pieces are included or left out
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(command)).toBe(false);
  }
  expect(composeManagedCompactCommand({compactInstruction: 'Сохрани задачу 🚀', mapPath: null}).command).toContain('Сохрани задачу 🚀');
});

it('a malformed receipt (no code) for a failed write is never reported as not sent', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  // No code: the transport reads the receipt as a failed write (send_failed, inputPhase attempted) without
  // throwing. A failed write may still have landed, so it is uncertain, never not sent.
  f.onText((text) => (text.startsWith('/compact') ? {ok: false, message: 'lost'} : undefined));
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  f.onText(() => undefined);
  for (let i = 0; i < 3; i++) await f.e.maybeAutoCompact(input);
  expect(compactWrites(f)).toBe(1);
});

it('a draft_* receipt from the paste stage is classified not_sent (the guard\'s refusal code, not an attempted write); the fake records the call, so this is not a zero-input proof', async () => {
  const f = fixture();
  await f.e.maybeAutoCompact(input);
  f.stageMap();
  f.onText((text) => (text.startsWith('/compact') ? {ok: false, code: 'draft_input_busy', message: 'The seat has an unsubmitted input.'} : undefined));
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'not_sent'});
});

for (const code of ['draft_input_busy', 'draft_input_unknown', 'draft_input_changed']) {
  it(`automatic: a ${code} hold is labeled not_reached by the transport, and still stops as not sent instead of waiting for idle`, async () => {
    const f = fixture();
    await armed(f);
    const real = f.transport.send.bind(f.transport);
    const results: unknown[] = [];
    vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; });
    f.onText((text) => (text.startsWith('/compact') ? {ok: false, code, message: 'The seat has an unsubmitted input.'} : undefined));
    expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: false, reason: 'send_failed'});
    expect(results[0]).toMatchObject({ok: false, reason: code, sent: false, inputPhase: 'not_reached'});
    expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', reason: code, compact: 'not_sent'});
  });
}

it('automatic: once a draft hold clears, the next poll before the cooldown does not reuse the stopped attempt; after it, a fresh one begins', async () => {
  const f = fixture();
  await armed(f);
  f.onText((text) => (text.startsWith('/compact') ? {ok: false, code: 'draft_input_busy', message: 'The seat has an unsubmitted input.'} : undefined));
  await f.e.maybeAutoCompact(input);
  const stopped = f.e.getPreparationState(seat)!;
  expect(stopped).toMatchObject({status: 'stopped', compact: 'not_sent'});
  f.onText(() => undefined);
  expect(await f.e.maybeAutoCompact(input)).toEqual({triggered: false, reason: 'preparation_stopped'});
  // The fake records the refused call, so one /compact call exists; the cleared poll adds none.
  expect(compactWrites(f)).toBe(1);
  expect(f.e.getPreparationState(seat)).toMatchObject({attemptId: stopped.attemptId, status: 'stopped'});
  f.advance(AUTO_RETRY_AFTER_STOP_MS_DEFAULT);
  await f.e.maybeAutoCompact(input);
  const fresh = f.e.getPreparationState(seat)!;
  expect(fresh.attemptId).not.toBe(stopped.attemptId);
  expect(fresh).toMatchObject({status: 'waiting', compact: 'not_sent'});
  expect(compactWrites(f)).toBe(1);
});

it('--skip-map with only the temporary map written: the restore request names the .tmp that carries the marker', async () => {
  const f = fixture();
  // --skip-map does not wait for a map, so the seat writes it while /compact goes in. stageMap writes only
  // <map>.tmp, as a seat does; nothing publishes it under --skip-map.
  f.onText((text) => { if (text.startsWith('/compact')) f.stageMap(); });
  expect(await f.e.triggerManualCompact({...input, usedPercentage: 40}, {operatorInitiated: true, skipMap: true})).toEqual({triggered: true, stage: 'compact-sent'});
  const carry = (f.e as any).restoreCarry.get(seat);
  const restore = (await drainToRestore(f))!;
  expect(restore).toContain(`This attempt's restore map is ${carry.skipMap.mapPath}.tmp`);
  expect(restore).not.toContain('No restore map was required');
});

// --- Root's four cases, each distinct and each with no second /compact write ------------------------------

async function armed(f: ReturnType<typeof fixture>) { await f.e.maybeAutoCompact(input); f.stageMap(); }
async function noSecondWrite(f: ReturnType<typeof fixture>) {
  f.onText(() => undefined); f.onKeys(undefined); f.metaThrows(false);
  for (let i = 0; i < 3; i++) await f.e.maybeAutoCompact(input);
}

it('deadline case (not a transport refusal): the attempt stops before any send, so not sent and no /compact write', async () => {
  const f = fixture();
  await armed(f);
  f.advance2(AUTO_PREP_WAIT_MS_DEFAULT + 1);
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'not_sent'});
  await noSecondWrite(f);
  expect(compactWrites(f)).toBe(0);
});

it('an issued write that throws (the adapter rejects after the paste was handed over) disarms as uncertain', async () => {
  const f = fixture();
  await armed(f);
  f.onText((text) => { if (text.startsWith('/compact')) throw new Error('paste-buffer: connection reset'); });
  await f.e.maybeAutoCompact(input);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  await noSecondWrite(f);
  expect(compactWrites(f)).toBe(1);
  expect(entersAfterCompact(f)).toBe(0);
});

it('a post-paste metadata failure (the binding read throws) reads written: 1 write, 0 Enters, uncertain', async () => {
  const f = fixture();
  await armed(f);
  f.onText((text) => { if (text.startsWith('/compact')) f.metaThrows(true); });
  const real = f.transport.send.bind(f.transport);
  const results: any[] = [];
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; });
  await f.e.maybeAutoCompact(input);
  expect(results[0]).toMatchObject({sent: true, inputPhase: 'written'});
  expect(results[0].error).toContain('Enter was not sent'); // the throw came before the Enter key reached the adapter
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  expect(compactWrites(f)).toBe(1);
  expect(entersAfterCompact(f)).toBe(0);
  vi.restoreAllMocks();
  await noSecondWrite(f);
  expect(compactWrites(f)).toBe(1);
});

it('Enter uncertainty (sendKeys itself throws): written, the submission outcome is unconfirmed, uncertain', async () => {
  const f = fixture();
  await armed(f);
  let pasted = false;
  f.onText((text) => { if (text.startsWith('/compact')) pasted = true; });
  f.onKeys(() => { if (pasted) throw new Error('send-keys: lost reply'); });
  const real = f.transport.send.bind(f.transport);
  const results: any[] = [];
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; });
  await f.e.maybeAutoCompact(input);
  expect(results[0]).toMatchObject({sent: true, inputPhase: 'written'});
  expect(results[0].error).toContain('the submission (Enter) outcome is unconfirmed');
  expect(results[0].error).not.toContain('Enter was not sent');
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  vi.restoreAllMocks();
  await noSecondWrite(f);
  expect(compactWrites(f)).toBe(1);
});

async function compactResult(f: ReturnType<typeof fixture>) {
  const real = f.transport.send.bind(f.transport);
  const results: any[] = [];
  vi.spyOn(f.transport, 'send').mockImplementation(async (s: string, text: string, opts?: any) => { const r = await real(s, text, opts); if (text.startsWith('/compact')) results.push(r); return r; });
  await f.e.maybeAutoCompact(input);
  vi.restoreAllMocks();
  return results[0];
}

it('an Enter whose adapter call reports failure: the submission outcome is unconfirmed, never "not submitted"', async () => {
  const f = fixture();
  await armed(f);
  let pasted = false;
  f.onText((text) => { if (text.startsWith('/compact')) pasted = true; });
  f.onKeys(() => (pasted ? {ok: false, code: 'unknown', message: 'send-keys failed'} : undefined));
  const result = await compactResult(f);
  expect(result).toMatchObject({reason: 'submit_failed', sent: true, inputPhase: 'written', outcome: 'failed'});
  expect(result.error).toContain('the Enter reported a failure');
  expect(result.error).toContain('submission outcome is unconfirmed');
  expect(result.error).not.toMatch(/was not submitted/);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
  await noSecondWrite(f);
  expect(compactWrites(f)).toBe(1);
});

it('an Enter receipt with no code is read without throwing: still submit_failed, written, uncertain', async () => {
  const f = fixture();
  await armed(f);
  let pasted = false;
  f.onText((text) => { if (text.startsWith('/compact')) pasted = true; });
  f.onKeys(() => (pasted ? {ok: false, message: 'lost'} : undefined));
  const result = await compactResult(f);
  expect(result).toMatchObject({reason: 'submit_failed', sent: true, inputPhase: 'written'});
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'uncertain'});
});

it('a real zero-input refusal through the transport (the pane is stuck in a tmux mode): 0 writes, 0 Enters, not sent; clearing it sends nothing more', async () => {
  const f = fixture();
  await armed(f);
  f.paneInMode(true);
  const result = await compactResult(f);
  // Refused inside SessionTransport before the text stage: no adapter write was issued.
  expect(result).toMatchObject({ok: false, sent: false, reason: 'pane_in_mode'});
  expect(result.inputPhase).toBeUndefined();
  expect(compactWrites(f)).toBe(0);
  expect(entersAfterCompact(f)).toBe(0);
  expect(f.events.filter((ev) => ev.kind === 'keys')).toHaveLength(1); // only the preparation prompt's Enter
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'not_sent'});
  // Clear the fault and keep polling: the stopped attempt owes no /compact, and none is written.
  f.paneInMode(false);
  for (let i = 0; i < 3; i++) await f.e.maybeAutoCompact(input);
  expect(compactWrites(f)).toBe(0);
});


it('cancel disarms a submitted manual attempt without claiming it failed or sending input; an explicit retry uses a fresh map', async () => {
  const f = fixture();
  f.onSleep(() => f.stageMap());
  expect(await f.e.triggerManualCompact(input, {operatorInitiated: true})).toMatchObject({triggered: true});
  const previous = f.e.getPreparationState(seat)!;
  const before = [...f.events];
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('compactionEnforcer' as never, f.e);
    c.set('sessionTransport' as never, f.transport);
    await next();
  });
  app.route('/api/compaction', compactionRoutes());
  vi.spyOn(f.transport, 'resolveSessions').mockResolvedValue({ok: true, sessions: [seat]} as any);
  const response = await app.request('/api/compaction/cancel', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({session: seat}),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ok: true, preparation: {
    attemptId: previous.attemptId, status: 'stopped', reason: 'compaction_cancelled', compact: 'submitted_unconfirmed',
  }});
  expect(f.e.getManualCompactionState(seat)).toMatchObject({stage: 'cancelled', reason: 'compaction_cancelled'});
  expect(f.e.observedCompaction(seat)).toBeNull();
  expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
  expect(await f.e.drainPendingPostCompactStage(input)).toEqual({triggered: false, reason: 'no_pending_stage'});
  f.advance(61_000);
  await f.e.maybeAutoCompact(input);
  expect(f.events).toEqual(before); // no automatic retry, restore, audit, or cancellation keystroke
  expect(await f.e.triggerManualCompact(input, {operatorInitiated: true})).toMatchObject({triggered: true});
  const next = f.e.getPreparationState(seat)!;
  expect(next.attemptId).not.toBe(previous.attemptId);
  expect(next.mapPath).not.toBe(previous.mapPath);
  expect(f.texts().filter((t) => t.startsWith('/compact'))).toHaveLength(2);
});

for (const activity of ['running', 'unknown']) {
  it(`cancel preserves the unconfirmed receipt, and a ${activity} pane cannot get a second /compact through a stale idle hook`, async () => {
    const f = fixture();
    await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
    expect(f.e.cancelPreparation(seat)).toMatchObject({status: 'stopped', compact: 'submitted_unconfirmed'});
    f.activity(activity);
    f.hook('idle');
    const retry = await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
    expect(retry).toMatchObject({triggered: false, reason: activity === 'unknown' ? 'target_activity_unknown' : 'wait_for_idle_timeout'});
    expect(f.texts().filter((t) => t.startsWith('/compact'))).toHaveLength(1);
    expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'not_sent'});
  });
}

it('cancel fences a pending back-half pane read before any text or Enter can land', async () => {
  const f = fixture();
  await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
  const before = [...f.events];
  let release!: () => void;
  const blocked = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const reading = new Promise<void>((r) => { entered = r; });
  vi.spyOn(f.transport as any, 'classifySendReadiness').mockImplementation(async () => {
    entered(); await blocked; return {state: 'idle', reason: 'fixture', evidenceSource: 'fixture'};
  });
  const drain = f.e.drainPendingPostCompactStage(input);
  await reading;
  f.e.cancelPreparation(seat);
  release();
  await drain;
  expect(f.events).toEqual(before);
  expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
  expect(f.e.getManualCompactionState(seat)?.stage).toBe('cancelled');
});

it('cancel after a back-half paste prevents Enter and does not resurrect the next stage', async () => {
  const f = fixture();
  await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
  const before = f.events.length;
  f.onText(() => { f.e.cancelPreparation(seat); });
  await f.e.drainPendingPostCompactStage(input);
  expect(f.events.slice(before).filter((ev) => ev.kind === 'keys' && ev.keys.includes('Enter'))).toEqual([]);
  expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
  expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'submitted_unconfirmed'});
});

it('cancel after a back-half send settles prevents its late receipt from rearming restore', async () => {
  const f = fixture();
  await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
  const real = f.transport.send.bind(f.transport);
  vi.spyOn(f.transport, 'send').mockImplementation(async (...args) => {
    const result = await real(...args);
    f.e.cancelPreparation(seat);
    return result;
  });
  await f.e.drainPendingPostCompactStage(input);
  expect(f.e.hasPendingPostCompactStage(seat)).toBe(false);
  const after = [...f.events];
  await f.e.drainPendingPostCompactStage(input);
  expect(f.events).toEqual(after);
});

for (const completedStages of [1, 2]) {
  it(`cancel disarms the remaining restore/audit after ${completedStages} completed back-half stages`, async () => {
    const f = fixture();
    await f.e.triggerManualCompact(input, {operatorInitiated: true, skipMap: true});
    for (let i = 0; i < completedStages; i++) await f.e.drainPendingPostCompactStage(input);
    const before = [...f.events];
    f.e.cancelPreparation(seat);
    expect(f.e.getPreparationState(seat)).toMatchObject({status: 'stopped', compact: 'submitted_unconfirmed'});
    expect(f.e.getManualCompactionState(seat)?.stage).toBe('cancelled');
    expect(await f.e.drainPendingPostCompactStage(input)).toEqual({triggered: false, reason: 'no_pending_stage'});
    expect(f.events).toEqual(before);
  });
}
