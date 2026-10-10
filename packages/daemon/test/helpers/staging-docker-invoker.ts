// The COMMITTED real StagingDocker invoker (founder-ruled 2026-08-21, the engine-independent leg
// of the container-runner scoping — workspace/artifacts/qitem-20260821183159-9b5b5117/).
//
// WHY THIS EXISTS AS CODE AND NOT AS RUNBOOK PROSE: the L6 runbook's inline invoker
// (`const docker = (args) => execFile("docker", args, …)`) was authored 08-06 and never learned
// the stdinFrom tar-pipe contract added 08-07 (scenario-container-stage.ts:20-28) — execFile left
// the child a pipe stdin that was held open and never fed, so the in-container `tar -xf -` blocked
// on read(stdin) forever (row 42576855: child stuck 7+ minutes, parent alive, zero output). An
// invoker inlined in a document drifts behind the code contract with nothing to fail; a committed
// helper the runbook IMPORTS is covered by the contract's own tests.
//
// The contract implemented (StagingDocker, scenario-container-stage.ts):
// - no stdinFrom → plain spawn with stdin IGNORED (closed): a stdin-reading child terminates on
//   EOF instead of blocking — the hang class dies even on a misused step.
// - stdinFrom   → two processes: `tar <stdinFrom>` piped into `docker <argv>`'s stdin, EOF
//   propagated when the producer exits. BOTH exits checked — a shell pipeline reports only the
//   last command's status, so a failing tar into a succeeding exec would mask an empty stage
//   (the false-green class the fence exists to catch late; this catches it AT the step).
// - every step is bounded by a TIMEOUT that kills both processes and returns a NAMED failure —
//   the 08-12 hang was unbounded and ended only by operator judgement at seven minutes.
// - never rejects (mirrors runRig): every outcome is a DockerResult with a non-zero code on
//   failure and the cause in stderr.
//
// SCOPE: this proves the INVOKER, hermetically. It claims nothing about live containment — the
// real-engine proof (docker vs Apple container, whose exec-stdin semantics are untested for this
// pipe) explicitly waits on the 5.3 engine-substrate ruling.

import { spawn } from "node:child_process";
import type { StagingDocker } from "./scenario-container-stage.js";

export interface RealStagingDockerOptions {
  /** The engine binary (default "docker"). Tests substitute "sh" to stay hermetic. */
  command?: string;
  /** The tar-side binary for stdinFrom steps (default "tar"). */
  tarCommand?: string;
  /** Per-step bound. Default 120s — sized for a topology-dir extract, not a build. A step that
   *  outlives it is KILLED and reported as a named timeout, never left to hang. */
  stepTimeoutMs?: number;
}

const DEFAULT_STEP_TIMEOUT_MS = 120_000;

interface ProcExit {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
}

/** Build the real two-process invoker satisfying the StagingDocker contract. */
export function makeRealStagingDocker(opts: RealStagingDockerOptions = {}): StagingDocker {
  const command = opts.command ?? "docker";
  const tarCommand = opts.tarCommand ?? "tar";
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;

  return async (args: string[], stdinFrom?: string[]) => {
    const kills: Array<() => void> = [];
    const groups: number[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      for (const kill of kills) kill();
    }, stepTimeoutMs);

    try {
      // Consumer side. Without a producer its stdin is IGNORED (closed at spawn): a child that
      // reads stdin sees EOF immediately — the exact hole the inline invoker left open.
      const consumer = spawn(command, args, {
        stdio: [stdinFrom ? "pipe" : "ignore", "pipe", "pipe"],
        detached: OWN_SESSION,
      });
      trackGroup(consumer, groups);
      kills.push(() => killAndRelease(consumer));

      let producerDone: Promise<ProcExit> | null = null;
      let producerClosed = false;
      let producerKilledEarly = false;
      let killProducer: (() => void) | null = null;
      if (stdinFrom) {
        const producer = spawn(tarCommand, stdinFrom, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: OWN_SESSION,
        });
        trackGroup(producer, groups);
        killProducer = () => killAndRelease(producer);
        kills.push(killProducer);
        // EPIPE on the wiring (consumer exited early) must not crash the invoker — the producer's
        // own SIGPIPE death is the loud signal, reported through the dual-exit check below.
        consumer.stdin!.on("error", () => {});
        producer.stdout!.pipe(consumer.stdin!); // pipe() forwards EOF when the producer exits
        producerDone = waitExit(producer).then((exit) => { producerClosed = true; return exit; });
      }

      const consumerExit = await waitExit(consumer);
      // Consumer gone while the producer still runs: the producer's stdout now backs up against a
      // pipe nobody drains, so it would block FOREVER (measured — this invoker's own first cut
      // hung here). Kill it and report the anomaly: a consumer that exited before its feed
      // finished did not stage what the feed carried, whatever its exit code said.
      if (producerDone && !producerClosed) {
        producerKilledEarly = true;
        killProducer!();
      }
      const producerExit = producerDone ? await producerDone : null;
      clearTimeout(timer);

      if (timedOut) {
        return {
          stdout: consumerExit.stdout,
          stderr:
            `step timeout: killed after ${stepTimeoutMs}ms (${command} ${args[0] ?? ""}` +
            `${stdinFrom ? ` fed by ${tarCommand}` : ""}) — a stalled step is a NAMED failure, never a hang`,
          code: 124,
        };
      }

      // DUAL-EXIT: the consumer's failure wins the code; otherwise a producer failure (including
      // death by signal — SIGPIPE from an early-exiting consumer means content did NOT arrive)
      // fails the step and NAMES the tar side, whatever the consumer's exit said.
      if (consumerExit.code !== 0 || consumerExit.spawnError) {
        return {
          stdout: consumerExit.stdout,
          stderr: consumerExit.spawnError ?? consumerExit.stderr,
          code: consumerExit.code,
        };
      }
      if (producerKilledEarly) {
        return {
          stdout: consumerExit.stdout,
          stderr:
            `tar-side (stdinFrom) was still producing when the consumer exited (${command} exited ` +
            `${consumerExit.code} early) — producer killed; the stage did not receive the full feed`,
          code: 1,
        };
      }
      if (producerExit && (producerExit.code !== 0 || producerExit.spawnError)) {
        const cause = producerExit.spawnError
          ?? `exit ${producerExit.code}${producerExit.signal ? ` (signal ${producerExit.signal})` : ""}`;
        return {
          stdout: consumerExit.stdout,
          stderr:
            `tar-side (stdinFrom) failed: ${cause}${producerExit.stderr ? ` — ${producerExit.stderr.trim()}` : ""}` +
            ` — the consumer exited 0 but the stage cannot be trusted (masked-empty-stage class)`,
          code: producerExit.code !== 0 ? producerExit.code : 1,
        };
      }
      return { stdout: consumerExit.stdout, stderr: consumerExit.stderr, code: 0 };
    } finally {
      clearTimeout(timer);
      for (const pgid of groups) releaseGroup(pgid);
    }
  };
}

