import { test } from 'node:test';
import { reducedEnvRestart } from '../packages/test-system/ci/reduced-env-restart.mjs';
import assert from 'node:assert/strict';
import { readReport, verifyPassingRun, verifyRun, PASSING_CASES, RESULT_PREFIX, SCENARIO } from '../packages/test-system/ci/result.mjs';

const mcpResult = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data });
const mcp = {
  identity: mcpResult({ identity: { sessionName: 'dev-impl@dev-pair-stub', rigName: 'dev-pair-stub' } }),
  unseated: mcpResult({ ok: true, seat: null, message: 'This server has no seat' }),
  created: mcpResult({ qitemId: 'qitem-installed-mcp' }),
  shown: mcpResult({ item: { qitemId: 'qitem-installed-mcp', sourceSession: 'dev-impl@dev-pair-stub',
    destinationSession: 'dev-qa@dev-pair-stub', body: 'Read the installed MCP result.' } }),
  missing: { isError: true, content: [{ type: 'text', text: '{"error":"qitem_not_found"}' }],
    structuredContent: { ok: false, code: 'qitem_not_found', message: 'qitem_not_found', status: 404 } },
  daemonError: { status: 404, body: { error: 'qitem_not_found' } },
  instructions: 'OPENRIG_SESSION_NAME\nrig_queue_create\nnot idle\nreserved for a person\nrig_queue_claim',
};

// Pure result-admission fixture; not a pane/daemon execution claim.
function promptStateProof() {
  const codex = 'dev-codex@prompt-state';
  const seen = attention => ({
    node: { needsAttention: attention, agentActivity: { state: attention ? 'needs_input' : 'running' } },
    compact: { needsAttention: attention, agentActivity: { state: attention ? 'needs_input' : 'running' } },
    rig: { attentionCount: attention ? 1 : 0 },
    table: 'SESSION ATTN REASON\n' + codex + (attention ? ' yes selection_prompt' : ' no working'),
  });
  return { stage: 'complete', hookEvents: 0, runtimes: ['codex', 'claude-code'], paneHeight: 45, codex, claude: 'dev-claude@prompt-state',
    attention: seen(true), clear: seen(false),
    working: ['quoted-selector', 'quoted-permission'].map(kind => ({ kind, marker: kind, before: ['Frame', '❯ ', '⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', ...Array(42).fill('')].join('\n') + '\n',
      send: { code: 0 }, pane: kind, wake: { id: 'wake-' + kind, pane: 'wake-' + kind } })),
    waiting: { marker: 'must-not-type', send: { code: 1, stdout: 'target_needs_input', stderr: '' },
      pane: 'real prompt', wake: { id: 'must-not-wake', fired: true, delivery: 'failed', pane: 'real prompt', jobId: 'watchdog-waiting',
        attempt: { historyId: 'attempt-waiting', jobId: 'watchdog-waiting', deliveryTargetSession: 'dev-claude@prompt-state',
          outcome: 'refused', deliveryStatus: 'failed', deliveryMessage: 'Wake must-not-wake',
          evaluationNotes: { deliveryReason: "Refused: 'dev-claude@prompt-state' is at an interactive prompt (selection_prompt). No text was sent." } } } },
  };
}

// Pure admission controls, not E2E evidence. No process, socket, native addon or DB.
function report(mode, result, fault = null) {
  return { mode, result, records: [result], fault };
}
const green = report('healthy', { scenario: SCENARIO, verdict: 'PASS' });
const red = report('lost-baton', {
  scenario: SCENARIO, verdict: 'FAIL', failedStep: 3,
  diff: 'expected baton-1 in-progress; last observed baton-1 pending',
  observation: { surface: 'queue', value: [
    { qitemId: 'baton-1', state: 'pending', destinationSession: 'dev-worker@scn-baton' },
  ] },
}, { changedRows: 1, before: 'in-progress', after: 'pending' });

