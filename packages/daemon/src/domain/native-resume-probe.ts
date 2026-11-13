import { currentClaudeMcpMenu } from "./claude-mcp-menu.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { claudePostureFlag, codexPostureArg } from "../adapters/yolo-mode.js";
import { operationalLaunchArg } from "../adapters/kernel-authority.js";
import { claudeMcpArgs, type ClaudeMcp } from "./claude-mcp.js";
import { codexEnvelopeArgs } from "./codex-rebuild-permissions.js";
import { codexMemberEnvelope, type CodexMemberPermissions } from "./codex-member-permissions.js";
import {
  observeCodexSandbox,
  type AppliedLaunchObservation,
  type CodexObservedApprovalPolicy,
} from "./permission-drift.js";

// L3 adds `attention_required` for the Claude resume-selection prompt proxy.
// Distinct from `inconclusive` (we don't know yet) and `failed` (terminal
// failure): the runtime is alive and recoverable but needs operator action.
export type NativeResumeProbeStatus = "resumed" | "failed" | "inconclusive" | "attention_required";

export interface NativeResumeProbeInput {
  runtime: string | null;
  paneCommand: string | null;
  paneContent: string | null;
  /** Only the managed adapter supplies this after exact, stable native-process proof. */
  claudeAutoIdentityVerified?: boolean;
  /** Only an exact --resume process-lineage proof may use the visible composer as readiness. */
  claudeResumeIdentityVerified?: boolean;
  /** Only a verified foreground Codex process may corroborate a non-gpt status footer. */
  codexProcessVerified?: boolean;
}

export interface NativeResumeProbeResult {
  status: NativeResumeProbeStatus;
  code: string;
  detail: string;
  loginRefusal?: { message: ClaudeLoginRefusal; row: "response" | "result" };
}

export interface ProbeShellReadyInput {
  paneCommand: string | null;
  paneContent: string | null;
}

export type CodexResumeLabelStatus =
  | "recorded_match"
  | "recorded_difference"
  | "recorded_uncertain"
  | "no_recorded_launch";

export interface CodexResumeDisplayInput {
  codexConfigProfile?: string | null;
  codexDaemonOptOut?: boolean;
  codexPermissions?: CodexMemberPermissions;
  resolvedPosture?: "floor" | "full_bypass" | "auto";
  /** True when the effective persisted restore posture is the empty string (""), so managed resume falls back to
   *  daemon OPENRIG_YOLO at restore time while the displayed command uses the normalized floor fallback. */
  emptySavedPosture?: boolean;
  nonInterruptive?: boolean;
  kernelAuthority?: boolean;
  teamPermissionDefault?: boolean;
  recordedLaunch?: AppliedLaunchObservation | null;
  launchWrapper?: readonly string[] | null;
}

export interface CodexResumeDisplay {
  command: string;
  status: CodexResumeLabelStatus;
  label: string | null;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);
// Provider model identifiers are not limited to the default gpt-* family.
// Keep the fallback structural so ordinary status prose cannot prove readiness.
const CODEX_MODEL_FIELD = /^[A-Za-z][A-Za-z0-9._:/@-]*[._:/@-]\d[A-Za-z0-9._:/@-]*(?: [A-Za-z][\w-]*)?(?:\s+⚠ \d+ warnings?)?$/i;
// Codex renders the model field as "{model_display_name} {effort_label}{ service_tier_name}" (codex-rs/tui
// chatwidget/status_surfaces.rs): an optional capitalized display word after the id, one of its effort labels
// (status_controls.rs; ReasoningEffort::as_str), then an optional tier, as in "GPT-6.1 Sol medium fast". Only that
// shape takes more than one word, so short prose after a model id ("GPT-6.1 is not ready") is not a footer.
const CODEX_RENDERED_SUFFIX = "(?: [A-Z][A-Za-z0-9]*)? (?:default|none|minimal|low|medium|high|xhigh|max|ultra|persistent)(?: [A-Za-z][\\w-]*)?";
const CODEX_RENDERED_GPT_FIELD = new RegExp(`^[Gg][Pp][Tt]-\\d[\\w.-]*${CODEX_RENDERED_SUFFIX}$`);
const CODEX_RENDERED_MODEL_FIELD = new RegExp(`^[A-Za-z][A-Za-z0-9._:/@-]*[._:/@-]\\d[A-Za-z0-9._:/@-]*${CODEX_RENDERED_SUFFIX}(?:\\s+⚠ \\d+ warnings?)?$`);

function formatCurrentCodexFlags(
  sandbox: string,
  approval: CodexObservedApprovalPolicy | null | undefined,
): string {
  return approval ? `-s ${sandbox} -a ${approval}` : `-s ${sandbox}`;
}

function formatRecordedCodexFlags(
  sandbox: string,
  approval: CodexObservedApprovalPolicy | null | undefined,
): string {
  // Historical launch observations (and floor launches without an explicit -a flag) store approval_policy as NULL;
  // never infer an approval value from current settings or claim NULL proves no -a flag was emitted.
  return approval ? `-s ${sandbox} -a ${approval}` : `-s ${sandbox} (approval unrecorded)`;
}

const CODEX_LAUNCH_WRAPPER_OMISSION_LABEL = "omits launch_wrapper (managed resume uses the wrapper)";

function composeCodexResumeLabel(baseLabel: string | null, hasLaunchWrapper: boolean): string | null {
  if (!hasLaunchWrapper) return baseLabel;
  return baseLabel ? `${baseLabel}; ${CODEX_LAUNCH_WRAPPER_OMISSION_LABEL}` : CODEX_LAUNCH_WRAPPER_OMISSION_LABEL;
}

