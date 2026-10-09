// V0.3.1 slice 05 kernel-rig-as-default — forward-fix #3 architectural.
// Decouples daemon health/listen from kernel-agent readiness.
//
// Prior behavior: `bootKernelIfNeeded` awaited `bootstrapOrchestrator.bootstrap(...)`
// inside `createDaemon`, so the daemon process couldn't reach `serve()` until
// the kernel rig's members had been launched + their startup deliveries
// completed. A broken kernel agent (e.g., Codex unauthenticated mid-boot)
// stalled healthz too. The CLI then reported "daemon failed to start" even
// though the daemon itself was perfectly happy — only the *kernel* was sad.
//
// New behavior: `bootKernelIfNeeded` builds a tracker, fires the bootstrap
// in the background, and returns immediately. The daemon binds healthz as
// soon as `createDaemon` completes (HTTP server bind happens in server.ts
// right after). Tracker state is published via GET /api/kernel/status so
// operators (and CLI flags like `--wait-for-kernel`) can observe progress.
//
// A configurable degraded-timer (default 90s) emits a single
// `kernel.agent.degraded` event if the kernel doesn't reach a ready / partial-
// ready state in time — telemetry that something is keeping the kernel
// stuck (auth / spec / tmux / etc.).

import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RigRepository } from "./rig-repository.js";
import type { BootstrapResult } from "./bootstrap-orchestrator.js";
import type { Session } from "./types.js";

export type KernelState =
  | "skipped"           // OPENRIG_NO_KERNEL=1 / VITEST auto-skip / kernel already managed
  | "auth_blocked"      // Both Claude Code + Codex unauthenticated; cannot pick a variant
  | "spec_missing"      // Selected variant's rig.yaml not found on disk
  | "booting"           // Bootstrap fired; awaiting member startup_status
  | "partial_ready"     // Bootstrap done; some members ready, others still pending/failed
  | "ready"             // Bootstrap done; all members reached ready
  | "bootstrap_failed"  // Bootstrap promise rejected or returned errors
  | "degraded";         // Booting > degradedTimeoutMs without reaching ready/partial_ready

export interface KernelAgentStatus {
  /** Session name (e.g. `advisor-lead@kernel`). */
  sessionName: string;
  /** Runtime declared in the agent profile (claude-code / codex / terminal). */
  runtime: string;
  /** Startup status from the sessions table. Same enum as session-registry. */
  startupStatus: "pending" | "ready" | "attention_required" | "failed";
  /** Present when the seat's newest session is detached (its tmux session is gone) or exited. */
  down?: true;
}

/** Reconcile marks a session whose tmux session is gone `detached`; teardown marks it `exited`. */
function isDownSession(session: Pick<Session, "status">): boolean {
  // superseded: a launch restore rolled back. Like detached and exited, nothing of it is running.
  return session.status === "detached" || session.status === "exited" || session.status === "superseded";
}

export interface KernelBootStatus {
  kernelState: KernelState;
  agents: KernelAgentStatus[];
  /** ISO timestamp of when the kernel first entered booting; null in
   *  terminal/skipped states. */
  firstUnreadySince: string | null;
  /** Filename of the picked variant (rig.yaml / rig-claude-only.yaml /
   *  rig-codex-only.yaml). null when no variant was selected. */
  variant: string | null;
  /** Human-readable detail for auth_blocked / spec_missing /
   *  bootstrap_failed / degraded states. null otherwise. */
  detail: string | null;
  /** A boot failure the kernel has since recovered from: every seat it expects is ready again, so
   *  kernelState is ready and this keeps the failure as history. null otherwise, including while
   *  the failure is still current. */
  lastBootFailure: { state: "bootstrap_failed" | "degraded"; detail: string | null; at: string | null } | null;
  /** The boot is the restore of an existing kernel a reboot or crash left down, not a first boot:
   *  whether that restore is still running or has returned. null for any other boot. */
  existingRestore: "in_progress" | "finished" | null;
}

