import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerPlatform, runWithDeadline } from './scenario-executor.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('target follows the Docker server, not this client platform', () => {
  assert.equal(dockerPlatform({ Os: 'linux', Arch: 'amd64' }), 'linux/amd64');
  assert.equal(dockerPlatform({ Os: 'linux', Arch: 'arm64' }), 'linux/arm64');
  for (const server of [undefined, {}, { Os: 'darwin', Arch: 'arm64' }, { Os: 'linux', Arch: 'mips' }]) {
    assert.throws(() => dockerPlatform(server), /Unsupported Docker server/);
  }
});
test('deadline wrapper preserves actual successful and nonzero exits', async () => {
  assert.equal(await runWithDeadline([process.execPath, '-e', 'process.exit(0)'], { timeoutMs: 3000 }), 0);
  assert.equal(await runWithDeadline([process.execPath, '-e', 'process.exit(7)'], { timeoutMs: 3000 }), 7);
});
test('deadline expires even when the child ignores TERM', async () => {
  const start = Date.now();
  const status = await runWithDeadline([process.execPath, '-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { timeoutMs: 300, killAfterMs: 100 });
  assert.equal(status, 124);
  assert.ok(Date.now() - start < 3000);
});
test('a missing executable and an invalid deadline cannot report success', async () => {
  assert.equal(await runWithDeadline(['/nonexistent/openrig-test-program'], { timeoutMs: 1000 }), 127);
  await assert.rejects(runWithDeadline([process.execPath], { timeoutMs: 0 }), /positive/);
});

test('the platform CLI queries a fake remote server and writes its actual receipt', () => {
  const root = mkdtempSync(join(process.cwd(), '.scenario-platform-'));
  try {
    const server = { Os: 'linux', Arch: 'amd64', Version: 'test-only' };
    writeFileSync(join(root, 'docker'), `#!/bin/sh
printf '%s\\n' '${JSON.stringify(server)}'
`, { mode: 0o755 });
    const receipt = join(root, 'server.json');
    const run = spawnSync(process.execPath, [resolve('scripts/scenario-executor.mjs'), 'platform', receipt], {
      env: { ...process.env, PATH: root + ':/usr/bin:/bin', DOCKER_HOST: 'ssh://fixture.invalid' }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'linux/amd64');
    assert.deepEqual(JSON.parse(readFileSync(receipt, 'utf8')), { platform: 'linux/amd64', server });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('ordinary invocation and ambiguous remote selection refuse before any build', () => {
  const script = resolve('scripts/run-pr-scenarios.sh');
  for (const [args, extra, message] of [
    [[], {}, /Use GitHub CI or --remote/],
    [['--remote'], {}, /requires explicit DOCKER_HOST/],
    [['--remote'], { DOCKER_HOST: 'ssh://fixture.invalid', DOCKER_CONTEXT: 'other' }, /Unset DOCKER_CONTEXT/],
    [['--remote', '--case', 'typo'], {}, /Expected --case/],
    [['--remote', '--mode', 'typo'], {}, /Expected --mode/],
  ]) {
    const env = { ...process.env, GITHUB_ACTIONS: '', DOCKER_HOST: '', DOCKER_CONTEXT: '', ...extra };
    const run = spawnSync('/bin/bash', [script, ...args], { env, encoding: 'utf8', timeout: 3000 });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, message);
  }
});

test('settlement uses the recorded ID, TERM and stopped-state removal; unknown effects stay retained', async () => {
  const { settleContainer } = await import('./scenario-executor.mjs');
  assert.equal(typeof settleContainer, 'function');
  const id='a'.repeat(64), image='sha256:'+'b'.repeat(64), name='testbed-owned';
  function fixture({running=false,mismatch=false,waitUnknown=false,stillRunning=false}={}) {
    const calls=[];let inspected=0;
    const invoke=args=>{
      calls.push(args);
      if(args[0]==='inspect')return JSON.stringify([{Id:mismatch?'c'.repeat(64):id,Name:'/'+name,Image:image,State:{Running:inspected++===0?running:stillRunning,Status:(inspected===1?running:stillRunning)?'running':'exited'}}]);
      if(args[0]==='wait'&&waitUnknown)throw Error('wait timed out; engine state unknown');
      return '';
    };
    return {calls,invoke};
  }
  const owned={id,name,image};
  const stopped=fixture();settleContainer(owned,stopped.invoke);assert.deepEqual(stopped.calls,[['inspect',id],['rm',id]]);
  const live=fixture({running:true});settleContainer(owned,live.invoke);assert.deepEqual(live.calls,[['inspect',id],['kill','--signal','TERM',id],['wait',id],['inspect',id],['rm',id]]);
  for(const opts of [{mismatch:true},{running:true,waitUnknown:true},{running:true,stillRunning:true}]){
    const f=fixture(opts);assert.throws(()=>settleContainer(owned,f.invoke));assert.ok(!f.calls.some(x=>x[0]==='rm'));
  }
  const f=fixture();assert.throws(()=>settleContainer({...owned,id:'not-an-id'},f.invoke));assert.equal(f.calls.length,0);
});