test('accepts a healthy run and a specifically observed post-restart lost baton', () => {
  verifyRun('healthy', 0, green);
  verifyRun('lost-baton', 1, red);
});
test('library admission requires its own seed, failing step, and exact destination', () => {
  const libraryGreen = { ...green, caseName: 'library', seed: { class: 'baton-drop', enabled: false } };
  const result = {
    ...red.result, failedStep: 4,
    observation: { surface: 'queue', value: [
      { qitemId: 'baton-1', state: 'pending', destinationSession: 'dev-qa@dev-pair-stub' },
    ] },
  };
  const libraryRed = { ...report('lost-baton', result, red.fault), caseName: 'library', seed: { class: 'baton-drop', enabled: true } };
  verifyRun('healthy', 0, libraryGreen, 'library');
  verifyRun('lost-baton', 1, libraryRed, 'library');
  for (const seed of [undefined, { class: 'typo', enabled: true }, { class: 'baton-drop', enabled: false }]) {
    assert.throws(() => verifyRun('lost-baton', 1, { ...libraryRed, seed }, 'library'));
  }
  assert.throws(() => verifyRun('healthy', 0, libraryGreen));
  assert.throws(() => verifyRun('lost-baton', 1, { ...libraryRed, result: red.result, records: [red.result] }, 'library'));
  assert.throws(() => verifyRun('healthy', 0, green, 'unknown'));
});
test('rejects a surviving mutant and a failure before the seeded boundary', () => {
  assert.throws(() => verifyRun('lost-baton', 0, { ...green, mode: 'lost-baton' }));
  assert.throws(() => verifyRun('lost-baton', 1, report('lost-baton', {
    ...red.result, failedStep: 1,
  }, red.fault)));
});
test('refuses timeout, setup error, missing injection, or an unrelated failing assertion', () => {
  assert.throws(() => verifyRun('lost-baton', 124, red));
  assert.throws(() => verifyRun('lost-baton', 1, { ...red, error: 'startup failed' }));
  assert.throws(() => verifyRun('lost-baton', 1, { ...red, fault: null }));
  assert.throws(() => verifyRun('lost-baton', 1, report('lost-baton', {
    ...red.result, observation: undefined, diff: 'HTTP transport failed',
  }, red.fault)));
});
test('requires the actual baton state and destination, never tokens in a diff or body', () => {
  const baton = red.result.observation.value[0];
  for (const observation of [
    undefined,
    { surface: 'pane', value: [baton] },
    { surface: 'queue', value: 'baton-1 pending dev-worker@scn-baton' },
    { surface: 'queue', value: [{ ...baton, qitemId: 'other-row' }] },
    { surface: 'queue', value: [{ ...baton, state: 'done', body: 'pending' }] },
    { surface: 'queue', value: [{ ...baton, destinationSession: 'other@scn-baton' }] },
    { surface: 'queue', value: [baton, { ...baton, state: 'done' }] },
  ]) {
    assert.throws(() => verifyRun('lost-baton', 1, report('lost-baton', {
      ...red.result, observation,
    }, red.fault)));
  }
  verifyRun('lost-baton', 1, report('lost-baton', {
    ...red.result, diff: 'human-readable formatting is not the admission contract',
  }, red.fault));
});
test('requires the actual runner ledger to agree with the returned result', () => {
  assert.throws(() => verifyRun('healthy', 0, { ...green, records: [] }));
  assert.throws(() => verifyRun('healthy', 0, { ...green, records: [red.result] }));
  assert.throws(() => verifyRun('healthy', 1, green));
});
test('a passing-only case admits only a clean PASS of its own scenario', () => {
  for (const [caseName, { scenario }] of Object.entries(PASSING_CASES)) {
    const result = { scenario, verdict: 'PASS' };
    const text = (PASSING_CASES[caseName].includes ?? []).join('\n');
    const hook = { rawOutput: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }), additionalContext: text };
    const pass = { ...(PASSING_CASES[caseName].kind === 'hook' ? { hook } : {}), mode: 'healthy', caseName, scenarioSha256: 'a'.repeat(64), result, records: [result], fault: null };
    if (caseName === 'prompt-state') pass.promptState = promptStateProof();
    if (caseName === 'daemon-restart') {
      pass.mcp = mcp;
      const snapshot = { nodes: [{ id: 'worker' }, { id: 'peer' }], bindings: [{ id: 'b1', node_id: 'worker', tmux_pane: '%1' }, { id: 'b2', node_id: 'peer', tmux_pane: '%2' }],
        sessions: [{ id: 's1', node_id: 'worker', session_name: 'worker', status: 'running' },
          { id: 's2', node_id: 'peer', session_name: 'peer', status: 'running' }],
        privatePanes: ['worker:%1:111:0', 'peer:%2:222:0'], defaultPanes: [] };
      snapshot.verdicts = snapshot.sessions.map((row, i) => ({ node_id: row.node_id, session_name: row.session_name, verdict: 'match',
        observed_pid: [333, 444][i], observed_pane_pid: [111, 222][i], observed_at: '2026-01-01T00:00:00Z' }));
      pass.reducedEnv = { stage: 'complete', scope: 'team seats only; kernel duplication not exercised',
        environment: { TMUX: false, TMUX_TMPDIR: false, wrapperOnPath: false },
        removed: ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper'], before: snapshot, after: structuredClone(snapshot),
        evidence: [{ node_id: 'peer', session_name: 'peer', pid: 222 }, { node_id: 'worker', session_name: 'worker', pid: 111 }] };
      Object.assign(pass.reducedEnv, { poll: structuredClone(snapshot), second: structuredClone(snapshot),
        recovered: structuredClone(snapshot), recovery: 'complete',
        delivery: { session: 'worker', marker: 'nonce', before: '', after: 'nonce' } });
      pass.reducedEnv.poll.verdicts = snapshot.verdicts.map(row => ({ ...row,
        verdict: 'tmux_unavailable', observed_pid: null, observed_pane_pid: null, observed_at: '2026-01-01T00:00:01Z' }));
      pass.reducedEnv.gone = { stage: 'complete', processAbsent: true, recovery: 'complete', outcome: 'detached',
        absenceProbe: { code: 1, stderr: 'No such process' },
        absenceProbes: [222, 444].map(pid => ({ pid, code: 1, stderr: 'No such process' })),
        target: { nodeId: 'peer', sessionId: 's2', pid: 222, pids: [222, 444] }, before: structuredClone(snapshot), after: structuredClone(snapshot) };
      pass.reducedEnv.gone.after.sessions[1].status = 'detached';
      pass.reducedEnv.gone.after.privatePanes = snapshot.privatePanes.slice(0, 1);

      pass.preservation = { failedBackupUnchanged: true, editedSha256: 'b'.repeat(64), backedUpSha256: 'b'.repeat(64),
        targetFilesChecked: 2, version: '0.1.17', shippedVersion: '0.1.17' };
      verifyPassingRun(0, pass, caseName);
      for (const after of [
        { ...snapshot, nodes: [] }, { ...snapshot, bindings: [] }, { ...snapshot, sessions: [] },
        { ...snapshot, sessions: snapshot.sessions.map((row, i) => i ? row : { ...row, status: 'superseded' }) },
        { ...snapshot, sessions: snapshot.sessions.map((row, i) => i ? row : { ...row, status: 'detached' }) },
        { ...snapshot, privatePanes: ['replacement'] }, { ...snapshot, defaultPanes: ['duplicate'] },
      ]) assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, after } }, caseName));
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: undefined }, caseName));
      for (const change of [ { second: undefined }, { poll: pass.reducedEnv.after },
        { poll: { ...pass.reducedEnv.poll, verdicts: pass.reducedEnv.poll.verdicts.map(row => ({ ...row, observed_pid: 111 })) } },
        { poll: { ...pass.reducedEnv.poll, verdicts: pass.reducedEnv.poll.verdicts.map(row => ({ ...row, observed_at: '2026-01-01T00:00:00Z' })) } },
        { delivery: { ...pass.reducedEnv.delivery, after: '' } }, { gone: undefined },
        { gone: { ...pass.reducedEnv.gone, processAbsent: false } },
        { gone: { ...pass.reducedEnv.gone, absenceProbe: { code: null, stderr: 'unknown' } } },
        { gone: { ...pass.reducedEnv.gone, absenceProbes: pass.reducedEnv.gone.absenceProbes.slice(0, 1) } },
        { gone: { ...pass.reducedEnv.gone, absenceProbes: pass.reducedEnv.gone.absenceProbes.map((row, i) => i ? { ...row, code: 0 } : row) } },
        { gone: { ...pass.reducedEnv.gone, after: snapshot } } ]) {
        assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, ...change } }, caseName));
      }
      const detached = snapshot.sessions.map(row => ({ ...row, status: 'detached' }));
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv,
        before: { ...snapshot, sessions: detached }, after: { ...snapshot, sessions: detached } } }, caseName));
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, stage: 'restart' } }, caseName));
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, evidence: pass.reducedEnv.evidence.slice(1) } }, caseName));
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv,
        environment: { ...pass.reducedEnv.environment, wrapperOnPath: true } } }, caseName));

      const restored = structuredClone(pass.reducedEnv.gone);
      restored.outcome = 'restored';
      restored.after.sessions[1].status = 'running';
      restored.after.privatePanes.push('peer:%3:333:0');
      verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, gone: restored } }, caseName);
      restored.after.privatePanes[1] = 'peer:%3:222:0';
      assert.throws(() => verifyPassingRun(0, { ...pass, reducedEnv: { ...pass.reducedEnv, gone: restored } }, caseName));
      for (const changed of [undefined, { ...mcp, identity: mcpResult({ identity: { sessionName: 'other', rigName: 'dev-pair-stub' } }) },
        { ...mcp, unseated: mcpResult({ ok: true, seat: 'unexpected', message: 'no seat' }) },
        { ...mcp, created: { content: mcp.created.content } },
        { ...mcp, missing: { ...mcp.missing, structuredContent: { ...mcp.missing.structuredContent, code: 'http_error' } } },
        { ...mcp, instructions: 'no guidance' }]) {
        assert.throws(() => verifyPassingRun(0, { ...pass, mcp: changed }, caseName));
      }
      for (const changed of [undefined, { ...pass.preservation, failedBackupUnchanged: false },
        { ...pass.preservation, backedUpSha256: 'c'.repeat(64) }, { ...pass.preservation, version: '0.0.1' }]) {
        assert.throws(() => verifyPassingRun(0, { ...pass, preservation: changed }, caseName));
      }
    }
    verifyPassingRun(0, pass, caseName);
    const fail = { ...result, verdict: 'FAIL', failedStep: 2 };
    for (const [exitCode, bad] of [
      [1, { ...pass, result: fail, records: [fail] }],
      [1, pass],
      [2, { ...pass, error: 'startup failed' }],
      [0, { ...pass, mode: 'lost-baton' }],
      [0, { ...pass, caseName: 'library' }],
      [0, { ...pass, scenarioSha256: undefined }],
      [0, { ...pass, seed: { class: 'baton-drop', enabled: false } }],
      [0, { ...pass, fault: { changedRows: 1 } }],
      [0, { ...pass, records: [] }],
      [0, { ...pass, result: { ...result, scenario: SCENARIO }, records: [{ ...result, scenario: SCENARIO }] }],
    ]) {
      assert.throws(() => verifyPassingRun(exitCode, bad, caseName));
    }
  }
  assert.throws(() => verifyPassingRun(0, green, 'fixture'));
  assert.throws(() => verifyRun('healthy', 0, green, 'transcript'));
});
test('only one structured outcome is allowed amid human-readable logs', () => {
  const line = RESULT_PREFIX + JSON.stringify(red);
  assert.deepEqual(readReport('daemon log\n' + line + '\n'), red);
  assert.throws(() => readReport('no result'));
  assert.throws(() => readReport(line + '\n' + line));
  assert.throws(() => readReport(RESULT_PREFIX + '{'));
});

