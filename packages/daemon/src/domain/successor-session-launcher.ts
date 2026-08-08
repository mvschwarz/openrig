import { ulid } from "ulid";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { RuntimeHint } from "./discovery-types.js";
import type { RuntimeAdapter, NodeBinding, ReadinessResult } from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode } from "./runtime-adapter.js";
import type { AppliedLaunchObservation } from "./permission-drift.js";
import type { TmuxOptionDefaultsApplier } from "./tmux-option-defaults.js";

/**
 * OPR.0.4.3.04 — the explicit successor-creation seam for the seat-handover
 * full-cycle composer (IMPL-SPEC §2.1b; resolves the rev1-dual BLOCKING B1).
 *
 * It creates an UNMANAGED, discoverable tmux successor for a non-discovered
 * handover source (fresh), routes it through REAL runtime startup so it becomes
 * a LIVE, READY agent (not a bare shell), records it as an ACTIVE discovery
 * candidate, and returns that candidate + the captured launch resume token so
 * the composer can route it through the EXISTING discovered->commit rebind path.
 * It deliberately does NOT `registerClaimedSession`/`upsertBinding` — the
 * session stays unmanaged until the handover `commit` claims it, so the
 * departing seat's binding is never touched before successor readiness.
 *
 * B1 (rev1-dual fix): the successor is launched through the runtime adapter's
 * `launchHarness` + readiness poll — the SAME startup/readiness primitives
 * `StartupOrchestrator` drives — WITHOUT the ahead-of-commit managed-session
 * registration those `StartupOrchestrator.startNode` bookkeeping steps would
 * require (updateStartupStatus / node_startup_context / updateResumeToken by
 * sessionId all need a registered session row). Driving the adapter primitives
 * directly is how we make the successor a live agent while keeping it unmanaged
 * until commit. Any launch/readiness failure UNWINDS the created session and
 * leaves the original binding intact (commit never runs).
 *
 * Why not `NodeLauncher.launchNode`: it refuses a bound node and, on success,
 * registers a managed session + binding in the same transaction — which would
 * trip `successor_already_managed` in the commit path. This seam creates a
 * DISTINCT unmanaged session instead.
 */
export interface SuccessorNode {
  id: string;
  runtime: string | null;
  cwd: string | null;
  /** OPR.0.4.8.3 Seam B: the departing seat's PERSISTED resolved launch posture —
   *  the successor is a CONTINUITY edge of the same seat, so its policy posture
   *  carries (populated by the caller from node provenance; absent = env decision). */
  launchPosture?: "floor" | "full_bypass";
  /** 0.5.2-07 model fidelity: the seat's SPEC-pinned model (nodes.model). The successor is a continuity
   *  edge of the same seat, so its launch must READ THE SPEC — a launch path that drops it makes the
   *  running topology drift from the founder-designed one. Populated by the caller from node provenance;
   *  absent → the adapter emits no model flag (unchanged for legacy/unpinned seats). */
  model?: string | null;
}

export type SuccessorLaunchResult =
  | {
      ok: true;
      discoveredId: string;
      tmuxSession: string;
      tmuxPane: string;
      resumeToken?: string;
      resumeType?: string;
      appliedLaunch?: AppliedLaunchObservation;
      /**
       * OPR.0.4.6.02 S1 — non-fatal tmux option-default warnings from the
       * fresh successor's launch (mouse/status/clipboard). Present only when
       * an option-set degraded; omitted (undefined) on the clean path so the
       * shape stays byte-compatible with pre-02 successors.
       */
      warnings?: string[];
    }
  | { ok: false; code: string; step: "create_successor" | "resolve_pane" | "start_agent"; message: string };

export class SuccessorSessionLauncher {
  private tmuxAdapter: TmuxAdapter;
  private discoveryRepo: DiscoveryRepository;
  private sessionEnv: Record<string, string | undefined>;
  private newId: () => string;
  private runtimeAdapters: Record<string, RuntimeAdapter>;
  private readinessTimeoutMs: number;
  private sleep: (ms: number) => Promise<void>;
  private tmuxOptionDefaults: TmuxOptionDefaultsApplier | null;
  private exitPollMs: number;
  private exitTimeoutMs: number;

