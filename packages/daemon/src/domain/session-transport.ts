import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { EventBus } from "./event-bus.js";
import type { AgentActivity } from "./types.js";
import { wrapPaneEnvelope } from "../lib/pane-envelope.js";

// OPR.0.4.1.10 — send-readiness freshness. The runtime-hook store keeps a 5min freshness for activity
// DISPLAY, but "safe to send NOW" needs a tight window: a stale "idle" read must not authorize a send
// into what may since have become a prompt. Beyond this window the hook is ignored for send-readiness
// and we fall through to the real-time capture-pane probe. Founder-tunable later.
// Value (15s) is research-shaped, not a prior: terminal-state currency in comparable agent tooling is
// SECONDS-scale — agtx caches pane status with a ~2s TTL, and the SWE-agent/OpenDevin-derived heuristics
// (daintree #3938) cite Claude 1-3s / Codex 3-5s inter-tool-call gaps with a 6s idle debounce. A 15s
// window comfortably spans one inter-tool gap (so a mid-turn reading stays trusted) while refusing to
// authorize a send from a reading tens of seconds old. (EXA: agtx#14, daintree#3938.)
const SEND_READINESS_FRESHNESS_MS = 15_000;

// Mid-work detection patterns (cheap heuristics)
const MID_WORK_PATTERNS = [
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, // spinner chars
  /Working/,
  /^[✶✢✳✻✽·]\s+\S.*(?:…|\.{3})\s+\([^)]*\bthinking\)$/m,
  /esc to interrupt/,
  /^[❯›]\s*\d+\.\s/m,   // trust/consent prompt choices (e.g. '› 1. Yes, continue')
];

// Idle-prompt patterns: empty prompt line (no typed text after the char).
// Lines like '❯ Working on a task.' have text after the prompt char and
// are NOT idle — the prompt is active with input that may look mid-work.
const IDLE_PROMPT_PATTERNS = [
  /^[❯›]\s*$/,  // prompt char + optional whitespace + end-of-line only
];

const PROMPT_DRAFT_PATTERNS = [
  /^[❯›]\s+\S/,
];

