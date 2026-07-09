import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PersistedEvent } from "./types.js";
import { validateSessionName, deriveSessionName } from "./session-name.js";
import {
  startTranscriptRotation,
  getTranscriptRotationOptionsFromEnv,
} from "./transcript-rotation.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";

import type { Session, Binding } from "./types.js";

export type LaunchResult =
  | { ok: true; sessionName: string; session: Session; binding: Binding; warnings?: string[] }
  | { ok: false; code: string; message: string };

interface LaunchOpts {
  sessionName?: string;
  cwd?: string;
  /**
   * Per-seat silence window override (seconds). Currently inert: the
   * live SeatActivityService poller uses the global default (3s) and
   * does not read per-seat windows. Retained for future per-seat-poller
   * decision. Caller plumbs from AgentSpec.profile.activity.
   */
  silenceWindowSeconds?: number;
}

interface NodeLauncherDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  sessionEnv?: Record<string, string | undefined>;
  /** Default silence window (seconds). Currently used only as the
   *  SeatActivityService global default (3s). Per-seat override via
   *  LaunchOpts is currently inert. */
  defaultSilenceWindowSeconds?: number;
  /**
   * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier (mouse/status
   * session-scope + set-clipboard/copy-command server-scope), applied to the
   * just-created session at launch. Injected from startup so the same
   * instance (and its once-per-daemon server-defaults memo) is shared with
   * SuccessorSessionLauncher. When omitted (most unit tests), the launch path
   * skips option application entirely.
   */
  tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
}

export class NodeLauncher {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private transcriptStore: TranscriptStore | null;
  private sessionEnv: Record<string, string>;
  private defaultSilenceWindowSeconds: number;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;

  constructor(deps: NodeLauncherDeps) {
    // Hard runtime invariant: all domain services must share the same db handle.
    // Without this, db.transaction() in launchNode cannot span all writes atomically.
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("NodeLauncher: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("NodeLauncher: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("NodeLauncher: eventBus must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.sessionEnv = compactEnv(deps.sessionEnv ?? {});
    this.defaultSilenceWindowSeconds = deps.defaultSilenceWindowSeconds ?? 3;
    this.tmuxOptionDefaults = deps.tmuxOptionDefaults ?? null;
  }

  async launchNode(
    rigId: string,
    logicalId: string,
    opts?: LaunchOpts
  ): Promise<LaunchResult> {
    // 1. Validate node exists and is unbound
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "node_not_found", message: `Rig ${rigId} not found` };
    }

    const node = rig.nodes.find((n) => n.logicalId === logicalId);
    if (!node) {
      return { ok: false, code: "node_not_found", message: `Node ${logicalId} not found in rig` };
    }

    if (node.binding !== null) {
      return { ok: false, code: "already_bound", message: `Node ${logicalId} is already bound` };
    }

    // 2. Derive or validate session name
    const sessionName = opts?.sessionName ?? deriveSessionName(rig.rig.name, logicalId);
    if (!validateSessionName(sessionName)) {
      return {
        ok: false,
        code: "invalid_session_name",
        message: `Derived session name "${sessionName}" does not match OpenRig naming pattern`,
      };
    }

    // 3. Create tmux session with OpenRig identity env vars (handle stale duplicate by killing and retrying)
    const openRigEnv = compactEnv({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: sessionName,
      OPENRIG_RUNTIME: node.runtime ?? undefined,
      ...this.sessionEnv,
    });
    const sessionCwd = opts?.cwd ?? node.cwd ?? undefined;
    let tmuxResult = await this.tmuxAdapter.createSession(sessionName, sessionCwd, openRigEnv);
    if (!tmuxResult.ok && tmuxResult.code === "duplicate_session") {
      await this.tmuxAdapter.killSession(sessionName);
      tmuxResult = await this.tmuxAdapter.createSession(sessionName, sessionCwd, openRigEnv);
    }
    if (!tmuxResult.ok) {
      return { ok: false, code: tmuxResult.code, message: tmuxResult.message };
    }

    const launchWarnings: string[] = [];

    // 3a2. OPR.0.4.6.02 S1 — apply the daemon's tmux option defaults to the
    // JUST-CREATED session via the shared applier (mouse/status session-scope
    // + set-clipboard/copy-command server-scope). Touches only this new
    // session, never an existing one (BR-1 never-retro). Option-set failures
    // come back as non-fatal launch warnings.
    if (this.tmuxOptionDefaults) {
      launchWarnings.push(...(await this.tmuxOptionDefaults.applyToFreshSession(sessionName)));
    }

    // 3b. Start transcript rotation (V1 pre-release CLI/daemon Item 1:
    // bounded capture-pane overwrite replaces the unbounded pipe-pane
    // mechanism). Failures inside individual rotation ticks are silent
    // (best-effort); only the transcript directory not being writable
    // surfaces a launch warning.
    if (this.transcriptStore?.enabled) {
      const dirOk = this.transcriptStore.ensureTranscriptDir(rig.rig.name);
      if (dirOk) {
        const transcriptPath = this.transcriptStore.getTranscriptPath(rig.rig.name, sessionName);
        startTranscriptRotation(
          this.tmuxAdapter,
          sessionName,
          transcriptPath,
          getTranscriptRotationOptionsFromEnv(),
        );
      } else {
        launchWarnings.push(`Transcript directory creation failed for rig ${rig.rig.name}`);
      }
    }

    // 4. DB transaction: session + binding + event (atomic)
    let persistedEvent: PersistedEvent;
    let createdSessionId: string | null = null;
    try {
      const txn = this.db.transaction(() => {
        const session = this.sessionRegistry.registerSession(node.id, sessionName);
        createdSessionId = session.id;
        this.sessionRegistry.updateStatus(session.id, "running");
        this.sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
        return this.eventBus.persistWithinTransaction({
          type: "node.launched",
          rigId,
          nodeId: node.id,
          logicalId: node.logicalId,
          sessionName,
        });
      });
      persistedEvent = txn();
    } catch (err) {
      // DB failed — best-effort tmux cleanup
      await this.tmuxAdapter.killSession(sessionName);
      return {
        ok: false,
        code: "db_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 5. Notify subscribers (best-effort, after commit)
    this.eventBus.notifySubscribers(persistedEvent);

    // 6. Fetch the created session + binding for the caller
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    const session = sessions.find((s) => s.id === createdSessionId);
    const binding = this.sessionRegistry.getBindingForNode(node.id);

    return {
      ok: true,
      sessionName,
      session: session!,
      binding: binding!,
      warnings: launchWarnings.length > 0 ? launchWarnings : undefined,
    };
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
