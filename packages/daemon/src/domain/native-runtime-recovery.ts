import { rebindAndVerifyPaneIdentity } from "./seat-attention-reconciler.js";
import { assessNativeResumeProbe } from "./native-resume-probe.js";
import { resumeProbeEvidence } from "./native-resume-probe-evidence.js";
import { verifyClaudePaneProcess, verifyPaneIdleShell } from "./native-process-lineage.js";
import type { RecoveryVerificationInput, RecoveryVerificationResult } from "./runtime-recovery.js";

/** Claude/Codex's existing no-input recovery proof, shared by their adapters and older callers. */
export async function verifyNativeRecovery(input: RecoveryVerificationInput, runtime: string | null): Promise<RecoveryVerificationResult> {
  const { nodeId, sessionName, expectedResumeToken, rotation } = input;
  // One exact-lineage check per process, accepting the stored token or the recorded rotation.
  const identity = await rebindAndVerifyPaneIdentity({
    db: input.db,
    sessionRegistry: input.sessionRegistry,
    tmux: input.tmux,
    nodeId,
    sessionName,
    runtime,
    expectedResumeToken,
    requireExactResumeLineage: true,
    resumeRotation: rotation,
    ...(input.listProcesses ? { listProcesses: input.listProcesses } : {}),
    assertCurrent: input.assertCurrent,
  });
  if (!identity.ok) {
    return { ok: false, code: "process_lineage_mismatch", detail: identity.detail };
  }
  const paneCommand = await input.tmux.getPaneCommand(identity.pane);
  const paneContent = (await input.tmux.capturePaneContent(identity.pane, 40)) ?? "";
  const claudeResumeIdentityVerified = runtime === "claude-code" && !!await verifyClaudePaneProcess({
    target: identity.pane,
    tmux: input.tmux,
    expectedToken: expectedResumeToken,
    rotation,
    requireResume: true,
    ...(input.listProcesses ? { listProcesses: input.listProcesses } : {}),
  });
  const probe = assessNativeResumeProbe({
    runtime,
    paneCommand,
    paneContent,
    // Headerless readiness requires the same stable foreground/argv proof
    // as the resume adapter; a token-bearing descendant alone is insufficient.
    ...(runtime === "claude-code" ? { claudeResumeIdentityVerified } : {}),
    ...(runtime === "codex" ? { codexProcessVerified: true } : {}),
  });
  const fgProcess = runtime === "claude-code" ? "claude" as const : runtime === "codex" ? "codex" as const : null;
  if (!fgProcess) {
    return { ok: false, code: "fg_process_not_runtime", detail: `Node runtime is ${runtime ?? "unknown"}, not claude/codex.` };
  }

  // Precondition #4: pane is at a usable/idle state — explicitly NOT a
  // resume-selection prompt and not the "returned to shell" failure mode.
  if (probe.status !== "resumed") {
    const probeEvidence = await resumeProbeEvidence(probe, paneContent, input.tmux, identity.pane);
    // The label reads as a shell, but the runtime's lineage was just proven in this pane: name a shell only for a proven idle one.
    if (probe.code === "returned_to_shell" && !await verifyPaneIdleShell({ target: identity.pane, tmux: input.tmux,
      ...(input.listProcesses ? { listProcesses: input.listProcesses } : {}) })) {
      return { ok: false, code: "pane_not_usable", probe: probeEvidence, detail: "Pane is not shown to be resumed: its command reads as a shell, but it is not a proven idle shell (the runtime may be starting or showing a dialog); reconciliation requires resumed." };
    }
    return { ok: false, code: "pane_not_usable", probe: probeEvidence, detail: `Pane state is ${probe.status} (${probe.code}); reconciliation requires resumed.` };
  }

  return { ok: true, evidence: { tmux: true, fgProcess, resumeTokenUsed: true, paneState: "usable" } };
}
