import { isPerSeatRoleStartupFile } from "./managed-blocks.js";
import type { Binding, StartupFile } from "./types.js";
import type { ProjectionPlan } from "./projection-planner.js";
import type { ClaudeResumeRotation } from "./native-process-lineage.js";

// -- Bridge type: NodeBinding extends Binding with cwd --
// Interim repo type. The current repo only has Binding in types.ts.
// The startup orchestrator (AS-T07) constructs NodeBinding from Binding + node.cwd.

export interface NodeBinding extends Binding {
  cwd: string;
  model?: string;
  effort?: string;
  /** Claude-only, session-scoped Advisor model. */
  advisor?: string;
  codexConfigProfile?: string;
  /** Rebuild only: a process/conversation-bound native predecessor policy. */
  codexRebuildPermissions?: import("./codex-rebuild-permissions.js").CodexPermissionEnvelope;
  /** OPR.0.4.8.3 Seam B: the seat's RESOLVED launch posture from its permission_policy
   * attachment (member > rig precedence, resolved by the core resolver at materialize /
   * restore). Absent = no policy attached → the env-driven floor/YOLO decision stands.
   * Present = authoritative for this seat (overrides the env read in BOTH directions). */
  launchPosture?: "floor" | "full_bypass" | "auto";
  /** Explicit Claude native mode; checked against the bound managed executable. */
  permissionMode?: string;
  /** Persisted rig opt-in to per-launch warning acceptance, only at full_bypass. */
  nonInterruptive?: boolean;
  /** Launch-only operational default, derived from the persisted kernel rig and explicit selections. */
  kernelAuthority?: boolean;
  /** Derived at launch only when no authored policy, seat choice or native profile applies. */
  teamPermissionDefault?: boolean;
  /** Reserved successor generation; current tenure remains the input fence until commit. */
  launchGeneration?: string;
  /** Slice 16: a successor staged beside the seat's current occupant on another runtime. That occupant stays the
   *  bound one until the runtime switch commits. */
  runtimeSwitchFrom?: { runtime: string; session: string; pane: string; generation: string };
  /** OPR.0.7.0.13: where this seat's skills go, its own storage outside the project (the plugin there is already on the
   *  seat's CLAUDE_CODE_PLUGIN_DIRS). Absent = the project, as before. Only the Claude adapter reads it. */
  seatSkillsRoot?: string;
  /** OPR.0.7.0.13: set when `seatSkillsRoot` is a seat's storage that a link refused: why. Every skill meant for it is then
   *  refused and named (none is written there or into the project), and a selected plugin's bundled skills are named lost. */
  seatSkillsRefused?: string;
  /** OPR.0.7.0.9: this seat's own launch additions, copies in its seat storage. Only the Claude adapters read them. */
  launchAdditions?: import("./seat-launch-additions.js").SeatLaunchAdditions;
  /** #25: the rig's `managed_blocks.claude-code` file. Absent = CLAUDE.md. Only the Claude adapter reads it. */
  claudeManagedBlockFile?: import("./managed-blocks.js").ClaudeManagedBlockFile;
}

// -- Resolved startup file with source-root provenance --

export interface ResolvedStartupFile {
  /** Explicit per-seat role orientation; never inferred from the filename. */
  orientation?: "role";
  path: string;
  absolutePath: string;
  ownerRoot: string;
  deliveryHint: "auto" | "guidance_merge" | "skill_install" | "send_text";
  required: boolean;
  appliesOn: ("fresh_start" | "restore")[];
  /** Optional discriminator; startup artifacts are files only. */
  kind?: "file";
}

// -- Adapter result types --

export interface InstalledResource {
  effectiveId: string;
  category: string;
  installedPath: string;
}

export interface ProjectionResult {
  warnings?: string[];
  projected: string[];
  skipped: string[];
  failed: Array<{ effectiveId: string; error: string }>;
}

export interface StartupDeliveryResult {
  warnings?: string[];
  delivered: number;
  failed: Array<{ path: string; error: string }>;
}

export interface ReadinessResult {
  ready: boolean;
  reason?: string;
  code?: string;
  /** Ready because the pane's process proved the seat with no launch record (#1477): the screen alone would not have. */
  provedWithoutLaunch?: boolean;
}

export const ATTENTION_REQUIRED_READINESS_CODES = new Set([
  "trust_gate",
  "hook_trust_gate",
  "update_gate",
  "login_required",
  "mcp_gate",
  "bypass_consent_gate",
  // Codex auth refusal (stored OAuth token can no longer be refreshed).
  // Defensive: row 6's verifyResumeLaunch patch propagates attention_required
  // through the launch path so the readiness fallback shouldn't see this code,
  // but adding it here keeps the two paths semantically aligned.
  "codex_auth_refusal",
  "codex_client_incompatible",
]);

export function isAttentionRequiredReadinessCode(code: string | undefined): boolean {
  return !!code && ATTENTION_REQUIRED_READINESS_CODES.has(code);
}

/** `resumeRotation`: the rotation recorded with `resumeToken` (#1077), as `rig seat clear-attention` passes it, so a
 *  seat whose Claude continued its conversation under a new id is proved by the process that recorded the rotation. */
export interface ReadinessOptions { resumeToken?: string | null; resumeRotation?: ClaudeResumeRotation | null }

// -- Harness launch result --

export type HarnessLaunchRecovery = "retry_fresh" | "attention_required";

