import type { PiRunnerState } from "../adapters/pi-runner-protocol.js";
import { basename } from "node:path";
import { readProcessTableCensus } from "./process-table.js";
import { recordedProcessStillRunning } from "./reconciler.js";
import { nodeSessionConfirmedMissing } from "./node-inventory.js";
import { ActivityGrantStore, hasActivityGrantsTable } from "./activity-grants.js";
import { observeClaudePaneProcess, observeClaudePaneRuntime, observeCodexPaneProcess, listNativeProcesses, type NativeProcessLister, type NativeProcessObservation, type NativeProcessRow } from "./native-process-lineage.js";
import { isShellForeground } from "./shell-classifier.js";
import { claudeResumeRotation } from "./session-registry.js";
import { SessionRegistry } from "./session-registry.js";
import { BackgroundProcessEvidence, type BackgroundProcess } from "./background-process-evidence.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { probeShowsNoServer, type TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";
import { SeatIdentityStore, SelfHostIdentityStore } from "./seat-identity-store.js";
import { RESERVED_HOST_IDS, validateHostRegistry } from "./hosts/hosts-registry-reader.js";
import { communityHarnessOf } from "./built-in-runtimes.js";
import { sessionCommunityHarnessSelect, sessionCommunityRunnerSelect, recordedRunner } from "./session-registry.js";
import { SettingsStore } from "./user-settings/settings-store.js";

/** Default identity-reconcile cadence: 5s. Process identity changes rarely
 *  (a seat's pane/process is stable for its whole life), and the check is
 *  more expensive than the 1Hz activity poll (per-seat pane PID + command
 *  tmux reads), so a slower cadence is the right cost/freshness trade. */
export const DEFAULT_IDENTITY_POLL_INTERVAL_MS = 5000;
/** daemon.identity_poll_interval_ms only slows the reconciler down: below the default it would cost more, not less. */
export const MIN_IDENTITY_POLL_INTERVAL_MS = DEFAULT_IDENTITY_POLL_INTERVAL_MS;
/** The ceiling of daemon.identity_poll_interval_ms (the settings store's bound too): a cap on the cadence, the time
 *  between scheduled sweep attempts; start schedules the first one interval in. It is not a freshness deadline: stored
 *  verdicts carry no age limit in the running/active projection, reconcileAll skips every tick that comes due while a
 *  sweep's reads are still pending, and a change seen after a sweep began waits for a later sweep, so noticing a
 *  stopped or replaced pane process, revoking its grants, or verifying a seat launched without a verdict can take
 *  longer than one interval. */
export const MAX_IDENTITY_POLL_INTERVAL_MS = 30_000;
/** The setting behind the cadence: `daemon.identity_poll_interval_ms`, mapped from OPENRIG_IDENTITY_POLL_INTERVAL_MS. */
export const IDENTITY_POLL_INTERVAL_KEY = "daemon.identity_poll_interval_ms";
type ReadIdentityPollSetting = () => { value: unknown; source?: string };
/** The cadence of the seat identity reconciler, from the typed setting `daemon.identity_poll_interval_ms`
 *  (config.json, or OPENRIG_IDENTITY_POLL_INTERVAL_MS; `rig config` shows it with its source). STARTUP-ONLY: read once
 *  when the daemon starts; changing it takes a daemon restart. Each sweep reads tmux for every running seat's pane and,
 *  for some seats, the process table; on a large fleet a slower cadence trades identity freshness for that load: a
 *  longer interval can delay the sweep noticing a stopped seat or a changed pane process, updating its identity verdict,
 *  and performing the grant revocation that goes with it. Unset keeps the 5 s default. The settings store validates
 *  the value: `rig config set` refuses one outside MIN..MAX, and an env value outside it is dropped with a warning on
 *  stderr (a valid config.json value is used, otherwise the default). A value that still reaches here outside MIN..MAX
 *  (a hand-edited config.json the store could not check) keeps the default, with a warning. */
export function resolveIdentityPollIntervalMs(
  read: ReadIdentityPollSetting = () => new SettingsStore().resolveOne(IDENTITY_POLL_INTERVAL_KEY as never),
  warn: (message: string) => void = (message) => console.warn(message),
): number {
  let setting: { value: unknown; source?: string };
  try {
    setting = read();
  } catch (err) {
    warn(`[seat-identity] ${IDENTITY_POLL_INTERVAL_KEY} could not be read (${err instanceof Error ? err.message : String(err)});`
      + ` using ${DEFAULT_IDENTITY_POLL_INTERVAL_MS} ms`);
    return DEFAULT_IDENTITY_POLL_INTERVAL_MS;
  }
  const ms = Number(setting.value);
  if (!Number.isSafeInteger(ms) || ms < MIN_IDENTITY_POLL_INTERVAL_MS || ms > MAX_IDENTITY_POLL_INTERVAL_MS) {
    warn(`[seat-identity] ${IDENTITY_POLL_INTERVAL_KEY}=${JSON.stringify(setting.value)} is not a whole number of milliseconds`
      + ` in ${MIN_IDENTITY_POLL_INTERVAL_MS}..${MAX_IDENTITY_POLL_INTERVAL_MS}; using ${DEFAULT_IDENTITY_POLL_INTERVAL_MS} ms`);
    return DEFAULT_IDENTITY_POLL_INTERVAL_MS;
  }
  return ms;
}
/** Starts the identity reconciler on the cadence of `daemon.identity_poll_interval_ms` (read once, here) and returns
 *  it; with no reconciler, returns the cadence without starting anything. */
export function startIdentityReconciler(
  reconciler: { start(intervalMs?: number): void } | undefined,
  read?: ReadIdentityPollSetting,
  warn?: (message: string) => void,
): number {
  const ms = resolveIdentityPollIntervalMs(read, warn);
  reconciler?.start(ms);
  return ms;
}

/** Foreground commands that read as a bare shell (a seat that dropped to a
 *  prompt, or an orphan/QA-squat shell occupying the pane). Mirrors the
 *  SessionFingerprinter SHELL_NAMES vocabulary. `pane_current_command` may
 *  carry a login-shell `-` prefix. */
const SHELL_COMMANDS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh",
  "-bash", "-zsh", "-fish", "-sh", "-dash", "-tcsh", "-csh",
]);

