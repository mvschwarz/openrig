// Runs INSIDE the network-disabled testbed, never on an operator's working host.
// The existing pipeline, YAML, assertions, CLI, daemon and SQLite remain real.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { defaultHostDaemon, runScenarioFile } from '../../daemon/test/helpers/scenario-pipeline.ts';
import { CASES, PASSING_CASES, RESULT_PREFIX } from './result.mjs';

assert.equal(process.platform, 'linux', 'container execution only');
assert.notEqual(process.getuid(), 0, 'run as the unprivileged testbed user');
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal),
  'requires --network none');
const mode = process.argv[2];
assert.ok(['healthy', 'lost-baton', 'seeded'].includes(mode), 'expected healthy or lost-baton');
const caseName = process.argv[3] ?? 'fixture';
const passingOnly = Object.hasOwn(PASSING_CASES, caseName);
const selected = passingOnly ? PASSING_CASES[caseName] : CASES[caseName];
assert.ok(selected, 'unknown scenario case');
assert.ok(!passingOnly || mode === 'healthy', 'a passing-only case runs healthy only');
assert.ok(mode !== 'seeded' || selected.kind === 'hook', 'seeded mode is bound to the hook control');
const rigBin = realpathSync('/usr/local/bin/rig');
const scenario = join('/opt/openrig-testbed', selected.file);
const records = [];
const report = {
  mode, caseName, records, fault: null,
  scenarioSha256: createHash('sha256').update(readFileSync(scenario)).digest('hex'),
};

try {
  report.result = await runScenarioFile(scenario, {
    rigBin,
    baseEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color' },
    deps: {
      appendRecord: record => records.push(record),
      onHookContext: hook => {
        report.hook = hook;
        if (mode === 'seeded') report.fault = JSON.parse(readFileSync(report.faultReceipt, 'utf8'));
      },
      refocusEnv: env => {
        if (mode !== 'seeded') return env;
        assert.deepEqual(report.seed, { class: 'parked-baton-as-current', enabled: true });
        const dir = join(env.OPENRIG_HOME, 'planted-trace-fault'); mkdirSync(dir, { recursive: true });
        const shim = join(dir, 'python'); report.faultReceipt = join(dir, 'effect.json');
        // Plant the lost-label regression in this hook's trace child, not in the captured hook output.
        writeFileSync(shim, `#!/usr/bin/env python3
import sys, subprocess, json, os
r = subprocess.run([sys.executable, *sys.argv[1:]], capture_output=True, text=True)
lines = r.stdout.splitlines(keepends=True)
removed = [line for line in lines if line.startswith("FALLBACK — no current typed baton")]
if r.returncode != 0 or len(removed) != 1:
    sys.stderr.write(r.stderr + "expected exactly one real fallback label before planting fault")
    sys.exit(1)
with open(os.environ["SCENARIO_TRACE_FAULT_RECEIPT"], "w") as f:
    json.dump({"class": "parked-baton-as-current", "removedLines": len(removed)}, f)
sys.stdout.write("".join(line for line in lines if line not in removed))
sys.stderr.write(r.stderr)
sys.exit(r.returncode)
`, { mode: 0o755 });
        return { ...env, PYTHON: shim, SCENARIO_TRACE_FAULT_RECEIPT: report.faultReceipt };
      },
      seedRegression: async regressionClass => {
        assert.equal(regressionClass, selected.seed, 'unsupported regression class');
        assert.equal(report.seed, undefined, 'seed must be armed exactly once');
        report.seed = { class: regressionClass, enabled: mode !== 'healthy' };
        return { code: 0, stdout: JSON.stringify(report.seed), stderr: '' };
      },
    },
    daemon: async (scaffold, options) => {
      const daemon = await defaultHostDaemon(scaffold, options);
      if (mode === 'healthy' || selected.kind === 'hook') return daemon;
      return {
        ...daemon,
        restart: async () => {
          if (selected.seed) assert.deepEqual(report.seed, { class: selected.seed, enabled: true },
            'the scenario must arm its fault before restart');
          await daemon.sigterm();
          await assert.rejects(fetch(`${daemon.baseUrl}/healthz`),
            error => error.cause?.code === 'ECONNREFUSED', 'daemon must be stopped before fault injection');
          // Seed the named durability fault ONLY in this scenario's stopped scratch DB.
          // Observation is still the unchanged shipped `rig queue list` path.
          const Database = createRequire(rigBin)('better-sqlite3');
          const db = new Database(join(scaffold.stateDir, 'scenario.db'), { fileMustExist: true });
          try {
            const before = db.prepare('SELECT state, destination_session FROM queue_items WHERE qitem_id = ?').get('baton-1');
            assert.equal(before?.state, 'in-progress');
            assert.equal(before.destination_session, selected.destination);
            const { changes } = db.prepare("UPDATE queue_items SET state = 'pending' WHERE qitem_id = ? AND state = 'in-progress'").run('baton-1');
            assert.equal(changes, 1);
            report.fault = {
              changedRows: changes, before: before.state,
              after: db.prepare('SELECT state FROM queue_items WHERE qitem_id = ?').get('baton-1').state,
            };
          } finally { db.close(); }
          await daemon.restart();
        },
      };
    },
  });
  process.exitCode = report.result.verdict === 'PASS' ? 0 : 1;
} catch (error) {
  report.error = String(error?.stack ?? error);
  process.exitCode = 2;
} finally {
  console.log(RESULT_PREFIX + JSON.stringify(report));
}