  constructor(
    tmuxAdapter: TmuxAdapter,
    discoveryRepo: DiscoveryRepository,
    opts: {
      sessionEnv?: Record<string, string | undefined>;
      newId?: () => string;
      /** Runtime adapters keyed by runtime, used to launch + ready-probe the
       *  successor agent. Absent → a fresh successor cannot be launched. */
      runtimeAdapters?: Record<string, RuntimeAdapter>;
      /** Readiness timeout in ms (default 30000, mirrors StartupOrchestrator). */
      readinessTimeoutMs?: number;
      /** Injectable sleep (tests). */
      sleep?: (ms: number) => Promise<void>;
      /**
       * OPR.0.4.6.02 S1 — the SHARED tmux option-defaults applier. A FRESH
       * successor is a new operator/agent seat (same launch-only class as
       * NodeLauncher), so it gets the same mouse/status/clipboard defaults on
       * its just-created session. Omitted → option application is skipped.
       */
      tmuxOptionDefaults?: TmuxOptionDefaultsApplier;
      /** Cutover retiree-exit poll interval + total bounded timeout (per graceful/forced phase). */
      exitPollMs?: number;
      exitTimeoutMs?: number;
    } = {},
  ) {
    this.tmuxAdapter = tmuxAdapter;
    this.discoveryRepo = discoveryRepo;
    this.sessionEnv = opts.sessionEnv ?? {};
    this.newId = opts.newId ?? ulid;
    this.runtimeAdapters = opts.runtimeAdapters ?? {};
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.tmuxOptionDefaults = opts.tmuxOptionDefaults ?? null;
    this.exitPollMs = opts.exitPollMs ?? 100;
    this.exitTimeoutMs = opts.exitTimeoutMs ?? 3_000;
  }

