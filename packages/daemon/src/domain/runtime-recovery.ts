import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ClaudeResumeRotation, NativeProcessLister } from "./native-process-lineage.js";
import type { NativeResumeProbeEvidence } from "./native-resume-probe-evidence.js";

export type RunnerRecoveryFailureCode = "runner_missing" | "runner_identity_mismatch"
  | "runner_state_unavailable" | "runner_session_mismatch" | "runner_rpc_unavailable" | "runner_identity_unconfirmed";

export interface RecoveryEvidence {
  tmux: boolean;
  fgProcess: string;
  resumeTokenUsed: boolean;
  paneState: "usable";
  runner?: { pid: number; childPid: number; launchId: string; rpcConfirmed: true; identityConfirmed: true };
}

export interface RecoveryVerificationInput {
  db: Database.Database;
  sessionRegistry: SessionRegistry;
  tmux: TmuxAdapter;
  nodeId: string;
  sessionName: string;
  expectedResumeToken: string;
  resumeType: string | null;
  rotation: ClaudeResumeRotation | null;
  listProcesses?: NativeProcessLister;
  assertCurrent: () => boolean;
}

export type RecoveryVerificationResult = { ok: true; evidence: RecoveryEvidence } | {
  ok: false;
  code: RunnerRecoveryFailureCode | "process_lineage_mismatch" | "fg_process_not_runtime" | "pane_not_usable";
  detail: string;
  probe?: NativeResumeProbeEvidence;
};
