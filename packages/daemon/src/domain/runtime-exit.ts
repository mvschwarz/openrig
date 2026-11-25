import type { TmuxAdapter, TmuxResult } from "../adapters/tmux.js";
import { composerContainsOwnedText } from "./composer-prompts.js";
import {
  listNativeProcesses, observeClaudePaneRuntime, observeCodexPaneProcess, verifyClaudePaneRuntime, verifyCodexPaneProcess,
  verifyPaneIdleShell, type NativeProcessLister, type NativeProcessObservation, type NativeProcessRow,
} from "./native-process-lineage.js";
import { classifyPaneActivity, inspectComposerInput } from "./session-transport.js";

/**
 * #3901: when OpenRig retires a seat's agent on purpose (an in-place handover or relaunch, a runtime switch, `rig down`),
 * the agent exits through its own shutdown where it has one. Its exit is read from the process table (its pid and start
 * time gone), never from the pane: an agent typed into a shell leaves that shell, and so the pane, running when it exits.
 *
 * Measured natively on Linux (bash and dash panes, OpenRig's launch shape; evidence in the #3901 build record):
 * - Claude Code 2.1.330 exits on TERM within half a second and runs its SessionEnd hooks (reason "other").
 * - Codex 0.171.0 has no handler for TERM, HUP or INT: each ends it at once (exit 143, 129, 130), without its SessionEnd
 *   hooks and with the terminal left in its alternate screen. A typed `/exit` (or `/quit`) runs its shutdown: exit 0,
 *   SessionEnd hooks, terminal restored, within a third of a second.
 * So Claude Code gets TERM, and Codex gets `/exit` typed into its input box, only while that box reads empty with no
 * prompt open. A Codex that can't take it (a draft, a prompt or menu, a box that can't be read) is ended with TERM, and
 * that is reported as forced: TERM doesn't run its shutdown.
 *
 * Every effect is preceded by a fresh check that the process is still the one observed: the same pid and start time, the
 * pane's one foreground agent of that runtime, in the same pane (whose root process hasn't changed). A pid reused by
 * another process, a launcher or helper, or another occupant is never signalled or typed to.
 */

/** How a runtime exits through its own shutdown. Runtimes without an entry keep the pane-level stop (pane-cutover.ts). */
const EXIT_STEP: Readonly<Record<string, "term" | "typed_exit">> = { "claude-code": "term", codex: "typed_exit" };

export function runtimeExitStep(runtime: string | null | undefined): "term" | "typed_exit" | null {
  return runtime ? EXIT_STEP[runtime] ?? null : null;
}

const RUNTIME_NAME: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex" };

/** The longest wait for Codex to show the typed `/exit` in its box before Enter. */
const READ_BACK_MS = 1_000;

/** What the exit reads and writes. `signalPaneRuntime` is the guarded effect; the rest are reads, except the typed exit. */
export type RuntimeExitTmux = Pick<TmuxAdapter, "getPanePid" | "signalPaneRuntime">
  & Partial<Pick<TmuxAdapter, "captureComposerSnapshot" | "sendText" | "sendKeys">>;

export interface RuntimeExitTiming {
  pollMs: number;
  /** The bounded wait for the agent's own exit, and again after KILL. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface RuntimeExitInput {
  /** The pane's immutable id, for reads. */
  pane: string;
  /** Where effects go: the seat's node id under the delivery guard (which resolves it to the seat's pane), else the pane. */
  inputTarget: string;
  runtime: string | null;
}

export type RuntimeExitOutcome =
  /** The agent's process is gone. `graceful`: it ran its own shutdown (or left by itself). `forced`: a signal it doesn't
   *  handle, or KILL after the window. */
  | { state: "exited"; path: "graceful" | "forced"; detail: string }
  /** No agent ran in the pane: its own shell held the foreground with nothing under it. Nothing was signalled. */
  | { state: "no_runtime"; detail: string }
  /** Something other than one recognisable agent of this runtime ran (or the process table couldn't be read). Nothing
   *  was signalled; the caller stops the pane as it did before. */
  | { state: "not_identified"; detail: string }
  /** The agent was still running after TERM and KILL, or changed before KILL could be checked. */
  | { state: "still_running"; detail: string };

interface Observed { pane: string; panePid: number; pid: number; startedAt: string }

/**
 * Exit the pane's agent through its own shutdown, bounded by `timing`, with KILL as the last resort. Returns null when the
 * runtime has no known exit step, so the caller keeps its own stop.
 */
