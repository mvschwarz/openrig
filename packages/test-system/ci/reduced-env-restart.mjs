import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const panesOf = rows => rows.map(line => {
  const [name, pane, pid, dead] = line.split(':');
  return { name, pane, pid: Number(pid), dead: Number(dead) };
});

function preserved(before, after) {
  assert.equal(before.nodes.length, 2, 'expected the existing two-seat team');
  assert.equal(before.bindings.length, 2, 'expected both team bindings');
  assert.equal(before.sessions.length, 2, 'expected both original team sessions');
  assert.ok(before.sessions.every(row => row.status === 'running'), 'team was not running before restart');
  assert.deepEqual(after.nodes, before.nodes, 'team identities/lifecycle changed');
  assert.deepEqual(after.bindings, before.bindings, 'team bindings changed');
  assert.deepEqual(after.sessions, before.sessions, 'team sessions replaced, detached or superseded');
  assert.equal(before.privatePanes.length, 2, 'expected both original team panes');
  assert.deepEqual(after.privatePanes, before.privatePanes, 'original panes/processes changed');
  assert.deepEqual(before.defaultPanes, [], 'fixture default socket already occupied');
  assert.deepEqual(after.defaultPanes, [], 'duplicate sessions on the default socket');
}

function polled(proof) {
  return proof.before.sessions.every(session => {
    const prior = proof.after.verdicts.find(row => row.node_id === session.node_id);
    const current = proof.poll.verdicts.find(row => row.node_id === session.node_id);
    return prior && current && current.session_name === session.session_name &&
      current.verdict === 'tmux_unavailable' && current.observed_pid === null && current.observed_pane_pid === null &&
      Number.isFinite(Date.parse(current.observed_at)) && Date.parse(current.observed_at) > Date.parse(prior.observed_at);
  });
}

