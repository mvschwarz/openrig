import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";
import { SeatIdentityStore, SelfHostIdentityStore } from "./seat-identity-store.js";
import { RESERVED_HOST_IDS, validateHostRegistry } from "./hosts/hosts-registry-reader.js";

/** Default identity-reconcile cadence: 5s. Process identity changes rarely
 *  (a seat's pane/process is stable for its whole life), and the check is
 *  more expensive than the 1Hz activity poll (per-seat pane PID + command
 *  tmux reads), so a slower cadence is the right cost/freshness trade. */
export const DEFAULT_IDENTITY_POLL_INTERVAL_MS = 5000;

/** Foreground commands that read as a bare shell (a seat that dropped to a
 *  prompt, or an orphan/QA-squat shell occupying the pane). Mirrors the
 *  SessionFingerprinter SHELL_NAMES vocabulary. `pane_current_command` may
 *  carry a login-shell `-` prefix. */
const SHELL_COMMANDS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh",
  "-bash", "-zsh", "-fish", "-sh", "-dash", "-tcsh", "-csh",
]);

/**
 * Classify the pane's foreground command against the registered runtime.
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
  const expectsAgent = expectedRuntime === "claude-code" || expectedRuntime === "codex";

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
  runtime: string | null;
  session_name: string;
  tmux_pane: string | null;
}

export interface SeatIdentityReconcilerDeps {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand">;
  now?: () => Date;
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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SeatIdentityReconcilerDeps) {
    this.db = deps.db;
    this.tmux = deps.tmux;
    this.now = deps.now ?? (() => new Date());
    this.store = new SeatIdentityStore(deps.db);
  }

  private runningSeats(): RunningSeatRow[] {
    return this.db.prepare(`
      SELECT n.id as node_id, n.runtime as runtime,
             s.session_name as session_name, b.tmux_pane as tmux_pane
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.status = 'running'
        AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as RunningSeatRow[];
  }

  /** Reconcile every running tmux-bound seat once and persist the verdicts. */
  async reconcileAll(): Promise<void> {
    const seats = this.runningSeats();
    // Prune verdicts for nodes no longer running (keep the table bounded).
    this.store.pruneExcept(seats.map((s) => s.node_id));
    if (seats.length === 0) return;

    const observedAt = this.now().toISOString();

    // One tmux availability probe per poll. If tmux is entirely unreachable
    // (throws) OR reports zero live sessions while we have running seats in
    // the DB, treat it as a transient tmux blip and record `tmux_unavailable`
    // for every seat — NEVER down-rank a live fleet on an infra hiccup.
    let liveSessions: Set<string> | null = null;
    try {
      const sessions = await this.tmux.listSessions();
      liveSessions = new Set(sessions.map((s) => s.name));
    } catch {
      liveSessions = null;
    }
    if (liveSessions === null || liveSessions.size === 0) {
      for (const seat of seats) {
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
      return;
    }

    for (const seat of seats) {
      try {
        this.store.upsert(await this.computeVerdict(seat, liveSessions, observedAt));
      } catch {
        // A single seat's tmux failure must not crash the loop; record it as
        // an unknown (non-down-ranking) observation.
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
    }
  }

  private tmuxUnavailableVerdict(seat: RunningSeatRow, observedAt: string): SeatIdentityVerdict {
    return {
      nodeId: seat.node_id,
      verdict: "tmux_unavailable",
      evidenceSource: null,
      reason: "tmux_unavailable",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt,
    };
  }

  private async computeVerdict(
    seat: RunningSeatRow,
    liveSessions: Set<string>,
    observedAt: string,
  ): Promise<SeatIdentityVerdict> {
    const base = {
      nodeId: seat.node_id,
      sessionName: seat.session_name,
      observedAt,
    };

    // No registered pane to reconcile against — we cannot verify identity.
    // Non-down-ranking (unknown), so a missing binding pane never flips a live
    // seat non-green.
    if (!seat.tmux_pane) {
      return {
        ...base,
        verdict: "tmux_unavailable",
        evidenceSource: null,
        reason: "tmux_unavailable",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const pid = await this.tmux.getPanePid(seat.tmux_pane);
    if (pid === null) {
      // The registered pane no longer resolves. Distinguish "the whole tmux
      // session is gone" from "the pane within a live session is gone".
      const sessionAlive = liveSessions.has(seat.session_name);
      return {
        ...base,
        verdict: "pane_missing",
        evidenceSource: sessionAlive ? "pane_process" : "tmux_session",
        reason: sessionAlive ? "pane_pid_gone" : "session_missing",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const command = await this.tmux.getPaneCommand(seat.tmux_pane);
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
  const candidate = normalizeCandidate(hostNameCandidate);
  // Seeded from the operator's name and still agreeing with it.
  if (candidate !== null && candidate === hostId) return "named";
  // Nobody named this machine and the id carries the generated shape: the founder-kept fallback.
  if (candidate === null && GENERATED_SELF_HOST_ID.test(hostId)) return "generated";
  // A configured name that disagrees, or an id whose shape matches neither story.
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