// Status-bar patterns that ONLY appear when the harness is at its idle
// prompt. These are more reliable than the prompt char alone because they
// are never rendered during active tool execution.
const IDLE_STATUS_BAR_PATTERNS = [
  /gpt-\d[\d.]* .+ · Context \[/,  // Codex model/context footer
  /⏵⏵ accept edits/,              // Claude Code edit-accept bar
];

const IDLE_TERMINAL_COMMANDS = new Set(["zsh", "bash", "sh", "fish", "nu", "tmux"]);

// OPR.0.4.1.10 — permission / confirmation question signatures. The numbered-selector pattern
// (`❯/› N.`) already catches the highlighted AskUserQuestion / trust-prompt choice; these catch the
// permission QUESTION line itself so a permission block whose selector has scrolled above an idle-
// looking footer is still classified as needing input (not idle). Specific phrasings keep the
// false-positive rate near zero (an agent rarely prints "Do you want to proceed?" as plain output).
const PERMISSION_PROMPT_PATTERNS = [
  /\bDo you want to (?:proceed|continue|trust|allow|make|apply|create|run|delete|overwrite|edit)\b/i,
  /\bDo you trust the\b/i,
  // Codex v0.139.0 command-approval render (qa-codex-approval-render-research-20260627): the selector
  // (`› N.`) is already caught above; these question lines make the fallback robust if it scrolls out.
  /\bWould you like to run the following command\b/i,
  /\bAllow Codex to run\b/i,
];

// OPR.0.4.1.10 — how many trailing non-blank lines to scan for an interactive-prompt SIGNATURE (the
// numbered selector / permission question). Wider than the generic activity window (8) because a real
// prompt's selector can be pushed UP past the bottom few lines by a tall persistent footer — Claude
// Code renders status bar + permission-mode hint + separator + input-box border + thinking-budget BELOW
// the actual "❯ " prompt, and in a narrow tiled pane that footer pushes the prompt out of an 8-line
// window, causing a false-idle read (the exact footgun). 12 mirrors the window the ntm project adopted
// after hitting this. Erring toward "prompt detected" is the SAFE direction for this guard: a false
// refusal is overridable; a false-idle lets a message land on a prompt. (EXA: ntm e28763e; AgentDeck.)
const PROMPT_SCAN_LINES = 12;

export interface PaneActivityClassification {
  state: "agent_active" | "agent_idle" | "attention" | "unknown";
  reason: string;
  evidence: string | null;
}

function trimPaneLines(paneContent: string): string[] {
  return paneContent
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function truncateEvidence(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function findPatternEvidence(lines: string[], patterns: RegExp[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (patterns.some((pattern) => pattern.test(line))) return truncateEvidence(line);
  }
  return null;
}

function findPromptDraftBeforeFooter(paneContent: string): string | null {
  const rawLines = paneContent.split("\n").map((line) => line.trimEnd());
  let lastLineIndex = rawLines.length - 1;
  while (lastLineIndex >= 0 && rawLines[lastLineIndex]!.trim().length === 0) {
    lastLineIndex--;
  }
  if (lastLineIndex <= 0) return null;

  const footerLine = rawLines[lastLineIndex]!.trim();
  const footerIsIdle = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(footerLine));
  if (!footerIsIdle) return null;

  const priorLine = rawLines[lastLineIndex - 1]!;
  if (priorLine.trim().length === 0) return null;

  const priorTrimmed = priorLine.trim();
  const looksLikeDraft = PROMPT_DRAFT_PATTERNS.some((pattern) => pattern.test(priorTrimmed));
  const looksLikeSelection = /^[❯›]\s*\d+\.\s/.test(priorTrimmed);
  if (!looksLikeDraft || looksLikeSelection) return null;

  return truncateEvidence(priorTrimmed);
}

export function classifyPaneActivity(paneContent: string): PaneActivityClassification {
  const lastNonBlank = trimPaneLines(paneContent);
  if (lastNonBlank.length === 0) {
    return { state: "unknown", reason: "empty_capture", evidence: null };
  }

  const recentLines = lastNonBlank.slice(-8);
  const recentWindow = recentLines.join("\n");
  // Wider window for prompt SIGNATURES so a tall footer can't push a real prompt out of view (see
  // PROMPT_SCAN_LINES). The generic activity checks below keep the tighter 8-line window.
  const promptScanLines = lastNonBlank.slice(-PROMPT_SCAN_LINES);
  const trailingNonBlank = lastNonBlank.slice(-3);
  const lastLine = lastNonBlank.at(-1) ?? "";
  const idlePromptLine = trailingNonBlank.find((line) =>
    IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
  );
  const idleStatusBarLine = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(lastLine))
    ? lastLine
    : null;
  const selectionPromptEvidence = findPatternEvidence(promptScanLines, [/^[❯›]\s*\d+\.\s/m]);
  if (selectionPromptEvidence) {
    return {
      state: "attention",
      reason: "selection_prompt",
      evidence: selectionPromptEvidence,
    };
  }

  // OPR.0.4.1.10 (FR-1c): a permission/confirmation question is attention even when its selector is
  // not in view — checked before the idle short-circuits so a permission block above an idle-looking
  // footer never reads as idle (which would let a default send land on it).
  const permissionPromptEvidence = findPatternEvidence(promptScanLines, PERMISSION_PROMPT_PATTERNS);
  if (permissionPromptEvidence) {
    return {
      state: "attention",
      reason: "permission_prompt",
      evidence: permissionPromptEvidence,
    };
  }

  const promptDraftEvidence = findPromptDraftBeforeFooter(paneContent);
  if (promptDraftEvidence) {
    return {
      state: "attention",
      reason: "prompt_draft",
      evidence: promptDraftEvidence,
    };
  }

  if (idleStatusBarLine) {
    return {
      state: "agent_idle",
      reason: "idle_status_bar",
      evidence: truncateEvidence(idleStatusBarLine),
    };
  }
  if (idlePromptLine && !MID_WORK_PATTERNS.some((pattern) => pattern.test(recentWindow))) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  const midWorkEvidence = findPatternEvidence(recentLines, MID_WORK_PATTERNS);
  if (midWorkEvidence) {
    return {
      state: "agent_active",
      reason: "mid_work_pattern",
      evidence: midWorkEvidence,
    };
  }

  if (idlePromptLine) {
    return {
      state: "agent_idle",
      reason: "idle_prompt",
      evidence: truncateEvidence(idlePromptLine),
    };
  }

  return {
    state: "unknown",
    reason: "no_activity_signal",
    evidence: truncateEvidence(lastLine),
  };
}

export async function probeSessionActivity(input: {
  sessionName: string | null;
  runtime: string | null;
  attachmentType: "tmux" | "external_cli" | null | undefined;
  tmuxAdapter: TmuxAdapter;
  now?: Date;
}): Promise<AgentActivity> {
  const sampledAt = (input.now ?? new Date()).toISOString();

  if (!input.sessionName) {
    return {
      state: "unknown",
      reason: "no_session",
      evidenceSource: "session_registry",
      sampledAt,
      evidence: null,
    };
  }
  if (input.attachmentType === "external_cli") {
    return {
      state: "unknown",
      reason: "unsupported_attachment",
      evidenceSource: "external_cli",
      sampledAt,
      evidence: input.sessionName,
    };
  }
  if (input.runtime === "terminal") {
    try {
      const paneCommand = await input.tmuxAdapter.getPaneCommand(input.sessionName);
      if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
        return {
          state: "running",
          reason: "foreground_command",
          evidenceSource: "pane_heuristic",
          sampledAt,
          evidence: paneCommand,
          fallback: true,
        };
      }
    } catch {
      return {
        state: "unknown",
        reason: "capture_failed",
        evidenceSource: "pane_heuristic",
        sampledAt,
        evidence: null,
        fallback: true,
      };
    }

    return {
      state: "unknown",
      reason: "unsupported_runtime",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    };
  }

  try {
    const exists = await input.tmuxAdapter.hasSession(input.sessionName);
    if (!exists) {
      return {
        state: "unknown",
        reason: "session_missing",
        evidenceSource: "tmux_session",
        sampledAt,
        evidence: input.sessionName,
      };
    }
  } catch {
    return {
      state: "unknown",
      reason: "tmux_unavailable",
      evidenceSource: "tmux_session",
      sampledAt,
      evidence: null,
    };
  }

  try {
    const paneContent = await input.tmuxAdapter.capturePaneContent(input.sessionName, 20);
    const classification = classifyPaneActivity(paneContent ?? "");
    return {
      state: mapPaneState(classification.state),
      reason: classification.reason,
      evidence: classification.evidence,
      evidenceSource: "pane_heuristic",
      sampledAt,
      fallback: true,
    };
  } catch {
    return {
      state: "unknown",
      reason: "capture_failed",
      evidenceSource: "pane_heuristic",
      sampledAt,
      evidence: null,
      fallback: true,
    };
  }
}

