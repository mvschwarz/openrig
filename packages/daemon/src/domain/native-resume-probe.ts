import { shellQuote } from "../adapters/shell-quote.js";

// L3 adds `attention_required` for the Claude resume-selection prompt proxy.
// Distinct from `inconclusive` (we don't know yet) and `failed` (terminal
// failure): the runtime is alive and recoverable but needs operator action.
export type NativeResumeProbeStatus = "resumed" | "failed" | "inconclusive" | "attention_required";

export interface NativeResumeProbeInput {
  runtime: string | null;
  paneCommand: string | null;
  paneContent: string | null;
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
  sessionName?: string | null
): string | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") {
    const nameSuffix = sessionName ? ` --name ${shellQuote(sessionName)}` : "";
    return `claude --resume ${shellQuote(resumeToken)}${nameSuffix}`;
  }
  if (runtime === "codex") {
    return `codex resume ${shellQuote(resumeToken)}`;
  }
  return null;
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
    if (paneCommand === "claude") {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Claude is the active foreground process in the probe pane.",
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
      detail: "Claude did not report an explicit failure, but it is not yet the active pane process.",
    };
  }

  if (runtime === "codex") {
    if (paneContent.includes("No saved session found")) {
      return {
        status: "failed",
        code: "no_saved_session",
        detail: "Codex reported that the requested saved session does not exist.",
      };
    }
    if (looksLikeCodexTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Codex is waiting for workspace trust approval before the session can become interactive.",
      };
    }
    if (looksLikeCodexModelSelectionPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "model_selection_gate",
        detail: "Codex is waiting for model selection before the session can become interactive.",
      };
    }
    if (looksLikeCodexTui(paneContent)) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Codex is running with an active interactive TUI in the probe pane.",
      };
    }
    if (paneContent.includes("Update available!") || paneContent.includes("Updating Codex")) {
      return {
        status: "inconclusive",
        code: "update_gate",
        detail: "Codex reached an update flow, so process-alive alone is not proof of a restored conversation.",
      };
    }
    if (paneCommand.startsWith("codex")) {
      return {
        status: "resumed",
        code: "active_runtime",
        detail: "Codex is the active foreground process in the probe pane.",
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
      detail: "Codex did not report an explicit failure, but it is not yet the active pane process.",
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
  const hasPrompt = /(^|\n)\s*❯/.test(paneContent);
  if (!hasPrompt) return false;

  return (
    paneContent.includes("Claude Code v")
    || paneContent.includes("accept edits on")
  );
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
  // Stable substring is the explicit "Choose ... conversation" verb plus the
  // numbered/arrow option marker that Claude prints. Both must be present so
  // we don't false-positive on similar TUI strings.
  const hasChooseVerb =
    paneContent.includes("Choose a conversation")
    || paneContent.includes("Choose the conversation")
    || paneContent.includes("Select a conversation");
  if (!hasChooseVerb) return false;

  // Look for the numbered/arrow option marker in recent lines.
  const recentLines = paneContent.split("\n").slice(-30);
  const numberedOption = recentLines.some((line) => /^\s*(?:›\s*)?\d+\.\s+\S/.test(line));
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
  if (paneContent.includes("OpenAI Codex (v")) {
    return true;
  }

  const recentLines = paneContent.split("\n").slice(-12).join("\n");
  const hasPromptLine = /(^|\n)\s*›(?:\s|$)/.test(recentLines);
  const hasModelFooter = /(^|\n)\s{2,}gpt-[^\n]+ · [^\n]+(?:\n|$)/.test(recentLines);

  return hasPromptLine && hasModelFooter;
}

function looksLikeCodexTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Do you trust the contents of this directory?")
    && paneContent.includes("Yes, continue");
}

function looksLikeCodexModelSelectionPrompt(paneContent: string): boolean {
  const recentLines = paneContent.split("\n").slice(-20);
  const numberedModelOptions = recentLines.filter((line) => (
    /^\s*(?:›\s*)?\d+\.\s+/.test(line)
    && /\bgpt-[\w.-]+\b/i.test(line)
  ));

  return numberedModelOptions.length >= 2;
}