const hookOf = context => ({ rawOutput: JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }), additionalContext: context });

test('refocus admission requires the emitted packet context: held work when healthy, held-as-current when seeded', () => {
  const heldContext = '## WORK — name it\nHELD WORK (blocked; this is not next):\n- refocus-baton — parked — blocked on external:scenario-release — continuation: none recorded';
  const passResult = { scenario: 'refocus-parked-baton', verdict: 'PASS' };
  const green = { mode: 'healthy', caseName: 'refocus-parked', scenarioSha256: 'a'.repeat(64), result: passResult, records: [passResult],
    hook: hookOf(heldContext), seed: { class: 'parked-baton-as-current', enabled: false }, fault: null };
  verifyRun('healthy', 0, green, 'refocus-parked');
  for (const context of [
    heldContext.replace('HELD WORK', 'held'),
    heldContext + '\nWORK FROM QUEUE EVIDENCE — tag mission:regression + slice:SCN.1 on row refocus-baton',
    heldContext + '\nintent: Trace the exact held work',
  ]) assert.throws(() => verifyRun('healthy', 0, { ...green, hook: hookOf(context) }, 'refocus-parked'));

  const context = '## WORK TRACE\nWORK FROM QUEUE EVIDENCE — tag mission:regression + slice:SCN.1 on row refocus-baton\nintent: Trace the exact held work';
  const hook = hookOf(context);
  const result = { scenario: 'refocus-parked-baton', verdict: 'FAIL', failedStep: 4,
    observation: { surface: 'hook_context', value: { rawOutput: hook.rawOutput, content: context } } };
  const red = { mode: 'seeded', caseName: 'refocus-parked', scenarioSha256: 'a'.repeat(64),
    result, records: [result], hook, seed: { class: 'parked-baton-as-current', enabled: true },
    fault: { class: 'parked-baton-as-current', movedRows: 1 } };
  verifyRun('seeded', 1, red, 'refocus-parked');
  for (const bad of [ { ...red, fault: null }, { ...red, fault: { class: 'parked-baton-as-current', removedLines: 1 } },
    { ...red, hook: { ...hook, rawOutput: '{}' } },
    { ...red, result: { ...result, failedStep: 2 }, records: [{ ...result, failedStep: 2 }] },
    { ...red, result: { ...result, observation: { surface: 'pane', value: context } }, records: [{ ...result, observation: { surface: 'pane', value: context } }] },
    { ...red, hook: { ...hook, additionalContext: 'tokens only in unrelated text' } },
    { ...red, hook: hookOf(context + '\nHELD WORK (blocked; this is not next):') },
  ]) assert.throws(() => verifyRun('seeded', 1, bad, 'refocus-parked'));
});

