import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const entries = value => Array.isArray(value) ? value : value.entries;
const named = (rows, name) => rows.find(row => row.canonicalSessionName === name || row.sessionName === name);

// Admission checks use the actual served values and rendered input, never a precomputed pass flag.
export function verifyPromptState(proof) {
  assert.equal(proof?.stage, 'complete', 'prompt-state observation incomplete');
  assert.equal(proof.hookEvents, 0, 'fixture emitted an activity hook');
  assert.deepEqual(proof.runtimes, ['codex', 'claude-code']);
  for (const [key, expected] of [['attention', true], ['clear', false]]) {
    const seen = proof[key];
    assert.equal(seen.node.needsAttention, expected, `${key}: seat API attention`);
    assert.equal(seen.compact.needsAttention, expected, `${key}: compact attention`);
    assert.equal(seen.rig.attentionCount, expected ? 1 : 0, `${key}: attention count`);
    assert.match(seen.table, /ATTN/);
    const row = seen.table.split('\n').find(line => line.includes(proof.codex));
    assert.ok(row, `${key}: table lost addressed seat`);
    if (expected) {
      assert.equal(seen.node.agentActivity?.state, 'needs_input', 'pane-only activity must be needs_input');
      assert.equal(seen.compact.agentActivity?.state, 'needs_input');
      assert.match(row, /\byes\b.*selection_prompt\s*$/);
    } else {
      assert.notEqual(seen.node.agentActivity?.state, 'needs_input');
      assert.doesNotMatch(row, /\byes\b.*selection_prompt\s*$/);
    }
  }
  assert.deepEqual(proof.working.map(row => row.kind), ['quoted-selector', 'quoted-permission']);
  assert.ok(proof.paneHeight >= 40, 'tall-pane geometry not exercised');
  const screen = proof.working[0].before.split('\n');
  if (screen.at(-1) === '') screen.pop();
  assert.equal(screen.length, proof.paneHeight, 'missing full pre-send screen');
  const lastDrawn = screen.findLastIndex(line => line.trim());
  assert.match(screen[lastDrawn] ?? '', /^⏵⏵ accept edits on/);
  assert.ok(screen.length - lastDrawn - 1 >= 20, 'composer not above the bottom 20 rows');
  for (const row of proof.working) {
    assert.equal(row.send.code, 0, `${row.kind}: working send refused`);
    assert.ok(row.pane.includes(row.marker), `${row.kind}: send did not reach pane`);
    assert.ok(row.wake.pane.includes(row.wake.id), `${row.kind}: wake did not reach pane`);
  }
  const waiting = proof.waiting;
  assert.notEqual(waiting.send.code, 0, 'real prompt admitted send');
  assert.match(waiting.send.stdout + waiting.send.stderr, /target_needs_input/);
  assert.ok(!waiting.pane.includes(waiting.marker), 'send typed into real prompt');
  assert.ok(waiting.wake.fired, 'refused wake never attempted');
  assert.match(waiting.wake.delivery, /needs_input|refused|retained|held|failed/i);
  const attempt = waiting.wake.attempt;
  assert.ok(attempt?.historyId && waiting.wake.jobId, 'missing watchdog refusal attempt');
  assert.equal(attempt.jobId, waiting.wake.jobId);
  assert.equal(attempt.deliveryTargetSession, proof.claude);
  assert.equal(attempt.outcome, 'refused');
  assert.equal(attempt.deliveryStatus, 'failed');
  assert.ok(attempt.deliveryMessage.includes(waiting.wake.id), 'attempt belongs to another queue row');
  const reason = attempt.evaluationNotes?.deliveryReason;
  assert.ok(typeof reason === 'string' && reason.startsWith(`Refused: '${proof.claude}' is at an interactive prompt (`));
  assert.match(reason, /interactive prompt \((?:selection_prompt|permission_prompt)\)/);
  assert.ok(reason.endsWith('No text was sent.'));
  assert.ok(!waiting.wake.pane.includes(waiting.wake.id), 'wake typed into real prompt');
}

