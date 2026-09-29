import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readReport, verifyRun, RESULT_PREFIX, SCENARIO } from '../packages/test-system/ci/result.mjs';

// Pure admission controls, not E2E evidence. No process, socket, native addon or DB.
function report(mode, result, fault = null) {
  return { mode, result, records: [result], fault };
}
const green = report('healthy', { scenario: SCENARIO, verdict: 'PASS' });
const red = report('lost-baton', {
  scenario: SCENARIO, verdict: 'FAIL', failedStep: 3,
  diff: 'expected baton-1 in-progress; last observed baton-1 pending',
}, { changedRows: 1, before: 'in-progress', after: 'pending' });

test('accepts a healthy run and a specifically observed post-restart lost baton', () => {
  verifyRun('healthy', 0, green);
  verifyRun('lost-baton', 1, red);
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
    ...red.result, diff: 'HTTP transport failed',
  }, red.fault)));
});
test('requires the actual runner ledger to agree with the returned result', () => {
  assert.throws(() => verifyRun('healthy', 0, { ...green, records: [] }));
  assert.throws(() => verifyRun('healthy', 0, { ...green, records: [red.result] }));
  assert.throws(() => verifyRun('healthy', 1, green));
});
test('only one structured outcome is allowed amid human-readable logs', () => {
  const line = RESULT_PREFIX + JSON.stringify(red);
  assert.deepEqual(readReport('daemon log\n' + line + '\n'), red);
  assert.throws(() => readReport('no result'));
  assert.throws(() => readReport(line + '\n' + line));
  assert.throws(() => readReport(RESULT_PREFIX + '{'));
});
