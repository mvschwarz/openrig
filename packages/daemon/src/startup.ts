import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { ExecFn } from "./adapters/tmux.js";
import type { CmuxTransportFactory } from "./adapters/cmux.js";
import { createDb } from "./db/connection.js";
import { migrate } from "./db/migrate.js";
import { coreSchema } from "./db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "./db/migrations/003_events.js";
import { RigRepository } from "./domain/rig-repository.js";
import { SessionRegistry } from "./domain/session-registry.js";
import { EventBus } from "./domain/event-bus.js";
import { NodeLauncher } from "./domain/node-launcher.js";
import { TmuxAdapter } from "./adapters/tmux.js";
import { CmuxAdapter } from "./adapters/cmux.js";
import { execCommand } from "./adapters/tmux-exec.js";
import { createCmuxCliTransport } from "./adapters/cmux-transport.js";
import { Reconciler } from "./domain/reconciler.js";
import { createApp, type AppDeps } from "./server.js";

interface DaemonOptions {
  dbPath?: string;
  tmuxExec?: ExecFn;
  cmuxExec?: ExecFn;
  cmuxFactory?: CmuxTransportFactory;
  cmuxTimeoutMs?: number;
}

interface DaemonResult {
  app: Hono;
  db: Database.Database;
  deps: AppDeps;
}

export async function createDaemon(opts?: DaemonOptions): Promise<DaemonResult> {
  const dbPath = opts?.dbPath ?? ":memory:";
  const db = createDb(dbPath);
  migrate(db, [coreSchema, bindingsSessionsSchema, eventsSchema]);

  const rigRepo = new RigRepository(db);
  const sessionRegistry = new SessionRegistry(db);
  const eventBus = new EventBus(db);

  const tmuxAdapter = new TmuxAdapter(opts?.tmuxExec ?? execCommand);
  // cmuxFactory takes precedence (for tests), then cmuxExec-based CLI transport, then default
  const cmuxFactory = opts?.cmuxFactory
    ?? createCmuxCliTransport(opts?.cmuxExec ?? execCommand);
  const cmuxAdapter = new CmuxAdapter(
    cmuxFactory,
    { timeoutMs: opts?.cmuxTimeoutMs ?? 5000 }
  );

  const nodeLauncher = new NodeLauncher({
    db,
    rigRepo,
    sessionRegistry,
    eventBus,
    tmuxAdapter,
  });

  // Connect to cmux at startup — degrades gracefully if absent
  await cmuxAdapter.connect();

  // Reconcile all managed rigs — marks stale sessions as detached
  const reconciler = new Reconciler({ db, sessionRegistry, eventBus, tmuxAdapter });
  const rigs = rigRepo.listRigs();
  for (const rig of rigs) {
    await reconciler.reconcile(rig.id);
  }

  const deps: AppDeps = {
    rigRepo,
    sessionRegistry,
    eventBus,
    nodeLauncher,
    tmuxAdapter,
    cmuxAdapter,
  };

  const app = createApp(deps);

  return { app, db, deps };
}
