import { basename } from "node:path";
import { listNativeProcesses, type NativeProcessRow } from "../domain/native-process-lineage.js";
import { readNativeProcessArguments } from "../domain/native-process-arguments.js";
import { observeSolePane } from "../domain/pane-binding-observation.js";
import { SeatIdentityStore } from "../domain/seat-identity-store.js";
import type { RecoveryVerificationInput, RecoveryVerificationResult, RunnerRecoveryFailureCode } from "../domain/runtime-recovery.js";
import { probePiRecovery } from "./pi-recovery-rpc.js";
import type { PiRunnerState, RunnerRuntime } from "./pi-runner-protocol.js";

/** Recovery trusts a sidecar only after binding it to the live runner, its child and a fresh RPC/daemon exchange. */
export async function verifyPiRecovery(input: RecoveryVerificationInput, adapter: {
  runtime: RunnerRuntime;
  stateRoot: string;
  entryPath: string;
  readState: () => PiRunnerState | null;
}): Promise<RecoveryVerificationResult> {
  const fail = (code: RunnerRecoveryFailureCode, detail: string) => ({ ok: false as const, code, detail });
  const state = adapter.readState();
  if (!state?.ready || state.exited || !state.launchId || !state.recovery) {
    return fail("runner_state_unavailable", "No ready runner with a recovery endpoint is recorded. Older runners need a managed relaunch before they can prove recovery.");
  }
  if (state.sessionFile !== input.expectedResumeToken || input.resumeType !== `${adapter.runtime}_session_file`) {
    return fail("runner_session_mismatch", "The runner sidecar does not match the seat's stored resume type and session file.");
  }
  const { pid, childPid, port } = state.recovery;
  if (![pid, childPid, port].every((value) => Number.isSafeInteger(value) && value > 0) || port > 65535) {
    return fail("runner_state_unavailable", "The runner recovery endpoint is malformed.");
  }
  const pane = await observeSolePane(input.tmux, input.sessionName);
  if (!pane.ok) return fail("runner_missing", pane.detail);
  const panePid = await input.tmux.getPanePid(pane.pane);
  if (!panePid) return fail("runner_missing", "The seat's pane has no live process.");

  const observe = async () => {
    const rows = await (input.listProcesses ?? listNativeProcesses)();
    const runner = rows.find((row) => row.pid === pid);
    const child = rows.find((row) => row.pid === childPid);
    if (!runner || !child) return fail("runner_missing", "The recorded runner or its RPC child is no longer running.");
    // Follow parent IDs rather than command substrings: a sibling runner is never this pane's occupant.
    const seen = new Set<number>();
    let ancestor: NativeProcessRow | undefined = runner;
    while (ancestor && ancestor.pid !== panePid && !seen.has(ancestor.pid)) {
      seen.add(ancestor.pid);
      ancestor = rows.find((row) => row.pid === ancestor!.ppid);
    }
    if (ancestor?.pid !== panePid || child.ppid !== runner.pid || !runner.startedAt || !child.startedAt
      || !runner.pgid || runner.pgid !== runner.tpgid) return fail("runner_identity_mismatch", "The pane does not own the recorded foreground runner and its RPC child.");
    const argv = runner.argv ?? (input.listProcesses ? null : (await readNativeProcessArguments([pid])).get(pid));
    if (!argv || basename(argv[0] ?? "") !== "node" || argv[1] !== adapter.entryPath) return fail("runner_identity_mismatch", "The recorded process is not this adapter's runner.");
    const value = (flag: string) => argv.filter((arg) => arg === flag).length === 1 ? argv[argv.indexOf(flag) + 1] : undefined;
    if (value("--session-name") !== input.sessionName || value("--state-root") !== adapter.stateRoot
      || value("--launch-id") !== state.launchId
      || (adapter.runtime === "omp" ? value("--runtime") !== "omp" : argv.includes("--runtime"))) return fail("runner_identity_mismatch", "The runner's launch arguments do not identify this seat and runtime.");
    return { ok: true as const, runner: { ...runner }, child: { ...child } };
  };
  const before = await observe();
  if (!before.ok) return before;
  const reply = await probePiRecovery(port, state.launchId, input.expectedResumeToken);
  if (!reply.ok) return reply;
  // Re-read after every asynchronous proof: a recovered predecessor cannot clear its replacement's attention.
  const after = await observe();
  const currentPane = await observeSolePane(input.tmux, input.sessionName);
  const currentPanePid = currentPane.ok ? await input.tmux.getPanePid(currentPane.pane) : null;
  const current = adapter.readState();
  if (!after.ok || after.runner.startedAt !== before.runner.startedAt || after.child.startedAt !== before.child.startedAt
    || after.runner.command !== before.runner.command || after.child.command !== before.child.command || !currentPane.ok || currentPane.pane !== pane.pane
    || currentPanePid !== panePid || !input.assertCurrent()
    || !current?.ready || current.exited || current.launchId !== state.launchId || current.sessionFile !== input.expectedResumeToken
    || current.recovery?.pid !== pid || current.recovery.childPid !== childPid || current.recovery.port !== port) {
    return fail("runner_identity_mismatch", "The pane, runner or session changed during recovery verification.");
  }
  input.sessionRegistry.updateBinding(input.nodeId, { tmuxSession: input.sessionName, tmuxPane: pane.pane });
  new SeatIdentityStore(input.db).upsert({
    nodeId: input.nodeId, verdict: "verified", evidenceSource: "pane_process", reason: null,
    evidence: { registeredPane: pane.pane, observedPid: pid, observedPanePid: panePid, observedCommand: after.runner.command, matchedLayer: 1 },
    sessionName: input.sessionName, observedAt: new Date().toISOString(),
  });
  return { ok: true, evidence: {
    tmux: true, fgProcess: adapter.runtime, resumeTokenUsed: true, paneState: "usable",
    runner: { pid, childPid, launchId: state.launchId, rpcConfirmed: true, identityConfirmed: true },
  } };
}