function mapPaneState(state: PaneActivityClassification["state"]): AgentActivity["state"] {
  if (state === "agent_active") return "running";
  if (state === "attention") return "needs_input";
  if (state === "agent_idle") return "idle";
  return "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (true) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) break;
    count++;
    start = index + needle.length;
  }
  return count;
}

export type TargetSpec =
  | { session: string }
  // OPR.0.4.3.30 — explicit multi-recipient list (`rig send --to a,b`). Resolved via
  // resolveByList (each name through the single-name resolver, so ambiguity/not-found are
  // reported honestly against the exact seat).
  | { sessions: string[] }
  | { rig: string }
  | { pod: string; rig?: string }
  | { global: true };

export type ResolveResult =
  | { ok: true; sessions: Array<{ sessionName: string; rigName: string; nodeLogicalId: string }> }
  | { ok: false; code: "not_found" | "ambiguous"; error: string };

export interface SendOpts {
  verify?: boolean;
  force?: boolean;
  waitForIdleMs?: number;
  // OPR.0.4.1.10 — interactive-prompt / permission guard.
  // `dangerouslyInteract` is the ONLY override of the prompt/permission guard (force does NOT bypass
  // it). It requires `reason` and writes an auditable `transport.prompt_override` record before the
  // send. `actorSession` is the caller identity recorded in that audit. (`--raw` is purely a CLI-side
  // envelope concern — the daemon guard behaves identically for raw and wrapped text.)
  dangerouslyInteract?: boolean;
  reason?: string;
  actorSession?: string | null;
}

// OPR.0.4.3.30 — options for the fan-out path (`broadcast()`). Superset of SendOpts.
// `envelopeSender`, when set, makes the fan-out wrap EACH recipient's text in its own
// From/To pane envelope (byte-identical to single-send CLI wrapping via wrapPaneEnvelope),
// so a multi/pod/rig `rig send` gives each seat its own `To:` header. Absent for
// `rig broadcast` (raw-to-all, unchanged) and for the CLI --raw / --dangerously-interact paths.
export interface BroadcastOpts extends SendOpts {
  envelopeSender?: string;
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
  /**
   * OPR.99.0.6.3 — honest delivery-outcome vocabulary (additive; `verified`
   * keeps its exact semantics for existing parsers). Three distinguishable
   * states, mirroring the restore honest-outcome style:
   * - `delivered`: text + Enter landed AND the post-send capture re-confirmed
   *   the snippet (the strong positive; was `Verified: yes`).
   * - `rendered-unconfirmed`: text + Enter BOTH succeeded (the message landed)
   *   but the post-send capture raced a TUI redraw and could not re-confirm
   *   the snippet. Landed-but-unconfirmable, NOT a failure — confirm with
   *   `rig capture` if it matters. (Was collapsed into `Verified: no`.)
   * - `failed`: the transport itself failed (paste or Enter did not land) —
   *   set on the send_failed / submit_failed returns for vocabulary symmetry;
   *   their `ok:false` + HTTP mapping is unchanged.
   */
  outcome?: "delivered" | "rendered-unconfirmed" | "failed";
  warning?: string;
  error?: string;
  reason?: string;
  activity?: AgentActivity;
  waitedMs?: number;
  attempts?: number;
  sent?: boolean;
}

export interface CaptureResult {
  ok: boolean;
  sessionName: string;
  content?: string;
  lines?: number;
  error?: string;
  reason?: string;
}

export interface BroadcastResult {
  total: number;
  sent: number;
  failed: number;
  results: SendResult[];
}

interface SessionTransportDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  agentActivityStore?: AgentActivityStore;
  // OPR.0.4.1.10 — required only for the --dangerously-interact audit path. When absent, a dangerous
  // override fails closed (refuses) rather than sending unaudited. Non-danger sends never need it.
  eventBus?: EventBus;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitForIdlePollMs?: number;
  // OPR.0.4.1.10 — send-readiness freshness override (default SEND_READINESS_FRESHNESS_MS). Test seam.
  sendReadinessFreshnessMs?: number;
}

interface SessionRow { node_id: string; session_name: string; }
interface NodeRow { rig_id: string; logical_id: string; }
interface SessionMetaRow { runtime: string | null; attachment_type: string | null; }
interface ResolvedTarget { sessionName: string; rigName: string; nodeLogicalId: string; }

