// Consumer-test assembly seam only. startServer, shutdown, scheduler, recorder,
// lifecycle store, migration and queue code are the compiled production modules.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root = process.env.S15_SOURCE_ROOT;
const load = rel => import(pathToFileURL(`${root}/packages/daemon/dist/${rel}.js`));
const { Hono } = createRequire(`${root}/packages/daemon/package.json`)('hono');
export async function createDaemon({ dbPath }) {
  const { createDb } = await load('db/connection');
  const { migrate } = await load('db/migrate');
  const { ALL_MIGRATIONS } = await load('db/all-migrations');
  const { DaemonLifecycleStore } = await load('domain/daemon-lifecycle-store');
  const { QueueRepository } = await load('domain/queue-repository');
  const { EventBus } = await load('domain/event-bus');
  const { WatchdogScheduler } = await load('domain/watchdog-scheduler');
  const { SlowOpRecorder } = await load('domain/slow-op-recorder');
  const { TmuxAdapter } = await load('adapters/tmux');
  const db = createDb(dbPath); migrate(db, ALL_MIGRATIONS);
  const store = new DaemonLifecycleStore(db);
  const epoch = `fixture-${process.pid}`; store.recordBoot(epoch, new Date().toISOString());
  const queue = new QueueRepository(db, new EventBus(db));
  if (!queue.getById('private-pending')) await queue.create({ qitemId: 'private-pending',
    sourceSession: 'owner@fixture', destinationSession: 'analyst@fixture', body: 'durable uncompleted work', priority: 'routine' });
  const mode = process.env.S15_CASE;
  const scheduler = new WatchdogScheduler({ tickIntervalMs: 60000,
    jobsRepo: { listActive: () => [{ jobId: 'private-job', lastEvaluationAt: null }] },
    policyEngine: { evaluate: () => mode === 'watchdog-pending' ? new Promise(() => {}) : Promise.resolve() },
  });
  scheduler.start(); if (mode === 'watchdog-pending') void scheduler.runTickNow();
  let recorder;
  if (mode === 'recorder-timeout') recorder = { close: () => new Promise(() => {}) };
  else {
    const logPath = `${process.env.OPENRIG_HOME}/measurements-${process.pid}.jsonl`;
    if (mode === 'recorder-failure') fs.mkdirSync(logPath); // real Worker write fails
    recorder = new SlowOpRecorder({ logPath }); recorder.recordMeasurement('shutdown.consumer', 300);
  }
  const app = new Hono(); app.get('/healthz', c => c.json({ status: 'ok' }));
  return { app, db,
    contextMonitor: { start() {} }, eventLoopMonitor: { stop() {} },
    injectWebSocket(server) {
      server.on('upgrade', (req, socket) => {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: fixture\r\n\r\n');
        socket.on('end', () => socket.end());
      });
    },
    deps: {
      tmuxAdapter: new TmuxAdapter(async () => ''),
      rigRepo: { db }, settingsStore: { resolveOne: () => ({ value: false }) },
      psProjectionService: { setPeriodicSnapshotState() {} },
      watchdogScheduler: scheduler, slowOpRecorder: recorder,
      healthDiagnosis: { start() {}, stop: async () => { if (mode === 'health-rejection') throw new Error('private health stop rejection'); } },
      daemonLifecycleStore: store, daemonBootEpoch: epoch,
    },
  };
}
