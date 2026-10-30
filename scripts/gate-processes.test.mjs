import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotGateProcesses } from './gate-processes.mjs';
import { observeForeignLoad } from './gate-lane-run.mjs';

test('Windows census uses no-profile PowerShell, names only and literal argv', () => {
  const result = snapshotGateProcesses({ platform:'win32', env:{SystemRoot:'C:\\Windows'}, execute:(file,args,options) => {
    assert.match(file, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
    assert.ok(!args.at(-1).includes('CommandLine'));
    assert.equal(options.windowsHide,true); assert.equal(options.timeout,5000);
    return '\uFEFF[{"pid":123,"command":"NODE"}]';
  }});
  assert.equal(result.status,'available');
  assert.equal(observeForeignLoad({processes:result.processes,loadavg:null}).foreignProcessCount,1);
});

test('unavailable or malformed process census cannot claim zero foreign load', () => {
  for (const execute of [() => {throw Error('private command arguments');}, () => '{}', () => '[{"pid":-1,"command":"node"}]']) {
    const observation=snapshotGateProcesses({platform:'win32',execute});
    assert.deepEqual(observation,{status:'unavailable',processes:null});
    const load=observeForeignLoad({processes:observation.processes,loadavg:null});
    assert.equal(load.foreignProcessCount,null); assert.equal(load.processObservation,'unavailable');
    assert.match(load.advisory.join(';'),/unknown/); assert.ok(!JSON.stringify(load).includes('private'));
  }
});

test('POSIX census keeps full process names and rejects partial malformed output', () => {
  assert.deepEqual(snapshotGateProcesses({platform:'linux',execute:()=>' 12 node\n34 /usr/bin/tsc\n'}).processes,
    [{pid:12,command:'node'},{pid:34,command:'/usr/bin/tsc'}]);
  assert.equal(snapshotGateProcesses({platform:'linux',execute:()=>'12 node\nbad\n'}).status,'unavailable');
});

test('actual host census observes this test process', () => {
  const observation=snapshotGateProcesses();
  assert.equal(observation.status,'available');
  assert.ok(observation.processes.some(p=>p.pid===process.pid && /node/i.test(p.command)));
});
