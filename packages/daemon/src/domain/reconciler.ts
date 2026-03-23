import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface ReconcileResult {
  checked: number;
  detached: number;
  errors: { sessionId: string; error: string }[];
}

interface ReconcilerDeps {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
}

const SKIP_STATUSES = new Set(["detached", "exited"]);

export class Reconciler {
  private db: Database.Database;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;

  constructor(deps: ReconcilerDeps) {
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("Reconciler: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("Reconciler: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async reconcile(rigId: string): Promise<ReconcileResult> {
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    let checked = 0;
    let detached = 0;
    const errors: { sessionId: string; error: string }[] = [];

    for (const session of sessions) {
      if (SKIP_STATUSES.has(session.status)) {
        continue;
      }

      let alive: boolean;
      try {
        alive = await this.tmuxAdapter.hasSession(session.sessionName);
        checked++;
      } catch (err) {
        errors.push({
          sessionId: session.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (!alive) {
        try {
          const txn = this.db.transaction(() => {
            this.sessionRegistry.markDetached(session.id);
            return this.eventBus.persistWithinTransaction({
              type: "session.detached",
              rigId,
              nodeId: session.nodeId,
              sessionName: session.sessionName,
            });
          });
          const persistedEvent = txn();
          this.eventBus.notifySubscribers(persistedEvent);
          detached++;
        } catch (err) {
          errors.push({
            sessionId: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { checked, detached, errors };
  }
}
