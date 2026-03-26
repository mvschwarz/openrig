/** Runtime hint from fingerprinting */
export type RuntimeHint = "claude-code" | "codex" | "terminal" | "unknown";

/** Confidence level of the runtime detection */
export type Confidence = "highest" | "high" | "medium" | "low";

/** Discovery session lifecycle status */
export type DiscoveryStatus = "active" | "vanished" | "claimed";

/** Origin of a managed session */
export type SessionOrigin = "launched" | "claimed";

/** A discovered (unmanaged) tmux session */
export interface DiscoveredSession {
  id: string;
  tmuxSession: string;
  tmuxWindow: string | null;
  tmuxPane: string | null;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidenceJson: string | null;
  configJson: string | null;
  status: DiscoveryStatus;
  claimedNodeId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}
