import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export function verifyReducedEnvRestart(proof) {
  assert.ok(proof, 'missing reduced-environment restart proof');
  assert.deepEqual(proof.removed, ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper']);
  assert.deepEqual(proof.environment, { TMUX: false, TMUX_TMPDIR: false, wrapperOnPath: false });
  assert.equal(proof.scope, 'team seats only; kernel duplication not exercised');
  assert.equal(proof.before.nodes.length, 2, 'expected the existing two-seat team');
  assert.deepEqual(proof.after.nodes, proof.before.nodes, 'team identities/lifecycle changed');
  assert.equal(proof.before.bindings.length, 2, 'expected both team bindings');
  assert.equal(proof.before.sessions.length, 2, 'expected both original team sessions');
  assert.deepEqual(proof.after.bindings, proof.before.bindings, 'team bindings changed');
  const identity = rows => rows.map(({ id, node_id, session_name }) => ({ id, node_id, session_name }));
  assert.deepEqual(identity(proof.after.sessions), identity(proof.before.sessions), 'sessions replaced or duplicated');
  assert.ok(proof.after.sessions.every(row => row.status !== 'superseded'), 'original session superseded');
  assert.equal(proof.before.privatePanes.length, 2, 'expected both original team panes');
  assert.deepEqual(proof.after.privatePanes, proof.before.privatePanes, 'original panes/processes changed');
  assert.deepEqual(proof.before.defaultPanes, [], 'fixture default socket already occupied');
  assert.deepEqual(proof.after.defaultPanes, [], 'duplicate sessions on the default socket');
}

// Runs only in the existing disposable, network-none installed-scenario container.
export async function reducedEnvRestart(daemon, scaffold, rigBin) {
  const reduced = { ...daemon.readEnv };
  delete reduced.TMUX;
  delete reduced.TMUX_TMPDIR;
  // Merely deleting the variables is vacuous while the scaffold wrapper forces -S.
  reduced.PATH = reduced.PATH.split(':').filter(path => path !== join(scaffold.root, 'bin')).join(':');
  const command = (file, args, env = reduced) => exec(file, args, { env, timeout: 15000, maxBuffer: 262144 });
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
  const snapshot = async () => {
    const Database = createRequire(rigBin)('better-sqlite3');
    const db = new Database(join(scaffold.stateDir, 'scenario.db'), { readonly: true, fileMustExist: true });
    try {
      const keys = ['id', 'rig_id', 'logical_id', 'status', 'lifecycle_state', 'is_archived', 'superseded_at', 'superseded_by'];
      return {
        nodes: db.prepare('SELECT * FROM nodes ORDER BY id').all()
          .map(row => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))),
        bindings: db.prepare('SELECT * FROM bindings ORDER BY id').all()
          .map(({ updated_at, ...binding }) => binding),
        sessions: db.prepare('SELECT id, node_id, session_name, status FROM sessions ORDER BY id').all(),
        privatePanes: await panes(scaffold.tmuxSocketPath), defaultPanes: await panes(),
      };
    } finally { db.close(); }
  };
  const before = await snapshot();
  await daemon.sigterm();
  await command(process.execPath, [rigBin, 'daemon', 'start', '--port', String(daemon.port),
    '--db', join(scaffold.stateDir, 'scenario.db'), '--no-kernel']);
  return { scope: 'team seats only; kernel duplication not exercised',
    removed: ['TMUX', 'TMUX_TMPDIR', 'scaffold tmux wrapper'],
    environment: { TMUX: Object.hasOwn(reduced, 'TMUX'), TMUX_TMPDIR: Object.hasOwn(reduced, 'TMUX_TMPDIR'),
      wrapperOnPath: reduced.PATH.split(':').includes(join(scaffold.root, 'bin')) },
    before, after: await snapshot() };
}
