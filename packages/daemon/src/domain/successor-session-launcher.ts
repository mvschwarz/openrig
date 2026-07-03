import { ulid } from "ulid";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { DiscoveryRepository } from "./discovery-repository.js";
import type { RuntimeHint } from "./discovery-types.js";
import type { RuntimeAdapter, NodeBinding, ReadinessResult } from "./runtime-adapter.js";
import { isAttentionRequiredReadinessCode } from "./runtime-adapter.js";

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
}

export type SuccessorLaunchResult =
  | { ok: true; discoveredId: string; tmuxSession: string; tmuxPane: string; resumeToken?: string; resumeType?: string }
  | { ok: false; code: string; step: "create_successor" | "resolve_pane" | "start_agent"; message: string };

export class SuccessorSessionLauncher {
  private tmuxAdapter: TmuxAdapter;
  private discoveryRepo: DiscoveryRepository;
  private sessionEnv: Record<string, string | undefined>;
  private newId: () => string;
  private runtimeAdapters: Record<string, RuntimeAdapter>;
  private readinessTimeoutMs: number;
  private sleep: (ms: number) => Promise<void>;

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
    } = {},
  ) {
    this.tmuxAdapter = tmuxAdapter;
    this.discoveryRepo = discoveryRepo;
    this.sessionEnv = opts.sessionEnv ?? {};
    this.newId = opts.newId ?? ulid;
    this.runtimeAdapters = opts.runtimeAdapters ?? {};
    this.readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Create the unmanaged successor tmux session, launch it into a LIVE agent,
   * and record it as an active discovery candidate. The candidate satisfies the
   * discovered->commit guards: active (upsert sets status='active'), distinct
   * name, matching runtime hint, unmanaged (no binding/session claims it),
   * tmux-present (just created). The returned resume token (if any) is the
   * launch-scraped token the composer persists at commit (B2 for fresh).
   */
  async createSuccessor(input: { node: SuccessorNode; departingSessionName: string }): Promise<SuccessorLaunchResult> {
    // Distinct successor name derived from the departing occupant's (valid)
    // session name so it stays inside the tmux/OpenRig naming charset while
    // never colliding with the current occupant.
    const distinctName = `${input.departingSessionName}-h${this.newId().slice(-8)}`;

    // OpenRig identity env mirrors NodeLauncher.launchNode's pattern so the
    // successor self-identifies + reports activity exactly like a launched seat.
    const env = compactEnv({
      OPENRIG_NODE_ID: input.node.id,
      OPENRIG_SESSION_NAME: distinctName,
      OPENRIG_RUNTIME: input.node.runtime ?? undefined,
      ...this.sessionEnv,
    });
    const cwd = input.node.cwd ?? undefined;

    // Driver note 1: create via the ACTUAL adapter signature createSession(name, cwd, env).
    const created = await this.tmuxAdapter.createSession(distinctName, cwd, env);
    if (!created.ok) {
      // tmux can run hooks after creating the session; if a hook fails,
      // `new-session` can return non-zero while the unmanaged session remains.
      // Do not kill on duplicate_session, which may be a real pre-existing
      // collision. All other failed-create cases get best-effort cleanup.
      if (created.code !== "duplicate_session") {
        await this.killBestEffort(distinctName);
      }
      return { ok: false, code: created.code, step: "create_successor", message: created.message };
    }

    // Driver note 2: resolve the real tmux pane AFTER create, BEFORE upsertDiscoveredSession —
    // upsert requires a pane, and createSession returns only { ok: true }.
    // A list-panes probe can THROW (permission/socket errors rethrow from the
    // adapter); treat a throw EXACTLY like the null-pane case — kill the
    // just-created successor and return the structured resolve_pane failure, so
    // the unmanaged session is never left orphaned and the caller never sees an
    // unstructured rejection/500.
    let pane: { id: string } | undefined;
    try {
      const panes = await this.tmuxAdapter.listPanes(distinctName);
      pane = panes.find((p) => p.active) ?? panes[0];
    } catch (err) {
      await this.tmuxAdapter.killSession(distinctName);
      return {
        ok: false,
        code: "pane_probe_failed",
        step: "resolve_pane",
        message: `Could not probe tmux panes for successor session "${distinctName}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (!pane) {
      // No pane resolvable — kill the just-created session so nothing leaks.
      await this.tmuxAdapter.killSession(distinctName);
      return {
        ok: false,
        code: "pane_unresolved",
        step: "resolve_pane",
        message: `Could not resolve a tmux pane for successor session "${distinctName}".`,
      };
    }

    // B1 — route the successor through REAL runtime startup so it becomes a LIVE,
    // READY agent BEFORE it can be committed. On ANY launch/readiness failure,
    // unwind (kill the unmanaged session) and fail loudly naming the step; the
    // original seat/binding is untouched because commit never runs.
    const started = await this.startAgent(input.node, distinctName, pane.id, cwd);
    if (!started.ok) {
      await this.killBestEffort(distinctName);
      return { ok: false, code: started.code, step: "start_agent", message: started.message };
    }

    const discovered = this.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: distinctName,
      tmuxPane: pane.id,
      // The hint equals the node's own runtime, so the commit-path runtime check
      // always matches; null runtime records as "unknown" (which the check skips).
      runtimeHint: (input.node.runtime ?? "unknown") as RuntimeHint,
      confidence: "high",
      cwd: input.node.cwd ?? undefined,
    });

    return {
      ok: true,
      discoveredId: discovered.id,
      tmuxSession: distinctName,
      tmuxPane: pane.id,
      resumeToken: started.resumeToken,
      resumeType: started.resumeType,
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
  ): Promise<{ ok: true; resumeToken?: string; resumeType?: string } | { ok: false; code: string; message: string }> {
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
    // for the adapter; it reads tmuxSession/tmuxPane/cwd). Model/config profile
    // are not resolved here (v0): a fresh successor launches with the runtime's
    // default profile, not the departing seat's AgentSpec-configured model —
    // a live default-config agent beats a dead shell; full-fidelity relaunch is
    // a tracked follow-on.
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

    return { ok: true, resumeToken, resumeType };
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
   * Failure cleanup for a created-but-not-committed successor. There is NO
   * binding to unwind (commit never ran), so this only kills the unmanaged
   * tmux session and marks the discovery candidate vanished. The original
   * seat/binding is untouched.
   */
  async cleanup(tmuxSession: string, discoveredId: string | null): Promise<void> {
    await this.tmuxAdapter.killSession(tmuxSession);
    if (discoveredId) this.discoveryRepo.markVanished([discoveredId]);
  }

  private async killBestEffort(tmuxSession: string): Promise<void> {
    try {
      await this.tmuxAdapter.killSession(tmuxSession);
    } catch {
      // Cleanup must not mask the original failure.
    }
  }
}

function compactEnv(input: Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string" && value.length > 0) result[key] = value;
  }
  return result;
}
