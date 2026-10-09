// Run after npm run build:
// node --import tsx packages/daemon/scripts/smoke-missing-session.mjs [rig-bin] [running|detached]
// Uses real CLI/daemon/tmux with two stub seats on a private socket. The
// YAML scenario runner has no external kill-session action, so use its hermetic
// helpers directly. An optional baseline binary can prove the old running result.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareHermeticEnv } from '../test/helpers/hermetic-env.ts';
import { runRig, spawnScenarioDaemon } from '../test/helpers/scenario-daemon.ts';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(join(root, 'package.json'));
const Database = require('better-sqlite3');
const rigBin = resolve(process.argv[2] ?? join(root, 'packages/cli/dist/bin-wrapper.js'));
const expected = process.argv[3] ?? 'detached';
assert.ok(
  rigBin && ['running', 'detached'].includes(expected),
  `Invalid expected status ${JSON.stringify(expected)}. Usage: node --import tsx packages/daemon/scripts/smoke-missing-session.mjs [rig-bin] [running|detached]`,
);
const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: 'xterm-256color' } });
let daemon;
let db;
const launched = [];
try {
  daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  console.log('Private daemon:', daemon.baseUrl, 'private tmux socket:', scaffold.tmuxSocketPath);
  /** Run a CLI command against this smoke's private daemon and require success. */
  const cli = async (args) => {
    const result = await runRig(args, daemon.readEnv, rigBin, 120000);
    assert.equal(result.code, 0, JSON.stringify({ args, ...result }));
    return result.stdout;
  };
  for (const name of ['alpha', 'beta']) {
    const cwd = join(scaffold.root, name);
    mkdirSync(cwd);
    await cli(['up', join(root, `packages/test-system/scenarios/rig-${name}-stub.yaml`), '--cwd', cwd, '--json', '--yes']);
    launched.push(`rig-${name}`);
  }
  const seat = 'work-worker@rig-beta';
  const before = JSON.parse(await cli(['ps', '--nodes', '--rig', 'rig-beta', '--json']))[0];
  assert.equal(before.sessionStatus, 'running');
  console.log('BEFORE:', JSON.stringify(before));
  execFileSync('tmux', ['-S', scaffold.tmuxSocketPath, 'kill-session', '-t', `=${seat}`], { env: { PATH: process.env.PATH }, stdio: 'pipe' });
  db = new Database(join(scaffold.stateDir, 'scenario.db'), { readonly: true });
  let verdict;
  const deadline = Date.now() + 25000;
  do {
    verdict = db.prepare('SELECT verdict, reason FROM seat_identity_verdicts WHERE session_name = ?').get(seat);
    if (verdict?.reason === 'session_missing') break;
    await delay(500);
  } while (Date.now() < deadline);
  assert.equal(verdict?.reason, 'session_missing', JSON.stringify(verdict));
  console.log('LIVE VERDICT:', verdict);
  const raw = db.prepare('SELECT status FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1').get(seat);
  assert.equal(raw.status, 'running');
  const after = JSON.parse(await cli(['ps', '--nodes', '--rig', 'rig-beta', '--json']))[0];
  console.log('AFTER:', JSON.stringify(after));
  const table = await cli(['ps', '--nodes', '--rig', 'rig-beta', '--full']);
  const seatStatus = await cli(['seat', 'status', seat]);
  console.log('FULL TABLE:\n' + table);
  console.log('SEAT STATUS:\n' + seatStatus);
  assert.ok(seatStatus.includes(`Session: ${expected}`));
  if (expected === 'detached') {
    assert.equal(after.agentActivity.state, 'unknown');
    assert.doesNotMatch(table, /\bworking\b|\bactive\b|\brunning\b/);
    const full = JSON.parse(await cli(['ps', '--nodes', '--rig', 'rig-beta', '--full', '--json']))[0];
    assert.equal(full.storedSessionStatus, 'running');
    assert.equal(full.terminalActive, false);
    assert.equal(full.agentActivity.reason, 'session_missing');
    const summary = JSON.parse(await cli(['ps', '--rig', 'rig-beta', '--json']))[0];
    assert.equal(summary.runningCount, 0);
    assert.equal(summary.activeCount, 0);
    assert.equal(summary.status, 'stopped');
  }
  assert.equal(after.sessionStatus, expected);
  const capture = await runRig(['capture', seat, '--lines', '5'], daemon.readEnv, rigBin);
  assert.notEqual(capture.code, 0);
  assert.match(capture.stderr + capture.stdout, /not found|missing/i);
  const sibling = JSON.parse(await cli(['ps', '--nodes', '--rig', 'rig-alpha', '--json']))[0];
  assert.equal(sibling.sessionStatus, 'running');
  console.log(`PASS: expected ${expected}; raw history unchanged; sibling remains running; missing capture rejected`);
} finally {
  db?.close();
  if (daemon) {
    for (const rig of launched) await runRig(['down', rig, '--json', '--force'], daemon.readEnv, rigBin, 30000);
    await daemon.stop();
  } else scaffold.cleanup();
}