/** Each side is spawned `detached`, which on POSIX is setsid(): the child leads its own session
 *  (and process group), so a group kill reaches everything the step started, not just the direct
 *  child. The price: a signal sent to the PARENT's process group (a terminal's Ctrl-C, a closed
 *  terminal or dropped SSH session's SIGHUP, a supervisor's group SIGTERM) no longer reaches the
 *  steps. The live-group registry below pays it back: while any step runs, the parent SIGKILLs
 *  every live step group on process exit and on SIGINT, SIGTERM, SIGHUP and SIGQUIT.
 *
 *  Its handlers are PREPENDED, so they run before any handler the host registered, and a host
 *  `process.once(signal, graceful)` is still counted (a once-wrapper removes itself only when it
 *  runs). If the host listens, its handler decides what the parent does next; if nothing else
 *  listens, the signal is re-raised so the parent ends by that signal, as it would have.
 *
 *  Accepted costs: SIGKILL of the parent cannot be caught, so it still orphans a running step
 *  (the step's own timeout does not help then either). And the handlers are JavaScript: while a
 *  step runs, a Ctrl-C is acted on only when the parent's event loop gets to it, not at once. */
const OWN_SESSION = process.platform !== "win32";

/** Process groups of steps still in flight (pgid === leader pid, since each side is detached). */
const liveGroups = new Set<number>();
let parentHandlersInstalled = false;

function killLiveGroups(): void {
  for (const pgid of liveGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // ESRCH: that group is already gone.
    }
  }
}

function onParentExit(): void {
  killLiveGroups();
}

function onParentSignal(signal: NodeJS.Signals): void {
  killLiveGroups();
  liveGroups.clear();
  uninstallParentHandlers();
  // We run first (prepended), so every host listener, a pending once-wrapper included, is still
  // registered here and will receive this same signal: then the host decides what the parent
  // does. With no other listener, the default action (end by that signal) is what would have
  // happened without us, so re-raise it.
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
}

/** Parent signals whose default action ends the process and so would orphan a running step. */
const PARENT_SIGNALS: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];

function installParentHandlers(): void {
  if (parentHandlersInstalled) return;
  process.prependListener("exit", onParentExit);
  for (const signal of PARENT_SIGNALS) process.prependListener(signal, onParentSignal);
  parentHandlersInstalled = true;
}

function uninstallParentHandlers(): void {
  if (!parentHandlersInstalled) return;
  process.off("exit", onParentExit);
  for (const signal of PARENT_SIGNALS) process.off(signal, onParentSignal);
  parentHandlersInstalled = false;
}

function trackGroup(child: ReturnType<typeof spawn>, groups: number[]): void {
  if (!OWN_SESSION || child.pid === undefined) return; // spawn failed: nothing to track
  groups.push(child.pid);
  liveGroups.add(child.pid);
  installParentHandlers();
}

function releaseGroup(pgid: number): void {
  liveGroups.delete(pgid);
  if (liveGroups.size === 0) uninstallParentHandlers();
}

/** SIGKILL the child's whole process group, then release our ends of its stdio.
 *
 *  A step's direct child is not the only process holding its pipes: `sh -c "sleep 30"` under dash
 *  as shipped on Debian/Ubuntu forks `sleep` instead of exec'ing it (bash execs it), and a real
 *  engine CLI may leave helpers behind. Killing only the direct child leaves those descendants
 *  running as orphans AND leaves `close` (what waitExit settles on, fired once every stdio stream
 *  closes) waiting on them, i.e. the step is unbounded again. The group kill ends the
 *  descendants; destroying the streams is the backstop for one that left the group (a further
 *  setsid). */
function killAndRelease(child: ReturnType<typeof spawn>): void {
  let groupKilled = false;
  if (OWN_SESSION && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      groupKilled = true;
    } catch {
      // ESRCH: the group is already gone. Fall through to the direct kill.
    }
  }
  if (!groupKilled) child.kill("SIGKILL");
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/** Settle a child into a ProcExit — spawn errors and signal deaths both map to non-zero codes,
 *  so the invoker never rejects and never reports a signaled child as success. */
function waitExit(child: ReturnType<typeof spawn>): Promise<ProcExit> {
  return new Promise((resolveExit) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      resolveExit({ code: 127, signal: null, stdout, stderr, spawnError: `spawn failed: ${err.message}` });
    });
    child.on("close", (code, signal) => {
      resolveExit({ code: code ?? 1, signal, stdout, stderr });
    });
  });
}