export function verifyReducedEnvRestart(proof) {
  assert.ok(proof, 'missing reduced-environment restart proof');
  assert.equal(proof.stage, 'complete', 'restart observation incomplete');
  assert.deepEqual(proof.removed, ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper']);
  assert.deepEqual(proof.environment, { TMUX: false, TMUX_TMPDIR: false, wrapperOnPath: false });
  assert.equal(proof.scope, 'team seats only; kernel duplication not exercised');
  assert.equal(proof.evidence?.length, 2, 'expected recorded processes before restart');
  for (const session of proof.before.sessions) assert.ok(proof.evidence.some(row =>
    row.node_id === session.node_id && row.session_name === session.session_name && row.pid > 0),
  'missing recorded process for original team session');
  for (const phase of ['after', 'poll', 'second', 'recovered']) preserved(proof.before, proof[phase]);
  assert.ok(polled(proof), 'actual intervening null-PID poll not observed');
  assert.equal(proof.recovery, 'complete');
  assert.ok(proof.delivery.marker && !proof.delivery.before.includes(proof.delivery.marker));
  assert.ok(proof.delivery.after.includes(proof.delivery.marker), 'recovered send did not reach the addressed pane');
  assert.ok(proof.before.sessions.some(row => row.session_name === proof.delivery.session));
}

export function verifyGoneProcess(proof) {
  assert.equal(proof?.stage, 'complete', 'gone-process control incomplete');
  assert.equal(proof.processAbsent, true, 'process disappearance not proved');
  assert.equal(proof.absenceProbe?.code, 1);
  assert.match(proof.absenceProbe.stderr, /No such process/i);
  assert.equal(proof.recovery, 'complete');
  const { target, before, after } = proof;
  assert.ok(target.pids.includes(target.pid) && target.pids.length >= 2, 'missing shell/child PID census');
  assert.deepEqual(proof.absenceProbes.map(row => row.pid), target.pids);
  for (const probe of proof.absenceProbes) {
    assert.equal(probe.code, 1);
    assert.match(probe.stderr, /No such process/i);
  }
  const prior = before.sessions.find(row => row.id === target.sessionId);
  assert.ok(prior?.status === 'running' && prior.node_id === target.nodeId);
  assert.ok(panesOf(before.privatePanes).some(row => row.name === prior.session_name && row.pid === target.pid && !row.dead));
  assert.deepEqual(after.nodes, before.nodes);
  assert.deepEqual(after.defaultPanes, []);
  const live = after.sessions.filter(row => row.node_id === target.nodeId && row.status === 'running');
  assert.ok(live.length <= 1, 'gone seat duplicated');
  assert.equal(proof.outcome, live.length ? 'restored' : 'detached');
  if (!live.length) {
    assert.equal(after.sessions.find(row => row.id === target.sessionId)?.status, 'detached', 'gone seat not detached');
    assert.ok(!panesOf(after.privatePanes).some(row => row.name === prior.session_name && !row.dead));
  } else {
    const panes = panesOf(after.privatePanes).filter(row => row.name === live[0].session_name && !row.dead);
    assert.equal(panes.length, 1);
    assert.ok(panes[0].pid > 0 && panes[0].pid !== target.pid, 'dead process kept as running');
  }
  for (const peer of before.sessions.filter(row => row.node_id !== target.nodeId)) {
    assert.deepEqual(after.sessions.find(row => row.id === peer.id), peer, 'live peer altered by gone control');
    assert.deepEqual(after.bindings.filter(row => row.node_id === peer.node_id), before.bindings.filter(row => row.node_id === peer.node_id));
    assert.deepEqual(panesOf(after.privatePanes).filter(row => row.name === peer.session_name), panesOf(before.privatePanes).filter(row => row.name === peer.session_name));
  }
}

// Only the existing disposable, network-none installed-scenario container.
export async function reducedEnvRestart(daemon, scaffold, rigBin, proof = {},
  { execute = exec, withDatabase, pause = sleep, controls = {} } = {}) {
  const reduced = { ...daemon.readEnv };
  delete reduced.TMUX;
  delete reduced.TMUX_TMPDIR;
  reduced.PATH = reduced.PATH.split(':').filter(path => path !== join(scaffold.root, 'bin')).join(':');
  const command = (file, args, env = reduced) => execute(file, args, { env, timeout: 15000, maxBuffer: 262144 });
  const cli = (args, env = reduced) => command(process.execPath, [rigBin, ...args], env);
  const panes = async socket => {
    try {
      const { stdout } = await command('/usr/bin/tmux', [...(socket ? ['-S', socket] : []),
        'list-panes', '-a', '-F', '#{session_name}:#{pane_id}:#{pane_pid}:#{pane_dead}']);
      return stdout.trim().split('\n').filter(Boolean).sort();
    } catch (error) {
      if (!socket && error.code === 1 && !error.stdout &&
          /no server running|error connecting.*No such file or directory/i.test(error.stderr)) return [];
      throw error;
    }
  };
  Object.assign(proof, { scope: 'team seats only; kernel duplication not exercised',
    removed: ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper'],
    environment: { TMUX: Object.hasOwn(reduced, 'TMUX'), TMUX_TMPDIR: Object.hasOwn(reduced, 'TMUX_TMPDIR'),
      wrapperOnPath: reduced.PATH.split(':').includes(join(scaffold.root, 'bin')) } });
  const database = withDatabase ?? (read => {
    const Database = createRequire(rigBin)('better-sqlite3');
    const db = new Database(join(scaffold.stateDir, 'scenario.db'), { readonly: true, fileMustExist: true });
    try { return read(db); } finally { db.close(); }
  });
  const snapshot = async (label, record = proof) => {
    record.stage = label + '-database';
    const rows = record[label] = {};
    database(db => {
      const keys = ['id', 'rig_id', 'logical_id', 'status', 'lifecycle_state', 'is_archived', 'superseded_at', 'superseded_by'];
      rows.nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all()
        .map(row => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
      rows.bindings = db.prepare('SELECT * FROM bindings ORDER BY id').all().map(({ updated_at, ...binding }) => binding);
      rows.sessions = db.prepare('SELECT id, node_id, session_name, status FROM sessions ORDER BY id').all();
      rows.verdicts = db.prepare('SELECT node_id, session_name, verdict, observed_pid, observed_pane_pid, observed_at FROM seat_identity_verdicts ORDER BY node_id').all();
    });
    record.stage = label + '-private-panes';
    rows.privatePanes = await panes(scaffold.tmuxSocketPath);
    record.stage = label + '-default-panes';
    rows.defaultPanes = await panes();
  };
  const recorded = () => database(db => db.prepare(`SELECT v.node_id, v.session_name,
    coalesce(v.observed_pane_pid, v.observed_pid) AS pid FROM sessions s
    JOIN seat_identity_verdicts v ON v.node_id = s.node_id AND v.session_name = s.session_name
    WHERE s.status = 'running' AND coalesce(v.observed_pane_pid, v.observed_pid) > 0 ORDER BY v.node_id`).all());
  const blind = async label => {
    proof.stage = label + '-stop';
    await daemon.sigterm();
    proof.stage = label + '-restart';
    await cli(['daemon', 'start', '--port', String(daemon.port), '--db', join(scaffold.stateDir, 'scenario.db'), '--no-kernel']);
    await snapshot(label);
    preserved(proof.before, proof[label]);
  };
  try {
    proof.stage = 'process-evidence';
    proof.evidence = recorded();
    for (let i = 0; proof.evidence.length < 2 && i < 60; i++) {
      await pause(500); proof.evidence = recorded();
    }
    assert.equal(proof.evidence.length, 2, 'both team process records required before restart');
    await snapshot('before');
    assert.ok(proof.before.sessions.every(row => row.status === 'running'), 'team must be running before restart');
    await blind('after');
    // Read the ordinary scheduler's persisted result; never call it or write its DB.
    for (let i = 0; i < 60; i++) {
      await pause(500); await snapshot('poll');
      if (polled(proof)) break;
    }
    proof.stage = 'poll-check';
    assert.ok(polled(proof), 'normal null-PID poll not observed within30s');
    preserved(proof.before, proof.poll);
    await blind('second');
    proof.stage = 'recovery-restart';
    proof.recovery = 'restarting-with-original-environment';
    await daemon.restart();
    await snapshot('recovered');
    preserved(proof.before, proof.recovered);
    proof.recovery = 'complete';
    proof.stage = 'recovered-delivery';
    const session = proof.before.sessions[0].session_name;
    const capture = async () => (await cli(['capture', session, '--lines', '40'], daemon.readEnv)).stdout;
    const marker = 'reduced-env-' + randomUUID();
    proof.delivery = { session, marker, before: await capture() };
    await cli(['send', session, marker, '--json'], daemon.readEnv);
    for (let i = 0; i < 20; i++) {
      proof.delivery.after = await capture();
      if (proof.delivery.after.includes(marker)) break;
      await pause(250);
    }
    assert.ok(proof.delivery.after.includes(marker), 'recovered send did not reach the addressed pane');
    proof.stage = 'complete';
    verifyReducedEnvRestart(proof);
    // Run just before the existing down step: the preceding two-seat expectation stays meaningful.
    controls.goneProcess = async () => {
      const gone = proof.gone = {};
      try {
        await snapshot('before', gone);
        preserved(proof.before, gone.before);
        const target = gone.before.sessions[1];
        const pane = panesOf(gone.before.privatePanes).find(row => row.name === target.session_name && !row.dead);
        assert.ok(pane?.pid > 1, 'owned seat process unavailable');
        gone.stage = 'owned-process-census';
        const children = (await command('/bin/ps', ['-axo', 'pid=,ppid='])).stdout.trim().split('\n')
          .map(line => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === pane.pid).map(([pid]) => pid);
        assert.ok(children.length && children.every(pid => Number.isSafeInteger(pid) && pid > 1), 'fixture child process unavailable');
        const recordedPids = gone.before.verdicts.filter(row => row.node_id === target.node_id && row.session_name === target.session_name)
          .flatMap(row => [row.observed_pid, row.observed_pane_pid]).filter(pid => Number.isSafeInteger(pid) && pid > 1);
        gone.target = { nodeId: target.node_id, sessionId: target.id, pid: pane.pid, pane: pane.pane,
          pids: [...new Set([pane.pid, ...children, ...recordedPids])].sort((a, b) => a - b) };
        gone.stage = 'confirm-owned-pane';
        const observed = await command('/usr/bin/tmux', ['-S', scaffold.tmuxSocketPath, 'display-message', '-p', '-t', pane.pane,
          '#{session_name}:#{pane_id}:#{pane_pid}:#{pane_dead}']);
        assert.deepEqual(panesOf([observed.stdout.trim()]), [pane], 'owned pane identity changed; no kill');
        gone.stage = 'kill-owned-seat';
        // Closing the owned PTY ends its interactive shell and foreground job; TERM to the shell does not.
        gone.kill = await command('/usr/bin/tmux', ['-S', scaffold.tmuxSocketPath, 'kill-pane', '-t', pane.pane]);
        for (let i = 0; i < 40; i++) {
          gone.absenceProbes = [];
          for (const pid of gone.target.pids) {
            try { await command('/bin/kill', ['-0', String(pid)], daemon.readEnv); }
            catch (error) {
              if (error.code !== 1 || !/No such process/i.test(error.stderr)) throw error;
              gone.absenceProbes.push({ pid, code: error.code, stderr: error.stderr });
            }
          }
          if (gone.absenceProbes.length === gone.target.pids.length) {
            gone.absenceProbe = gone.absenceProbes.find(row => row.pid === pane.pid);
            gone.processAbsent = true; break;
          }
          await pause(250);
        }
        assert.equal(gone.processAbsent, true, 'owned process did not disappear');
        gone.stage = 'restart';
        await daemon.sigterm();
        await cli(['daemon', 'start', '--port', String(daemon.port), '--db', join(scaffold.stateDir, 'scenario.db'), '--no-kernel']);
        await snapshot('after', gone);
        gone.outcome = gone.after.sessions.some(row => row.node_id === target.node_id && row.status === 'running') ? 'restored' : 'detached';
        gone.stage = 'recovery-restart';
        await daemon.restart();
        gone.recovery = 'complete';
        gone.stage = 'complete';
        verifyGoneProcess(gone);
      } catch (error) { gone.failedStage = gone.stage; throw error; }
    };
    return proof;
  } catch (error) { proof.failedStage = proof.stage; throw error; }
}