export async function exitPaneRuntime(tmux: RuntimeExitTmux, input: RuntimeExitInput, timing: RuntimeExitTiming,
  listProcesses: NativeProcessLister = listNativeProcesses): Promise<RuntimeExitOutcome | null> {
  const step = runtimeExitStep(input.runtime);
  if (!step) return null;
  const runtime = input.runtime!;
  const name = RUNTIME_NAME[runtime] ?? runtime;
  const read = { target: input.pane, tmux: { getPanePid: (target: string) => tmux.getPanePid(target) }, listProcesses };
  const verified = runtime === "claude-code" ? await verifyClaudePaneRuntime(read) : await verifyCodexPaneProcess(read);
  if (!verified?.process.startedAt) {
    if (await verifyPaneIdleShell(read) && await bareShell(tmux, input.pane, listProcesses)) {
      return { state: "no_runtime", detail: `No ${name} was running in the pane, only its shell.` };
    }
    return { state: "not_identified", detail: `${name} couldn't be identified in the pane, so it wasn't sent its own exit.` };
  }
  const observed: Observed = { pane: input.pane, panePid: verified.panePid, pid: verified.process.pid, startedAt: verified.process.startedAt };
  const still = (pane: string) => stillThatProcess(tmux, read, runtime, observed, pane);
  const started = Date.now();
  const seconds = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;

  let forcedBecause: string | null = null;
  if (step === "typed_exit") {
    const typed = await typeExit(tmux, input, observed, still, timing);
    if (!typed.ok) forcedBecause = typed.why;
  }
  if (step === "term" || forcedBecause !== null) {
    const term = await tmux.signalPaneRuntime(input.inputTarget, observed.pid, "TERM", still);
    if (!term.ok) {
      if (await gone(listProcesses, observed)) return { state: "exited", path: "graceful", detail: `${name} exited by itself before it was signalled.` };
      return { state: "not_identified", detail: `${name} wasn't signalled: ${term.message}${forcedBecause === null ? "" : ` /exit couldn't be used: ${forcedBecause}.`}` };
    }
  }
  if (await waitGone(listProcesses, observed, timing)) {
    return forcedBecause === null
      ? { state: "exited", path: "graceful", detail: step === "term" ? `${name} exited on TERM in ${seconds()}.` : `${name} exited through /exit in ${seconds()}.` }
      : { state: "exited", path: "forced", detail: `${name} was ended with TERM, which doesn't run its own shutdown, because /exit couldn't be used: ${forcedBecause}.` };
  }
  const window = `${(timing.timeoutMs / 1000).toFixed(1)} s`;
  const kill = await tmux.signalPaneRuntime(input.inputTarget, observed.pid, "KILL", still);
  if (!kill.ok) {
    if (await gone(listProcesses, observed)) return { state: "exited", path: "graceful", detail: `${name} exited by itself ${seconds()} after ${step === "term" ? "TERM" : "/exit"}, just past the ${window} window.` };
    return { state: "still_running", detail: `${name} didn't exit within ${window}, and KILL wasn't sent: ${kill.message}` };
  }
  if (await waitGone(listProcesses, observed, timing)) {
    return { state: "exited", path: "forced", detail: forcedBecause === null
      ? `${name} didn't exit within ${window} of ${step === "term" ? "TERM" : "/exit"} and was killed.`
      : `${name} didn't exit within ${window} of TERM and was killed (/exit couldn't be used: ${forcedBecause}).` };
  }
  return { state: "still_running", detail: `${name} was still running after TERM and KILL.` };
}

/** The observed agent is still the pane's one foreground agent of this runtime: the same pid and start time, in a pane
 *  whose root process is unchanged, and the effect's target (the pane the guard resolved, when there is a guard) is that
 *  same pane. */
async function stillThatProcess(tmux: RuntimeExitTmux, read: { target: string; tmux: { getPanePid(target: string): Promise<number | null> }; listProcesses: NativeProcessLister },
  runtime: string, observed: Observed, resolvedPane: string): Promise<boolean> {
  if ((await tmux.getPanePid(resolvedPane)) !== observed.panePid) return false;
  const now: NativeProcessObservation | null = runtime === "claude-code" ? await observeClaudePaneRuntime(read) : await observeCodexPaneProcess(read);
  return !!now && now.panePid === observed.panePid && now.process.pid === observed.pid && now.process.startedAt === observed.startedAt;
}

/** The pane's root process has no process under it at all. An idle shell's foreground says nothing about its background
 *  jobs: a stopped or backgrounded agent is still there, and isn't "no agent". An unreadable table isn't bare. */
async function bareShell(tmux: RuntimeExitTmux, pane: string, listProcesses: NativeProcessLister): Promise<boolean> {
  const panePid = await tmux.getPanePid(pane);
  let rows: NativeProcessRow[];
  try { rows = await listProcesses(); } catch { return false; }
  if (!panePid || !rows.some((row) => row.pid === panePid)) return false;
  return !rows.some((row) => row.ppid === panePid);
}

/** Gone: no row with that pid and start time, or only its zombie (it has exited and its parent hasn't reaped it yet).
 *  An unreadable process table isn't proof of either. */
async function gone(listProcesses: NativeProcessLister, observed: Observed): Promise<boolean> {
  let rows: NativeProcessRow[];
  try { rows = await listProcesses(); } catch { return false; }
  if (rows.length === 0) return false;
  return !rows.some((row) => row.pid === observed.pid && row.startedAt === observed.startedAt && row.state !== "Z");
}

/** Poll for the exit up to the bounded window (count-bounded, so injected no-op sleeps stay fast). */
async function waitGone(listProcesses: NativeProcessLister, observed: Observed, timing: RuntimeExitTiming): Promise<boolean> {
  const polls = Math.max(1, Math.ceil(timing.timeoutMs / timing.pollMs));
  for (let i = 0; i < polls; i++) {
    if (await gone(listProcesses, observed)) return true;
    await timing.sleep(timing.pollMs);
  }
  return gone(listProcesses, observed);
}

/**
 * Codex's own exit: `/exit` typed into its input box and submitted, only while that box reads empty with no prompt or
 * menu open, and Enter only once the box reads exactly `/exit`. Never typed over a person's draft or into an open
 * prompt, so no native decision is answered. Returns why it wasn't (or couldn't be) submitted.
 */
async function typeExit(tmux: RuntimeExitTmux, input: RuntimeExitInput, observed: Observed,
  still: (pane: string) => Promise<boolean>, timing: RuntimeExitTiming): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!tmux.captureComposerSnapshot || !tmux.sendText || !tmux.sendKeys) return { ok: false, why: "its input box can't be read here" };
  const snapshot = await tmux.captureComposerSnapshot(observed.pane);
  const box = inspectComposerInput(snapshot, "codex");
  if (box.state === "text") return { ok: false, why: "its input box held text" };
  if (box.state !== "empty" || !snapshot) return { ok: false, why: "its input box couldn't be read" };
  // An open prompt (an approval, a question) is never typed into. Running work isn't a reason to hold back: /exit is
  // Codex's own shutdown, which ends a running turn as Codex does (and the agent is being retired either way); the
  // activity reading isn't used for that, since Codex 0.171's welcome logo reads as a busy spinner.
  if (classifyPaneActivity("", { runtime: "codex", composerSnapshot: snapshot }).state === "attention") return { ok: false, why: "it was showing a prompt" };
  if (!await still(observed.pane)) return { ok: false, why: "the process changed before input" };
  // Typed as keys (no bracketed paste), as a person types it, so Codex reads a slash command.
  const typed: TmuxResult = await tmux.sendText(input.inputTarget, "/exit", undefined, { bracketed: false });
  if (!typed.ok) return { ok: false, why: `typing failed (${typed.message})` };
  // Codex redraws its box a moment after the keys (about 0.2 s measured): read it back until it shows exactly /exit, for
  // at most a second. Other text there (a person typing at the same time) ends the wait.
  let owned = false;
  for (let waited = 0; ; waited += timing.pollMs) {
    const after = inspectComposerInput(await tmux.captureComposerSnapshot(observed.pane), "codex");
    if (composerContainsOwnedText(after, "/exit")) { owned = true; break; }
    if ((after.state === "text" && !after.rows.join("").startsWith("/")) || waited >= Math.min(timing.timeoutMs, READ_BACK_MS)) break;
    await timing.sleep(timing.pollMs);
  }
  if (!owned) return { ok: false, why: "the typed /exit wasn't read back alone in its input box, so Enter wasn't sent" };
  if (!await still(observed.pane)) return { ok: false, why: "the process changed before Enter" };
  const entered = await tmux.sendKeys(input.inputTarget, ["Enter"]);
  if (!entered.ok) return { ok: false, why: `Enter failed (${entered.message})` };
  return { ok: true };
}
