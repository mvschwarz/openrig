// Runs INSIDE the network-disabled testbed, never on an operator's working host.
// The existing pipeline, YAML, assertions, CLI, daemon and SQLite remain real.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { defaultHostDaemon, runScenarioFile } from '../../daemon/test/helpers/scenario-pipeline.ts';
import { RESULT_PREFIX } from './result.mjs';

assert.equal(process.platform, 'linux', 'container execution only');
assert.notEqual(process.getuid(), 0, 'run as the unprivileged testbed user');
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal),
  'requires --network none');
const mode = process.argv[2];
assert.ok(['healthy', 'lost-baton'].includes(mode), 'expected healthy or lost-baton');
const rigBin = realpathSync('/usr/local/bin/rig');
const scenario = '/opt/openrig-testbed/scenarios/scenario-02-baton.yaml';
const records = [];
const report = {
  mode, records, fault: null,
  scenarioSha256: createHash('sha256').update(readFileSync(scenario)).digest('hex'),
};

try {
  report.result = await runScenarioFile(scenario, {
    rigBin,
    baseEnv: { PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color' },
    deps: { appendRecord: record => records.push(record) },
    daemon: async (scaffold, options) => {
      const daemon = await defaultHostDaemon(scaffold, options);
      if (mode === 'healthy') return daemon;
      return {
        ...daemon,
        restart: async () => {
          await daemon.sigterm();
          await assert.rejects(fetch(`${daemon.baseUrl}/healthz`),
            error => error.cause?.code === 'ECONNREFUSED', 'daemon must be stopped before fault injection');
          // Seed the named durability fault ONLY in this scenario's stopped scratch DB.
          // Observation is still the unchanged shipped `rig queue list` path.
          const Database = createRequire(rigBin)('better-sqlite3');
          const db = new Database(join(scaffold.stateDir, 'scenario.db'), { fileMustExist: true });
          try {
            const before = db.prepare('SELECT state FROM queue_items WHERE qitem_id = ?').get('baton-1');
            assert.equal(before?.state, 'in-progress');
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