test('the packet-off control admits only the labelled root fallback', () => {
  const result = { scenario: 'refocus-parked-baton-packet-off', verdict: 'PASS' };
  const fallback = 'FALLBACK — no current typed baton (…)\nThe work root is not evidence of a current mission';
  const pass = { mode: 'healthy', caseName: 'refocus-parked-off', scenarioSha256: 'a'.repeat(64), result, records: [result], fault: null, hook: hookOf(fallback) };
  verifyPassingRun(0, pass, 'refocus-parked-off');
  for (const context of ['## WORK — name it\nHELD WORK (blocked; this is not next):', fallback + '\nintent: Execute the scoped regression mission', 'no label']) {
    assert.throws(() => verifyPassingRun(0, { ...pass, hook: hookOf(context) }, 'refocus-parked-off'));
  }
});


for (const failure of [null, 'after-restart', 'before-private-panes', 'after-private-panes',
  'after-default-panes', 'second-restart', 'recovery-restart', 'recovered-delivery', 'gone-restart', 'wrong-owned-pane',
  'shell-survives', 'child-survives', 'missing-poll']) {
  test(`reduced-env sequence retains proof at ${failure ?? 'completion'}`, async () => {
    // Only synthetic command/SQLite seams; no process, addon, socket or real poll.
    const proof = {}, controls = {}, events = [];
    let blind = 0, recovered = false, killed = false, goneRestart = false, ticks = 0, marker = '';
    const sessions = [{ id: 's1', node_id: 'worker', session_name: 'worker', status: 'running' },
      { id: 's2', node_id: 'peer', session_name: 'peer', status: 'running' }];
    const evidence = sessions.map((row, i) => ({ node_id: row.node_id, session_name: row.session_name, pid: 111 + i }));
    const withDatabase = read => read({ prepare: sql => ({ all: () => {
      if (sql.includes('coalesce')) return evidence;
      if (sql.includes('seat_identity_verdicts')) return sessions.map((row, i) => ({ node_id: row.node_id,
        session_name: row.session_name, verdict: blind && !recovered ? 'tmux_unavailable' : 'match', observed_pid: blind && !recovered ? null : 211 + i,
        observed_pane_pid: blind && !recovered ? null : 111 + i,
        observed_at: new Date(failure === 'missing-poll' ? 0 : ticks * 1000).toISOString() }));
      if (sql.includes('FROM nodes')) return sessions.map(row => ({ id: row.node_id }));
      if (sql.includes('FROM bindings')) return sessions.map(row => ({ id: row.id, node_id: row.node_id }));
      assert.ok(sql.includes('FROM sessions'));
      return sessions.map((row, i) => ({ ...row, status: i && goneRestart ? 'detached' : 'running' }));
    } }) });
    const execute = async (file, args, { env }) => {
      if (file === '/bin/ps') return { stdout: '112 1\n212 112\n211 111\n' };
      if (file === '/bin/kill') {
        assert.ok(['112', '212'].includes(args[1]));
        // Interactive bash accepts TERM but stays alive with its foreground child.
        if (args[0] === '-TERM') return { stdout: '' };
        assert.equal(args[0], '-0');
        if (!killed || failure === 'shell-survives' && args[1] === '112' || failure === 'child-survives' && args[1] === '212') return { stdout: '' };
        throw Object.assign(new Error('gone'), { code: 1, stderr: 'No such process' });
      }
      if (args.includes('kill-pane')) {
        assert.equal(file, '/usr/bin/tmux');
        assert.deepEqual(args, ['-S', '/fixture/tmux.sock', 'kill-pane', '-t', '%2']);
        events.push('kill'); killed = true; return { stdout: '' };
      }
      if (file !== '/usr/bin/tmux') {
        if (args[1] === 'capture') return { stdout: marker };
        if (args[1] === 'send') {
          if (failure === 'recovered-delivery') throw new Error('synthetic delivery failure');
          events.push('send'); marker = args[3]; return { stdout: '{}' };
        }
        assert.equal(env.TMUX, undefined); assert.equal(env.TMUX_TMPDIR, undefined);
        assert.ok(!env.PATH.includes('/fixture/bin'));
        blind++; events.push(killed ? 'gone-blind' : 'blind' + blind);
        if (killed) goneRestart = true;
        if (failure === (killed ? 'gone-restart' : blind === 1 ? 'after-restart' : 'second-restart')) throw new Error('synthetic restart failure');
        return { stdout: '' };
      }
      // tmux renders literal tabs in format output as underscores (as in CI).
      const row = (name, pane, pid) => args.at(-1).replaceAll('#{session_name}', name)
        .replaceAll('#{pane_id}', pane).replaceAll('#{pane_pid}', pid).replaceAll('#{pane_dead}', '0')
        .replaceAll('\t', '_') + '\n';
      if (args.includes('display-message')) return { stdout: row('peer', '%2', failure === 'wrong-owned-pane' ? '999' : '112') };
      if (failure === proof.stage) throw Object.assign(new Error('synthetic unreadable socket'),
        { code: 13, stdout: '', stderr: 'permission denied' });
      return { stdout: args[0] !== '-S' ? '' : row('worker', '%1', '111') + (killed ? '' : row('peer', '%2', '112')) };
    };
    const daemon = { port: 12345, readEnv: { PATH: '/fixture/bin:/usr/bin:/bin', TMUX: 'synthetic', TMUX_TMPDIR: '/fixture' },
      sigterm: async () => {}, restart: async () => {
        const stage = killed ? 'gone-recovery' : 'recovery-restart'; events.push(stage);
        if (failure === stage) throw new Error('synthetic restart failure');
        if (killed) goneRestart = true; else recovered = true;
      } };
    const run = () => reducedEnvRestart(daemon,
      { root: '/fixture', stateDir: '/fixture/state', tmuxSocketPath: '/fixture/tmux.sock' },
      '/fixture/rig.cjs', proof, { execute, withDatabase, controls, pause: async () => { ticks++; events.push('poll-read'); } });
    if (['gone-restart', 'wrong-owned-pane', 'shell-survives', 'child-survives'].includes(failure)) {
      await run(); await assert.rejects(controls.goneProcess());
      assert.equal(proof.gone.failedStage, failure === 'gone-restart' ? 'restart' : failure === 'wrong-owned-pane' ? 'confirm-owned-pane' : 'kill-owned-seat');
      assert.equal(proof.gone.processAbsent, failure === 'gone-restart' ? true : undefined);
      if (failure === 'wrong-owned-pane') assert.ok(!events.includes('kill'));
      assert.equal(proof.gone.before.sessions.length, 2);
    } else if (failure) {
      await assert.rejects(run());
      assert.ok(proof.failedStage);
      assert.deepEqual(proof.evidence, evidence);
      if (!failure.startsWith('before-')) assert.equal(proof.before.privatePanes.length, 2);
      if (failure.startsWith('after-') && !failure.endsWith('restart')) assert.equal(proof.after.sessions.length, 2);
      if (failure.includes('private-panes')) assert.equal(Object.hasOwn(failure.startsWith('before') ? proof.before : proof.after, 'privatePanes'), false);
    } else {
      assert.equal(await run(), proof);
      assert.equal(proof.stage, 'complete');
      await controls.goneProcess();
      assert.equal(proof.gone.stage, 'complete');
      assert.deepEqual(proof.gone.before.privatePanes, ['peer:%2:112:0', 'worker:%1:111:0']);
      assert.deepEqual(events, ['blind1', 'poll-read', 'blind2', 'recovery-restart', 'send', 'kill', 'gone-blind', 'gone-recovery']);
    }
  });
}


