import { currentClaudeMcpMenu } from "./claude-mcp-menu.js";
import { shellQuote } from "../adapters/shell-quote.js";
import { claudePostureFlag, codexPostureArg } from "../adapters/yolo-mode.js";

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

export function buildNativeResumeCommand(
  runtime: string | null,
  resumeToken: string | null,
  sessionName?: string | null,
  codexConfigProfile?: string | null,
  /** Codex: the seat's recorded daemon choice; only a positive true adds --no-daemon (absent and false print as before). */
  codexDaemonOptOut?: boolean,
): string | null {
  if (!resumeToken) return null;
  if (runtime === "claude-code") {
    const nameSuffix = sessionName ? ` --name ${shellQuote(sessionName)}` : "";
    return `claude ${claudePostureFlag(process.env)} --resume ${shellQuote(resumeToken)}${nameSuffix}`;
  }
  if (runtime === "codex") {
    return buildCodexResumeCore(resumeToken, codexConfigProfile, undefined, undefined, undefined, undefined, undefined, codexDaemonOptOut === true);
  }
  return null;
}

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