  /**
   * Create the unmanaged successor tmux session, launch it into a LIVE agent,
   * and record it as an active discovery candidate. The candidate satisfies the
   * discovered->commit guards: active (upsert sets status='active'), distinct
   * name, matching runtime hint, unmanaged (no binding/session claims it),
   * tmux-present (just created). The returned resume token (if any) is the
   * launch-scraped token the composer persists at commit (B2 for fresh).
   */
  async createSuccessor(input: {
    node: SuccessorNode;
    departingSessionName: string;
    occupantGeneration?: string | null;
  }): Promise<SuccessorLaunchResult> {
    // CUTOVER MODEL (plan 411c43de): a SEAT = one durable tmux session; the successor takes over the
    // retiree's EXACT pane via respawn-pane, so the canonical session name is PRESERVED (no -h shuffle)
    // and native scrollback survives — predecessor history stays above the successor boot (the money
    // proof). The retiree exits in place; its provider session file is the durable wake target, so the
    // new unwind invariant is that a failed successor NEVER destroys that recoverable state.
    const departingSession = input.departingSessionName;

    // OpenRig identity env mirrors NodeLauncher.launchNode's pattern so the successor self-identifies +
    // reports activity like a launched seat. OPENRIG_SESSION_NAME is the PRESERVED canonical name.
    const env = compactEnv({
      OPENRIG_NODE_ID: input.node.id,
      OPENRIG_SESSION_NAME: departingSession,
      OPENRIG_RUNTIME: input.node.runtime ?? undefined,
      ...this.sessionEnv,
      OPENRIG_OCCUPANT_GENERATION: input.occupantGeneration ?? undefined,
    });
    const cwd = input.node.cwd ?? undefined;

    // 1. Resolve the DEPARTING session's active pane — the retiree's pane we take over. A probe throw or
    //    an empty result is a structured resolve_pane failure BEFORE any respawn, so the seat is wholly
    //    untouched (still the live retiree; nothing to recover).
    let pane: { id: string } | undefined;
    try {
      const panes = await this.tmuxAdapter.listPanes(departingSession);
      pane = panes.find((p) => p.active) ?? panes[0];
    } catch (err) {
      return {
        ok: false,
        code: "pane_probe_failed",
        step: "resolve_pane",
        message: `Could not probe tmux panes for departing session "${departingSession}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!pane) {
      return {
        ok: false,
        code: "pane_unresolved",
        step: "resolve_pane",
        message: `Could not resolve a tmux pane for departing session "${departingSession}".`,
      };
    }

    // 2. Terminate the retiree IN PLACE, then respawn the now-dead pane WITHOUT -k so native scrollback
    //    survives (respawn-pane -k CLEARS the pane history — verified on tmux 3.6a; that would defeat the
    //    money-proof). The swap: set remain-on-exit so the pane survives the exit → graceful SIGTERM
    //    ("exits in place"; also protects the provider session state the successor's resume depends on) →
    //    bounded-timeout SIGKILL fallback (pinned degraded path) → respawn-pane (no -k) on the dead pane.
    const terminated = await this.terminateRetiree(pane.id);
    if (!terminated.ok) {
      return { ok: false, code: "retiree_not_terminated", step: "create_successor", message: terminated.message };
    }
    const respawned = await this.tmuxAdapter.respawnPane(pane.id, undefined, { cwd, env });
    if (!respawned.ok) {
      return {
        ok: false,
        code: (respawned as { code?: string }).code ?? "respawn_failed",
        step: "create_successor",
        message: `Could not respawn the successor into pane "${pane.id}" of "${departingSession}": ${(respawned as { message?: string }).message ?? "respawn-pane failed"}`,
      };
    }

    // Ghost-stage (e) re-key: the retiring occupant's seat-name-keyed stores are invalidated so the
    // successor never inherits a ghost. That call is made ATOMICALLY at SeatHandoverService.commit()
    // (inside the rebind tx, where the retiring + successor names are in scope), per the ghost-stage
    // contract — NOT here at the swap, so it commits together with the rebind. See occupant-invalidator.ts.

    // 3. Route the successor through REAL runtime startup (launchHarness send-keys + readiness) so it
    //    becomes a LIVE, READY agent in the reused pane BEFORE it can be committed. UNWIND INVARIANT:
    //    on ANY launch/readiness failure we do NOT killSession the preserved seat — that would destroy
    //    the retiree's recoverable state. We return the structured failure and leave the re-wakeable
    //    shell in the pane; commit never runs, so the binding is not repointed.
    const started = await this.startAgent(input.node, departingSession, pane.id, cwd);
    if (!started.ok) {
      return { ok: false, code: started.code, step: "start_agent", message: started.message };
    }

    const discovered = this.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: departingSession,
      tmuxPane: pane.id,
      // The hint equals the node's own runtime, so the commit-path runtime check always matches; null
      // runtime records as "unknown" (which the check skips).
      runtimeHint: (input.node.runtime ?? "unknown") as RuntimeHint,
      confidence: "high",
      cwd: input.node.cwd ?? undefined,
    });

    return {
      ok: true,
      discoveredId: discovered.id,
      tmuxSession: departingSession,
      tmuxPane: pane.id,
      resumeToken: started.resumeToken,
      resumeType: started.resumeType,
      appliedLaunch: started.appliedLaunch,
    };
  }

  /**
   * B1 — launch the successor into a live, ready agent via the runtime adapter's
   * `launchHarness` + readiness probe (the same primitives StartupOrchestrator
   * drives), capturing the launch resume token. No session/binding is
   * registered — the successor stays unmanaged until commit. The token is NEVER
   * logged or placed in a returned message.
   */
  private async startAgent(
    node: SuccessorNode,
    tmuxSession: string,
    tmuxPane: string,
    cwd: string | undefined,
  ): Promise<{ ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: AppliedLaunchObservation } | { ok: false; code: string; message: string }> {
    const adapter = node.runtime ? this.runtimeAdapters[node.runtime] : undefined;
    if (!adapter) {
      return {
        ok: false,
        code: "successor_runtime_unsupported",
        message: `No runtime adapter for "${node.runtime ?? "unknown"}"; a live successor cannot be launched for this seat.`,
      };
    }

    // Transient binding for the adapter launch/readiness probe — the successor
    // is unmanaged, so there is no persisted binding row (id/updatedAt are inert
    // for the adapter; it reads tmuxSession/tmuxPane/cwd/model). 0.5.2-07 (model
    // fidelity): the SPEC-pinned model IS carried now — a successor is a continuity
    // edge of the same seat, so its launch must read the seat's spec, else the
    // running topology silently drifts from the founder-designed one at every
    // handover. (config profile is still a tracked follow-on.)
    const binding: NodeBinding = {
      id: "",
      nodeId: node.id,
      attachmentType: "tmux",
      tmuxSession,
      tmuxWindow: null,
      tmuxPane,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: cwd ?? "",
      // Seam B: continuity — the successor launches at the departing seat's posture.
      ...(node.launchPosture ? { launchPosture: node.launchPosture } : {}),
      // 0.5.2-07: the successor reads the seat's SPEC-pinned model (adapter emits -m/--model).
      model: node.model ?? undefined,
    };

    let launch: Awaited<ReturnType<RuntimeAdapter["launchHarness"]>>;
    try {
      launch = await adapter.launchHarness(binding, { name: tmuxSession });
    } catch (err) {
      return { ok: false, code: "successor_launch_failed", message: `Successor harness launch threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!launch.ok) {
      return { ok: false, code: "successor_launch_failed", message: `Successor harness launch failed: ${launch.error}` };
    }

    // Capture the launch-scraped resume token (never logged). Persisted by the
    // composer at commit with provenance "scrape" (B2, launched modes).
    let resumeToken: string | undefined;
    let resumeType: string | undefined;
    const trimmed = launch.resumeToken?.trim();
    if (trimmed) {
      resumeToken = trimmed;
      resumeType = launch.resumeType;
    }

    // OPR.0.4.3.04 rev2 code-review fix — checkReady/waitForReady can THROW after
    // createSession already succeeded (adapter/socket/permission errors rethrow).
    // A thrown exception must NOT reject createSuccessor before its kill/unwind
    // runs (that would LEAK the unmanaged successor + surface an unstructured 500).
    // Catch it here and return a STRUCTURED ok:false so the caller kills the
    // just-created session (killBestEffort) and fails loudly at step=start_agent —
    // exactly like a returned readiness failure.
    let readiness: ReadinessResult;
    try {
      readiness = await this.waitForReady(adapter, binding);
    } catch (err) {
      return {
        ok: false,
        code: "successor_readiness_failed",
        message: `Successor readiness probe threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!readiness.ready) {
      return {
        ok: false,
        code: isAttentionRequiredReadinessCode(readiness.code) ? "successor_attention_required" : "successor_not_ready",
        message: `Successor did not become a ready agent: ${readiness.reason ?? "readiness timeout"}`,
      };
    }

    return { ok: true, resumeToken, resumeType, appliedLaunch: launch.appliedLaunch };
  }

  /**
   * Wait for harness readiness with exponential backoff (1s→2s→…→16s cap,
   * 30s default timeout) — mirrors StartupOrchestrator.waitForReady.
   */
  private async waitForReady(adapter: RuntimeAdapter, binding: NodeBinding): Promise<ReadinessResult> {
    const startTime = Date.now();
    let delay = 1000;
    const maxDelay = 16_000;

    while (true) {
      const result = await adapter.checkReady(binding);
      if (result.ready) return result;
      if (isAttentionRequiredReadinessCode(result.code)) return result;

      const elapsed = Date.now() - startTime;
      if (elapsed + delay > this.readinessTimeoutMs) {
        const finalResult = await adapter.checkReady(binding);
        if (finalResult.ready) return finalResult;
        return { ready: false, reason: result.reason ?? "readiness timeout" };
      }

      await this.sleep(delay);
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /**
   * Cutover: terminate the retiree occupant in its pane so the successor can respawn into it WHILE
   * PRESERVING scrollback. `setRemainOnExit(true)` FIRST (so the pane survives dead, not destroyed, on
   * exit); graceful SIGTERM ("exits in place" — a clean exit also protects the provider session state the
   * successor's resume depends on); a bounded-timeout SIGKILL is the pinned DEGRADED fallback. Returns
   * which path terminated the retiree, or a failure if it never became dead (then commit never runs).
   * (Graceful signal = SIGTERM as the desk-provisional default under build-ahead; dev-planner ratifies
   * the exact graceful mechanism — SIGTERM vs a runtime-specific quit — at their resume.)
   */
  private async terminateRetiree(
    paneId: string,
  ): Promise<{ ok: true; path: "graceful" | "forced" } | { ok: false; message: string }> {
    await this.tmuxAdapter.setRemainOnExit(paneId, true);
    await this.tmuxAdapter.signalPaneProcess(paneId, "TERM");
    if (await this.waitPaneDead(paneId)) return { ok: true, path: "graceful" };
    // Graceful window elapsed — force-kill (the pinned degraded path).
    await this.tmuxAdapter.signalPaneProcess(paneId, "KILL");
    if (await this.waitPaneDead(paneId)) return { ok: true, path: "forced" };
    return { ok: false, message: `Retiree in pane "${paneId}" did not exit after graceful TERM + forced KILL.` };
  }

  /** Poll `isPaneDead` up to the bounded exit timeout (count-bounded so injected no-op sleeps stay fast). */
  private async waitPaneDead(paneId: string): Promise<boolean> {
    const maxPolls = Math.max(1, Math.ceil(this.exitTimeoutMs / this.exitPollMs));
    for (let i = 0; i < maxPolls; i++) {
      if (await this.tmuxAdapter.isPaneDead(paneId)) return true;
      await this.sleep(this.exitPollMs);
    }
    return this.tmuxAdapter.isPaneDead(paneId);
  }

  /**
   * Composer unwind for a successor that launched but failed downstream (context delivery or continuity
   * verify). CUTOVER INVARIANT: the successor occupies the retiree's PRESERVED pane, so cleanup NEVER
   * kills the session — that would destroy the seat's recoverable state. It only marks the discovery
   * candidate vanished; the re-wakeable shell stays in the pane and the seat is recoverable from its
   * provider session file. (`tmuxSession` is retained for signature stability + call-site logging.)
   */
  async cleanup(_tmuxSession: string, discoveredId: string | null): Promise<void> {
    if (discoveredId) this.discoveryRepo.markVanished([discoveredId]);
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
