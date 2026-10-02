import { shellQuote } from "../adapters/shell-quote.js";
import { codexPostureArg } from "../adapters/yolo-mode.js";

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
}

export interface NativeResumeProbeResult {
  status: NativeResumeProbeStatus;
  code: string;
  detail: string;
}

export interface ProbeShellReadyInput {
  paneCommand: string | null;
  paneContent: string | null;
}

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export function buildNativeResumeCommand(
  runtime: string | null,
  resumeToken: string | null,
  sessionName?: string | null,
  codexConfigProfile?: string | null,
): string | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") {
    const nameSuffix = sessionName ? ` --name ${shellQuote(sessionName)}` : "";
    return `claude --resume ${shellQuote(resumeToken)}${nameSuffix}`;
  }
  if (runtime === "codex") {
    return buildCodexResumeCore(resumeToken, codexConfigProfile);
  }
  if (runtime === "agy") {
    return buildAgyResumeCore(resumeToken);
  }
  return null;
}

export function buildAgyResumeCore(
  resumeToken: string,
  model?: string | null,
  postureArg?: string,
): string {
  const parts = ["agy"];
  if (postureArg) parts.push(postureArg);
  if (model?.trim()) parts.push(`--model ${shellQuote(model.trim())}`);
  parts.push(`--conversation ${shellQuote(resumeToken)}`);
  return parts.join(" ");
}

export function buildCodexResumeCore(
  resumeToken: string,
  codexConfigProfile?: string | null,
  useLast?: boolean,
  extraArgs?: string,
  // OPR.0.4.8.3 Seam B: optional resolved posture — LAUNCH callers thread the seat's
  // persisted/bound posture; the shared non-launch consumers (node inventory,
  // resume-metadata) omit it and keep byte-identical behavior.
  resolvedPosture?: "floor" | "full_bypass",
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
  const middle = extraArgs ? `${extraArgs} ` : "";
  const tokenArg = useLast ? "--last" : shellQuote(resumeToken);
  const daemonArg = daemonOptOut ? " --no-daemon" : "";
  return `codex${daemonArg}${profileOrPosture}${modelArg}${effortArg} resume ${middle}${tokenArg}`;
}

export function assessNativeResumeProbe(
  input: NativeResumeProbeInput
): NativeResumeProbeResult {
  const runtime = input.runtime ?? "";
  const paneCommand = input.paneCommand ?? "";
  const paneContent = input.paneContent ?? "";

  if (runtime === "claude-code") {
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
    if (looksLikeClaudeTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Claude is waiting for workspace trust approval before the session can become interactive.",
      };
    }
    if (looksLikeClaudeMcpApprovalPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "mcp_gate",
        detail: "Claude is waiting for project MCP server approval before the session can become interactive.",
      };
    }
    if (looksLikeClaudeLoginPrompt(paneContent)) {
      return {
        status: "failed",
        code: "login_required",
        detail: "Claude is running but cannot continue until the user logs in.",
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
    if (looksLikeCodexTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Codex is running with an active interactive TUI in the probe pane.",
      };
    }
    if (looksLikeCodexTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Codex is waiting for workspace trust approval before the session can become interactive.",
      };
    }
    if (paneContent.includes("Update available!") || paneContent.includes("Updating Codex")) {
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

  if (runtime === "agy") {
    if (paneContent.includes("Conversation not found") || paneContent.includes("conversation not found") || /conversation "[^"]+" not found/i.test(paneContent)) {
      return {
        status: "failed",
        code: "no_conversation_found",
        detail: "Antigravity reported that the requested conversation no longer exists.",
      };
    }
    if (looksLikeAgyTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Antigravity is running with an active interactive TUI in the probe pane.",
      };
    }
    if (paneCommand === "agy") {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Antigravity is the active foreground process in the probe pane.",
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
      detail: "Antigravity did not report an explicit failure, but an interactive conversation has not been observed.",
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

function looksLikeClaudeTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Accessing workspace:")
    && paneContent.includes("Yes, I trust this folder");
}

