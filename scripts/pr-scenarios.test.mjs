import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport, verifyPassingRun, verifyRun, PASSING_CASES, RESULT_PREFIX, SCENARIO } from '../packages/test-system/ci/result.mjs';

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
    const pass = { mode: 'healthy', caseName, scenarioSha256: 'a'.repeat(64), result, records: [result], fault: null };
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