/**
 * Legacy short-command classifier. Codex callers additionally require the
 * shared native-process proof; this label alone is not positive Codex identity.
 *
 * Deliberately LENIENT to preserve the slice-15 no-false-green-for-live-seats
 * invariant: a genuinely-live claude/codex TUI usually reports its host
 * process (`node`) as `pane_current_command`, NOT the literal runtime name, so
 * we only declare `mismatch` on a POSITIVE contradiction — a different known
 * agent runtime, or a bare shell where an agent was expected (the process
 * died / an orphan shell squatted the pane). Ambiguous commands (`node`,
 * `python`, empty) never down-rank.
 *
 * Mirrors SessionFingerprinter's Layer-1 process-command vocabulary; we do NOT
 * run the full 4-layer scan (cmux query + pane-content capture) per poll — it
 * is far more expensive at fleet scale and its content layer would not change
 * the down-rank decision here (the reconcile only needs to distinguish
 * "process contradicts the seat" from "no contradiction").
 */
export function classifyPaneRuntimeMatch(
  command: string | null,
  expectedRuntime: string | null,
): "match" | "mismatch" {
  if (!command) return "match"; // no signal — never false-mismatch a present pane
  const cmd = command.trim().toLowerCase();
  // Pi and OMP run their agent behind the OpenRig runner (`node`). Their supported launch shapes normally reach `node`
  // by the time readiness succeeds, but any check can still see a shell: before the launch, or after the agent exits.
  // Terminal seats deliberately run a shell and are not included.
  const expectsAgent = expectedRuntime === "claude-code" || expectedRuntime === "codex"
    || expectedRuntime === "pi" || expectedRuntime === "omp";

  // Positive same-runtime signal.
  if (expectedRuntime === "claude-code" && cmd.includes("claude")) return "match";
  if (expectedRuntime === "codex" && cmd.includes("codex")) return "match";

  // Cross-runtime contradiction (a DIFFERENT agent occupies the pane).
  if (expectedRuntime === "claude-code" && cmd.includes("codex")) return "mismatch";
  if (expectedRuntime === "codex" && cmd.includes("claude")) return "mismatch";

  // A bare shell where an agent runtime was expected — the agent process is
  // gone or an orphan/squat shell occupies the pane.
  if (expectsAgent && SHELL_COMMANDS.has(cmd)) return "mismatch";

  // Ambiguous / expected-shell (terminal nodes) — no contradiction.
  return "match";
}

interface RunningSeatRow {
  node_id: string;
  rig_id: string;
  runtime: string | null;
  session_name: string;
  session_id: string;
  binding_session: string | null;
  tmux_pane: string | null;
  resume_token?: string | null;
  resume_provenance?: string | null;
  resume_rotated_from?: string | null;
  resume_rotated_process?: string | null;
  resume_launch_process?: string | null;
  community_harness?: string | null;
  community_runner?: number | null;
  startup_status?: string | null;
}

type RunnerProcessCensus = { rows: NativeProcessRow[]; permissionHiddenPids: number[] };

type PaneObservation = { pid: number | null; command: string | null; dead?: boolean; observedAt: string };
type TimedNativeProof = NativeProcessObservation & { observedAt: string };

/** Both completion and periodic checks use the same unavailable-observation mapping. */
export function tmuxUnavailableIdentity(input: {
  nodeId: string; runtime: string | null; sessionName: string; registeredPane: string | null; observedAt: string;
  db?: Database.Database; retainStopped?: boolean;
}): SeatIdentityVerdict {
  const stopped = input.db && input.retainStopped !== false && nodeSessionConfirmedMissing(input.db, input.nodeId)
    ? new SeatIdentityStore(input.db).getForNode(input.nodeId) : null;
  if (stopped?.sessionName === input.sessionName && stopped.evidence.registeredPane === input.registeredPane) {
    return { ...stopped, reason: "session_missing_tmux_unavailable", observedAt: input.observedAt };
  }
  return { nodeId: input.nodeId, verdict: input.runtime === "codex" ? "mismatch" : "tmux_unavailable",
    evidenceSource: null, reason: "tmux_unavailable", sessionName: input.sessionName, observedAt: input.observedAt,
    evidence: { registeredPane: input.registeredPane, observedPid: null, observedCommand: null, matchedLayer: null } };
}

export interface SeatIdentityReconcilerDeps {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand"> & Partial<Pick<TmuxAdapter, "readAllPaneProcesses" | "listPanes" | "probeSession">>;
  now?: () => Date;
  listProcesses?: NativeProcessLister;
  readProcessTableCensus?: () => Promise<RunnerProcessCensus>;
  readPiRunnerState?: (sessionName: string, runtime?: "pi" | "omp") => PiRunnerState | null;
}

/**
 * OPR.0.4.3.19 — periodic reconciler for the liveness identity verdict (the
 * THIRD axis). Mirrors SeatActivityService.start(): polls every running
 * tmux-bound managed seat, reconciles the current pane PID/command against the
 * registered seat, and persists the verdict to `seat_identity_verdicts`.
 * Projections then read the cheap persisted verdict synchronously.
 *
 * Non-inference: this reconciler reads ONLY tmux pane process identity vs the
 * registered binding. It NEVER reads queue/classifier/hook heartbeats, and it
 * does NOT touch `terminalActive` / `hasAssignedWork`.
 */
export class SeatIdentityReconciler {
  private readonly db: Database.Database;
  private readonly tmux: SeatIdentityReconcilerDeps["tmux"];
  private readonly now: () => Date;
  private readonly store: SeatIdentityStore;
  private readonly listProcesses: NativeProcessLister;
  private readonly readPiRunnerState?: SeatIdentityReconcilerDeps["readPiRunnerState"];
  private readonly readRunnerCensus: () => Promise<RunnerProcessCensus>;
  private readonly canSampleBackground: boolean;
  private readonly backgroundEvidence = new BackgroundProcessEvidence();
  private readonly backgroundMatches = new Map<string, { generation: string; sessionId: string; processes: BackgroundProcess[] }>();
  private backgroundWorkSnapshot: Array<{ nodeId: string; rigId: string; sessionName: string; state: "unknown"; reason: string; observedAt: string; processes: BackgroundProcess[] }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;
  private generation = 0;