export class SessionTransport {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private tmuxAdapter: TmuxAdapter;
  private agentActivityStore?: AgentActivityStore;
  private eventBus?: EventBus;
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private waitForIdlePollMs: number;
  private sendReadinessFreshnessMs: number;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.agentActivityStore = deps.agentActivityStore;
    this.eventBus = deps.eventBus;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? delay;
    this.waitForIdlePollMs = deps.waitForIdlePollMs ?? 500;
    this.sendReadinessFreshnessMs = deps.sendReadinessFreshnessMs ?? SEND_READINESS_FRESHNESS_MS;
  }

  private getSessionMeta(sessionName: string): { runtime: string | null; attachmentType: string | null } {
    const row = this.db.prepare(`
      SELECT
        n.runtime AS runtime,
        b.attachment_type AS attachment_type
      FROM sessions s
      JOIN nodes n ON s.node_id = n.id
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.session_name = ?
      ORDER BY s.id DESC
      LIMIT 1
    `).get(sessionName) as SessionMetaRow | undefined;

    return {
      runtime: row?.runtime ?? null,
      attachmentType: row?.attachment_type ?? null,
    };
  }

  async resolveSessions(target: TargetSpec): Promise<ResolveResult> {
    if ("session" in target) {
      return this.resolveBySessionName(target.session);
    }
    if ("sessions" in target) {
      return this.resolveByList(target.sessions);
    }
    if ("pod" in target) {
      return this.resolveByPod(target.pod, target.rig);
    }
    if ("global" in target) {
      return this.resolveGlobal();
    }
    return this.resolveByRig(target.rig);
  }

  private resolveGlobal(): ResolveResult {
    const allRigs = this.rigRepo.listRigs();
    if (allRigs.length === 0) {
      return { ok: false, code: "not_found", error: "No rigs found. Check status with: rig ps" };
    }
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of allRigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No running sessions found. Check status with: rig ps" };
    }
    return { ok: true, sessions };
  }

  private resolveBySessionName(sessionName: string): ResolveResult {
    const sessionRows = this.db
      .prepare("SELECT node_id, session_name FROM sessions WHERE session_name = ? ORDER BY id DESC")
      .all(sessionName) as SessionRow[];

    if (sessionRows.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    // Check for ambiguity: same session name across different rigs
    const rigNames = new Map<string, { nodeLogicalId: string }>();
    for (const row of sessionRows) {
      const nodeRow = this.db
        .prepare("SELECT rig_id, logical_id FROM nodes WHERE id = ?")
        .get(row.node_id) as NodeRow | undefined;
      if (nodeRow) {
        const rig = this.rigRepo.getRig(nodeRow.rig_id);
        if (rig) {
          rigNames.set(rig.rig.name, { nodeLogicalId: nodeRow.logical_id });
        }
      }
    }

    if (rigNames.size === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `Session '${sessionName}' not found. Check session names with: rig ps --nodes`,
      };
    }

    if (rigNames.size > 1) {
      const names = Array.from(rigNames.keys()).join(", ");
      return {
        ok: false,
        code: "ambiguous",
        error: `Session '${sessionName}' is ambiguous — found in rigs: ${names}. Specify the rig explicitly.`,
      };
    }

    const [rigName, meta] = Array.from(rigNames.entries())[0]!;
    return {
      ok: true,
      sessions: [{ sessionName, rigName, nodeLogicalId: meta.nodeLogicalId }],
    };
  }

  // OPR.0.4.3.30 — resolve an explicit list of named seats for a multi-recipient `rig send`.
  // Each name goes through the single-name resolver so a not-found / ambiguous seat is reported
  // honestly against that exact name (matching single-send semantics), and the whole command is
  // rejected rather than silently dropping a mistyped seat. Duplicate names are de-duplicated so
  // `--to a,a` delivers once. (Per-recipient GUARD independence is a send()-time concern, not a
  // resolution one — a guard refusal is one ok:false in the fan-out results, never an abort.)
  private resolveByList(sessionNames: string[]): ResolveResult {
    const sessions: ResolvedTarget[] = [];
    const seen = new Set<string>();
    for (const name of sessionNames) {
      if (seen.has(name)) continue;
      seen.add(name);
      const resolved = this.resolveBySessionName(name);
      if (!resolved.ok) return resolved;
      sessions.push(...resolved.sessions);
    }
    if (sessions.length === 0) {
      return { ok: false, code: "not_found", error: "No target sessions provided." };
    }
    return { ok: true, sessions };
  }

  private resolveByRig(rigName: string): ResolveResult {
    const rigs = this.rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No rig named '${rigName}' found. Check available rigs with: rig ps`,
      };
    }

    const sessions: ResolvedTarget[] = [];
    for (const rig of rigs) {
      sessions.push(...this.collectTransportTargetsForRig(rig.id, rig.name));
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for rig '${rigName}'. Check rig status with: rig ps`,
      };
    }

    return { ok: true, sessions };
  }

  private resolveByPod(podName: string, rigName?: string): ResolveResult {
    // Get rigs to search
    const rigs = rigName
      ? this.rigRepo.findRigsByName(rigName)
      : this.rigRepo.listRigs();

    if (rigs.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: rigName
          ? `No rig named '${rigName}' found. Check available rigs with: rig ps`
          : `No rigs found. Check status with: rig ps`,
      };
    }

    // Collect running sessions across all matching rigs, deduplicated by rig ID
    const sessions: ResolvedTarget[] = [];
    const seenRigIds = new Set<string>();
    for (const rig of rigs) {
      if (seenRigIds.has(rig.id)) continue;
      seenRigIds.add(rig.id);

      for (const target of this.collectTransportTargetsForRig(rig.id, rig.name)) {
        const podPart = target.nodeLogicalId.split(".")[0];
        if (podPart === podName) {
          sessions.push(target);
        }
      }
    }

    if (sessions.length === 0) {
      return {
        ok: false,
        code: "not_found",
        error: `No running sessions found for pod '${podName}'${rigName ? ` in rig '${rigName}'` : ""}. Check available pods with: rig ps --nodes`,
      };
    }

    return { ok: true, sessions };
  }

  private collectTransportTargetsForRig(rigId: string, rigName: string): ResolvedTarget[] {
    const rigSessions = this.sessionRegistry.getSessionsForRig(rigId);
    const latestByNode = new Map<string, typeof rigSessions[0]>();
    for (const session of rigSessions) {
      const existing = latestByNode.get(session.nodeId);
      if (!existing || session.id > existing.id) {
        latestByNode.set(session.nodeId, session);
      }
    }

    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return [];

    const targets: ResolvedTarget[] = [];
    for (const node of rig.nodes) {
      const binding = this.sessionRegistry.getBindingForNode(node.id);
      const latestSession = latestByNode.get(node.id);

      if (binding?.attachmentType === "external_cli" && binding.externalSessionName) {
        targets.push({
          sessionName: binding.externalSessionName,
          rigName,
          nodeLogicalId: node.logicalId,
        });
        continue;
      }

      if (latestSession?.status === "running" && binding?.tmuxSession) {
        targets.push({
          sessionName: binding.tmuxSession,
          rigName,
          nodeLogicalId: node.logicalId,
        });
      }
    }

    return targets;
  }

  async send(sessionName: string, text: string, opts?: SendOpts): Promise<SendResult> {
    let preVerifyContent: string | null = null;
    const sessionMeta = this.getSessionMeta(sessionName);
    const runtime = sessionMeta.runtime;
    const waitForIdleMs = opts?.waitForIdleMs;
    const waitMode = waitForIdleMs !== undefined;
    let waitEvidence: Pick<SendResult, "activity" | "waitedMs" | "attempts"> = {};

    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux transport is unavailable for this target.`,
      };
    }

    if (waitForIdleMs !== undefined) {
      if (opts?.force) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "--wait-for-idle cannot be combined with force. No text was sent.",
          sent: false,
        };
      }
      if (!Number.isFinite(waitForIdleMs) || waitForIdleMs <= 0) {
        return {
          ok: false,
          sessionName,
          reason: "invalid_wait_for_idle",
          error: "waitForIdleMs must be a positive number. No text was sent.",
          sent: false,
        };
      }
    }

    // 1. Check session exists / tmux available
    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    if (waitForIdleMs !== undefined) {
      const waitResult = await this.waitForIdle({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
        timeoutMs: waitForIdleMs,
      });
      waitEvidence = {
        activity: waitResult.activity,
        waitedMs: waitResult.waitedMs,
        attempts: waitResult.attempts,
      };
      if (!waitResult.ok) {
        return {
          ok: false,
          sessionName,
          reason: waitResult.reason,
          error: waitResult.error,
          sent: false,
          ...waitEvidence,
        };
      }
    }

    // 2. OPR.0.4.1.10 — robust prompt/permission + mid-work guard on the DEFAULT path.
    // Runs the same detector previously reachable only via --wait-for-idle: fresh runtime-hook primary
    // (within the send-readiness window) + hardened capture-pane fallback. This closes the rig-send
    // prompt-injection footgun — a message can never select/submit/approve another agent's prompt by
    // default. OPR.0.4.3.28 correction + fast-follow: only POSITIVE picker/approval evidence
    // (needs_input) FAILS CLOSED (refuse, or an audited --dangerously-interact override). Every other
    // state now PROCEEDS with a non-blocking advisory: UNKNOWN (absent/stale/failed telemetry) and
    // RUNNING (mid-work, busy) both send-and-advise — busy/uncertain is not authority to block
    // communication. --force is a no-op on this path now (kept for back-compat) and never bypasses
    // the positive-picker guard (FR-4 — the footgun separation). The advisory is carried on the
    // success result via `warning` so the honest telemetry is surfaced.
    let sendAdvisory: string | undefined;
    if (waitForIdleMs === undefined) {
      const readiness = await this.classifySendReadiness({
        sessionName,
        runtime,
        attachmentType: sessionMeta.attachmentType,
      });

      // Single state dispatch (B1 code-review fix): flattened so `unknown` ALWAYS attaches the advisory
      // regardless of whether --dangerously-interact was passed — the deliberate-override branch no
      // longer bypasses unknown handling.
      if (readiness.state === "needs_input") {
        // The POSITIVE picker/approval footgun. --dangerously-interact is the deliberate audited
        // override (reason required + an auditable record persisted BEFORE the send; fail closed if it
        // cannot be audited so an unauditable override never sends). Otherwise refuse with the
        // proceed-path. This is the ONLY state --dangerously-interact bypasses.
        if (opts?.dangerouslyInteract) {
          if (!opts.reason || opts.reason.trim().length === 0) {
            return {
              ok: false,
              sessionName,
              reason: "dangerously_interact_requires_reason",
              error: "--dangerously-interact requires --reason explaining why the prompt is being driven. No text was sent.",
            };
          }
          const audit = this.recordPromptOverride({
            sessionName,
            readiness,
            actorSession: opts.actorSession ?? null,
            overrideReason: opts.reason,
          });
          if (!audit.ok) {
            return {
              ok: false,
              sessionName,
              reason: "prompt_override_audit_unavailable",
              activity: readiness,
              error: `Refused: --dangerously-interact requires an auditable override record, which could not be persisted (${audit.reason}). No text was sent.`,
            };
          }
          // audited → proceed to the send.
        } else {
          return {
            ok: false,
            sessionName,
            reason: "target_needs_input",
            activity: readiness,
            error: `Refused: '${sessionName}' is at an interactive prompt (${readiness.reason}). A message must not select or approve it. To deliberately drive the prompt: rig send ${sessionName} "<text>" --dangerously-interact --reason "<why>". No text was sent.`,
          };
        }
      } else if (readiness.state === "unknown") {
        // OPR.0.4.3.28 correction — INVERT the fail-closed-on-unknown default. Absent/stale/failed
        // telemetry is NOT positive picker evidence, so the send PROCEEDS. Diagnose the producer link
        // and carry it as a NON-blocking advisory (`warning` on the success result) — ALWAYS, whether
        // or not --dangerously-interact was passed (B1 code-review fix) — so the honest telemetry is
        // surfaced without ever blocking communication. Hooks are advisory telemetry, not authority
        // over whether agents can talk.
        const linkDiagnosis = await this.diagnoseProducerLink(sessionName);
        sendAdvisory = `producer-link: ${linkDiagnosis} — activity could not be determined (${readiness.reason}); sent anyway (telemetry is advisory).`;
        // fall through to the send below.
      } else if (readiness.state === "running") {
        // OPR.0.4.3.28 fast-follow (advisor audit-catch, pm-ruled a founder-principle residual):
        // busy is NOT a block. Downgrade the old mid_work HARD REFUSE to a non-blocking advisory —
        // attach it on the success result + PROCEED (mirrors the unknown inversion). --force is now a
        // no-op here (the option is kept for back-compat). needs_input (positive picker) remains the
        // ONLY hard refuse; unknown/stale/missing already proceed-with-advisory above.
        sendAdvisory = `target pane appears mid-task; sent anyway (busy is advisory, not a block).`;
        // fall through to the send below.
      }
      // idle (or running/unknown — now advisory-and-proceed) → proceed to send.
    }

    if (opts?.verify) {
      try {
        preVerifyContent = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
      } catch {
        preVerifyContent = null;
      }
    }

    // 3. Send text (paste)
    const textResult = await this.tmuxAdapter.sendText(sessionName, text);
    if (!textResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "send_failed",
        outcome: "failed",
        error: `Failed to send text to '${sessionName}': ${textResult.message}`,
        ...(waitMode ? { sent: false, ...waitEvidence } : {}),
      };
    }

    // 4. Wait 200ms (spike-proven delay)
    await this.sleep(200);

    // 5. Submit (C-m)
    const submitResult = await this.tmuxAdapter.sendKeys(sessionName, ["C-m"]);
    if (!submitResult.ok) {
      return {
        ok: false,
        sessionName,
        reason: "submit_failed",
        outcome: "failed",
        error: `Text is visible in '${sessionName}' but was not submitted (Enter failed). The agent may need manual attention.`,
        ...(waitMode ? { sent: true, ...waitEvidence } : {}),
      };
    }

    // 6. Verify if requested. At this point text + Enter BOTH succeeded, so the
    // message LANDED; the capture only re-confirms the render. Not re-confirming
    // (a TUI redraw race, or the capture throwing) is therefore the honest
    // middle outcome `rendered-unconfirmed` — never a failure (OPR.99.0.6.3).
    if (opts?.verify) {
      await this.sleep(500);
      try {
        const content = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return { ok: true, sessionName, verified, outcome: verified ? "delivered" : "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      } catch {
        return { ok: true, sessionName, verified: false, outcome: "rendered-unconfirmed", ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      }
    }

    return { ok: true, sessionName, ...(sendAdvisory ? { warning: sendAdvisory } : {}), ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
  }

  private async waitForIdle(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
    timeoutMs: number;
  }): Promise<
    | { ok: true; activity: AgentActivity; waitedMs: number; attempts: number }
    | { ok: false; reason: string; error: string; activity: AgentActivity; waitedMs: number; attempts: number }
  > {
    const startedAt = Date.now();
    let attempts = 0;

    while (true) {
      attempts++;
      const activity = await this.classifySendReadiness(input);
      const waitedMs = Date.now() - startedAt;

      if (activity.state === "idle") {
        return { ok: true, activity, waitedMs, attempts };
      }

      if (activity.state === "needs_input") {
        return {
          ok: false,
          reason: "target_needs_input",
          error: `Target requires attention (${activity.reason}). No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      if (activity.state === "unknown") {
        return {
          ok: false,
          reason: "target_activity_unknown",
          error: `Target activity could not be determined (${activity.reason}). No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      if (waitedMs >= input.timeoutMs) {
        return {
          ok: false,
          reason: "wait_for_idle_timeout",
          error: `Target remained busy for ${waitedMs}ms. No text was sent.`,
          activity,
          waitedMs,
          attempts,
        };
      }

      const remainingMs = input.timeoutMs - waitedMs;
      await this.sleep(Math.min(this.waitForIdlePollMs, Math.max(1, remainingMs)));
    }
  }

  private async classifySendReadiness(input: {
    sessionName: string;
    runtime: string | null;
    attachmentType: string | null;
  }): Promise<AgentActivity> {
    const now = this.now();
    const hookActivity = this.agentActivityStore?.getLatestForNode({
      sessionName: input.sessionName,
      now,
    });
    // Use the fresh runtime-hook as the authoritative signal ONLY within the tight send-readiness
    // window. Beyond it (but still inside the looser display freshness) the hook is too old to prove
    // "safe to send now" — fall through to the real-time capture-pane probe (also Codex's sole guard).
    if (
      hookActivity &&
      hookActivity.evidenceSource === "runtime_hook" &&
      hookActivity.stale !== true
    ) {
      // Fresh hook (within the 15s send window): authoritative for any state.
      if (this.hookFreshForSend(hookActivity, now)) {
        return hookActivity;
      }
      // OPR.0.4.3.28 Part A — a stale-but-latest `idle` hook (older than the 15s
      // send window but still within the 5-min store window, so stale!==true) is
      // SENDABLE. getLatestForNode returns the single newest event by seq, so a
      // latest hook still `idle` proves no newer activity exists (had the seat
      // started work, the latest hook would be UserPromptSubmit/PermissionRequest).
      // A stale NON-idle hook (running/needs_input >15s) still falls through to
      // the pane probe below. No 15s widen; scoped to stale!==true so a
      // truly-abandoned seat (>5min) still degrades to the probe.
      if (hookActivity.state === "idle") {
        // Guard code-review 2026-07-02 (Blocker 1): a NARROW real-time veto
        // before trusting the stale-idle hook — never paste+Enter onto a VISIBLE
        // picker/permission prompt. Only a POSITIVE needs_input from the pane
        // vetoes (→ refuse); an unknown pane (the flaky-Codex case this trust
        // exists for) or a clean idle pane does NOT veto → trust the stale hook.
        const paneVeto = await probeSessionActivity({
          sessionName: input.sessionName,
          runtime: input.runtime,
          attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
          tmuxAdapter: this.tmuxAdapter,
          now,
        });
        if (paneVeto.state === "needs_input") {
          return paneVeto;
        }
        return hookActivity;
      }
    }

    return probeSessionActivity({
      sessionName: input.sessionName,
      runtime: input.runtime,
      attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
      tmuxAdapter: this.tmuxAdapter,
      now,
    });
  }

  // OPR.0.4.1.10 — a runtime-hook is authoritative for send-readiness only within the tight send
  // window. No usable hook timestamp → not send-fresh (fall through to real-time capture).
  private hookFreshForSend(activity: AgentActivity, now: Date): boolean {
    const eventMs = activity.eventAt ? Date.parse(activity.eventAt) : NaN;
    if (!Number.isFinite(eventMs)) return false;
    return now.getTime() - eventMs <= this.sendReadinessFreshnessMs;
  }

  // OPR.0.4.3.28 Part C — producer-link diagnostic. When a send fails closed on
  // `unknown` (no usable activity signal), name WHICH link in the hook→activity
  // producer chain is broken + the next step, instead of an opaque
  // `no_activity_signal`. NEVER surfaces a token value — env checks are
  // presence-only, and the store carries no token.
  private async diagnoseProducerLink(sessionName: string): Promise<string> {
    // Link 1 — the SEAT ENV: can the relay even reach the daemon?
    let hasUrl: boolean | null = null;
    let hasToken: boolean | null = null;
    if (typeof this.tmuxAdapter?.hasSessionEnv === "function") {
      try {
        hasUrl = await this.tmuxAdapter.hasSessionEnv(sessionName, "OPENRIG_URL");
        hasToken = await this.tmuxAdapter.hasSessionEnv(sessionName, "OPENRIG_ACTIVITY_HOOK_TOKEN");
      } catch { /* best-effort — fall through to the store evidence below */ }
    }
    if (hasUrl === false || hasToken === false) {
      return `seat-env link DOWN — OPENRIG_URL ${hasUrl ? "present" : "MISSING"}, OPENRIG_ACTIVITY_HOOK_TOKEN ${hasToken ? "present" : "MISSING"}; the activity relay cannot reach the daemon. Relaunch the seat, or (for a reconciled/restored seat) ensure the daemon's activity-endpoint.json is discoverable`;
    }

    // Link 2 — the DAEMON INGEST + store: did any hook actually land, and how stale?
    const store = this.agentActivityStore;
    if (!store) {
      return `daemon-ingest link DOWN — the activity store is not configured on this daemon (ingest returns 503)`;
    }
    const latest = store.getLatestForNode({ sessionName, now: this.now() });
    if (!latest || latest.evidenceSource !== "runtime_hook") {
      return `daemon-ingest link DOWN — no activity hook has ever been received for this seat; the ingest is rejecting posts (token mismatch → 401, or ingest unconfigured → 503) or Codex hook-trust is uncleared. Verify the seat was OpenRig-launched with hook-trust cleared`;
    }
    if (latest.stale === true) {
      const ageS = latest.eventAt ? Math.round((this.now().getTime() - Date.parse(latest.eventAt)) / 1000) : null;
      return `producer link OK but STALE — the last activity hook arrived ${ageS !== null ? `${ageS}s ago` : "long ago"} (beyond the store window); the seat has gone quiet or its hooks stopped firing`;
    }
    return `a recent activity hook exists but the live pane probe could not confirm idle (possible identity mismatch between the seat env, the DB, and the stored payload)`;
  }

  // OPR.0.4.1.10 — persist the audit record for a --dangerously-interact prompt override. Audit-all-
  // or-nothing: if there is no eventBus, the target rig/node can't be resolved, or the event cannot be
  // persisted, return !ok so the caller fails closed and does NOT send. Payload keeps the caller's
  // overrideReason distinct from the classifier's detectedReason/evidenceSource (not overloaded).
  private recordPromptOverride(input: {
    sessionName: string;
    readiness: AgentActivity;
    actorSession: string | null;
    overrideReason: string | null;
  }): { ok: true } | { ok: false; reason: string } {
    if (!this.eventBus) return { ok: false, reason: "audit_unconfigured" };
    const resolved = this.agentActivityStore?.resolveSession({ sessionName: input.sessionName });
    if (!resolved) return { ok: false, reason: "session_unresolved" };
    try {
      this.eventBus.emit({
        type: "transport.prompt_override",
        rigId: resolved.rigId,
        nodeId: resolved.nodeId,
        sessionName: resolved.sessionName,
        actorSession: input.actorSession,
        detectedState: input.readiness.state,
        detectedReason: input.readiness.reason,
        evidenceSource: input.readiness.evidenceSource,
        overrideReason: input.overrideReason,
      });
      return { ok: true };
    } catch {
      return { ok: false, reason: "audit_persist_failed" };
    }
  }

  async capture(sessionName: string, opts?: { lines?: number }): Promise<CaptureResult> {
    const sessionMeta = this.getSessionMeta(sessionName);
    if (sessionMeta.attachmentType === "external_cli") {
      return {
        ok: false,
        sessionName,
        reason: "transport_unavailable",
        error: `Session '${sessionName}' is attached as an external CLI node. Inbound tmux capture is unavailable for this target.`,
      };
    }

    try {
      const exists = await this.tmuxAdapter.hasSession(sessionName);
      if (!exists) {
        return {
          ok: false,
          sessionName,
          reason: "session_missing",
          error: `Session '${sessionName}' not found. Check available sessions with: rig ps --nodes`,
        };
      }
    } catch {
      return {
        ok: false,
        sessionName,
        reason: "tmux_unavailable",
        error: "tmux is not available. Ensure tmux is installed and a server is running.",
      };
    }

    const lines = opts?.lines ?? 20;
    const content = await this.tmuxAdapter.capturePaneContent(sessionName, lines);
    if (content === null) {
      return {
        ok: false,
        sessionName,
        reason: "capture_failed",
        error: `Could not capture pane content for '${sessionName}'.`,
      };
    }

    return { ok: true, sessionName, content, lines };
  }

  async broadcast(target: TargetSpec, text: string, opts?: BroadcastOpts): Promise<BroadcastResult> {
    const resolved = await this.resolveSessions(target);
    if (!resolved.ok) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        results: [{
          ok: false,
          sessionName: "",
          reason: resolved.code,
          error: resolved.error,
        }],
      };
    }

    const results: SendResult[] = [];
    for (const session of resolved.sessions) {
      // OPR.0.4.3.30 — per-recipient From/To envelope for `rig send` fan-out: each recipient
      // gets its OWN `To:` header rendered daemon-side (the CLI can't wrap per recipient because
      // it doesn't know each resolved seat). When envelopeSender is absent (`rig broadcast`,
      // --raw, --dangerously-interact) the text is delivered raw, exactly as before.
      const perRecipientText = opts?.envelopeSender
        ? wrapPaneEnvelope(opts.envelopeSender, session.sessionName, text)
        : text;
      const result = await this.send(session.sessionName, perRecipientText, opts);
      results.push(result);
    }

    return {
      total: results.length,
      sent: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}