// Claude's resume-selection prompt appears when `claude --resume` finds multiple
// candidate conversations (or after a reboot when the conversation index is
// rebuilt). The prompt lists numbered options and asks the operator to pick.
//
// L3 invariant: do NOT auto-answer. Surface as `attention_required` and let an
// operator choose; later reconciliation upgrades to `operator_recovered` only
// when the operator reaches a usable state.
function looksLikeClaudeResumeSelectionPrompt(paneContent: string): boolean {
  // Current Claude chooser (observed 2026-09-04) asks which fidelity to
  // resume with. Require the heading, both option rows, and a selection cursor;
  // prose containing the labels is intentionally insufficient.
  const recentLines = paneContent.split("\n").slice(-30);
  const currentChooserHeading = recentLines.some((line) => line.trim() === "How would you like to resume?");
  const currentChooserOptions = recentLines.filter((line) =>
    /^\s*(?:[❯›]\s+)?(?:Resume from summary|Resume full session as-is)\s*$/.test(line)
  );
  const currentChooserSelection = currentChooserOptions.some((line) => /^\s*[❯›]\s+/.test(line));
  if (
    currentChooserHeading
    && currentChooserSelection
    && currentChooserOptions.some((line) => line.includes("Resume from summary"))
    && currentChooserOptions.some((line) => line.includes("Resume full session as-is"))
  ) return true;

  // Stable substring is the explicit "Choose ... conversation" verb plus the
  // numbered/arrow option marker that Claude prints. Both must be present so
  // we don't false-positive on similar TUI strings.
  const hasChooseVerb =
    paneContent.includes("Choose a conversation")
    || paneContent.includes("Choose the conversation")
    || paneContent.includes("Select a conversation");
  if (!hasChooseVerb) return false;

  // Look for the numbered/arrow option marker in recent lines.
  const numberedOption = recentLines.some((line) => /^\s*(?:[›»]\s*)?\d+\.\s+\S/.test(line));
  return numberedOption;
}

function looksLikeClaudeLoginPrompt(paneContent: string): boolean {
  return paneContent.includes("Not logged in")
    && paneContent.includes("Run /login");
}

function looksLikeClaudeMcpApprovalPrompt(paneContent: string): boolean {
  return paneContent.includes("new MCP servers found in .mcp.json")
    && paneContent.includes("Select any you wish to enable")
    && paneContent.includes("Enter to confirm");
}

function looksLikeCodexTui(paneContent: string): boolean {
  const current = paneContent.slice(Math.max(0, paneContent.lastIndexOf("OpenAI Codex (v")));
  if (/model:\s*loading\b/i.test(current)) return false;
  const recentLines = current.trimEnd().split("\n").slice(-20).join("\n");
  const hasPromptLine = recentLines.split("\n").some((line) => {
    const text = line.trimStart();
    const hasPrompt = text.startsWith("›") || text.startsWith("»");
    return hasPrompt && !/^\d+\.\s/.test(text.slice(1).trimStart());
  });
  const hasModelFooter = /(^|\n)\s{2,}gpt-[^\n]+ · [^\n]+(?:\n|$)/.test(recentLines);
  // Custom status lines can put the model's display name in any field. Keep
  // corroboration structural: an indented status row and a whole model field,
  // not a model mentioned somewhere in conversation prose.
  // A custom row must not make an unresolved trust/update panel disappear.
  const hasCustomModelFooter = !looksLikeCodexTrustPrompt(current)
    && !current.includes("Update available!") && !current.includes("Updating Codex")
    && recentLines.split("\n").some((line) => {
      const fields = line.trim().split(" · ");
      return /^[ \t]{2,}\S/.test(line) && fields.length > 1
        && fields.some((field) => /^gpt-\d[\w.-]*(?: [\w-]+)?$/i.test(field));
    });
  return hasPromptLine && (current.includes("OpenAI Codex (v") || hasModelFooter || hasCustomModelFooter);
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

function looksLikeCodexTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Do you trust the contents of this directory?")
    && paneContent.includes("Yes, continue");
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
  const recentLines = paneContent.split("\n").slice(-20);
  const numberedModelOptions = recentLines.filter((line) => (
    /^\s*(?:[›»]\s*)?\d+\.\s+/.test(line)
    && /\bgpt-[\w.-]+\b/i.test(line)
  ));

  return numberedModelOptions.length >= 2;
}

function looksLikeAgyTui(paneContent: string): boolean {
  return (
    paneContent.includes("Antigravity CLI")
    || paneContent.includes("? for shortcuts")
    || /(^|\n)\s*>\s*/.test(paneContent)
  );
}
