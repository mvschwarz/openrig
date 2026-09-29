import assert from 'node:assert/strict';

export const RESULT_PREFIX = 'OPENRIG_SCENARIO_RESULT=';
export const SCENARIO = 'queue-baton-survives-restart';

// A failed start, bad command, timeout, or unrelated assertion is NOT a caught regression.
export function verifyRun(mode, exitCode, report) {
  assert.equal(report.mode, mode);
  assert.equal(report.result?.scenario, SCENARIO);
  assert.equal(report.error, undefined);
  assert.equal(report.records.length, 1);
  assert.deepEqual(report.records[0], report.result);
  if (mode === 'healthy') {
    assert.equal(exitCode, 0);
    assert.equal(report.result.verdict, 'PASS');
    assert.equal(report.fault, null);
  } else {
    assert.equal(mode, 'lost-baton');
    assert.equal(exitCode, 1);
    assert.equal(report.fault?.changedRows, 1);
    assert.equal(report.fault?.before, 'in-progress');
    assert.equal(report.fault?.after, 'pending');
    assert.equal(report.result.verdict, 'FAIL');
    assert.equal(report.result.failedStep, 3); // the queue read AFTER restart
    const observation = report.result.observation;
    assert.equal(observation?.surface, 'queue');
    assert.ok(Array.isArray(observation.value));
    const baton = observation.value.filter(row => row?.qitemId === 'baton-1');
    assert.equal(baton.length, 1);
    assert.equal(baton[0].destinationSession, 'dev-worker@scn-baton');
    assert.equal(baton[0].state, 'pending');
  }
}

export function readReport(log) {
  const lines = log.split('\n').filter(line => line.startsWith(RESULT_PREFIX));
  assert.equal(lines.length, 1, 'expected exactly one scenario result');
  return JSON.parse(lines[0].slice(RESULT_PREFIX.length));
}
