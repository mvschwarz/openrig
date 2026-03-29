import type { CmuxAdapter } from "../adapters/cmux.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ScannedPane } from "./tmux-discovery-scanner.js";
import type { RuntimeHint, Confidence } from "./discovery-types.js";

/** Evidence collected during fingerprinting */
export interface FingerprintEvidence {
  layerUsed: number;
  cmuxSignal?: { runtime: string; pid: number };
  processSignal?: { command: string; matched: string };
  paneContentSignal?: { pattern: string; matchedLine: string };
  configSignal?: { claudeDir: boolean; agentsDir: boolean };
}

/** Result of fingerprinting a single pane */
export interface FingerprintResult {
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidence: FingerprintEvidence;
}

const SHELL_NAMES = new Set(["bash", "zsh", "fish", "sh", "dash", "tcsh", "csh"]);

const CLAUDE_PROCESS_PATTERNS = ["claude", "claude-code"];
const CODEX_PROCESS_PATTERNS = ["codex"];

const CLAUDE_PANE_PATTERNS = [
  { label: "Claude Code", test: (line: string) => /^\s*Claude Code\b/i.test(line) },
  { label: "claude>", test: (line: string) => /^\s*claude>\s*/i.test(line) },
  { label: "╭─ Claude", test: (line: string) => /^\s*╭─ Claude\b/i.test(line) },
];

const CODEX_PANE_PATTERNS = [
  { label: "Codex CLI", test: (line: string) => /^\s*Codex CLI\b/i.test(line) },
  { label: "codex>", test: (line: string) => /^\s*codex>\s*/i.test(line) },
  { label: "╭─ Codex", test: (line: string) => /^\s*╭─ Codex\b/i.test(line) },
];

/**
 * Four-layer runtime detection pipeline.
 * Layer 0: cmux agent PID (highest confidence)
 * Layer 1: Process tree / active command (high)
 * Layer 2: Pane content heuristics (medium)
 * Layer 3: CWD/config context (low-medium, boost only)
 */
export class SessionFingerprinter {
  private cmux: CmuxAdapter;
  private tmux: TmuxAdapter;
  private fsExists: (path: string) => boolean;
  private cachedAgentPIDs: Map<number, { runtime: string; pid: number }> | null = null;

  constructor(deps: { cmuxAdapter: CmuxAdapter; tmuxAdapter: TmuxAdapter; fsExists: (path: string) => boolean }) {
    this.cmux = deps.cmuxAdapter;
    this.tmux = deps.tmuxAdapter;
    this.fsExists = deps.fsExists;
  }

  /** Pre-fetch cmux agent PIDs for batch use. Call before fingerprinting multiple panes. */
  async refreshCmuxSignals(): Promise<void> {
    const result = await this.cmux.queryAgentPIDs();
    this.cachedAgentPIDs = result.ok ? result.data : null;
  }

  /** Fingerprint a single scanned pane. */
  async fingerprint(pane: ScannedPane): Promise<FingerprintResult> {
    const evidence: FingerprintEvidence = { layerUsed: -1 };

    // --- Layer 0: cmux agent PID ---
    if (this.cachedAgentPIDs === null) {
      await this.refreshCmuxSignals();
    }

    if (this.cachedAgentPIDs && pane.pid) {
      const cmuxMatch = this.cachedAgentPIDs.get(pane.pid);
      if (cmuxMatch) {
        evidence.layerUsed = 0;
        evidence.cmuxSignal = cmuxMatch;
        const hint = cmuxMatch.runtime.includes("claude") ? "claude-code" as RuntimeHint
          : cmuxMatch.runtime.includes("codex") ? "codex" as RuntimeHint
          : "unknown" as RuntimeHint;
        return { runtimeHint: hint, confidence: "highest", evidence };
      }
    }

    // --- Layer 1: Process tree / active command ---
    if (pane.activeCommand) {
      const cmd = pane.activeCommand.toLowerCase();

      for (const pattern of CLAUDE_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "claude-code", confidence: "high", evidence };
        }
      }

      for (const pattern of CODEX_PROCESS_PATTERNS) {
        if (cmd.includes(pattern)) {
          evidence.layerUsed = 1;
          evidence.processSignal = { command: pane.activeCommand, matched: pattern };
          return { runtimeHint: "codex", confidence: "high", evidence };
        }
      }

      if (SHELL_NAMES.has(cmd)) {
        evidence.layerUsed = 1;
        evidence.processSignal = { command: pane.activeCommand, matched: "shell" };
        return { runtimeHint: "terminal", confidence: "high", evidence };
      }
    }

    // --- Layer 2: Pane content heuristics ---
    const content = await this.tmux.capturePaneContent(pane.tmuxPane);
    if (content) {
      const lines = content.split("\n");

      for (const line of lines) {
        for (const pattern of CLAUDE_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "claude-code", confidence: "medium", evidence };
          }
        }

        for (const pattern of CODEX_PANE_PATTERNS) {
          if (pattern.test(line)) {
            evidence.layerUsed = 2;
            evidence.paneContentSignal = { pattern: pattern.label, matchedLine: line.trim() };
            return { runtimeHint: "codex", confidence: "medium", evidence };
          }
        }
      }
    }

    // --- Layer 3: CWD/config context (boost only) ---
    let configBoost: RuntimeHint = "unknown";
    if (pane.cwd) {
      const hasClaudeDir = this.fsExists(`${pane.cwd}/.claude`);
      const hasAgentsDir = this.fsExists(`${pane.cwd}/.agents`);
      evidence.configSignal = { claudeDir: hasClaudeDir, agentsDir: hasAgentsDir };

      if (hasClaudeDir && !hasAgentsDir) configBoost = "claude-code";
      else if (hasAgentsDir && !hasClaudeDir) configBoost = "codex";
    }

    if (configBoost !== "unknown") {
      evidence.layerUsed = 3;
      return { runtimeHint: configBoost, confidence: "low", evidence };
    }

    // --- No signal ---
    evidence.layerUsed = -1;
    return { runtimeHint: "unknown", confidence: "low", evidence };
  }
}
