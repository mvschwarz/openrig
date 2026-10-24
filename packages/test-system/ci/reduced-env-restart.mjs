import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function verifyReducedEnvRestart(proof) {
  assert.ok(proof, 'missing reduced-environment restart proof');
  assert.equal(proof.stage, 'complete', 'restart observation incomplete');
  assert.deepEqual(proof.removed, ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper']);
  assert.deepEqual(proof.environment, { TMUX: false, TMUX_TMPDIR: false, wrapperOnPath: false });
  assert.equal(proof.scope, 'team seats only; kernel duplication not exercised');
  assert.equal(proof.before.nodes.length, 2, 'expected the existing two-seat team');
  assert.deepEqual(proof.after.nodes, proof.before.nodes, 'team identities/lifecycle changed');
  assert.equal(proof.before.bindings.length, 2, 'expected both team bindings');
  assert.equal(proof.before.sessions.length, 2, 'expected both original team sessions');
  assert.ok(proof.before.sessions.every(row => row.status === 'running'), 'team was not running before restart');
  assert.deepEqual(proof.after.bindings, proof.before.bindings, 'team bindings changed');
  const identity = rows => rows.map(({ id, node_id, session_name }) => ({ id, node_id, session_name }));
  assert.deepEqual(identity(proof.after.sessions), identity(proof.before.sessions), 'sessions replaced or duplicated');
  assert.ok(proof.after.sessions.every(row => row.status !== 'superseded'), 'original session superseded');
  assert.equal(proof.evidence?.length, 2, 'expected a recorded process for each running team seat before the restart');
  for (const session of proof.before.sessions) assert.ok(proof.evidence.some(row =>
    row.node_id === session.node_id && row.session_name === session.session_name && row.pid > 0),
  'missing recorded process for original team session');
  assert.deepEqual(proof.after.sessions.map(row => row.status), proof.before.sessions.map(row => row.status),
    'a team session still running elsewhere was marked detached');
  assert.equal(proof.before.privatePanes.length, 2, 'expected both original team panes');
  assert.deepEqual(proof.after.privatePanes, proof.before.privatePanes, 'original panes/processes changed');
  assert.deepEqual(proof.before.defaultPanes, [], 'fixture default socket already occupied');
  assert.deepEqual(proof.after.defaultPanes, [], 'duplicate sessions on the default socket');
}

// Runs only in the existing disposable, network-none installed-scenario container.
export async function reducedEnvRestart(daemon, scaffold, rigBin, proof = {}, { execute = exec, withDatabase } = {}) {
  const reduced = { ...daemon.readEnv };
  delete reduced.TMUX;
  delete reduced.TMUX_TMPDIR;
  // Merely deleting the variables is vacuous while the scaffold wrapper forces -S.
  reduced.PATH = reduced.PATH.split(':').filter(path => path !== join(scaffold.root, 'bin')).join(':');
  const command = (file, args, env = reduced) => execute(file, args, { env, timeout: 15000, maxBuffer: 262144 });
  const panes = async socket => {
    try {
      const { stdout } = await command('/usr/bin/tmux', [...(socket ? ['-S', socket] : []),
        'list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}']);
      return stdout.trim().split('\n').filter(Boolean).sort();
    } catch (error) {
      if (!socket && error.code === 1 && !error.stdout &&
          /no server running|error connecting.*No such file or directory/i.test(error.stderr)) return [];
      throw error; // An unreadable socket is not absence.
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
  const snapshot = async label => {
    proof.stage = label + '-database';
    const rows = proof[label] = {};
    database(db => {
      const keys = ['id', 'rig_id', 'logical_id', 'status', 'lifecycle_state', 'is_archived', 'superseded_at', 'superseded_by'];
      rows.nodes = db.prepare('SELECT * FROM nodes ORDER BY id').all()
        .map(row => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
      rows.bindings = db.prepare('SELECT * FROM bindings ORDER BY id').all().map(({ updated_at, ...binding }) => binding);
      rows.sessions = db.prepare('SELECT id, node_id, session_name, status FROM sessions ORDER BY id').all();
    });
    proof.stage = label + '-private-panes';
    rows.privatePanes = await panes(scaffold.tmuxSocketPath);
    proof.stage = label + '-default-panes';
    rows.defaultPanes = await panes();
  };
  const recorded = () => database(db => db.prepare(`SELECT v.node_id, v.session_name,
    coalesce(v.observed_pane_pid, v.observed_pid) AS pid
    FROM sessions s JOIN seat_identity_verdicts v ON v.node_id = s.node_id AND v.session_name = s.session_name
    WHERE s.status = 'running' AND coalesce(v.observed_pane_pid, v.observed_pid) > 0 ORDER BY v.node_id`).all());
  try {
    proof.stage = 'process-evidence';
    proof.evidence = recorded();
    for (let i = 0; proof.evidence.length < 2 && i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      proof.evidence = recorded();
    }
    assert.equal(proof.evidence.length, 2, 'both team process records required before restart');
    await snapshot('before');
    assert.ok(proof.before.sessions.every(row => row.status === 'running'), 'team must be running before restart');
    proof.stage = 'stop';
    await daemon.sigterm();
    proof.stage = 'restart';
    await command(process.execPath, [rigBin, 'daemon', 'start', '--port', String(daemon.port),
      '--db', join(scaffold.stateDir, 'scenario.db'), '--no-kernel']);
    await snapshot('after');
    proof.stage = 'complete';
    return proof;
  } catch (error) {
    proof.failedStage = proof.stage;
    throw error;
  }
}
