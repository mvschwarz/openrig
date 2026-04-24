import type { Binding, StartupFile } from "./types.js";
import type { ProjectionPlan } from "./projection-planner.js";

// -- Bridge type: NodeBinding extends Binding with cwd --
// Interim repo type. The current repo only has Binding in types.ts.
// The startup orchestrator (AS-T07) constructs NodeBinding from Binding + node.cwd.

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
}

// -- Resolved startup file with source-root provenance --

export interface ResolvedStartupFile {
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
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
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

// -- Harness launch result --

export type HarnessLaunchRecovery = "retry_fresh";

export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string }
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery };

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

  /** Launch the harness (claude/codex/terminal) inside the tmux session. */
  launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string }): Promise<HarnessLaunchResult>;

  /** Check if the runtime harness is responsive and ready. */
  checkReady(binding: NodeBinding): Promise<ReadinessResult>;
}
