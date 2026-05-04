import type { Binding, StartupFile } from "./types.js";
import type { ProjectionPlan } from "./projection-planner.js";

// -- Bridge type: NodeBinding extends Binding with cwd --
// Interim repo type. The current repo only has Binding in types.ts.
// The startup orchestrator (AS-T07) constructs NodeBinding from Binding + node.cwd.

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
  codexConfigProfile?: string;
}

// -- Resolved startup file with source-root provenance --

export interface ResolvedStartupFile {
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
  /** PL-014 Item 6: kind discriminator on the resolved record. The
   *  instantiator's expandContextPacks step rewrites entries with
   *  kind: "context_pack" into kind: "file" pointing at the
   *  assembled-bundle file on disk; downstream consumers
   *  (resolveAutoHints, adapter.deliverStartup) see only kind: "file"
   *  records. The field is optional so back-compat code paths that
   *  don't set it default to "file" semantics. */
  kind?: "file" | "context_pack";
  /** PL-014 Item 6: only meaningful pre-expansion. */
  contextPackName?: string;
  contextPackVersion?: string;
}

// -- Adapter result types --

export interface InstalledResource {
  effectiveId: string;
  category: string;
  installedPath: string;
}

export interface ProjectionResult {
  projected: string[];
  skipped: string[];
  failed: Array<{ effectiveId: string; error: string }>;
}

export interface StartupDeliveryResult {
  delivered: number;
  failed: Array<{ path: string; error: string }>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  code?: string;
}

export const ATTENTION_REQUIRED_READINESS_CODES = new Set([
  "trust_gate",
  "update_gate",
  "login_required",
  "mcp_gate",
  // Codex auth refusal (stored OAuth token can no longer be refreshed).
  // Defensive: row 6's verifyResumeLaunch patch propagates attention_required
  // through the launch path so the readiness fallback shouldn't see this code,
  // but adding it here keeps the two paths semantically aligned.
  "codex_auth_refusal",
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

// -- Harness launch result --

export type HarnessLaunchRecovery = "retry_fresh" | "attention_required";

export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string }
  // `evidence` carries the last-N pane lines for `attention_required` outcomes
  // so the failure can flow honest evidence through to RestoreNodeResult's
  // attentionEvidence field. Omitted for non-attention recoveries.
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence?: string };

// -- Shared concrete-hint resolver --

/**
 * Resolve 'auto' delivery hint to a concrete hint.
 * Single source of truth — used by both the startup partition and adapter delivery.
 * Rules match existing adapter logic byte-for-byte.
 */
export function resolveConcreteHint(
  path: string,
  content: string,
): "guidance_merge" | "skill_install" | "send_text" {
  if (path.endsWith("SKILL.md") || content.startsWith("# SKILL")) return "skill_install";
  if (path.endsWith(".md")) return "guidance_merge";
  return "send_text";
}

// -- Runtime adapter contract --

/**
 * Member-level fork-source input translated by the startup orchestrator from
 * the rigspec member's `sessionSource` field. v1 narrow MVP: kind="native_id"
 * only; other shapes are rejected at schema validation today.
 *
 * Adapters that support fork (claude-code, codex) build their respective
 * fork command from this input and capture the NEW post-fork token, never
 * the parent. Adapters that don't support fork (terminal) refuse with a
 * clear runtime-mismatch error.
 */
export interface ForkSource {
  kind: "native_id" | "artifact_path" | "name" | "last";
  value?: string;
}

/**
 * The five-method runtime adapter contract.
 * Adapters own projection, delivery, harness launch, reconciliation, and readiness.
 * Startup action execution is NOT part of this contract — that belongs
 * to the startup orchestrator after checkReady().
 */
export interface RuntimeAdapter {
  readonly runtime: string;

  /** List currently installed/projected resources for a node. */
  listInstalled(binding: NodeBinding): Promise<InstalledResource[]>;

  /** Project resources from a projection plan to the runtime target locations. */
  project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult>;

  /** Deliver startup files to the runtime. */
  deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult>;

  /**
   * Launch the harness (claude/codex/terminal) inside the tmux session.
   *
   * `resumeToken` and `forkSource` are mutually exclusive. If both are
   * provided, adapters MUST refuse with a clear error rather than guess.
   * `forkSource` triggers a fork from the named source; the captured
   * resumeToken in the result is the NEW post-fork token, never the parent.
   */
  launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult>;

  /** Check if the runtime harness is responsive and ready. */
  checkReady(binding: NodeBinding): Promise<ReadinessResult>;
}
