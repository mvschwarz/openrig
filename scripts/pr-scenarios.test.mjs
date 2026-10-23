import { test } from 'node:test';
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
  instructions: 'OPENRIG_SESSION_NAME\nrig_queue_create\nnot idle\nreserved for a person',
};

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
    if (caseName === 'daemon-restart') {
      pass.mcp = mcp;
      pass.preservation = { failedBackupUnchanged: true, editedSha256: 'b'.repeat(64), backedUpSha256: 'b'.repeat(64),
        targetFilesChecked: 2, version: '0.1.17', shippedVersion: '0.1.17' };
      verifyPassingRun(0, pass, caseName);
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