export function buildCodexResumeDisplay(
  resumeToken: string,
  input: CodexResumeDisplayInput = {},
  opts?: { useLast?: boolean },
): CodexResumeDisplay {
  const profile = input.codexConfigProfile ?? null;
  const profileArg = profile ? ` -p ${shellQuote(profile)}` : "";
  const effectivePosture = input.resolvedPosture ?? "floor";
  const permissions = input.codexPermissions;
  const hasFilesystemPolicy = permissions !== undefined && "filesystem" in permissions;
  const envelope = permissions && !("filesystem" in permissions) ? codexMemberEnvelope(permissions) : undefined;
  // Derive displayed flags from the same three inputs adapters/codex-resume.ts uses (member permission envelope,
  // resolved posture with an empty env so ambient OPENRIG_YOLO never leaks, and operationalLaunchArg).
  // A filesystem choice currently uses the posture fallback here; label that omission below.
  const posture = envelope ? profileArg + codexEnvelopeArgs(envelope) : codexPostureArg(profileArg, {}, effectivePosture);
  const postureArg = posture + operationalLaunchArg(
    "codex",
    envelope
      ? { nonInterruptive: input.nonInterruptive }
      : {
          kernelAuthority: input.kernelAuthority,
          teamPermissionDefault: input.teamPermissionDefault,
          nonInterruptive: input.nonInterruptive,
          launchPosture: effectivePosture,
        },
  );
  const daemonOptOut = (input.codexDaemonOptOut ?? input.recordedLaunch?.daemonOptOut) === true;
  const command = buildCodexResumeCore(
    resumeToken,
    profile,
    opts?.useLast,
    undefined,
    effectivePosture,
    undefined,
    postureArg,
    daemonOptOut,
  );
  const hasLaunchWrapper = Boolean(input.launchWrapper && input.launchWrapper.length > 0);

  let currentSandbox: string | null = null;
  let currentApproval: CodexObservedApprovalPolicy | null | undefined = null;
  let currentFlags: string;
  if (envelope) {
    currentSandbox = envelope.sandboxPolicy.type;
    currentApproval = envelope.approvalPolicy;
    currentFlags = formatCurrentCodexFlags(currentSandbox, currentApproval);
  } else {
    const obs = observeCodexSandbox(posture);
    if (obs.state === "observed" && obs.value) {
      currentSandbox = obs.value;
      currentApproval = obs.approvalPolicy ?? null;
      currentFlags = formatCurrentCodexFlags(currentSandbox, currentApproval);
    } else {
      currentFlags = posture.trim();
    }
  }

  const recorded = input.recordedLaunch ?? null;
  const hasObservedRecord = recorded !== null
    && recorded.runtime === "codex"
    && recorded.axis === "sandbox"
    && recorded.state === "observed"
    && recorded.value !== null;

  if (hasFilesystemPolicy) {
    return {
      command,
      status: hasObservedRecord ? "recorded_uncertain" : "no_recorded_launch",
      label: composeCodexResumeLabel(
        `shown command uses posture fallback ${postureArg.trim()}; does not carry the agent's filesystem policy (managed resume carries it)`,
        hasLaunchWrapper,
      ),
    };
  }

  if (!envelope && input.emptySavedPosture) {
    const fallbackClause = `saved posture empty, showing fallback ${currentFlags} (managed resume posture unknown)`;
    if (!hasObservedRecord) {
      return {
        command,
        status: "no_recorded_launch",
        label: composeCodexResumeLabel(fallbackClause, hasLaunchWrapper),
      };
    }
    const recordedFlags = formatRecordedCodexFlags(recorded.value!, recorded.approvalPolicy ?? null);
    return {
      command,
      status: "recorded_uncertain",
      label: composeCodexResumeLabel(`launched with ${recordedFlags}; ${fallbackClause}`, hasLaunchWrapper),
    };
  }

  if (!hasObservedRecord) {
    return {
      command,
      status: "no_recorded_launch",
      label: composeCodexResumeLabel("flags from current settings", hasLaunchWrapper),
    };
  }

  const recordedApproval = recorded.approvalPolicy ?? null;
  // A NULL approval_policy cannot distinguish a plain floor launch without -a from a pre-upgrade envelope whose
  // on-request/untrusted approval was not recorded, so only a non-null recorded approval can prove recorded_match.
  if (
    currentSandbox !== null
    && recorded.value === currentSandbox
    && recordedApproval !== null
    && recordedApproval === currentApproval
  ) {
    return {
      command,
      status: "recorded_match",
      label: composeCodexResumeLabel(null, hasLaunchWrapper),
    };
  }

  const recordedFlags = formatRecordedCodexFlags(recorded.value!, recordedApproval);
  const isSameSandboxUnrecordedApproval = currentSandbox !== null
    && recorded.value === currentSandbox
    && recorded.value !== "read-only"
    && recordedApproval === null
    && currentApproval === null;
  return {
    command,
    status: isSameSandboxUnrecordedApproval ? "recorded_uncertain" : "recorded_difference",
    label: composeCodexResumeLabel(`launched with ${recordedFlags}; a resume now uses ${currentFlags}`, hasLaunchWrapper),
  };
}

export function buildNativeResumeDisplay(
  runtime: string | null,
  resumeToken: string | null,
  sessionName?: string | null,
  codexConfigProfile?: string | null,
  /** Codex: the seat's recorded daemon choice; only a positive true adds --no-daemon (absent and false print as before). */
  codexDaemonOptOut?: boolean,
  claudeMcp?: ClaudeMcp | null,
  codexDisplay?: CodexResumeDisplayInput,
  launchWrapper?: readonly string[] | null,
): { command: string; label: string | null; status?: CodexResumeLabelStatus } | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") {
    const nameSuffix = sessionName ? ` --name ${shellQuote(sessionName)}` : "";
    const mcpSuffix = claudeMcpArgs(claudeMcp).map(arg => ` ${shellQuote(arg)}`).join("");
    return {
      command: `claude ${claudePostureFlag(process.env)} --resume ${shellQuote(resumeToken)}${nameSuffix}${mcpSuffix}`,
      label: null,
    };
  }
  if (runtime === "codex") {
    return buildCodexResumeDisplay(resumeToken, {
      ...codexDisplay,
      codexConfigProfile: codexDisplay?.codexConfigProfile !== undefined ? codexDisplay.codexConfigProfile : codexConfigProfile,
      codexDaemonOptOut: codexDisplay?.codexDaemonOptOut !== undefined ? codexDisplay.codexDaemonOptOut : codexDaemonOptOut,
      launchWrapper: codexDisplay?.launchWrapper !== undefined ? codexDisplay.launchWrapper : launchWrapper,
    });
  }
  return null;
}

export function buildNativeResumeCommand(
  runtime: string | null,
  resumeToken: string | null,
  sessionName?: string | null,
  codexConfigProfile?: string | null,
  /** Codex: the seat's recorded daemon choice; only a positive true adds --no-daemon (absent and false print as before). */
  codexDaemonOptOut?: boolean,
  claudeMcp?: ClaudeMcp | null,
  codexDisplay?: CodexResumeDisplayInput,
  launchWrapper?: readonly string[] | null,
): string | null {
  return buildNativeResumeDisplay(
    runtime,
    resumeToken,
    sessionName,
    codexConfigProfile,
    codexDaemonOptOut,
    claudeMcp,
    codexDisplay,
    launchWrapper,
  )?.command ?? null;
}

