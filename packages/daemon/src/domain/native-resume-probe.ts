import { shellQuote } from "../adapters/shell-quote.js";

export type NativeResumeProbeStatus = "resumed" | "failed" | "inconclusive";

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
    if (looksLikeClaudeTrustPrompt(paneContent)) {
      return {
        status: "inconclusive",
        code: "trust_gate",
        detail: "Claude is waiting for workspace trust approval before the session can become interactive.",
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

function looksLikeClaudeLoginPrompt(paneContent: string): boolean {
  return paneContent.includes("Not logged in")
    && paneContent.includes("Run /login");
}

function looksLikeCodexTui(paneContent: string): boolean {
  return paneContent.includes("OpenAI Codex (v");
}

function looksLikeCodexTrustPrompt(paneContent: string): boolean {
  return paneContent.includes("Do you trust the contents of this directory?")
    && paneContent.includes("Yes, continue");
}
