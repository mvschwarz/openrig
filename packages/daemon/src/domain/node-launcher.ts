import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { TranscriptStore } from "./transcript-store.js";
import type { PersistedEvent } from "./types.js";
import { validateSessionName, deriveSessionName } from "./session-name.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";
import { paneObservationVerdict } from "./pane-binding-observation.js";
import type { AttachmentKind, SeatHost, SeatKindRegistry } from "./seat-kinds.js";
import { TmuxSeatHost } from "./tmux-seat-host.js";
import { SeatIdentityStore } from "./seat-identity-store.js";
import type { OccupantKind } from "./session-registry.js";
import { mergeSeatEnv, seatEnvLaunchVars, type SeatEnv } from "./seat-env.js";
import { SEAT_PROJECT_DIR_ENV, seatCorePluginDir, withCorePlugin } from "./claude-core-plugin-env.js";

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
  /** A deliberate fresh occupant is distinct from initial rig boot in the tenure ledger. */
  occupantKind?: OccupantKind;
  /** One-off env for this launch only (`rig up --env`); wins over the spec's env and is not saved. */
  env?: SeatEnv;
  /** The seat's resolved plugin locations (what the profile resolver selected for it, or a snapshot saved). A Claude
   *  seat whose selection includes the vendored openrig-core plugin loads it. Without this the node's saved startup
   *  context is read. */
  pluginPaths?: readonly string[];
  /** The seat kind to launch. Absent = tmux. Any other kind must be registered in `seatKinds`. */
  kind?: AttachmentKind;
}

interface NodeLauncherDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  tmuxAdapter: TmuxAdapter;
  transcriptStore?: TranscriptStore;
  sessionEnv?: Record<string, string | undefined>;
  /** Extra launch env for one runtime only (OMP's provider keys), merged over
   *  sessionEnv so other runtimes' seats never receive it. */
  runtimeSessionEnv?: Record<string, Record<string, string | undefined>>;
  /** Where the daemon vendors its plugins; default is `plugins` under the OpenRig home (tests). */
  pluginsDir?: string;
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
  /** Seat kinds registered beyond tmux; absent = none. */
  seatKinds?: SeatKindRegistry;
}

export class NodeLauncher {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private tmuxAdapter: TmuxAdapter;
  private transcriptStore: TranscriptStore | null;
  private sessionEnv: Record<string, string>;
  private runtimeSessionEnv: Record<string, Record<string, string | undefined>>;
  private pluginsDir: string | undefined;
  private defaultSilenceWindowSeconds: number;
  private tmuxSeatHost: TmuxSeatHost;
  private seatKinds: SeatKindRegistry | null;

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
    this.runtimeSessionEnv = deps.runtimeSessionEnv ?? {};
    this.pluginsDir = deps.pluginsDir;
    this.defaultSilenceWindowSeconds = deps.defaultSilenceWindowSeconds ?? 3;
    this.tmuxSeatHost = new TmuxSeatHost({
      tmuxAdapter: deps.tmuxAdapter,
      transcriptStore: this.transcriptStore,
      tmuxOptionDefaults: deps.tmuxOptionDefaults ?? null,
    });
    this.seatKinds = deps.seatKinds ?? null;
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

    const guard = this.tmuxAdapter.deliveryGuard;
    if (guard && !guard.ownsLifecycle(node.id)) {
      return guard.lifecycle([node.id], () => this.launchNode(rigId, logicalId, opts));
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

    // 3. Reserve the source-bound occupant generation before the process starts. Reservation is
    // side-effect-free and fail-open: an unavailable ledger yields null and the launch remains valid.
    const occupantGeneration = this.sessionRegistry.reserveOccupantGeneration();

    // Create tmux session with OpenRig identity env vars. A duplicate is a
    // collision, never authority to kill an unmanaged same-name session.
    const specEnv = this.rigRepo.getEffectiveSeatEnv(node.id);
    const corePluginDir = seatCorePluginDir(node, this.db, opts?.pluginPaths, this.pluginsDir);
    const sessionCwd = opts?.cwd ?? node.cwd ?? undefined;
    const launchEnv = (oneOff?: SeatEnv) => compactEnv({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: sessionName,
      OPENRIG_RUNTIME: node.runtime ?? undefined,
      ...this.sessionEnv,
      ...(node.runtime ? this.runtimeSessionEnv[node.runtime] : undefined),
      ...seatEnvLaunchVars(withCorePlugin(mergeSeatEnv(specEnv, oneOff), corePluginDir)),
      // The launch project of a seat that loads the plugin, so a Claude started elsewhere inside the seat is not taken for it.
      [SEAT_PROJECT_DIR_ENV]: corePluginDir ? sessionCwd : undefined,
      OPENRIG_OCCUPANT_GENERATION: occupantGeneration ?? undefined,
    });
    const openRigEnv = launchEnv(opts?.env);
    const kind = opts?.kind && opts.kind !== "tmux" ? this.seatKinds?.custom(opts.kind) ?? null : null;
    if (opts?.kind && opts.kind !== "tmux" && !kind) {
      return { ok: false, code: "seat_kind_unknown", message: `No seat kind '${opts.kind}' is registered with this daemon` };
    }
    const host: SeatHost = kind?.host ?? this.tmuxSeatHost;
    const seatRef = { nodeId: node.id, sessionName, runtime: node.runtime ?? null, kind: kind?.kind ?? "tmux", pane: null, occupant: null };
    const created = await host.create({
      nodeId: node.id,
      rigName: rig.rig.name,
      sessionName,
      cwd: sessionCwd,
      env: openRigEnv,
      ...(opts?.env && Object.keys(opts.env).length > 0 ? { oneOffEnv: { names: Object.keys(opts.env), baseline: launchEnv() } } : {}),
    });
    if (!created.ok) {
      return { ok: false, code: created.code, message: created.message };
    }

    const launchWarnings: string[] = created.warnings;
    const paneObservation = created.paneObservation;

    // 4. DB transaction: session + binding + event (atomic)
    let persistedEvent: PersistedEvent;
    let createdSessionId: string | null = null;
    try {
      const txn = this.db.transaction(() => {
        const session = this.sessionRegistry.registerSession(
          node.id,
          sessionName,
          opts?.occupantKind ?? "initial",
          occupantGeneration,
        );
        createdSessionId = session.id;
        this.sessionRegistry.updateStatus(session.id, "running");
        this.sessionRegistry.updateBinding(node.id, kind ? { attachmentType: kind.kind, externalSessionName: sessionName } : created.binding);
        if (paneObservation && !paneObservation.ok) {
          new SeatIdentityStore(this.db).upsert(paneObservationVerdict({
            nodeId: node.id,
            sessionId: session.id,
            sessionName,
            observation: paneObservation,
          }));
        }
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
      // DB failed — best-effort cleanup of the seat just made
      await host.stop(seatRef);
      return {
        ok: false,
        code: "db_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    this.tmuxAdapter.deliveryGuard?.rebindLifecycle(node.id);
    if (!kind) this.tmuxAdapter.finishLaunchBinding?.(sessionName);

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