export interface KernelBootTrackerDeps {
  eventBus: EventBus;
  sessionRegistry: SessionRegistry;
  rigRepo: RigRepository;
  /** Milliseconds the tracker waits in `booting` before emitting
   *  `kernel.agent.degraded` and transitioning to the `degraded` state.
   *  Default 90_000 (90s) per IMPL-PRD §6.3 amendment. Tests pass
   *  shorter values; daemon startup honors the OPENRIG_KERNEL_DEGRADED_MS
   *  env override resolved by startup.ts. */
  degradedTimeoutMs?: number;
}

export class KernelBootTracker {
  private state: KernelState = "skipped";
  private variant: string | null = null;
  private detail: string | null = null;
  private firstUnreadySince: string | null = null;
  private failedAt: string | null = null;
  /** The seats the booting kernel spec declares (`pod.member`). null when unknown, which keeps a
   *  boot failure current: recovery needs the whole expected roster, never just the rows present. */
  private expectedSeats: string[] | null = null;
  private degradedTimer: ReturnType<typeof setTimeout> | null = null;
  private degradedEmitted = false;
  private bootstrapInFlight = false;
  private managedKernelLive = false;
  private existingRestore = false;

  constructor(private readonly deps: KernelBootTrackerDeps) {}

  /** Mark the tracker as having intentionally not booted (--no-kernel,
   *  already-managed short-circuit, VITEST auto-skip). Terminal state;
   *  no degraded timer. */
  setSkipped(detail: string): void {
    this.cancelTimer();
    this.state = "skipped";
    this.detail = detail;
    this.firstUnreadySince = null;
  }

  /** The daemon skipped its boot because a kernel rig already exists with seats still running. Its
   *  status then follows those seats when they read ready or partial_ready (the same aggregation as
   *  a cold boot), instead of always `skipped`. Otherwise it stays `skipped`, as before, so a running
   *  kernel whose seats are not ready yet never newly blocks `rig start`. */
  observeManagedKernel(): void {
    this.managedKernelLive = true;
  }

  /** Auth-blocked terminal. Operator sees the 3-part error in detail. */
  setAuthBlocked(message: string): void {
    this.cancelTimer();
    this.state = "auth_blocked";
    this.detail = message;
    this.firstUnreadySince = null;
  }

  /** Spec-missing terminal. Path is in detail for ops triage. */
  setSpecMissing(specPath: string): void {
    this.cancelTimer();
    this.state = "spec_missing";
    this.detail = specPath;
    this.firstUnreadySince = null;
  }

  /** Begin tracking an in-flight bootstrap. The bootstrap promise
   *  is awaited internally; the caller does NOT block on it. */
  startBooting(
    variant: string | null,
    bootstrapPromise: Promise<Pick<BootstrapResult, "errors">>,
    expectedSeats?: readonly string[] | null,
    opts: { existingRestore?: boolean } = {},
  ): void {
    if (this.bootstrapInFlight) return;
    this.bootstrapInFlight = true;
    this.existingRestore = opts.existingRestore === true;
    this.state = "booting";
    this.variant = variant;
    this.detail = null;
    this.firstUnreadySince = new Date().toISOString();
    this.failedAt = null;
    this.expectedSeats = expectedSeats && expectedSeats.length > 0 ? [...expectedSeats] : null;
    this.degradedEmitted = false;
    this.scheduleDegradedTimer();

    bootstrapPromise
      .then((result) => this.onBootstrapComplete(result))
      .catch((err) => this.onBootstrapError(err));
  }

