import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { AgentActivityStore } from "./agent-activity-store.js";
import type { AgentActivity } from "./types.js";

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
  const trailingNonBlank = lastNonBlank.slice(-3);
  const lastLine = lastNonBlank.at(-1) ?? "";
  const idlePromptLine = trailingNonBlank.find((line) =>
    IDLE_PROMPT_PATTERNS.some((pattern) => pattern.test(line))
  );
  const idleStatusBarLine = IDLE_STATUS_BAR_PATTERNS.some((pattern) => pattern.test(lastLine))
    ? lastLine
    : null;
  const selectionPromptEvidence = findPatternEvidence(recentLines, [/^[❯›]\s*\d+\.\s/m]);
  if (selectionPromptEvidence) {
    return {
      state: "attention",
      reason: "selection_prompt",
      evidence: selectionPromptEvidence,
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

function looksLikeMidWork(paneContent: string): boolean {
  const activity = classifyPaneActivity(paneContent);
  return activity.state === "agent_active" || activity.state === "attention";
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
}

export interface SendResult {
  ok: boolean;
  sessionName: string;
  verified?: boolean;
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
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  waitForIdlePollMs?: number;
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
  private now: () => Date;
  private sleep: (ms: number) => Promise<void>;
  private waitForIdlePollMs: number;

  constructor(deps: SessionTransportDeps) {
    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.agentActivityStore = deps.agentActivityStore;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? delay;
    this.waitForIdlePollMs = deps.waitForIdlePollMs ?? 500;
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

    // 2. Legacy mid-work check (unless force or explicit wait mode already proved idle)
    if (!opts?.force && waitForIdleMs === undefined) {
      try {
        if (runtime === "terminal") {
          const paneCommand = await this.tmuxAdapter.getPaneCommand(sessionName);
          if (paneCommand && !IDLE_TERMINAL_COMMANDS.has(paneCommand)) {
            return {
              ok: false,
              sessionName,
              reason: "mid_work",
              error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
            };
          }
        }
        const paneContent = await this.tmuxAdapter.capturePaneContent(sessionName, 20);
        if (paneContent && looksLikeMidWork(paneContent)) {
          return {
            ok: false,
            sessionName,
            reason: "mid_work",
            error: `Target pane appears mid-task. Use force: true to send anyway, or wait for the task to settle.`,
          };
        }
      } catch {
        // Can't check — proceed anyway
      }
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
        error: `Text is visible in '${sessionName}' but was not submitted (Enter failed). The agent may need manual attention.`,
        ...(waitMode ? { sent: true, ...waitEvidence } : {}),
      };
    }

    // 6. Verify if requested
    if (opts?.verify) {
      await this.sleep(500);
      try {
        const content = await this.tmuxAdapter.capturePaneContent(sessionName, 30);
        const snippet = text.substring(0, Math.min(text.length, 40));
        const preCount = countOccurrences(preVerifyContent ?? "", snippet);
        const postCount = countOccurrences(content ?? "", snippet);
        const verified = postCount > preCount;
        return { ok: true, sessionName, verified, ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      } catch {
        return { ok: true, sessionName, verified: false, ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
      }
    }

    return { ok: true, sessionName, ...(waitMode ? { sent: true, ...waitEvidence } : {}) };
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
    if (hookActivity && hookActivity.evidenceSource === "runtime_hook" && hookActivity.stale !== true) {
      return hookActivity;
    }

    return probeSessionActivity({
      sessionName: input.sessionName,
      runtime: input.runtime,
      attachmentType: input.attachmentType as "tmux" | "external_cli" | null | undefined,
      tmuxAdapter: this.tmuxAdapter,
      now,
    });
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

  async broadcast(target: TargetSpec, text: string, opts?: SendOpts): Promise<BroadcastResult> {
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
      const result = await this.send(session.sessionName, text, opts);
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
