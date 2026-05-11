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
  private degradedTimer: ReturnType<typeof setTimeout> | null = null;
  private degradedEmitted = false;
  private bootstrapInFlight = false;

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
  startBooting(variant: string, bootstrapPromise: Promise<BootstrapResult>): void {
    if (this.bootstrapInFlight) return;
    this.bootstrapInFlight = true;
    this.state = "booting";
    this.variant = variant;
    this.detail = null;
    this.firstUnreadySince = new Date().toISOString();
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
    let kernelState = this.state;
    // Once bootstrap has completed (state == 'booting' before then),
    // promote to ready / partial_ready based on agent startup_status.
    if (this.state === "booting" && !this.bootstrapInFlight) {
      kernelState = this.aggregateReadinessFromAgents(agents);
    }
    return {
      kernelState,
      agents,
      firstUnreadySince:
        kernelState === "ready" || kernelState === "skipped"
          ? null
          : this.firstUnreadySince,
      variant: this.variant,
      detail: this.detail,
    };
  }

  /** Stop the degraded timer. Safe to call from anywhere (idempotent).
   *  Production callers don't need this; tests + graceful daemon
   *  shutdown do. */
  stop(): void {
    this.cancelTimer();
  }

  private onBootstrapComplete(result: BootstrapResult): void {
    this.bootstrapInFlight = false;
    if (result.errors && result.errors.length > 0) {
      this.cancelTimer();
      this.state = "bootstrap_failed";
      this.detail = result.errors.join("; ");
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
    const readyCount = agents.filter((a) => a.startupStatus === "ready").length;
    if (readyCount === agents.length) return "ready";
    if (readyCount === 0) return "booting";
    return "partial_ready";
  }

  private computeAgents(): KernelAgentStatus[] {
    try {
      const kernelRigs = this.deps.rigRepo.findRigsByName("kernel");
      if (kernelRigs.length === 0) return [];
      const out: KernelAgentStatus[] = [];
      for (const rig of kernelRigs) {
        const sessions = this.deps.sessionRegistry.getSessionsForRig(rig.id);
        for (const s of sessions) {
          // session-registry's Session shape carries startupStatus +
          // sessionName; runtime comes from the node row. Read minimal
          // fields here so the tracker doesn't pull in node-repository.
          out.push({
            sessionName: s.sessionName,
            runtime: (s as { runtime?: string }).runtime ?? "unknown",
            startupStatus: s.startupStatus,
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