  /** Read current status. Computes agents[] live from the sessions
   *  table so the response always reflects the freshest startup_status. */
  getStatus(): KernelBootStatus {
    const agents = this.computeAgents();
    const state = this.state;
    let kernelState = state;
    let lastBootFailure: KernelBootStatus["lastBootFailure"] = null;
    // Once bootstrap has completed (state == 'booting' before then),
    // promote to ready / partial_ready based on agent startup_status.
    if (state === "booting" && !this.bootstrapInFlight) {
      kernelState = this.aggregateReadinessFromAgents(agents);
    } else if (state === "skipped" && this.managedKernelLive) {
      const aggregated = this.aggregateReadinessFromAgents(agents);
      // agents[] lists seats with a session; a declared seat that never launched keeps it partial.
      if (aggregated === "ready") kernelState = this.everyKernelNodeHasSession() ? "ready" : "partial_ready";
      else if (aggregated === "partial_ready") kernelState = aggregated;
    } else if (
      (state === "bootstrap_failed" || state === "degraded")
      && !this.bootstrapInFlight
      && this.aggregateReadinessFromAgents(agents) === "ready"
      && this.rosterRecovered()
    ) {
      // Every seat the kernel expects has since reached ready (a resolved startup gate, a
      // `rig seat continue`), so the failure is history, not current health. A seat that is not
      // ready, has no session, or has no node keeps it current, and so does an unknown roster.
      kernelState = "ready";
      lastBootFailure = { state, detail: this.detail, at: this.failedAt };
    }
    return {
      kernelState,
      agents,
      firstUnreadySince:
        kernelState === "ready" || kernelState === "skipped"
          ? null
          : this.firstUnreadySince,
      variant: this.variant,
      detail: lastBootFailure ? null : this.detail,
      lastBootFailure,
      existingRestore: this.existingRestore ? (this.bootstrapInFlight ? "in_progress" : "finished") : null,
    };
  }

  /** Stop the degraded timer. Safe to call from anywhere (idempotent).
   *  Production callers don't need this; tests + graceful daemon
   *  shutdown do. */
  stop(): void {
    this.cancelTimer();
  }

  private onBootstrapComplete(result: Pick<BootstrapResult, "errors">): void {
    this.bootstrapInFlight = false;
    if (result.errors && result.errors.length > 0) {
      this.cancelTimer();
      this.state = "bootstrap_failed";
      this.detail = result.errors.join("; ");
      this.failedAt = new Date().toISOString();
      return;
    }
    // Bootstrap returned cleanly. State transitions to ready /
    // partial_ready are computed on read from agents[]. Cancel the
    // degraded timer ONLY when at least one agent is ready — until
    // then, the kernel is still effectively booting and the operator
    // wants the degraded telemetry if no agent ever reaches ready.
    const agents = this.computeAgents();
    const aggregated = this.aggregateReadinessFromAgents(agents);
    if (aggregated === "ready" || aggregated === "partial_ready") {
      this.cancelTimer();
    }
  }

  private onBootstrapError(err: unknown): void {
    this.bootstrapInFlight = false;
    this.cancelTimer();
    this.state = "bootstrap_failed";
    this.detail = err instanceof Error ? err.message : String(err);
    this.failedAt = new Date().toISOString();
  }

  private aggregateReadinessFromAgents(
    agents: KernelAgentStatus[],
  ): KernelState {
    if (agents.length === 0) {
      // Bootstrap finished but no agents are registered yet (race
      // window between session insert + status update). Keep state
      // as booting so the operator sees progress, not a false ready.
      return "booting";
    }
    // A seat whose newest session is gone keeps its last startup status; it is not ready.
    const readyCount = agents.filter((a) => a.startupStatus === "ready" && !a.down).length;
    if (readyCount === agents.length) return "ready";
    if (readyCount === 0) return "booting";
    return "partial_ready";
  }

  private computeAgents(): KernelAgentStatus[] {
    try {
      // Archived kernel generations aren't the current kernel.
      const out: KernelAgentStatus[] = [];
      for (const rig of this.deps.rigRepo.findUnarchivedRigsByName("kernel")) {
        // One entry per seat. The runtime is on the node row, not the session.
        const runtimeByNode = new Map(
          (this.deps.rigRepo.getRig(rig.id)?.nodes ?? []).map((node) => [node.id, node.runtime]),
        );
        for (const s of this.latestSessionByNode(rig.id).values()) {
          out.push({
            sessionName: s.sessionName,
            runtime: runtimeByNode.get(s.nodeId) ?? "unknown",
            startupStatus: s.startupStatus,
            ...(isDownSession(s) ? { down: true } : {}),
          });
        }
      }
      return out;
    } catch {
      // Tracker must NEVER throw — /api/kernel/status returning a
      // valid envelope with empty agents[] is more useful than a 500
      // when the DB has a transient hiccup.
      return [];
    }
  }