// A terminal fixture, not a provider: no runtime SDK, hooks, credentials, or assertions in the child.
// Draw inline near the top of a tall pane, leaving blank rows under the composer.
const fixtureProgram = `
const fs = require('node:fs');
const frame = process.argv[2];
process.title = process.argv[3]; // provider-shaped name; still only this scripted Node fixture
let received = '';
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', chunk => { received += chunk.toString(); });
setInterval(() => {
  const text = fs.readFileSync(frame, 'utf8');
  const rows = process.stdout.rows || 40;
  const lines = (received.replace(/\\x1b\\[[0-9;]*[A-Za-z~]/g, '') + '\\n' + text).trimEnd().split('\\n').slice(-rows);
  // Preserve the inline layout and put the cursor inside the current input box.
  const input = lines.findLastIndex(line => /^[❯›] *$/.test(line));
  process.stdout.write('\\x1b[2J\\x1b[H' + lines.join('\\n') +
    (input < 0 ? '' : '\\x1b[' + (input + 1) + ';3H'));
}, 200);
`;

export async function runPromptState(rigBin, frames, proof = {}) {
  const { prepareHermeticEnv } = await import('../../daemon/test/helpers/hermetic-env.ts');
  const { spawnScenarioDaemon, runRig } = await import('../../daemon/test/helpers/scenario-daemon.ts');
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color' } });
  const rigName = 'prompt-state';
  const codex = `dev-codex@${rigName}`, claude = `dev-claude@${rigName}`;
  Object.assign(proof, { stage: 'setup', codex, claude, working: [] });
  let daemon;
  try {
    const cli = async (args, as, requireSuccess = true) => {
      const result = await runRig([...args, '--json'], { ...daemon.readEnv, ...(as ? { OPENRIG_SESSION_NAME: as } : {}) }, rigBin, 20_000);
      if (requireSuccess) assert.equal(result.code, 0, JSON.stringify({ args, ...result }));
      return result;
    };
    const jsonCli = async (...args) => JSON.parse((await cli(args)).stdout);
    const tmux = (...args) => exec('tmux', args, { env: scaffold.env, timeout: 10_000, maxBuffer: 256 * 1024 });
    const get = async path => {
      const response = await fetch(daemon.baseUrl + path, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200, path);
      return response.json();
    };
    const until = async (read, accepts, label, ms = 20_000) => {
      const end = Date.now() + ms;
      let seen;
      do {
        seen = await read();
        if (accepts(seen)) return seen;
        await pause(250);
      } while (Date.now() < end);
      throw new Error(`${label}: ${JSON.stringify(seen)}`);
    };
    const frameFiles = new Map();
    const fixture = join(scaffold.root, 'pane.cjs');
    writeFileSync(fixture, fixtureProgram, { mode: 0o644 });
    cpSync('/opt/openrig-testbed/library/agents/worker', join(scaffold.root, 'worker'), { recursive: true });
    const members = [];
    for (const [id, name, runtime, frame] of [
      ['codex', codex, 'codex', frames.selector], ['claude', claude, 'claude-code', frames.workingPlain],
    ]) {
      const cwd = join(scaffold.root, id); mkdirSync(cwd);
      const file = join(cwd, 'frame.txt'); writeFileSync(file, frame, { mode: 0o644 });
      frameFiles.set(name, file);
      await tmux('new-session', '-d', '-s', name, '-x', '120', '-y', '45', 'node', fixture, file, runtime === 'claude-code' ? 'claude' : 'codex');
      members.push({ id, runtime, agent_ref: 'local:worker', profile: 'default', cwd });
    }
    // JSON is valid YAML. Adopt materializes and binds these actual private panes without launching a provider.
    const spec = join(scaffold.root, 'prompt-state.yaml');
    writeFileSync(spec, JSON.stringify({ version: '0.2', name: rigName,
      pods: [{ id: 'dev', label: 'Dev', members, edges: [] }], edges: [] }), { mode: 0o644 });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const adopted = JSON.parse((await cli(['adopt', spec, '--bind', `dev.codex=${codex}`, '--bind', `dev.claude=${claude}`])).stdout);
    assert.ok(adopted.rigId, 'adopt did not identify a rig');
    const nodes = () => get(`/api/rigs/${adopted.rigId}/nodes`);
    const setup = await nodes();
    proof.paneHeight = Number((await tmux('display-message', '-p', '-t', claude, '#{pane_height}')).stdout.trim());
    proof.runtimes = [codex, claude].map(name => named(setup, name)?.runtime);
    assert.deepEqual(proof.runtimes, ['codex', 'claude-code'], 'adoption changed fixture runtime');
    assert.ok(setup.every(row => row.sessionStatus === 'running' && row.startupStatus === 'ready'), 'adopted fixture not ready');
    const capture = async name => (await tmux('capture-pane', '-p', '-t', name, '-S', '-80')).stdout;
    const setFrame = async (name, frame) => {
      writeFileSync(frameFiles.get(name), frame, { mode: 0o644 });
      await until(() => capture(name), pane => pane.includes(frame.split('\n')[0]), 'fixture frame not displayed');
    };
    const surfaces = async () => ({
      node: named(await nodes(), codex),
      rig: entries(await jsonCli('ps')).find(row => row.rigId === adopted.rigId),
      compact: named(entries(await jsonCli('ps', '--nodes', '--rig', rigName)), codex),
      table: (await runRig(['ps', '--nodes', '--rig', rigName], daemon.readEnv, rigBin, 20_000)).stdout,
    });
    const hookCount = () => {
      const Database = createRequire(rigBin)('better-sqlite3');
      const db = new Database(join(scaffold.stateDir, 'scenario.db'), { readonly: true, fileMustExist: true });
      try { return db.prepare("SELECT count(*) AS n FROM events WHERE type='agent.activity'").get().n; }
      finally { db.close(); }
    };
    proof.hookEvents = hookCount();
    assert.equal(proof.hookEvents, 0, 'fixture emitted a hook before observation');
    proof.selectorPane = await until(() => capture(codex), pane => pane.includes(frames.selector.split('\n')[0]), 'selector not displayed');
    proof.stage = 'pane-only-attention';
    proof.attention = await until(surfaces, row => row.node?.agentActivity?.state === 'needs_input', '#1946 pane-only needs_input/ATTN');
    assert.equal(proof.attention.node.needsAttention, true, '#1946 pane-only needs_input/ATTN');
    await setFrame(codex, frames.codexWorking);
    proof.clear = await until(surfaces, row => row.node?.needsAttention === false, 'attention did not clear');

    const wake = async (expectDelivery) => {
      const created = JSON.parse((await cli(['queue', 'create', '--destination', claude, '--body', 'Scenario timer continuation', '--no-nudge'], codex)).stdout);
      const id = created.qitemId; assert.ok(id);
      await cli(['queue', 'update', id, '--state', 'blocked', '--blocked-on', 'external:scenario-timer', '--wake-after', '1s'], claude);
      const read = async () => {
        const transitions = await jsonCli('queue', 'transitions', id, '--full');
        const fired = entries(transitions).find(row => row.wake?.phase === 'fired');
        const jobId = fired?.wake?.ref;
        const history = !expectDelivery && jobId ? (await get(`/api/watchdog/${encodeURIComponent(jobId)}/status`)).recentHistory : [];
        // A fresh generated one-shot timer must have exactly one matching attempt, not an unrelated delivery error.
        const matches = history.filter(row => row.jobId === jobId && row.deliveryTargetSession === claude && row.deliveryMessage?.includes(id));
        return { id, fired: Boolean(fired), jobId, attempt: matches.length === 1 ? matches[0] : null,
          delivery: fired?.wake?.deliveryStatus ?? '', pane: await capture(claude) };
      };
      const observed = await until(read, row => expectDelivery ? row.pane.includes(id) : row.fired && row.delivery && row.attempt,
        'timer wake not observed', 35_000);
      await cli(['queue', 'update', id, '--state', 'done', '--closure-reason', 'no-follow-on'], claude);
      return observed;
    };
    proof.stage = 'working-quoted-text';
    for (const [kind, frame] of [['quoted-selector', frames.workingSelector], ['quoted-permission', frames.workingPermission]]) {
      await setFrame(claude, frame);
      const marker = `send-${randomUUID()}`;
      const row = { kind, marker, before: (await tmux('capture-pane', '-p', '-t', claude)).stdout }; proof.working.push(row);
      const send = row.send = await cli(['send', claude, marker], codex, false);
      assert.equal(send.code, 0, `#1955 ${kind}: working send refused: ${send.stdout} ${send.stderr}`);
      row.pane = await until(() => capture(claude), pane => pane.includes(marker), 'send absent from addressed pane');
      row.wake = await wake(true);
    }
    proof.stage = 'real-waiting-prompt';
    await setFrame(claude, frames.waiting);
    const marker = `refused-${randomUUID()}`;
    proof.waiting = { marker, send: await cli(['send', claude, marker], codex, false) };
    proof.waiting.wake = await wake(false);
    proof.waiting.pane = await capture(claude);
    proof.hookEvents = hookCount();
    proof.stage = 'complete';
    verifyPromptState(proof);
    return proof;
  } finally {
    if (daemon) await daemon.stop();
    else scaffold.cleanup();
  }
}