/** Managed Codex seats run tool commands in a non-login shell, so they keep the seat's own environment, including the
 *  OpenRig command folder at the front of PATH. Codex otherwise gives each command the user's login-shell environment
 *  and puts back only its own directories, so a login file that sets PATH outright drops that folder. */
export const CODEX_NON_LOGIN_SHELL_OVERRIDE = "allow_login_shell=false";
export const codexNonLoginShellArg = ` -c ${shellQuote(CODEX_NON_LOGIN_SHELL_OVERRIDE)}`;

export function buildCodexResumeCore(
  resumeToken: string,
  codexConfigProfile?: string | null,
  useLast?: boolean,
  extraArgs?: string,
  // OPR.0.4.8.3 Seam B: optional resolved posture — LAUNCH callers thread the seat's
  // persisted/bound posture; the shared non-launch consumers (node inventory,
  // resume-metadata) omit it and keep byte-identical behavior.
  resolvedPosture?: "floor" | "full_bypass" | "auto",
  // 0.5.2-07: the seat's SPEC-pinned model. LAUNCH callers (legacy restore) thread it so the
  // resumed seat boots on the spec model, not the runtime default; the non-launch consumers
  // (node inventory, resume-metadata) omit it and stay byte-identical.
  model?: string | null,
  /** Launch callers may pass the exact already-resolved segment they insert, avoiding a second policy decision. */
  precomputedPostureArg?: string,
  /** #69: launch callers pass true when the installed Codex supports `--no-daemon`. Absent → byte-identical. */
  daemonOptOut?: boolean,
  /** #75: optional reasoning effort for the seat. Emitted as -c 'model_reasoning_effort="<level>"'. */
  effort?: string | null,
): string {
  // OPR.0.4.8.2: the RESUME path uses the SAME posture decision (codexPostureArg) as fresh/fork.
  // YOLO forces -s danger-full-access (overriding even a named profile); otherwise a named profile
  // governs itself and the no-profile case is OpenRig's explicit -s workspace-write floor flag.
  const profileArg = codexConfigProfile ? ` -p ${shellQuote(codexConfigProfile)}` : "";
  const profileOrPosture = precomputedPostureArg ?? codexPostureArg(profileArg, process.env, resolvedPosture);
  // 0.5.2-07: -m is a top-level codex flag (matches the fresh-launch adapter), emitted before the
  // resume subcommand.
  const modelArg = model ? ` -m ${shellQuote(model)}` : "";
  const effortArg = effort ? ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}` : "";
  // Keep the identity before paths: process listings join argv without shell quoting.
  const suffix = extraArgs ? ` ${extraArgs}` : "";
  const tokenArg = useLast ? "--last" : shellQuote(resumeToken);
  const daemonArg = daemonOptOut ? " --no-daemon" : "";
  return `codex${daemonArg}${profileOrPosture}${modelArg}${effortArg} resume ${tokenArg}${suffix}`;
}

export function assessNativeResumeProbe(
  input: NativeResumeProbeInput
): NativeResumeProbeResult {
  const runtime = input.runtime ?? "";
  const paneCommand = input.paneCommand ?? "";
  const paneContent = input.paneContent ?? "";

  if (runtime === "claude-code") {
    if (looksLikeClaudeBypassConsentPrompt(paneContent)) {
      return {
        status: "attention_required",
        code: "bypass_consent_gate",
        detail: "Claude is waiting for you to review its bypass-permissions warning and choose whether to accept. Startup context has not been sent.",
      };
    }
    if (paneContent.includes("No conversation found")) {
      return {
        status: "failed",
        code: "no_conversation_found",
        detail: "Claude reported that the requested session no longer exists.",
      };
    }
    if (looksLikeClaudeResumeSelectionPrompt(paneContent)) {
      return {
        status: "attention_required",
        code: "claude_resume_selection_prompt",
        detail: "Claude is at a resume-selection prompt; an operator must choose the conversation to continue.",
      };
    }
    // #2820 item 2: the gated-grants backstop is never answered by OpenRig (not even with
    // recovery.auto_drive_provider_prompts): its default choice declines the folder's pre-approved tool permissions or
    // exits, and approving them is the person's call. Checked before the plain trust prompt, whose texts it shares.
    const gatedGrants = claudeGatedGrantsPrompt(paneContent);
    if (gatedGrants === "live") {
      return {
        status: "attention_required",
        code: "claude_gated_grants_gate",
        detail: `Claude is at its workspace trust check that warns "This folder pre-approves N tool permissions" (from the folder's .claude/settings.json)${focusedChoice(paneContent)}. Review and choose in the seat's pane. OpenRig does not approve or bypass this review. No input was sent.`,
      };
    }
    if (gatedGrants === "partial") {
      return {
        status: "inconclusive",
        code: "awaiting_runtime",
        detail: "Claude is still drawing its workspace trust check for the folder's pre-approved tool permissions.",
      };
    }
    if (looksLikeClaudeTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    }
    if (currentClaudeMcpMenu(paneContent) || looksLikeClaudeMcpApprovalPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "mcp_gate",
        detail: "Claude is waiting for project MCP server approval before the session can become interactive.",
      };
    }
    const loginRefusal = currentClaudeLoginRefusal(paneContent);
    if (loginRefusal) {
      return {
        status: "failed",
        code: "login_required",
        detail: "Claude is running but cannot continue until the user logs in.",
        loginRefusal,
      };
    }
    if (looksLikeClaudeTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Claude is running with an active interactive TUI in the probe pane.",
      };
    }
    if (input.claudeResumeIdentityVerified && hasClaudeComposerPrompt(paneContent)) {
      return {
        status: "resumed",
        code: "verified_native_identity",
        detail: "Claude is at its interactive prompt and the exact managed resume process was verified.",
      };
    }
    if (paneCommand === "claude" && input.claudeResumeIdentityVerified !== false) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Claude is the active foreground process in the probe pane.",
      };
    }
    if (/(^|\n)\s*❯/.test(paneContent)
      && /^[ \t]*⏵⏵ auto mode on \(shift\+tab to cycle\)(?:[ \t]+·[^\r\n]*)?[ \t]*$/m.test(paneContent)) {
      return input.claudeAutoIdentityVerified
        ? { status: "resumed", code: "active_runtime", detail: "Claude auto-mode TUI and the exact managed native identity were verified." }
        : { status: "inconclusive", code: "claude_auto_identity_required", detail: "Auto-mode screen text requires proof of the launched Claude identity." };
    }
    if (SHELL_COMMANDS.has(paneCommand)) {
      return {
        status: "failed",
        code: "returned_to_shell",
        detail: "The probe pane returned to a shell instead of staying inside the runtime.",
      };
    }
    return {
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Claude did not report an explicit failure, but it is not yet the active pane process.",
    };
  }

  if (runtime === "codex") {
    if (looksLikeCodexLoginPrompt(paneContent)) {
      // A wrapper must be verified and resampled before old chrome can prove readiness or drive a menu.
      if (paneCommand !== "codex" && input.codexProcessVerified !== true) {
        const shell = SHELL_COMMANDS.has(paneCommand);
        return {
          status: shell ? "failed" : "inconclusive",
          code: shell ? "returned_to_shell" : "awaiting_runtime",
          detail: shell
            ? "The probe pane returned to a shell instead of staying inside the runtime."
            : "Codex did not report an explicit failure, but an interactive conversation has not been observed.",
        };
      }
      return {
        status: "attention_required",
        code: "login_required",
        detail: "Codex is waiting for you to sign in or configure provider credentials before the session can become interactive.",
      };
    }
    if (/requires a newer version of Codex/i.test(paneContent.replace(/\s+/g, " "))) {
      return {
        status: "attention_required", code: "codex_client_incompatible",
        detail: "The selected Codex client cannot use the configured model. Use a compatible client and retry; replacing history or changing credentials will not repair this prerequisite.",
      };
    }
    if (paneContent.includes("No saved session found")) {
      return {
        status: "failed",
        code: "no_saved_session",
        detail: "Codex reported that the requested saved session does not exist.",
      };
    }
    if (looksLikeCodexAuthRefusal(paneContent)) {
      return {
        status: "attention_required",
        code: "codex_auth_refusal",
        detail: "Codex could not refresh the stored access token; an operator must sign in again before the session can resume.",
      };
    }
    if (looksLikeCodexModelSelectionPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "model_selection_gate",
        detail: "Codex is waiting for model selection before the session can become interactive.",
      };
    }
    // Native review panels can overlay a normal Codex header. The header
    // alone does not prove the prompt can receive startup context.
    if (looksLikeCodexHookReviewPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "hook_trust_gate",
        detail: "Codex is waiting for hook trust approval before the session can become interactive.",
      };
    }
    // Only the current-format panel can override TUI evidence. Legacy text
    // retains its existing position after the TUI check, including scrollback.
    const currentTrustPrompt = looksLikeCurrentCodexTrustPrompt(paneContent);
    const legacyTrustPrompt = looksLikeCodexTrustPrompt(paneContent);
    const dismissedLegacyTrustPrompt = paneContent.includes("OpenAI Codex (v")
      || input.codexProcessVerified === true && hasCodexCustomModelFooterAfterComposer(paneContent);
    if (!currentTrustPrompt && (!legacyTrustPrompt || dismissedLegacyTrustPrompt)
      && looksLikeCodexTui(paneContent, input.codexProcessVerified === true)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Codex is running with an active interactive TUI in the probe pane.",
      };
    }
    if (currentTrustPrompt || (legacyTrustPrompt && !dismissedLegacyTrustPrompt)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Codex is waiting for workspace trust approval before the session can become interactive.",
      };
    }
    if (hasCodexUpdateHeader(paneContent) || paneContent.includes("Updating Codex")) {
      return {
        status: "inconclusive",
        code: "update_gate",
        detail: "Codex reached an update flow, so process-alive alone is not proof of a restored conversation.",
      };
    }
    if (SHELL_COMMANDS.has(paneCommand)) {
      return {
        status: "failed",
        code: "returned_to_shell",
        detail: "The probe pane returned to a shell instead of staying inside the runtime.",
      };
    }
    return {
      status: "inconclusive",
      code: "awaiting_runtime",
      detail: "Codex did not report an explicit failure, but an interactive conversation has not been observed.",
    };
  }

  return {
    status: "inconclusive",
    code: "unsupported_runtime",
    detail: "No native resume probe is defined for this runtime.",
  };
}

export function isProbeShellReady(input: ProbeShellReadyInput): boolean {
  const paneCommand = input.paneCommand ?? "";
  const paneContent = input.paneContent?.trim() ?? "";
  return SHELL_COMMANDS.has(paneCommand) && paneContent.length > 0;
}

function looksLikeClaudeTui(paneContent: string): boolean {
  const hasPrompt = hasClaudeComposerPrompt(paneContent);
  if (!hasPrompt) return false;

  return (
    paneContent.includes("Claude Code v")
    || paneContent.includes("accept edits on")
  );
}

function hasClaudeComposerPrompt(paneContent: string): boolean {
  return /(^|\n)\s*❯/.test(paneContent);
}

/** A fresh launch needs the last prompt inside Claude's complete input frame. Earlier
 * headers or frames can belong to the predecessor above the shell's launch command. */
export function hasClaudeDrawnInput(paneContent: string): boolean {
  const rows = paneContent.split(/\r?\n/);
  const prompt = rows.map(row => /^\s*❯/.test(row)).lastIndexOf(true);
  return prompt > 0 && hasClaudeInputFrame(rows.slice(prompt - 1));
}

function looksLikeClaudeBypassConsentPrompt(paneContent: string): boolean {
  // Plain capture of Claude's current consent menu. Labels in prose or a menu
  // followed by a new composer are not evidence of an active dialog.
  const lines = paneContent.trimEnd().split(/\r?\n/).filter(line => line.trim()).slice(-16);
  if (lines.at(-1)?.trim() !== "Enter to confirm · Esc to cancel") return false;
  const choices = lines.slice(-3, -1).map(line => line.trim());
  if (!(choices[0] === "❯ No, exit" && choices[1] === "Yes, I accept")
    && !(choices[0] === "No, exit" && choices[1] === "❯ Yes, I accept")) return false;
  return /\b(?:in|running in) Bypass Permissions mode\./.test(lines.slice(0, -3).join(" ").replace(/\s+/g, " "));
}

// Claude Code's "gated grants" backstop (2.1.319+, #2820 item 2). Its marks, which the plain workspace trust prompt
// lacks: the warning that the folder's .claude/settings.json pre-approves tool permissions, and the option that
// declines them. Its default choice declines them ("No, continue without these permissions") or exits ("No, exit").
// The marks are read on the whitespace-joined screen too, so a row that a narrow pane wraps still counts.
const CLAUDE_GATED_GRANTS_MARK = /This folder pre-approves \d+ tool permissions?\b|No, continue without these permissions/;
// One row of the backstop's marks, or of a part of one that a narrow pane wrapped.
const CLAUDE_GATED_GRANTS_MARK_ROW = /This folder pre-approves\b|No, continue without\b|without these permissions\b/;
const CLAUDE_TRUST_FOOTER = "Enter to confirm · Esc to cancel";
const CLAUDE_TRUST_YES = "Yes, I trust this folder";
const CLAUDE_TRUST_EXIT = "No, exit";
// An option row of Claude's select: an optional cursor (❯ or ›), an optional "1." and a "Yes, …" or "No, …" label.
const CLAUDE_TRUST_OPTION_ROW = /^\s*([❯›]\s*)?(?:\d+\.\s+)?((?:Yes|No), .*?)\s*$/;

/** The gated-grants backstop on Claude's current screen (claudeCurrentRows): "live" when it is complete ("Enter to
 *  confirm · Esc to cancel" is the last drawn row, with "Yes, I trust this folder" above it); "partial" while it is
 *  still being drawn; null when the current screen has none. A backstop left in the scrollback above a session that
 *  started is not current. The "Accessing workspace:" heading is not required: a long permission list can push it
 *  out of the capture. */
function claudeGatedGrantsPrompt(paneContent: string): "live" | "partial" | null {
  const rows = claudeCurrentRows(paneContent);
  if (!hasClaudeGatedGrantsMark(rows)) return null;
  const mark = rows.map(row => CLAUDE_GATED_GRANTS_MARK_ROW.test(row)).lastIndexOf(true);
  const drawn = rows.slice(Math.max(mark, 0)).filter(row => row.trim()).map(row => row.trim());
  if (drawn.at(-1) !== CLAUDE_TRUST_FOOTER) return "partial";
  return drawn.some(row => CLAUDE_TRUST_OPTION_ROW.exec(row)?.[2] === CLAUDE_TRUST_YES) ? "live" : "partial";
}

/** A mark of the gated-grants backstop in these rows: on their whitespace-joined text, so a row that a narrow pane
 *  wrapped still counts, or on a single row, so a warning still being drawn ("This folder pre-approves 2 tool" before
 *  the next row) counts too. */
function hasClaudeGatedGrantsMark(rows: string[]): boolean {
  return CLAUDE_GATED_GRANTS_MARK.test(rows.join(" ").replace(/\s+/g, " "))
    || rows.some(row => CLAUDE_GATED_GRANTS_MARK_ROW.test(row));
}

/** The rows Claude drew after its last own element (input frame, header or reply): the screen a prompt is on now.
 *  Text above a session that started (a scrollback, a reply quoting a prompt's words) never decides what is current,
 *  and neither does a draft in the input box: an input frame ends at its closing rule. */
function claudeCurrentRows(paneContent: string): string[] {
  const rows = claudeWithoutDrafts(paneContent.trimEnd().split(/\r?\n/));
  let current = rows;
  for (let at = rows.length - 1; at >= 0; at--) {
    if (!claudeDrawnAfter(rows.slice(at))) continue;
    const framed = CLAUDE_INPUT_RULE.test(rows[at]!) && /^\s*❯/.test(rows[at + 1] ?? "");
    const closing = framed ? rows.findIndex((row, index) => index > at + 1 && CLAUDE_INPUT_RULE.test(row)) : -1;
    current = rows.slice((closing >= 0 ? closing : at) + 1);
    break;
  }
  // An input frame still being drawn (its opening rule and the ❯ row, no closing rule yet) holds a draft, not a dialog.
  const opening = current.findIndex((row, index) => CLAUDE_INPUT_RULE.test(row) && /^\s*❯/.test(current[index + 1] ?? ""));
  return opening >= 0 ? current.slice(0, opening) : current;
}

/** These rows with the text of every draft in Claude's input frames blanked (the ❯ kept), so a rule, a reply or a
 *  header pasted into a draft never reads as Claude's own UI. Claude draws the frame's rules from column 0 and a
 *  draft's continuation rows indented under the ❯, so a frame opens at a column-0 rule over the ❯ row and the first
 *  column-0 rule after it closes the frame; a frame with no closing rule yet holds a draft to the end. A frame quoted
 *  in a reply is indented like the reply: it blanks nothing. */
function claudeWithoutDrafts(rows: string[]): string[] {
  const shown = [...rows];
  for (let at = 0; at < rows.length; at++) {
    if (!CLAUDE_FRAME_RULE.test(rows[at]!) || !/^\s*❯/.test(rows[at + 1] ?? "")) continue;
    const closing = rows.findIndex((row, index) => index > at + 1 && CLAUDE_FRAME_RULE.test(row));
    const end = closing >= 0 ? closing : rows.length;
    shown[at + 1] = rows[at + 1]!.replace(/❯.*$/, "❯");
    for (let index = at + 2; index < end; index++) shown[index] = "";
    at = end - 1;
  }
  return shown;
}

/** ", with \"<label>\" highlighted" for the detail of the gated-grants gate, or nothing when no option is focused. */
function focusedChoice(paneContent: string): string {
  const label = claudeFocusedOption(paneContent);
  return label ? `, with "${label}" highlighted` : "";
}

/** The label of the focused option on Claude's current screen (the row with ❯ or ›), if one is drawn. */
function claudeFocusedOption(paneContent: string): string | null {
  const focused = claudeCurrentRows(paneContent).map(row => CLAUDE_TRUST_OPTION_ROW.exec(row)).filter(match => match?.[1]);
  return focused.at(-1)?.[2] ?? null;
}

/** The focus of Claude's plain workspace trust prompt (#2820 item 2), read from its last 12 drawn rows. An allowlist:
 *  "yes" or "no" only when the prompt's options are exactly "No, exit" and "Yes, I trust this folder" (in either
 *  order, numbered or not) and one of them carries the cursor (❯ or ›): "yes" on "Yes, I trust this folder", "no" on
 *  "No, exit" (Claude Code 2.1.322 opens the plain prompt there). Anything else is "unknown": another option set (the
 *  gated-grants backstop's "No, continue without these permissions" included), no cursor, or more than one. */
export function claudeTrustPromptFocus(paneContent: string): "yes" | "no" | "unknown" {
  const rows = paneContent.trimEnd().split(/\r?\n/).filter(row => row.trim()).slice(-12);
  const options = rows.map(row => CLAUDE_TRUST_OPTION_ROW.exec(row)).filter(match => match !== null);
  const labels = options.map(match => match[2]);
  if (labels.length !== 2 || !labels.includes(CLAUDE_TRUST_YES) || !labels.includes(CLAUDE_TRUST_EXIT)) return "unknown";
  const focused = options.filter(match => match[1]);
  if (focused.length !== 1) return "unknown";
  return focused[0]![2] === CLAUDE_TRUST_YES ? "yes" : "no";
}

function looksLikeClaudeTrustPrompt(paneContent: string): boolean {
  // #2820 item 2: read on Claude's current screen only, and a screen with the backstop's marks is never the plain
  // trust prompt, even still drawn: pressing Enter on it would decline the folder's grants or exit.
  const current = claudeCurrentRows(paneContent);
  const text = current.join("\n");
  return text.includes("Accessing workspace:")
    && text.includes("Yes, I trust this folder")
    && !hasClaudeGatedGrantsMark(current);
}

// Claude's resume-selection prompt appears when `claude --resume` finds multiple
// candidate conversations (or after a reboot when the conversation index is
// rebuilt). The prompt lists numbered options and asks the operator to pick.
//
// L3 invariant: do NOT auto-answer. Surface as `attention_required` and let an
// operator choose; later reconciliation upgrades to `operator_recovered` only
// when the operator reaches a usable state.
function looksLikeClaudeResumeSelectionPrompt(paneContent: string): boolean {
  if (currentClaudeResumePicker(paneContent)) return true;
  // Current Claude chooser (observed 2026-09-04) asks which fidelity to
  // resume with. Require the heading, both option rows after it, and a selection cursor;
  // prose containing the labels is intentionally insufficient. A chooser drawn
  // at the top of a tall pane sits above blank rows, so count from the last drawn row.
  // A chooser counts only while it is the last thing drawn: a composer, header or reply
  // after its options means it is history above a session that resumed.
  const drawn = paneContent.trimEnd().split("\n");
  const recentLines = drawn.slice(-30);
  const heading = recentLines.map((line) => line.trim() === "How would you like to resume?").lastIndexOf(true);
  if (heading >= 0) {
    const after = recentLines.slice(heading + 1);
    const options = after.map((line) => /^\s*(?:[❯›]\s+)?(?:Resume from summary|Resume full session as-is)\s*$/.test(line));
    const chosen = (test: (line: string) => boolean) => after.some((line, at) => options[at] && test(line));
    if (
      chosen((line) => /^\s*[❯›]\s+/.test(line))
      && chosen((line) => line.includes("Resume from summary"))
      && chosen((line) => line.includes("Resume full session as-is"))
      && !claudeDrawnAfter(after.slice(options.lastIndexOf(true) + 1))
    ) return true;
  }

  // Stable substring is the explicit "Choose ... conversation" verb plus the
  // numbered/arrow option marker that Claude prints after it. A long list can push the
  // heading above the window, so it's read from the whole capture; the last option must be
  // in the window, and nothing of Claude's own may be drawn after it.
  const verb = drawn.map((line) => /Choose (?:a|the) conversation|Select a conversation/.test(line)).lastIndexOf(true);
  if (verb < 0) return false;
  const recentStart = Math.max(verb + 1, drawn.length - 30);
  const lastOption = drawn.map((line, at) => at >= recentStart && /^\s*(?:[›»]\s*)?\d+\.\s+\S/.test(line)).lastIndexOf(true);
  // A draft's own numbered rows can read as the last options, so the input frame counts anywhere after the heading.
  return lastOption >= 0 && !claudeDrawnAfter(drawn.slice(lastOption + 1)) && !hasClaudeInputFrame(drawn.slice(verb + 1));
}

/** Claude Code's "Resume session" picker (2.1.309), drawn when `claude --resume` has no exact session to open: a bare
 *  `--resume`, or a name that matches no session title or several. Its heading row (an optional detail follows, such as
 *  " (2 of 9)"), then its search box directly under it: `╭─…─╮`, a `│ ⌕` row, any rows a long query wraps to, `╰─…─╯`.
 *  The cards, the query and the hint row vary with the mode (a list, a search with no match, rename), so none of them
 *  is required. A paste or typed text goes into its search, and Enter resumes the focused card. The last picker drawn
 *  counts until Claude's framed input box or a reply (a column-0 ● or ⏺ row) follows its box, which makes it history.
 *  Claude's header text doesn't count here: a card's title can say "Claude Code v2.1.309" too, and a resumed session
 *  draws its input box. Returns the heading row, or null. */
export function currentClaudeResumePicker(paneContent: string): string | null {
  const rows = paneContent.trimEnd().split(/\r?\n/);
  for (let at = rows.length - 1; at >= 0; at--) {
    if (!/^\s*Resume session\b/.test(rows[at]!)) continue;
    const boxEnd = claudeSearchBoxEnd(rows, at + 1);
    if (boxEnd < 0) continue;
    const later = rows.slice(boxEnd + 1);
    return hasClaudeInputFrame(later) || later.some((line) => /^[●⏺]/.test(line)) ? null : rows[at]!.trim();
  }
  return null;
}

function claudeSearchBoxEnd(rows: string[], top: number): number {
  if (!/^\s*╭─+╮\s*$/.test(rows[top] ?? "") || !/^\s*│\s*⌕/.test(rows[top + 1] ?? "")) return -1;
  for (let at = top + 2; at < rows.length; at++) {
    if (/^\s*╰─+╯\s*$/.test(rows[at]!)) return at;
    if (!/^\s*│.*│\s*$/.test(rows[at]!)) return -1;
  }
  return -1;
}

/** Claude's own UI drawn after a chooser's options: its framed input box, its version header or a reply. A bare ❯ row
 *  doesn't count: it can sit under a live chooser, and a missed chooser reads resumed. Hint rows and blank rows under the
 *  options belong to the chooser. */
function claudeDrawnAfter(rows: string[]): boolean {
  return hasClaudeInputFrame(rows) || rows.some((line) => line.includes("Claude Code v") || /^[●⏺]/.test(line));
}

// On a named session Claude labels the frame's top rule (`─────…── probe-claude@rig ─`), so a rule may carry text after a space.
const CLAUDE_INPUT_RULE = /^\s*─{3,}(?:\s.*)?$/;
// The same rule drawn from column 0, as Claude draws its frame: a rule indented like a draft's row is the draft's.
const CLAUDE_FRAME_RULE = /^─{3,}(?:\s.*)?$/;

/** Claude's input frame: a rule, the ❯ row directly under it, and another rule below. A composer holding a draft that
 *  starts with "1." looks like a numbered option row; the frame is what tells them apart. */
function hasClaudeInputFrame(rows: string[]): boolean {
  return rows.some((line, at) => CLAUDE_INPUT_RULE.test(line) && /^\s*❯/.test(rows[at + 1] ?? "")
    && rows.slice(at + 2).some((row) => CLAUDE_INPUT_RULE.test(row)));
}

// Claude's interactive refusals of a request for a missing, expired or revoked login (code.claude.com/docs/en/errors).
// Only these exact messages count. A 401 reads "Please run /login · API Error: 401 …" with a varying tail, and a
// reply or tool output can start with the same words, so this input can't tell a real one apart.
const CLAUDE_LOGIN_REFUSALS = [
  "Not logged in · Please run /login",
  "Login expired · Please run /login",
  "OAuth token revoked · Please run /login",
] as const;
type ClaudeLoginRefusal = typeof CLAUDE_LOGIN_REFUSALS[number];

// A refusal blocks only as Claude's latest response. The persistent "Not logged in · Run /login" footer says only
// that Claude holds no credential of its own, and a gateway can still authenticate its requests. Claude starts a
// reply with ● or ⏺ at column 0 and a result with ⎿ two cells in, continuing either on indented rows up to a blank
// row; an indented marker is quoted text. The last ❯ row is the input box only when no response follows it;
// otherwise it is a submitted prompt and no box is drawn. A refusal counts when it is the last response after the
// last submitted prompt, so older scrollback, quoted text and a refusal followed by a newer reply or prompt do not.
function currentClaudeLoginRefusal(paneContent: string): NativeResumeProbeResult["loginRefusal"] {
  const lines = paneContent.split(/\r?\n/);
  const isPrompt = (line: string) => /^\s*❯/.test(line);
  const isResponse = (line: string) => /^[●⏺]/.test(line) || /^ {2}⎿/.test(line);
  const prompts: number[] = [];
  const responses: Array<{ at: number; text: string; row: "response" | "result" }> = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at]!;
    if (isPrompt(line)) prompts.push(at);
    if (!isResponse(line)) continue;
    let text = line.replace(/^\s*[●⏺⎿]/, "");
    // Claude wraps its own rows with a short hanging indent; a right-aligned footer is not a continuation.
    for (let next = at + 1; next < lines.length && /^ {1,6}\S/.test(lines[next]!) && !isPrompt(lines[next]!)
      && !isResponse(lines[next]!); next++) text += ` ${lines[next]}`;
    responses.push({ at, text: text.replace(/\s+/g, " ").trim(), row: /^ {2}⎿/.test(line) ? "result" : "response" });
  }
  const lastPrompt = prompts.at(-1) ?? -1;
  const inputBox = responses.some(({ at }) => at > lastPrompt) ? lines.length : lastPrompt;
  const turnStart = prompts.filter((at) => at < inputBox).at(-1) ?? -1;
  const latest = responses.filter(({ at }) => at > turnStart && at < inputBox).at(-1);
  const message = CLAUDE_LOGIN_REFUSALS.find(message => message === latest?.text);
  return message && latest ? { message, row: latest.row } : undefined;
}

function looksLikeClaudeMcpApprovalPrompt(paneContent: string): boolean {
  return paneContent.includes("new MCP servers found in .mcp.json")
    && paneContent.includes("Select any you wish to enable")
    && paneContent.includes("Enter to confirm");
}

/** Header formats observed before and since Codex 0.160.0. */
export function hasCodexUpdateHeader(paneContent: string): boolean {
  // Preserve legacy-header behavior. A current-format header may instead be
  // quoted output above a later live composer. A footer alone does not end it.
  if (paneContent.includes("Update available!")) return true;
  const header = [...paneContent.matchAll(/^[ \t]*Update available · \S+ → \S+[ \t]*$/gm)].at(-1);
  return !!header && !hasCodexComposer(paneContent.slice(header.index! + header[0].length));
}

function hasCodexComposer(paneContent: string): boolean {
  return paneContent.split("\n").some((line) => {
    const text = line.trimStart();
    const hasPrompt = text.startsWith("›") || text.startsWith("»");
    return hasPrompt && !/^\d+\.\s/.test(text.slice(1).trimStart());
  });
}

function looksLikeCodexTui(paneContent: string, codexProcessVerified: boolean): boolean {
  const current = paneContent.slice(Math.max(0, paneContent.lastIndexOf("OpenAI Codex (v")));
  if (/model:\s*loading\b/i.test(current)) return false;
  const recentLines = current.trimEnd().split("\n").slice(-20).join("\n");
  const hasPromptLine = hasCodexComposer(recentLines);
  const hasDefaultModelFooter = /(^|\n)\s{2,}gpt-[^\n]+ · [^\n]+(?:\n|$)/.test(recentLines);
  const hasDelimitedModelFooter = recentLines.split("\n").some(isCodexGptModelFooterLine);
  // Custom status lines can put the model's display name in any field. Keep
  // corroboration structural: an indented status row and a whole model field,
  // not a model mentioned somewhere in conversation prose.
  // A custom row must not make an unresolved trust/update panel disappear.
  const verifiedCustomModelFooter = codexProcessVerified && hasCodexCustomModelFooterAfterComposer(recentLines);
  const activeLegacyTrustPrompt = looksLikeCodexTrustPrompt(current) && !verifiedCustomModelFooter;
  const hasCustomModelFooter = (hasDelimitedModelFooter || verifiedCustomModelFooter)
    && !activeLegacyTrustPrompt
    && !hasCodexUpdateHeader(current) && !current.includes("Updating Codex");
  return hasPromptLine && (current.includes("OpenAI Codex (v") || hasDefaultModelFooter || hasCustomModelFooter);
}

// Codex prints these messages when its stored OAuth access token can no
// longer be refreshed — operator logged out elsewhere, account changed,
// device key revoked, etc. Operator recovers via `codex login`. Both
// anchors required: the access-token phrase distinguishes from generic
// errors; the operator-instruction phrase distinguishes from internal
// debug logs that may include the access-token phrase incidentally.
//
// Source verified at codex-cli 0.125.0 binary at
// /opt/homebrew/Caskroom/codex/0.125.0/codex-aarch64-apple-darwin:
//   "Your access token could not be refreshed because you have since
//    logged out or signed in to another account. Please sign in again."
//   "Your access token could not be refreshed. Please log out and sign
//    in again."
function looksLikeCodexAuthRefusal(paneContent: string): boolean {
  if (!paneContent.includes("access token could not be refreshed")) return false;
  return (
    paneContent.includes("Please sign in again")
    || paneContent.includes("Please log out and sign in again")
  );
}

function looksLikeCodexLoginPrompt(paneContent: string): boolean {
  const lines = paneContent.trimEnd().split(/\r?\n/);
  let welcome = -1;
  let fence = "";
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = "";
      welcome = -1;
    } else if (!fence && line === "  Welcome to Codex, OpenAI's command-line coding agent") {
      welcome = index;
    }
  }
  if (welcome < 0) return false;
  const current = lines.slice(welcome + 1);
  if (hasCodexComposer(current.join("\n"))) return false;
  const panel = current.map(line => line.trim()).filter(Boolean);

  // Read the current complete panel only: a later prompt or menu must not lend an old login picker its footer.
  const legacyChooser = panel[0] === "Sign in with ChatGPT to use Codex as part of your paid plan"
    && panel[1] === "or connect an API key for usage-based billing";
  if ((panel[0] === "Choose how you want to use Codex." || legacyChooser)
    && panel.indexOf("Press enter to continue") === panel.length - 1) {
    const choices = panel.flatMap(line => {
      const choice = /^(> )?(\d+)\. (.+)$/.exec(line);
      return choice ? [{ selected: !!choice[1], number: Number(choice[2]), label: choice[3] }] : [];
    });
    const labels = legacyChooser
      ? ["Sign in with ChatGPT", "Sign in with Device Code", "Provide your own API key"]
      : ["Sign in with ChatGPT", "Sign in with Device Code", "Use an OpenAI API key", "Use Amazon Bedrock"];
    return choices.length >= 2 && (!legacyChooser || choices.length === labels.length)
      && choices.filter(choice => choice.selected).length === 1
      && choices.every((choice, index) => choice.number === index + 1
        && (legacyChooser ? choice.label === labels[index] : labels.includes(choice.label!)));
  }
  return panel[0] === "> Use your own OpenAI API key for usage-based billing"
    && panel.includes("Paste or type your API key below.")
    && panel.some(line => /^╭API key─+╮$/.test(line))
    && panel.indexOf("Press enter to save") === panel.length - 2
    && panel.at(-1) === "Press esc to go back";
}

function looksLikeCodexTrustPrompt(paneContent: string): boolean {
  // Preserve legacy wording semantics, including scrollback matching.
  return paneContent.includes("Do you trust the contents of this directory?")
    && paneContent.includes("Yes, continue");
}

function isCodexModelFooterLine(line: string): boolean {
  // Preserve the existing default-footer shape, including multiple modifiers.
  if (/^\s{2,}gpt-[^\n]+ · [^\n]+$/.test(line)) return true;
  const fields = line.trim().split(" · ");
  return /^[ \t]{2,}\S/.test(line) && fields.length > 1
    && fields.some((field) => CODEX_MODEL_FIELD.test(field) || CODEX_RENDERED_MODEL_FIELD.test(field));
}

function isCodexGptModelFooterLine(line: string): boolean {
  if (/^\s{2,}gpt-[^\n]+ · [^\n]+$/.test(line)) return true;
  const fields = line.trim().split(" · ");
  return /^[ \t]{2,}\S/.test(line) && fields.length > 1
    && fields.some((field) => /^gpt-\d[\w.-]*(?: [\w-]+)?$/i.test(field) || CODEX_RENDERED_GPT_FIELD.test(field));
}

function hasCodexGptModelFooter(paneContent: string): boolean {
  return /(^|\n)\s{2,}gpt-[^\n]+ · [^\n]+(?:\n|$)/i.test(paneContent)
    || paneContent.split("\n").some(isCodexGptModelFooterLine);
}

function hasCodexCustomModelFooterAfterComposer(paneContent: string): boolean {
  const lines = paneContent.split("\n");
  let lastComposer = -1;
  for (let index = 0; index < lines.length; index += 1) {
    if (hasCodexComposer(lines[index]!)) lastComposer = index;
  }
  return lastComposer >= 0 && lines.slice(lastComposer + 1).some((line) =>
    isCodexModelFooterLine(line) && !isCodexGptModelFooterLine(line));
}

function looksLikeCurrentCodexTrustPrompt(paneContent: string): boolean {
  const headings = [...paneContent.matchAll(/^[ \t]*Trust this folder\?/gm)];
  // A trailing partial redraw must not erase the latest complete panel.
  for (let index = headings.length - 1; index >= 0; index--) {
    const heading = headings[index]!;
    const start = heading.index! + heading[0].length;
    const panel = paneContent.slice(start, headings[index + 1]?.index);
    const choice = /^[ \t]*(?:[›»]\s*)?\d+\.\s+Trust and continue[ \t]*$/m.exec(panel);
    if (!choice) continue;
    const afterChoice = paneContent.slice(start + choice.index + choice[0].length);
    return !hasCodexComposer(afterChoice)
      && !hasCodexGptModelFooter(afterChoice);
  }
  return false;
}

function looksLikeCodexHookReviewPrompt(paneContent: string): boolean {
  // A newer header supersedes a dismissed prompt retained in scrollback.
  const current = paneContent.slice(Math.max(0, paneContent.lastIndexOf("OpenAI Codex (v")));
  // Closing a review panel may redraw only the input prompt, without a new
  // header. A later non-menu conversation prompt supersedes that old panel.
  const gateEnd = Math.max(current.lastIndexOf("Press t to trust"), current.lastIndexOf("Trust all and continue"));
  if (gateEnd >= 0 && current.slice(gateEnd).split("\n").some((line) => /^\s*[›»](?:\s|$)/.test(line) && !/^\s*[›»]\s*\d+\.\s/.test(line))) return false;
  return (current.includes("Hooks need review") && current.includes("Trust all and continue"))
    || (/hooks? needs? review before (?:it|they) can run\./.test(current)
      && /Press t to trust(?: all)?;/.test(current));
}

function looksLikeCodexModelSelectionPrompt(paneContent: string): boolean {
  // A chooser drawn at the top of a tall pane sits above blank rows, so count from the last drawn row.
  const recentLines = paneContent.trimEnd().split("\n").slice(-20);
  const options = recentLines.map((line) => /^\s*(?:[›»]\s*)?\d+\.\s+/.test(line) && /\bgpt-[\w.-]+\b/i.test(line));
  if (options.filter(Boolean).length < 2) return false;
  // The options count only while they are the last thing drawn: a composer or a Codex header after
  // them means they are history above a session that resumed. The status footer belongs to the chooser.
  return !recentLines.slice(options.lastIndexOf(true) + 1)
    .some((line) => line.includes("OpenAI Codex (v") || hasCodexComposer(line));
}