  /** A relaunch or `rig seat continue` adds a session row for the same node, so only each node's
   *  newest row is the seat's current startup status. */
  private latestSessionByNode(rigId: string): Map<string, Session> {
    const latestByNode = new Map<string, Session>();
    for (const s of this.deps.sessionRegistry.getSessionsForRig(rigId)) {
      const prior = latestByNode.get(s.nodeId);
      if (!prior || s.createdAt > prior.createdAt || (s.createdAt === prior.createdAt && s.id > prior.id)) {
        latestByNode.set(s.nodeId, s);
      }
    }
    return latestByNode;
  }

  /** False when a current kernel node has no session at all, and on any read error. */
  private everyKernelNodeHasSession(): boolean {
    try {
      for (const rig of this.deps.rigRepo.findUnarchivedRigsByName("kernel")) {
        const latest = this.latestSessionByNode(rig.id);
        if ((this.deps.rigRepo.getRig(rig.id)?.nodes ?? []).some((node) => !latest.has(node.id))) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** True only when every kernel node's newest session is ready and every expected seat has such a
   *  node. A node with no session is not ready, and a member that failed before its node was
   *  created is missing. False when the expected roster is unknown, and on any read error. */
  private rosterRecovered(): boolean {
    if (!this.expectedSeats) return false;
    try {
      const readySeats = new Set<string>();
      for (const rig of this.deps.rigRepo.findUnarchivedRigsByName("kernel")) {
        const latest = this.latestSessionByNode(rig.id);
        for (const node of this.deps.rigRepo.getRig(rig.id)?.nodes ?? []) {
          const session = latest.get(node.id);
          if (session?.startupStatus !== "ready" || isDownSession(session)) return false;
          readySeats.add(node.logicalId);
        }
      }
      return readySeats.size > 0 && this.expectedSeats.every((seat) => readySeats.has(seat));
    } catch {
      return false;
    }
  }

  private scheduleDegradedTimer(): void {
    const ms = this.deps.degradedTimeoutMs ?? 90_000;
    if (ms <= 0) return;
    this.cancelTimer();
    this.degradedTimer = setTimeout(() => this.checkDegraded(), ms);
    // Allow the daemon to exit cleanly without waiting on the timer.
    if (typeof this.degradedTimer === "object" && "unref" in this.degradedTimer) {
      (this.degradedTimer as unknown as { unref(): void }).unref();
    }
  }

  private cancelTimer(): void {
    if (this.degradedTimer !== null) {
      clearTimeout(this.degradedTimer);
      this.degradedTimer = null;
    }
  }

  private checkDegraded(): void {
    const agents = this.computeAgents();
    const aggregated =
      this.state === "booting"
        ? this.aggregateReadinessFromAgents(agents)
        : this.state;
    if (aggregated === "ready" || aggregated === "partial_ready") {
      // Made it before the deadline; no degraded emission.
      return;
    }
    // Promote to degraded + emit telemetry exactly once.
    if (this.degradedEmitted) return;
    this.degradedEmitted = true;
    this.state = "degraded";
    this.failedAt = new Date().toISOString();
    try {
      this.deps.eventBus.emit({
        type: "kernel.agent.degraded",
        agents: agents.map((a) => ({
          sessionName: a.sessionName,
          runtime: a.runtime,
          startupStatus: a.startupStatus,
        })),
        firstUnreadySince: this.firstUnreadySince,
        detail: this.detail,
      });
    } catch {
      // Best-effort telemetry; tracker must not throw.
    }
  }
}