// `launchedProcess` (Claude resume launches): the first process the launch's own readiness check
// pinned as the one it started, kept even when a later sample saw it replaced (#1077).
export type HarnessLaunchResult =
  | { ok: true; resumeToken?: string; resumeType?: string; appliedLaunch?: import("./permission-drift.js").AppliedLaunchObservation;
    /** Where resumeToken came from, when not a pane scrape: a community harness's launcher reported it. */
    resumeProvenance?: "launcher" | "passed";
    /** Launch notes for the person, such as a community harness whose launch identity is unavailable. */
    warnings?: string[];
    launchedProcess?: import("./native-process-lineage.js").ClaudeLaunchedProcess;
    /** Codex (#1524): the native process a managed resume was proven on from Codex's own records. Restore's join
     *  compares the process it verifies later against this one before it reports the seat resumed. */
    resumedProcess?: { pid: number; startedAt: string } }
  // `evidence` carries the last-N pane lines for `attention_required` outcomes
  // so the failure can flow honest evidence through to RestoreNodeResult's
  // attentionEvidence field. Omitted for non-attention recoveries.
  // `missingConversation` is set only when the runtime itself reported that the requested
  // conversation doesn't exist; other `retry_fresh` failures (such as a pane back at its shell)
  // leave it unset.
  | { ok: false; error: string; recovery?: HarnessLaunchRecovery; evidence?: string; missingConversation?: true;
    probe?: import("./native-resume-probe-evidence.js").NativeResumeProbeEvidence;
    /** The native resume probe's code for the startup gate that stopped the launch (for example `hook_trust_gate`),
     *  when one did. Reporting only: it changes no recovery decision. */
    gate?: string;
    /** Reporting only, with `gate: "update_gate"`: whether that screen offered a choice (an update prompt with a skip
     *  option) rather than an update already in progress. */
    gateChoice?: boolean;
    /** Reporting only: what the resume verification itself typed into the pane. */
    verifierInput?: "none" | "update_skip_key_sent" | "update_skip_key_failed";
    /** Reporting only: the reported screen is the last one seen before the verification's own input (`verifierInput`);
     *  nothing after that input was observed. */
    screenBeforeInput?: true;
    /** Codex (#1524), reporting only: a managed resume of a known conversation ended without proof and without a gate
     *  on the newest screen (records unread or unknown, or the window ended, whatever the last frame showed). Not set
     *  for a disproved resume (see `resumeMismatch`). The resumed Codex may still be running the conversation. */
    resumeUnproven?: true;
    /** Codex (#1524), reporting only: the resumed process's own records name a different conversation (`opened`). */
    resumeMismatch?: { opened: string };
    /** Codex, reporting only, with `resumeUnproven` or `resumeMismatch`: `error` without its closing "The session was
     *  preserved; nothing was restarted.", for a caller that did restart the pane (an in-place restart). */
    resumeDetail?: string;
    /** The native fork command was sent, but its child identity is not yet available. */
    forkIdentityPending?: boolean;
    launchedProcess?: import("./native-process-lineage.js").ClaudeLaunchedProcess };

// -- Shared concrete-hint resolver --

/**
 * Resolve 'auto' delivery hint to a concrete hint.
 * Single source of truth — used by both the startup partition and adapter delivery.
 * Rules match existing adapter logic byte-for-byte.
 */
export function resolveConcreteHint(
  path: string,
  content: string,
  orientation?: string,
): "guidance_merge" | "skill_install" | "send_text" {
  // A seat's own role never merges into the file its pod-mates share.
  if (isPerSeatRoleStartupFile(path, orientation)) return "send_text";
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
  /** Set only by a seat handover: a launch whose new id isn't captured yet still succeeds, with the id
   *  pending, so the handover can commit the ready successor. Every other fork caller keeps the
   *  refusal on a missed capture. */
  pendingIdAllowed?: boolean;
}

/**
 * The five-method runtime adapter contract.
 * Adapters own projection, delivery, harness launch, reconciliation, and readiness.
 * Startup action execution is NOT part of this contract — that belongs
 * to the startup orchestrator after checkReady().
 */
export interface RuntimeAdapter {
  /** Claude's managed capability/launch seam, shared with seat selection. */
  readonly claudeManagedLaunch?: import("./claude-managed-launch.js").ClaudeManagedLaunch;
  readonly runtime: string;
  /** The file an adapter's project() writes for a skill when it lives outside
   *  the Claude project tree, for "already in place" detection. Absent = the
   *  instantiator's default target. */
  skillTargetPath?(tmuxSession: string | null, effectiveId: string): string | null;

  /** List currently installed/projected resources for a node. */
  listInstalled(binding: NodeBinding): Promise<InstalledResource[]>;

  /** Project resources from a projection plan to the runtime target locations. */
  project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult>;

  /** Deliver startup files. Claude's post-launch path can reuse the orchestrator's checked send.
   * The adapter still owns file reads, ordering, provisioning and required/optional errors. */
  deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding, sendInteractiveText?: (text: string) => Promise<void>): Promise<StartupDeliveryResult>;

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
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource;
      /** The saved token's type, when known (a community harness resumes only its own `community:<name>` ids). */
      resumeType?: string;
      /** Fresh successor in the retired occupant's pane; not an adopt, resume or fork. */
      freshInPlace?: boolean },
  ): Promise<HarnessLaunchResult>;

  /** Observe an already launched fork without sending input or starting another process. */
  captureForkIdentity?(
    binding: NodeBinding, parentToken: string,
  ): Promise<{ resumeToken: string; resumeType: string } | null>;

  /** Check if the runtime harness is responsive and ready. `options.resumeToken` is the seat's recorded conversation,
   *  passed by a caller that holds the real binding (its pane) and has no launch to ask: the Claude adapter then
   *  proves a banner-less auto-mode screen by that exact conversation (#1477). */
  checkReady(binding: NodeBinding, options?: ReadinessOptions): Promise<ReadinessResult>;
}
