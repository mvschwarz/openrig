import assert from 'node:assert/strict';

export const RESULT_PREFIX = 'OPENRIG_SCENARIO_RESULT=';
export const SCENARIO = 'queue-baton-survives-restart';
export const CASES = {
  'refocus-parked': { file: 'library/refocus-parked-baton.yaml', scenario: 'refocus-parked-baton', kind: 'hook', seed: 'parked-baton-as-current', failedStep: 4 },
  fixture: { file: 'scenarios/scenario-02-baton.yaml', destination: 'dev-worker@scn-baton', failedStep: 3 },
  library: { file: 'library/queue-baton-survives-restart.yaml', destination: 'dev-qa@dev-pair-stub', failedStep: 4, seed: 'baton-drop' },
};
// Stub-script scenarios run in their passing form only. Their planted failures are
// product-code mutations, so they stay per-PR evidence outside CI.
export const PASSING_CASES = {
  'refocus-active': { file: 'library/refocus-active-baton.yaml', scenario: 'refocus-active-baton', kind: 'hook',
    includes: ['Trace the exact held work'], excludes: ['FALLBACK'] },
  // The parked case with the work packet switched off: today's labelled root fallback, never the slice as work.
  'refocus-parked-off': { file: 'library/refocus-parked-baton-packet-off.yaml', scenario: 'refocus-parked-baton-packet-off', kind: 'hook',
    includes: ['FALLBACK — no current typed baton', 'not evidence of a current mission'],
    excludes: ['Execute the scoped regression mission', 'HELD WORK', 'WORK FROM QUEUE EVIDENCE'] },
  transcript: { file: 'library/transcript-reads-addressed-seat.yaml', scenario: 'transcript-reads-addressed-seat' },
  capture: { file: 'library/capture-returns-addressed-seat.yaml', scenario: 'capture-returns-addressed-seat' },
  'daemon-restart': { file: 'library/daemon-restart-preserves-team-identity.yaml', scenario: 'daemon-restart-preserves-team-identity' },
};

// Only a clean PASS of the named scenario counts: no error, no seed, no fault.
export function verifyPassingRun(exitCode, report, caseName) {
  const selected = PASSING_CASES[caseName];
  assert.ok(selected, 'unknown passing-only case');
  assert.equal(report.caseName, caseName);
  assert.equal(report.mode, 'healthy');
  assert.match(report.scenarioSha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(report.result?.scenario, selected.scenario);
  assert.equal(report.error, undefined);
  assert.equal(report.seed, undefined);
  assert.equal(report.fault, null);
  assert.equal(report.records.length, 1);
  assert.deepEqual(report.records[0], report.result);
  assert.equal(exitCode, 0);
  assert.equal(report.result.verdict, 'PASS');
  if (selected.kind === 'hook') {
    verifyHookOutput(report.hook);
    for (const text of selected.includes) assert.ok(report.hook.additionalContext.includes(text), text);
    for (const text of selected.excludes) assert.ok(!report.hook.additionalContext.includes(text), text);
  }
}

function verifyHookOutput(hook) {
  const parsed = JSON.parse(hook.rawOutput);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.equal(parsed.hookSpecificOutput.additionalContext, hook.additionalContext);
}

// A failed start, bad command, timeout, or unrelated assertion is NOT a caught regression.
export function verifyRun(mode, exitCode, report, caseName = 'fixture') {
  const selected = CASES[caseName];
  assert.ok(selected, 'unknown scenario case');
  assert.equal(report.caseName ?? 'fixture', caseName);
  assert.equal(report.mode, mode);
  if (selected.kind === 'hook') {
    assert.equal(report.mode, mode); assert.equal(report.caseName, caseName);
    assert.match(report.scenarioSha256 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(report.result?.scenario, selected.scenario);
    assert.equal(report.error, undefined);
    assert.deepEqual(report.records, [report.result]);
    assert.deepEqual(report.seed, { class: selected.seed, enabled: mode !== 'healthy' });
    verifyHookOutput(report.hook);
    const context = report.hook.additionalContext;
    if (mode === 'healthy') {
      // The work packet is on: the parked row is held work, never the current work.
      assert.equal(exitCode, 0); assert.equal(report.result.verdict, 'PASS'); assert.equal(report.fault, null);
      assert.ok(context.includes('HELD WORK (blocked; this is not next):\n- refocus-baton — '));
      assert.ok(context.includes('blocked on external:scenario-release'));
      assert.ok(!context.includes('WORK FROM QUEUE EVIDENCE'));
      assert.ok(!context.includes('Trace the exact held work'));
    } else {
      assert.equal(mode, 'seeded'); assert.equal(exitCode, 1);
      assert.deepEqual(report.fault, { class: selected.seed, movedRows: 1 });
      assert.equal(report.result.verdict, 'FAIL'); assert.equal(report.result.failedStep, selected.failedStep);
      assert.equal(report.result.observation?.surface, 'hook_context');
      assert.equal(report.result.observation.value.rawOutput, report.hook.rawOutput);
      assert.equal(report.result.observation.value.content, report.hook.additionalContext);
      // The planted regression: the held row rendered as the seat's current work, with the slice's intent.
      assert.ok(context.includes('WORK FROM QUEUE EVIDENCE — tag mission:regression + slice:SCN.1 on row refocus-baton'));
      assert.ok(context.includes('Trace the exact held work'));
      assert.ok(!context.includes('HELD WORK'));
    }
    return;
  }
  assert.equal(report.result?.scenario, SCENARIO);
  assert.equal(report.error, undefined);
  assert.equal(report.records.length, 1);
  assert.deepEqual(report.records[0], report.result);
  if (selected.seed) {
    assert.deepEqual(report.seed, { class: selected.seed, enabled: mode !== 'healthy' });
  }
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
    assert.equal(report.result.failedStep, selected.failedStep); // queue read AFTER restart
    const observation = report.result.observation;
    assert.equal(observation?.surface, 'queue');
    assert.ok(Array.isArray(observation.value));
    const baton = observation.value.filter(row => row?.qitemId === 'baton-1');
    assert.equal(baton.length, 1);
    assert.equal(baton[0].destinationSession, selected.destination);
    assert.equal(baton[0].state, 'pending');
  }
}

export function readReport(log) {
  const lines = log.split('\n').filter(line => line.startsWith(RESULT_PREFIX));
  assert.equal(lines.length, 1, 'expected exactly one scenario result');
  return JSON.parse(lines[0].slice(RESULT_PREFIX.length));
}