  constructor(deps: SeatIdentityReconcilerDeps) {
    this.db = deps.db;
    this.tmux = deps.tmux;
    this.now = deps.now ?? (() => new Date());
    this.store = new SeatIdentityStore(deps.db);
    this.listProcesses = deps.listProcesses ?? listNativeProcesses;
    this.readPiRunnerState = deps.readPiRunnerState;
    this.canSampleBackground = !deps.listProcesses || !!deps.readProcessTableCensus;
    // Unlike the native best-effort recognizer, absence proof must not turn a census failure into an empty table.
    this.readRunnerCensus = deps.readProcessTableCensus ?? (deps.listProcesses
      ? async () => ({ rows: await deps.listProcesses!(), permissionHiddenPids: [] }) : readProcessTableCensus);
  }

  private runningSeats(): RunningSeatRow[] {
    return this.db.prepare(`
      SELECT n.id as node_id, n.rig_id as rig_id, n.runtime as runtime,
             s.id as session_id, s.session_name as session_name, b.tmux_session as binding_session, b.tmux_pane as tmux_pane, s.resume_token as resume_token,
             s.resume_provenance as resume_provenance,
             s.resume_rotated_from as resume_rotated_from,
             s.resume_rotated_process as resume_rotated_process,
             s.resume_launch_process as resume_launch_process,
             ${sessionCommunityHarnessSelect(this.db)} as community_harness,
             ${sessionCommunityRunnerSelect(this.db)} as community_runner, s.startup_status as startup_status
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.status = 'running'
        AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as RunningSeatRow[];
  }

  /** A missing pane is not evidence that work it started has ended. These are unknowns, not a process inventory. */
  backgroundWorkUnknown(): Array<{ nodeId: string; rigId: string; sessionName: string; state: "unknown"; reason: string; observedAt: string; processes: BackgroundProcess[] }> {
    return this.backgroundWorkSnapshot;
  }

  private computeBackgroundWorkUnknown(): typeof this.backgroundWorkSnapshot {
    const registry = new SessionRegistry(this.db);
    return this.runningSeats().flatMap((seat) => {
      const verdict = this.store.getForNode(seat.node_id);
      if (!verdict || verdict.sessionName !== seat.session_name || verdict.verdict !== "pane_missing"
        || !["session_missing", "pane_pid_gone", "pane_exited"].includes(verdict.reason ?? "")) return [];
      const match = this.backgroundMatches.get(seat.node_id);
      const tenure = registry.currentOccupantTenure(seat.node_id);
      const bootAt = tenure ? parseSqliteUtcMs(tenure.bootAt) : NaN;
      const verdictAt = Date.parse(verdict.observedAt);
      // Tenure boot_at has one-second precision; a verdict in that same second may predate a successor.
      if (tenure && (!Number.isFinite(bootAt) || !Number.isFinite(verdictAt) || verdictAt < bootAt + 1000)) return [];
      const generation = tenure?.generationUuid;
      const processes = match && generation && match.generation === generation && match.sessionId === seat.session_id ? match.processes : [];
      return [{ nodeId: seat.node_id, rigId: seat.rig_id, sessionName: seat.session_name, state: "unknown" as const, reason: verdict.reason!, observedAt: verdict.observedAt, processes }];
    });
  }

  /** Awaited pane reads cannot publish a verdict for a superseded selection. */
  private selectionIsCurrent(seat: RunningSeatRow): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM nodes n JOIN sessions s ON s.node_id = n.id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE n.id = ? AND s.id = ? AND s.status = 'running' AND s.session_name = ?
        AND s.id = (SELECT id FROM sessions WHERE node_id = n.id ORDER BY id DESC LIMIT 1)
        AND n.runtime IS ? AND b.tmux_session IS ? AND b.tmux_pane IS ?
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).get(seat.node_id, seat.session_id, seat.session_name, seat.runtime, seat.binding_session, seat.tmux_pane));
  }

  /** Nodes whose latest session `rig unclaim` released (detached, origin claimed). Unclaim leaves the process running,
   *  so the node's last recorded process stays on record: a fresh launch reads it before reopening a tmux server, and
   *  must not start a second occupant beside a process that still runs. An older schema without `origin` keeps none. */
  private releasedSeats(): string[] {
    try {
      return (this.db.prepare(`
        SELECT n.id as node_id FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        WHERE s.status = 'detached' AND s.origin = 'claimed'
      `).all() as Array<{ node_id: string }>).map((r) => r.node_id);
    } catch {
      return [];
    }
  }

  /** Reconcile every running tmux-bound seat once and persist the verdicts. */
  async reconcileAll(): Promise<void> {
    // Skip ticks while actual reads are pending; never release on a deadline
    // that could leave subprocesses alive. Normal polling cost is unchanged.
    if (this.reconciling) return;
    this.reconciling = true;
    const generation = this.generation;
    try {
      await this.reconcileSweep(generation);
      if (generation === this.generation) this.backgroundWorkSnapshot = this.computeBackgroundWorkUnknown();
    } finally {
      this.reconciling = false;
    }
  }

  private async reconcileSweep(generation: number): Promise<void> {
    const seats = this.runningSeats();
    const registry = new SessionRegistry(this.db);
    const occupantGenerations = new Map(seats.map(seat => [seat.node_id, registry.currentOccupantTenure(seat.node_id)?.generationUuid ?? null]));
    const released = this.releasedSeats();
    const activeNodes = new Set([...seats.map(seat => seat.node_id), ...released]);
    this.backgroundEvidence.retain(activeNodes);
    for (const nodeId of this.backgroundMatches.keys()) if (!activeNodes.has(nodeId)) this.backgroundMatches.delete(nodeId);
    // Capture exact issuance before any observation awaits. A delayed verdict cannot revoke a successor.
    const grants = hasActivityGrantsTable(this.db) ? new ActivityGrantStore(this.db) : null;
    const observedGrants = new Map(seats.map(seat => {
      const grant = grants?.activeForNode(seat.node_id);
      let bootstrapComplete = false;
      const bootstrapRuntime = grant?.binding?.runner === 0 && (grant.binding.runtime === "pi" || grant.binding.runtime === "omp")
        ? grant.binding.runtime : null;
      if (bootstrapRuntime) {
        // A shell can be the launch bootstrap. Capture current-attempt readiness BEFORE observing the pane;
        // a later ready result cannot turn an earlier bootstrap-shell sample into a definitive exit.
        try {
          const state = this.readPiRunnerState?.(seat.session_name, bootstrapRuntime);
          bootstrapComplete = !!state && state.launchId === grant?.runId && (state.ready || !!state.exited);
        } catch { /* Missing launch evidence is unknown, not proof that the runner exited. */ }
      }
      return [seat.node_id, grant?.runId && grant.binding?.pane === seat.tmux_pane
        ? { grantId: grant.grantId, shellExitConfirmed: !bootstrapRuntime || bootstrapComplete }
        : null];
    }));
    // Prune verdicts for nodes no longer running (keep the table bounded), except a released seat's.
    this.store.pruneExcept([...seats.map((s) => s.node_id), ...released]);
    if (seats.length === 0) return;

    // One tmux availability probe per poll. If tmux is entirely unreachable
    // (throws) OR reports zero live sessions while we have running seats in
    // the DB, treat it as a transient tmux blip and record `tmux_unavailable`
    // for legacy runtimes. Codex remains non-green without native evidence.
    let liveSessions: Set<string> | null = null;
    try {
      const sessions = await this.tmux.listSessions();
      liveSessions = new Set(sessions.map((s) => s.name));
    } catch {
      liveSessions = null;
    }
    const observedAt = this.now().toISOString();
    if (generation !== this.generation) return;
    if (liveSessions === null || liveSessions.size === 0) {
      // An empty listing can't tell a blip from a server that's gone, but each seat's own probe can: tmux saying no
      // server runs on the daemon's socket, or a live server without the session, is positive absence, as rig down
      // reads it. A seat whose recorded process still runs is on a server this daemon doesn't see, as the boot
      // reconciler reads it, so it stays unavailable, as does anything else.
      let table: Promise<Array<{ pid: number; ppid: number; command: string; startedAt: string }> | null> | undefined;
      const processes = () => (table ??= this.readRunnerCensus()
        .then(census => census.rows.flatMap(row => row.startedAt === undefined ? [] : [{ ...row, startedAt: row.startedAt }]))
        .catch(() => null));
      for (const seat of seats) {
        const probe = await this.tmux.probeSession?.(seat.session_name).catch(() => null) ?? null;
        const probeAt = this.now().toISOString();
        if (generation !== this.generation) return;
        const absent = probe !== null && (probe.state === "absent" || probeShowsNoServer(probe));
        const elsewhere = await recordedProcessStillRunning(this.db, { nodeId: seat.node_id, sessionName: seat.session_name }, processes);
        if (generation !== this.generation) return;
        const gone = absent && !elsewhere;
        if (!this.selectionIsCurrent(seat)) continue;
        const published = this.store.upsert(gone ? this.sessionMissingVerdict(seat, probeAt)
          : this.tmuxUnavailableVerdict(seat, probeAt, !elsewhere && probe?.state !== "present"));
        // As on the observed path below: the run whose grant was captured before this sweep has ended.
        const observedGrant = observedGrants.get(seat.node_id);
        if (published && gone && observedGrant) grants!.revoke({ grantId: observedGrant.grantId }, "runner_exit_observed");
      }
      await this.refreshBackgroundEvidence(seats, null, occupantGenerations, generation);
      return;
    }

    const readPanes = async (): Promise<Map<string, PaneObservation>> => {
      try {
        const rows = await this.tmux.readAllPaneProcesses?.() ?? [];
        const sampledAt = this.now().toISOString();
        return new Map([...rows].map(([pane, row]) => [pane, { ...row, observedAt: sampledAt }]));
      }
      catch { return new Map(); }
    };
    let panes = await readPanes();
    if (generation !== this.generation) return;
    // Cache the per-pane fallback, including absent PIDs. Selection and verdict
    // share this observation; direct Claude seats need no additional subprocess.
    const readPane = async (target: string): Promise<PaneObservation> => {
      const existing = panes.get(target);
      if (existing) return existing;
      const pid = await this.tmux.getPanePid(target);
      const command = pid === null ? null : await this.tmux.getPaneCommand(target);
      const observed = { pid, command, observedAt: this.now().toISOString() };
      panes.set(target, observed);
      return observed;
    };

    // Only wrapped Claude seats need native proof. Tokenless proof also needs
    // the sole-pane recheck below; do not sample when that capability is absent.
    const nativeSeats: RunningSeatRow[] = [];
    for (const seat of seats) {
      if (!seat.tmux_pane || !liveSessions.has(seat.session_name) || panes.get(seat.tmux_pane)?.dead === true) continue;
      if (seat.runtime === "codex") nativeSeats.push(seat);
      else if (seat.runtime === "claude-code" && (seat.resume_token != null || this.tmux.listPanes)) {
        try {
          let command: string | null;
          if (this.tmux.readAllPaneProcesses) {
            const observed = await readPane(seat.tmux_pane);
            if (observed.pid === null) continue;
            command = observed.command;
          } else {
            // Legacy adapters have no batch. Preserve their independent early
            // selection and final observation rather than caching an early label.
            command = await this.tmux.getPaneCommand(seat.tmux_pane);
          }
          if (classifyPaneRuntimeMatch(command, seat.runtime) === "mismatch"
            && isShellForeground(command?.trim().toLowerCase() ?? "")) nativeSeats.push(seat);
        } catch { /* No proof selected; the final per-seat observation still runs. */ }
        if (generation !== this.generation) return;
      }
    }
    const sample = async (observations: Map<string, PaneObservation>) => {
      let snapshot: ReturnType<NativeProcessLister> | undefined;
      // Two fresh process snapshots, each paired with its own pane observation.
      // The first uses the selection batch; the second starts after it settles.
      const tmux = Object.assign(Object.create(this.tmux) as typeof this.tmux, {
        getPanePid: async (target: string) => {
          const observed = observations.get(target);
          return observed ? observed.pid : this.tmux.getPanePid(target);
        },
      });
      return Promise.all(nativeSeats.map((seat) => (seat.runtime === "codex" ? observeCodexPaneProcess
        : seat.resume_token !== null && seat.resume_token !== undefined ? observeClaudePaneProcess : observeClaudePaneRuntime)({
        target: seat.tmux_pane!, tmux, expectedToken: seat.resume_token, rotation: claudeResumeRotation(seat),
        ...(seat.runtime === "codex" ? { requireArgv: true } : {}),
        listProcesses: () => snapshot ??= this.listProcesses(),
      }).then(proof => proof && { ...proof, observedAt: this.now().toISOString() })));
    };
    const firstPanes = panes;
    // Only sample live work when this pass already needs the two native process observations.
    // Otherwise keep reporting unknown instead of introducing a new periodic process census.
    const trackBackground = this.canSampleBackground && nativeSeats.length > 0 && seats.some(seat => occupantGenerations.get(seat.node_id) && seat.tmux_pane);
    // Share each strict census with the existing native proof's concurrent process read.
    const firstCensusAt = this.now().getTime();
    const firstCensusPromise = trackBackground ? this.readRunnerCensus().catch(() => null) : null;
    const first = await sample(panes);
    const firstCensus = firstCensusPromise ? await firstCensusPromise : null;
    if (generation !== this.generation) return;
    const secondPanes = nativeSeats.length > 0 || trackBackground ? await readPanes() : panes;
    const secondCensusPromise = trackBackground ? this.readRunnerCensus().catch(() => null) : null;
    const second = nativeSeats.length > 0 ? await sample(secondPanes) : [];
    const secondCensus = secondCensusPromise ? await secondCensusPromise : null;
    if (generation !== this.generation) return;
    const nativeProofs = new Map(nativeSeats.map((seat, index) => [seat.node_id,
      first[index] && first[index]?.fingerprint === second[index]?.fingerprint ? second[index]! : null]));
    if (nativeSeats.length > 0 || trackBackground) {
      // Native proof crossed awaits: final verdicts must not reuse the initial
      // command/PID (including a direct seat that became a shell meanwhile).
      panes = await readPanes();
      if (generation !== this.generation) return;
    }
    let runnerProcesses: Promise<RunnerProcessCensus> | undefined;
    const readRunnerProcesses = () => runnerProcesses ??= Promise.resolve().then(() => this.readRunnerCensus());
    for (const seat of seats) {
      try {
        const verdict = await this.computeVerdict(seat, liveSessions, observedAt, nativeProofs.get(seat.node_id) ?? null, panes, readRunnerProcesses);
        if (generation !== this.generation) return;
        if (!this.selectionIsCurrent(seat)) continue;
        if (!this.store.upsert(verdict)) continue;
        const observedGrant = observedGrants.get(seat.node_id);
        if (observedGrant && (verdict.verdict === "pane_missing"
          || (verdict.verdict === "mismatch" && verdict.reason === "process_identity_mismatch" && observedGrant.shellExitConfirmed))) {
          grants!.revoke({ grantId: observedGrant.grantId }, "runner_exit_observed");
        }
      } catch {
        if (generation !== this.generation) return;
        if (!this.selectionIsCurrent(seat)) continue;
        // A single seat's tmux failure must not crash the loop; record it as
        // unavailable observation (non-green for Codex).
        this.store.upsert(this.tmuxUnavailableVerdict(seat, this.now().toISOString(), !liveSessions.has(seat.session_name)));
      }
    }
    await this.refreshBackgroundEvidence(seats, firstPanes, occupantGenerations, generation, firstCensus, secondCensus, panes, firstCensusAt);
  }

  /** Use this existing reconciliation pass; no independent poll or process signalling is introduced. */
  private async refreshBackgroundEvidence(
    seats: RunningSeatRow[], panes: Map<string, PaneObservation> | null,
    occupantGenerations: Map<string, string | null>, sweepGeneration: number,
    firstSnapshot?: RunnerProcessCensus | null, lastSnapshot?: RunnerProcessCensus | null,
    finalPaneSnapshot?: Map<string, PaneObservation>,
    firstCensusAt?: number,
  ): Promise<void> {
    const registry = new SessionRegistry(this.db);
    const eligible = seats.filter(seat => occupantGenerations.get(seat.node_id) && seat.tmux_pane
      && (firstSnapshot != null || (this.backgroundEvidence.has(seat.node_id)
        && this.store.getForNode(seat.node_id)?.verdict === "pane_missing")));
    if (!eligible.length) return;
    let census: RunnerProcessCensus;
    try {
      census = firstSnapshot ?? await this.readRunnerCensus();
    }
    catch { this.backgroundMatches.clear(); return; }
    if (sweepGeneration !== this.generation) return;
    // An omitted process may be a parent; never treat an incomplete table as an attribution.
    if (census.permissionHiddenPids.length) { this.backgroundMatches.clear(); return; }
    const finalPanes = finalPaneSnapshot ?? null;
    if (sweepGeneration !== this.generation) return;
    let finalCensus = census;
    if (firstSnapshot) {
      if (!lastSnapshot) { this.backgroundMatches.clear(); return; }
      finalCensus = lastSnapshot;
      if (sweepGeneration !== this.generation) return;
      if (finalCensus.permissionHiddenPids.length) { this.backgroundMatches.clear(); return; }
    }
    const finalRows = new Map(finalCensus.rows.map(row => [row.pid, row]));
    if (finalRows.size !== finalCensus.rows.length) { this.backgroundMatches.clear(); return; }
    const stableRows = census.rows.filter(row => {
      const last = finalRows.get(row.pid);
      return !!last && !!row.startedAt && row.startedAt === last.startedAt && row.ppid === last.ppid
        && row.command === last.command && last.state !== "Z";
    });
    const current = new Map(this.runningSeats().map(seat => [seat.node_id, seat]));
    for (const seat of eligible) {
      const gen = occupantGenerations.get(seat.node_id)!;
      const nowSeat = current.get(seat.node_id);
      const binding = registry.getBindingForNode(seat.node_id);
      if (!nowSeat || nowSeat.session_id !== seat.session_id || nowSeat.session_name !== seat.session_name
        || nowSeat.tmux_pane !== seat.tmux_pane || binding?.tmuxSession !== seat.session_name
        || binding.tmuxPane !== seat.tmux_pane || registry.currentOccupantTenure(seat.node_id)?.generationUuid !== gen) {
        this.backgroundEvidence.forget(seat.node_id);
        this.backgroundMatches.delete(seat.node_id);
        continue;
      }
      const verdict = this.store.getForNode(seat.node_id);
      const initialPane = panes?.get(seat.tmux_pane!);
      const finalPane = finalPanes?.get(seat.tmux_pane!);
      const root = stableRows.find(row => row.pid === initialPane?.pid);
      if (verdict?.verdict === "verified" && initialPane?.pid && !initialPane.dead
        && finalPane?.pid === initialPane.pid && !finalPane.dead && root?.startedAt
        && firstCensusAt !== undefined && firstCensusAt - Date.parse(root.startedAt) >= 2000) {
        this.backgroundEvidence.capture(seat.node_id, gen, seat.session_id, seat.tmux_pane!, initialPane.pid, stableRows, firstCensusAt, finalCensus.rows);
        this.backgroundMatches.delete(seat.node_id);
      } else if (verdict?.verdict === "pane_missing") {
        const processes = this.backgroundEvidence.afterLoss(seat.node_id, gen, seat.session_id, seat.tmux_pane!, finalCensus.rows);
        this.backgroundMatches.set(seat.node_id, { generation: gen, sessionId: seat.session_id, processes });
      } else {
        this.backgroundMatches.delete(seat.node_id);
      }
    }
  }

  private sessionMissingVerdict(seat: RunningSeatRow, observedAt: string): SeatIdentityVerdict {
    return {
      nodeId: seat.node_id,
      verdict: "pane_missing",
      evidenceSource: "tmux_session",
      reason: "session_missing",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt,
    };
  }

  private tmuxUnavailableVerdict(seat: RunningSeatRow, observedAt: string, retainStopped = true): SeatIdentityVerdict {
    // An unreadable sample cannot undo positive absence for this same session, pane and occupant.
    // A session this sweep listed or probed present, or a positively matched recorded process, undoes it
    // (retainStopped=false).
    return tmuxUnavailableIdentity({ nodeId: seat.node_id, runtime: seat.runtime,
      sessionName: seat.session_name, registeredPane: seat.tmux_pane, observedAt, db: this.db, retainStopped });
  }

  private async computeVerdict(
    seat: RunningSeatRow,
    liveSessions: Set<string>,
    observedAt: string,
    native: TimedNativeProof | null,
    panes: Map<string, PaneObservation> | null = null,
    readRunnerProcesses: () => Promise<RunnerProcessCensus>,
  ): Promise<SeatIdentityVerdict> {
    const base = {
      nodeId: seat.node_id,
      sessionName: seat.session_name,
      observedAt,
    };

    // A null binding pane has two distinct causes. When the target session is
    // absent, that is a down-ranking missing-session fact. When it is live,
    // only the binding is absent: named, and non-green for Codex.
    if (!seat.tmux_pane) {
      if (!liveSessions.has(seat.session_name)) {
        return {
          ...base,
          verdict: "pane_missing",
          evidenceSource: "tmux_session",
          reason: "session_missing",
          evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
        };
      }
      return {
        ...base,
        verdict: seat.runtime === "codex" ? "mismatch" : "binding_absent",
        evidenceSource: "tmux_session",
        reason: "binding_pane_missing",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    // From the sweep's one batched list-panes when the pane is in it; otherwise read per pane as before.
    const batched = panes?.get(seat.tmux_pane) ?? null;
    if (batched) base.observedAt = batched.observedAt;
    if (batched?.dead === true) {
      // Pane IDs can outlive their stored association after a move or server restart.
      // Only observed membership in the exact session proves this executor exited.
      const currentPanes = await this.tmux.listPanes?.(seat.session_name, true).catch(() => null);
      if (!currentPanes?.some(pane => pane.id === seat.tmux_pane)) return this.tmuxUnavailableVerdict(seat, this.now().toISOString(), !liveSessions.has(seat.session_name) && !currentPanes?.length);
      return {
        ...base, verdict: "pane_missing", evidenceSource: "pane_process", reason: "pane_exited",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: batched.command, matchedLayer: null },
      };
    }
    const pid = batched ? batched.pid : await this.tmux.getPanePid(seat.tmux_pane);
    if (!batched) base.observedAt = this.now().toISOString();
    if (pid === null) {
      // getPanePid collapses transport/read failures into null. Only a readable census
      // showing another pane, or a successful session snapshot proving absence, establishes loss.
      const sessionAlive = liveSessions.has(seat.session_name);
      if (sessionAlive) {
        const currentPanes = await this.tmux.listPanes?.(seat.session_name, true).catch(() => null);
        base.observedAt = this.now().toISOString();
        if (!currentPanes?.length || currentPanes.some(pane => pane.id === seat.tmux_pane)) {
          return this.tmuxUnavailableVerdict(seat, base.observedAt, !liveSessions.has(seat.session_name));
        }
      }
      return {
        ...base,
        verdict: "pane_missing",
        evidenceSource: sessionAlive ? "pane_process" : "tmux_session",
        reason: sessionAlive ? "pane_pid_gone" : "session_missing",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const command = batched ? batched.command : await this.tmux.getPaneCommand(seat.tmux_pane);
    if (!batched) base.observedAt = this.now().toISOString();
    if (command === null && seat.runtime === "claude-code") {
      return this.tmuxUnavailableVerdict(seat, base.observedAt, !liveSessions.has(seat.session_name));
    }
    if (seat.runtime === "codex" || (seat.runtime === "claude-code" && (seat.resume_token != null || native !== null)
      && classifyPaneRuntimeMatch(command, seat.runtime) === "mismatch" && isShellForeground(command?.trim().toLowerCase() ?? ""))) {
      let verified = native?.panePid === pid;
      if (verified && seat.runtime === "claude-code" && seat.resume_token == null) {
        // Runtime-only proof must still refer to the sole bound pane after the
        // two shared process snapshots. It does not clear startup/restore state.
        const currentPanes = await this.tmux.listPanes?.(seat.session_name).catch(() => []);
        const currentPid = await this.tmux.getPanePid(seat.tmux_pane).catch(() => null);
        verified = currentPanes?.length === 1 && currentPanes[0]?.id === seat.tmux_pane && currentPid === pid;
      }
      return {
        ...base, verdict: verified ? "verified" : "mismatch",
        observedAt: seat.runtime === "codex" && verified && native ? native.observedAt : base.observedAt,
        evidenceSource: "pane_process", reason: verified ? null : "process_identity_ambiguous",
        evidence: { registeredPane: seat.tmux_pane, observedPanePid: pid, observedPid: native?.process.pid ?? pid,
          observedCommand: native?.process.command ?? command, matchedLayer: verified ? 1 : null },
      };
    }
    const match = classifyPaneRuntimeMatch(command, seat.runtime);
    if (match === "mismatch") {
      return {
        ...base,
        verdict: "mismatch",
        evidenceSource: "pane_process",
        reason: "process_identity_mismatch",
        evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
      };
    }

    // Core can observe a runner's exit without any native reference, but a live process never verifies its conversation.
    if (communityHarnessOf(seat.community_harness, seat.runtime)) {
      const unconfirmed: SeatIdentityVerdict = { ...base, verdict: "unconfirmed", evidenceSource: "pane_process",
        reason: "process_identity_unconfirmed",
        evidence: { registeredPane: seat.tmux_pane, observedPanePid: pid, observedPid: pid, observedCommand: command, matchedLayer: null } };
      if (!recordedRunner(seat.community_runner) || seat.startup_status !== "ready"
        || !isShellForeground(command?.trim().toLowerCase() ?? "")) return unconfirmed;
      let census: RunnerProcessCensus | null = null;
      try { census = await readRunnerProcesses(); } catch { /* Unreadable census cannot establish absence. */ }
      const [finalPid, finalCommand, membership] = await Promise.all([
        this.tmux.getPanePid(seat.tmux_pane), this.tmux.getPaneCommand(seat.tmux_pane),
        this.tmux.listPanes?.(seat.session_name, true).catch(() => null) ?? null,
      ]);
      unconfirmed.observedAt = this.now().toISOString();
      const selected = this.db.prepare(`SELECT s.id AS session_id,s.startup_status,n.runtime,b.tmux_session,b.tmux_pane FROM sessions s
        JOIN nodes n ON n.id=s.node_id LEFT JOIN bindings b ON b.node_id=n.id WHERE n.id=? ORDER BY s.id DESC LIMIT 1`)
        .get(seat.node_id) as { session_id: string; startup_status: string | null; runtime: string | null; tmux_session: string | null; tmux_pane: string | null } | undefined;
      if (finalPid !== pid || finalCommand !== command || !membership?.some(pane => pane.id === seat.tmux_pane)
        || selected?.session_id !== seat.session_id || selected.startup_status !== "ready" || selected.runtime !== seat.runtime
        || selected.tmux_session !== seat.session_name || selected.tmux_pane !== seat.tmux_pane) {
        return { ...unconfirmed, evidence: { ...unconfirmed.evidence, observedPanePid: null, observedPid: null } };
      }
      // A hidden stat cannot reveal its parent; even an unrelated omission prevents this absence proof.
      if (!census || census.permissionHiddenPids.length > 0) return unconfirmed;
      const rows = census.rows;
      const root = rows.find(row => row.pid === pid);
      if (!root) return unconfirmed;
      // Any live child makes this a wrapper/ambiguous subtree. Its argv cannot prove native identity and is never persisted.
      const child = rows.find(row => row.ppid === pid && row.pid !== pid);
      if (child) return { ...unconfirmed, evidence: { ...unconfirmed.evidence, observedPid: child.pid } };
      const shell = root.executableName ?? basename(root.command.trim().split(/\s+/)[0] ?? "");
      if (!isShellForeground(shell.toLowerCase()) || !root.pgid || root.pgid <= 0 || root.tpgid !== root.pgid) return unconfirmed;
      return { ...unconfirmed, verdict: "mismatch", reason: "process_identity_mismatch" };
    }

    return {
      ...base,
      verdict: "verified",
      evidenceSource: "pane_process",
      reason: null,
      evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
    };
  }

  /** Start the scheduler. Idempotent — calling twice is a no-op. */
  start(intervalMs: number = DEFAULT_IDENTITY_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll();
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the scheduler. Safe to call before start or multiple times. */
  stop(): void {
    // Fence old observations without releasing their flight before settlement.
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

// ── 51-09 increment 1: durable daemon self-host identity ─────────────────────
// Co-located with the seat-identity substrate per arch ruling cb19867f (extend,
// do not invent a parallel identity lifecycle). Reconciled once AT BOOT.

/**
 * Reserved / non-identity host tokens that must NEVER become a self-host id: the
 * registry reserved set ({kernel, host, local}, hosts-registry-reader) plus the
 * bare display default "localhost" (host.name's default — display-only per DP4,
 * never an identity). Compared case-insensitively.
 */
export const RESERVED_SELF_HOST_SEEDS = new Set<string>([...RESERVED_HOST_IDS, "localhost"]);

function isReservedSeed(candidate: string): boolean {
  return RESERVED_SELF_HOST_SEEDS.has(candidate.trim().toLowerCase());
}

/**
 * Assert a self-host id is never empty and never a reserved/display token.
 * Throws (loud, fail-closed) if violated — the never-'local' invariant guard.
 */
export function assertNeverReservedHostId(hostId: string): void {
  const norm = hostId.trim().toLowerCase();
  if (!norm) {
    throw new Error("[self-host-identity] invariant: self-host id must be non-empty");
  }
  if (RESERVED_SELF_HOST_SEEDS.has(norm)) {
    throw new Error(
      `[self-host-identity] invariant: self-host id must never be a reserved/display token (got '${hostId}'; reserved: ${[...RESERVED_SELF_HOST_SEEDS].sort().join(", ")})`,
    );
  }
}

/**
 * Where a live self-host id CAME FROM, derived at read time — `named`, `generated`, or the honest
 * `indeterminate`.
 *
 * WHY DERIVED AND NOT READ: `self_host_identity` stores `host_id`, `minted_at`, `reconciled_at` and
 * NOTHING about provenance, so there is no record to consult. Recording it properly is a migration
 * and belongs with the population work, not here.
 *
 * `indeterminate` is load-bearing, not a cop-out. It is exactly the CONFLICT state the reconciler
 * already warns about: an operator sets `host.name` AFTER the id was minted, the reconciler keeps
 * the original id (a durable identity is never silently re-keyed), and from then on the configured
 * name and the live id disagree. Calling that `generated` would be a false claim about a machine
 * someone did name, and an unknown that reads as a known state is the whole defect this slice is
 * about.
 */
export type SelfHostIdSource = "named" | "generated" | "indeterminate";

const GENERATED_SELF_HOST_ID = /^host-[0-9a-f]{8}$/;

export function deriveSelfHostIdSource(
  hostId: string | null | undefined,
  hostNameCandidate: string | null | undefined,
): SelfHostIdSource | null {
  if (typeof hostId !== "string" || hostId.trim() === "") return null;
  // ADMISSIBILITY MUST MATCH THE MINT BRANCH EXACTLY, not merely "is it set".
  // `host.name` DEFAULTS to "localhost", which is a reserved display token the reconciler refuses as
  // a seed — so on a freshly generated host the candidate is present-but-unusable. Testing only for
  // presence reported `indeterminate` for the most ordinary machine there is: one nobody named.
  const candidate = normalizeCandidate(hostNameCandidate);
  const admissibleSeed =
    candidate !== null && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : null;

  // Seeded from the operator's name and still agreeing with it.
  if (admissibleSeed !== null && admissibleSeed === hostId) return "named";
  // Nobody usably named this machine and the id carries the generated shape: the retained generated-id fallback.
  if (admissibleSeed === null && GENERATED_SELF_HOST_ID.test(hostId)) return "generated";
  // An admissible name that DISAGREES (the conflict the reconciler keeps and warns about), or an id
  // whose shape fits neither story. Unprovable, and said so.
  return "indeterminate";
}

/** A collision-safe generated self-host id, used when no unambiguous operator seed exists. */
function generateSelfHostId(): string {
  return `host-${randomUUID().slice(0, 8)}`;
}

// ── 51-09 increment 2b: self-id ↔ registry-id ALIGNMENT (arch ruling dfa65bfc) ─
// Interpretation (ii): there is NO registry self-row (type-incoherent against the
// closed HostEntry union); the alignment property is that the minted self-host id
// must be a VALID, NON-RESERVED registry id so a REMOTE host can adopt it as a
// registry key (transport-carries-host). We REUSE the canonical registry-id
// validator (validateHostRegistry — the CLI/daemon lockstep twin, parity-pinned
// in hosts-registry-parity.test.ts) via a single-entry probe rather than a
// divergent copy of its rules (regex + reserved set). The probe fixes a valid
// transport/target so ONLY the id can fail — ok===false iff the id is invalid.

function isRegistryValidSelfId(id: string): boolean {
  return validateHostRegistry(
    { hosts: [{ id, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  ).ok;
}

/**
 * 51-09 increment 2b — the FAIL-CLOSED registry-alignment assert. A durable
 * self-host id that is not a valid registry id could not be resolved by a remote
 * host as a key (transport-carries-host breaks), so it is a fatal boot
 * misconfiguration. Escalates increment 1's loud-conflict posture to a
 * fail-closed assert-on-boot for the registry-alignment case, per the ruling.
 */
export function assertSelfHostIdRegistryAligned(hostId: string): void {
  const probe = validateHostRegistry(
    { hosts: [{ id: hostId, transport: "ssh", target: "self-host-alignment-probe" }] },
    "<self-host-identity>",
  );
  if (!probe.ok) {
    throw new Error(
      `[self-host-identity] registry-alignment: self-host id '${hostId}' is not a valid registry id — remote hosts could not resolve it as a key. ${probe.error} Fix the operator host.name or drop the self-host record to re-key.`,
    );
  }
}

function normalizeCandidate(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface SelfHostReconcileResult {
  hostId: string;
  minted: boolean;
  /**
   * Populated (non-null) when a stored id already exists AND an operator
   * candidate (host.name) differs from it — the identity is NEVER silently
   * re-keyed; the stored id is kept and the conflict is surfaced loudly. This is
   * the general loud-conflict mechanism increment 2 reuses for self-id ↔
   * registry-id alignment.
   */
  conflict: { storedId: string; candidate: string } | null;
}

/**
 * 51-09 increment 1 — mint-or-reconcile the daemon's durable self-host id at
 * boot. First boot MINTS (seeding from an unambiguous operator host.name where
 * present, else a generated collision-safe id); every subsequent boot RECONCILES
 * (advances reconciled_at, keeps the id — restart ⇒ same id). host.name is a
 * DISPLAY-ONLY candidate seed (arch ruling cb19867f / DP4); a reserved/default
 * candidate is rejected in favour of a generated id. When a stored id exists and
 * the operator candidate now differs, the id is KEPT (never silent re-key) and a
 * LOUD conflict naming BOTH is surfaced.
 */
export function reconcileSelfHostIdentity(
  store: SelfHostIdentityStore,
  opts: { nowIso: string; hostNameCandidate?: string | null; log?: (message: string) => void },
): SelfHostReconcileResult {
  const log = opts.log ?? ((message: string) => console.error(message));
  const candidate = normalizeCandidate(opts.hostNameCandidate);
  const existing = store.get();

  if (existing) {
    store.touchReconciledAt(opts.nowIso);
    assertNeverReservedHostId(existing.hostId);
    // 51-09 incr 2b: fail-closed if the stored self-id is not a valid registry id
    // (a pre-2b-minted or DB-tampered id that a remote could not adopt as a key).
    assertSelfHostIdRegistryAligned(existing.hostId);
    let conflict: SelfHostReconcileResult["conflict"] = null;
    if (candidate && !isReservedSeed(candidate) && candidate !== existing.hostId) {
      conflict = { storedId: existing.hostId, candidate };
      log(
        `[self-host-identity] CONFLICT: operator host.name '${candidate}' differs from the minted self-host id '${existing.hostId}'. Keeping '${existing.hostId}' — a durable host identity is NEVER silently re-keyed. Re-key deliberately (drop the self-host record) or reconcile the display name.`,
      );
    }
    return { hostId: existing.hostId, minted: false, conflict };
  }

  // 51-09 incr 2b: a host.name seed is adopted ONLY when it is a valid registry id
  // (non-reserved via incr-1's case-insensitive guard AND registry-id-format valid),
  // so a format-invalid operator host.name falls back to a generated valid id
  // rather than minting an unusable, boot-bricking self-id.
  const seed =
    candidate && !isReservedSeed(candidate) && isRegistryValidSelfId(candidate)
      ? candidate
      : generateSelfHostId();
  assertNeverReservedHostId(seed);
  const record = store.mint(seed, opts.nowIso);
  // Belt: the minted id (adopted-valid or generated) is registry-aligned.
  assertSelfHostIdRegistryAligned(record.hostId);
  return { hostId: record.hostId, minted: true, conflict: null };
}