test('prompt-state result rejects every escaped regression and missing control', () => {
  const result = { scenario: 'prompt-state', verdict: 'PASS' };
  const pass = { mode: 'healthy', caseName: 'prompt-state', scenarioSha256: 'a'.repeat(64),
    result, records: [result], fault: null, promptState: promptStateProof() };
  verifyPassingRun(0, pass, 'prompt-state');
  const mutations = [
    p => { p.stage = 'setup'; },
    p => { p.hookEvents = 1; },
    p => { p.runtimes[1] = 'stub'; },
    p => { p.paneHeight = 24; },
    p => { p.working[0].before = p.working[0].before.trimEnd(); },
    p => { p.working[0].before = '\n'.repeat(45); },
    p => { p.attention.node.agentActivity.state = 'working'; },
    p => { p.attention.compact.needsAttention = false; },
    p => { p.attention.rig.attentionCount = 0; },
    p => { p.attention.table = 'ATTN no working'; },
    p => { p.clear.node.needsAttention = true; },
    p => { p.working[0].send.code = 1; },
    p => { p.working[1].pane = ''; },
    p => { p.working[0].wake.pane = ''; },
    p => { p.waiting.send.code = 0; },
    p => { p.waiting.pane += p.waiting.marker; },
    p => { p.waiting.wake.fired = false; },
    p => { p.waiting.wake.delivery = 'ok'; },
    p => { p.waiting.wake.attempt = null; },
    p => { p.waiting.wake.attempt.outcome = 'failed'; p.waiting.wake.attempt.evaluationNotes.deliveryReason = 'transport unavailable'; },
    p => { p.waiting.wake.delivery = 'retained'; p.waiting.wake.attempt.outcome = 'skipped'; },
    p => { p.waiting.wake.attempt.evaluationNotes = null; },
    p => { p.waiting.wake.attempt.jobId = 'another-job'; },
    p => { p.waiting.wake.attempt.deliveryTargetSession = 'another-seat'; },
    p => { p.waiting.wake.attempt.deliveryMessage = 'another-queue-row'; },
    p => { p.waiting.wake.pane += p.waiting.wake.id; },
  ];
  for (const mutate of mutations) {
    const proof = promptStateProof(); mutate(proof);
    assert.throws(() => verifyPassingRun(0, { ...pass, promptState: proof }, 'prompt-state'));
  }
});
