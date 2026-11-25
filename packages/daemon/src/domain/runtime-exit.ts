import type { PaneTerminal, TmuxAdapter, TmuxResult } from "../adapters/tmux.js";
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
 * Measured natively on Linux (bash and dash panes, OpenRig's launch shape, each runtime idle at its prompt; evidence in
 * the #3901 build record):
 * - Claude Code 2.1.330 exited on TERM within half a second and ran its SessionEnd hooks (reason "other").
 * - Codex 0.171.0 ended at once on TERM, HUP or INT (exit 143, 129, 130), without its SessionEnd hooks and with the
 *   terminal left in its alternate screen. A typed `/exit` (or `/quit`) ran its shutdown: exit 0, SessionEnd hooks,
 *   terminal restored, within a third of a second. Those are native observations; that Codex installs no handler for
 *   those signals comes from a secondary read of its 0.171 source, not a version-pinned review of it.
 * So Claude Code gets TERM, and Codex gets `/exit` typed into its input box, only while that box reads empty with no
 * prompt open. A Codex that can't take it (a draft, a prompt or menu, a box that can't be read) is ended with TERM, and
 * that is reported as forced: TERM doesn't run its shutdown.
 *
 * The checks before each effect, and their limits. Before each signal, and at the typed `/exit` and at its Enter, the
 * process is read again: the same pid and start time (to the second, as the process table gives it), the pane's one
 * foreground agent of that runtime, in the same pane (whose root process hasn't changed), and, with a `pin`, that pane
 * still in the tmux session and on the server it was first read in (a replaced server reuses session names and pane ids
 * for other terminals). The input box is read again at the input boundary itself (sendText's `beforePaste`, after the
 * buffer is loaded; sendKeys' `beforeKeys`): empty with no prompt before the paste, exactly the typed `/exit` with no
 * prompt before Enter. Each check is a read followed by a separate write, so a change in the moment between the last read
 * and the signal or keys isn't caught (the OS offers no way to make them one step), and a pid reused within the same
 * second isn't told apart by its start time. A check that can't be made isn't a refusal to stop the agent: the caller
 * falls back to the pane-level stop, reported as forced. Only a pane seen in another session or on another server is
 * left alone (`terminal_changed`).
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
  & Partial<Pick<TmuxAdapter, "captureComposerSnapshot" | "sendText" | "sendKeys" | "paneTerminal">>;

/** #3901: the terminal (tmux session and server) a pane was first read in, which each later effect on it is held to. */
export interface TerminalPin {
  readonly terminal: PaneTerminal;
  /** Set once a check saw the pane in another session or on another server: a positive change, not an unreadable read. */
  readonly changed: boolean;
  /** True only while `pane` is still in that session on that server; false too when that can't be read. */
  holds(pane: string): Promise<boolean>;
}

/** Hold later effects to the terminal `terminal` names, as killSession holds its detach and kill to the session id and
 *  server it read (tmux.ts). */
export function pinTerminal(tmux: Pick<TmuxAdapter, "paneTerminal">, terminal: PaneTerminal): TerminalPin {
  let changed = false;
  return {
    terminal,
    get changed() { return changed; },
    async holds(pane: string): Promise<boolean> {
      const now = await tmux.paneTerminal(pane);
      if (!now) return false;
      if (now.sessionId === terminal.sessionId && now.server.pid === terminal.server.pid && now.server.start === terminal.server.start) return true;
      changed = true;
      return false;
    },
  };
}

export interface RuntimeExitTiming {
  pollMs: number;
  /** Each wait: for the agent's own exit, and again after KILL. The reads and writes between them take time of their
   *  own, so the whole exit can take longer than twice this. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

export interface RuntimeExitInput {
  /** The pane's immutable id, for reads. */
  pane: string;
  /** Where effects go: the seat's node id under the delivery guard (which resolves it to the seat's pane), else the pane. */
  inputTarget: string;
  runtime: string | null;
  /** The terminal the pane was first read in (with the seat's marker, for `rig down`), which every effect is held to.
   *  Null when it couldn't be read: nothing is sent, and the caller stops the pane as before. */
  pin?: TerminalPin | null;
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
  /** Its exit step was sent, but its end wasn't established: the process table couldn't be read, or KILL wasn't sent
   *  because the check before it didn't hold. Unknown, not running: the caller stops the pane as it did before. */
  | { state: "unverified"; detail: string }
  /** The pane is no longer in the session or on the server it was first read in: nothing more is sent to it. */
  | { state: "terminal_changed"; detail: string }
  /** The agent was seen still running (its pid and start time) after KILL was sent. */
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
  if (input.pin === null) return { state: "not_identified", detail: `${name}'s terminal (its tmux session and server) couldn't be read, so it wasn't sent its own exit.` };
  const read = { target: input.pane, tmux: { getPanePid: (target: string) => tmux.getPanePid(target) }, listProcesses };
  const verified = runtime === "claude-code" ? await verifyClaudePaneRuntime(read) : await verifyCodexPaneProcess(read);
  if (!verified?.process.startedAt) {
    if (await verifyPaneIdleShell(read) && await bareShell(tmux, input.pane, listProcesses)) {
      return { state: "no_runtime", detail: `No ${name} was running in the pane, only its shell.` };
    }
    return { state: "not_identified", detail: `${name} couldn't be identified in the pane, so it wasn't sent its own exit.` };
  }
  const observed: Observed = { pane: input.pane, panePid: verified.panePid, pid: verified.process.pid, startedAt: verified.process.startedAt };
  const pin = input.pin;
  const still = async (pane: string) => await stillThatProcess(tmux, read, runtime, observed, pane) && (!pin || await pin.holds(pane));
  const changed = (): RuntimeExitOutcome => ({ state: "terminal_changed",
    detail: `${name}'s pane is no longer in the tmux session and server it was first read in (the server may have been replaced), so nothing more was sent to it.` });
  const started = Date.now();
  const seconds = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;

  let forcedBecause: string | null = null;
  if (step === "typed_exit") {
    const typed = await typeExit(tmux, input, observed, still, timing);
    if (pin?.changed) return changed();
    if (!typed.ok) forcedBecause = typed.why;
  }
  // What was sent as its exit step: TERM (Claude Code's own exit, or Codex's forced end), or /exit.
  const sent = step === "term" || forcedBecause !== null ? "TERM" : "/exit";
  const because = forcedBecause === null ? "" : ` /exit couldn't be used: ${forcedBecause}.`;
  if (sent === "TERM") {
    const term = await tmux.signalPaneRuntime(input.inputTarget, observed.pid, "TERM", still);
    if (!term.ok) {
      if (pin?.changed) return changed();
      if (await gone(listProcesses, observed) === true) return { state: "exited", path: "graceful", detail: `${name} exited by itself before it was signalled.` };
      return { state: "not_identified", detail: `${name} wasn't signalled: ${term.message}${because}` };
    }
  }
  if (await waitGone(listProcesses, observed, timing) === true) {
    return forcedBecause === null
      ? { state: "exited", path: "graceful", detail: step === "term" ? `${name} exited on TERM in ${seconds()}.` : `${name} exited through /exit in ${seconds()}.` }
      : { state: "exited", path: "forced", detail: `${name} was ended with TERM, which doesn't run its own shutdown, because /exit couldn't be used: ${forcedBecause}.` };
  }
  const window = `${(timing.timeoutMs / 1000).toFixed(1)} s`;
  const kill = await tmux.signalPaneRuntime(input.inputTarget, observed.pid, "KILL", still);
  if (!kill.ok) {
    if (pin?.changed) return changed();
    const now = await gone(listProcesses, observed);
    if (now === true) {
      // It ended after the window, before KILL: by itself after its own exit step, or on the TERM it was sent because
      // /exit couldn't be used, which is still forced (TERM doesn't run Codex's shutdown).
      return forcedBecause === null
        ? { state: "exited", path: "graceful", detail: `${name} exited by itself ${seconds()} after ${sent}, just past the ${window} window.` }
        : { state: "exited", path: "forced", detail: `${name} was ended with TERM, which doesn't run its own shutdown, just past the ${window} window, because /exit couldn't be used: ${forcedBecause}.` };
    }
    // Not seen gone, and not killed: whether it is still running isn't known (unverified), not established.
    return { state: "unverified", detail: now === false
      ? `${name} didn't exit within ${window} of ${sent}, and KILL wasn't sent (${sentence(kill.message)}), so its end wasn't verified.${because}`
      : `${name} was sent ${sent}, but its exit couldn't be checked: the process table couldn't be read, and KILL wasn't sent (${sentence(kill.message)}).${because}` };
  }
  const afterKill = await waitGone(listProcesses, observed, timing);
  if (afterKill === true) {
    return { state: "exited", path: "forced", detail: forcedBecause === null
      ? `${name} didn't exit within ${window} of ${sent} and was killed.`
      : `${name} didn't exit within ${window} of TERM and was killed (/exit couldn't be used: ${forcedBecause}).` };
  }
  if (afterKill === null) {
    return { state: "unverified", detail: `${name} was sent ${sent} and then KILL, but its exit couldn't be checked: the process table couldn't be read.${because}` };
  }
  return { state: "still_running", detail: `${name} was still running after ${sent} and KILL.${because}` };
}

/** A message as a clause: without its closing full stop. */
function sentence(message: string): string {
  return message.trim().replace(/\.$/, "");
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

/** Whether the observed process is gone: true when no row has its pid and start time, or only its zombie (it exited and
 *  its parent hasn't reaped it yet); false when it is still there; null when the table can't be read (or reads empty),
 *  which is evidence of neither. */
async function gone(listProcesses: NativeProcessLister, observed: Observed): Promise<boolean | null> {
  let rows: NativeProcessRow[];
  try { rows = await listProcesses(); } catch { return null; }
  if (rows.length === 0) return null;
  return !rows.some((row) => row.pid === observed.pid && row.startedAt === observed.startedAt && row.state !== "Z");
}

/** Poll for the exit for one wait window (count-bounded, so injected no-op sleeps stay fast): true once it is gone,
 *  otherwise the last read (false: still there; null: unreadable). */
async function waitGone(listProcesses: NativeProcessLister, observed: Observed, timing: RuntimeExitTiming): Promise<boolean | null> {
  const polls = Math.max(1, Math.ceil(timing.timeoutMs / timing.pollMs));
  for (let i = 0; i < polls; i++) {
    if (await gone(listProcesses, observed) === true) return true;
    await timing.sleep(timing.pollMs);
  }
  return gone(listProcesses, observed);
}

/**
 * Codex's own exit: `/exit` typed into its input box and submitted, only while that box reads empty with no prompt or
 * menu open, and Enter only once the box reads exactly `/exit`. Never typed over a person's draft or into an open
 * prompt, so no native decision is answered. Both are read again at the input boundary: in sendText's `beforePaste`
 * (after the paste buffer is loaded, right before the paste) and sendKeys' `beforeKeys` (right before Enter), each
 * after the delivery guard's own reads, with the process and its terminal checked there too. Returns why it wasn't (or
 * couldn't be) submitted; the caller then ends Codex with TERM, reported as forced.
 */
async function typeExit(tmux: RuntimeExitTmux, input: RuntimeExitInput, observed: Observed,
  still: (pane: string) => Promise<boolean>, timing: RuntimeExitTiming): Promise<{ ok: true } | { ok: false; why: string }> {
  const capture = tmux.captureComposerSnapshot?.bind(tmux), sendText = tmux.sendText?.bind(tmux), sendKeys = tmux.sendKeys?.bind(tmux);
  if (!capture || !sendText || !sendKeys) return { ok: false, why: "its input box can't be read here" };
  // An open prompt (an approval, a question) is never typed into. Whether Codex is mid-turn isn't read (its 0.171 welcome
  // logo reads as a busy spinner), and what /exit does to a running turn wasn't measured: the native checks were at an
  // idle prompt. That stays a named limit, not a reason to hold back an agent being retired either way.
  const unusable = async (pane: string): Promise<string | null> => {
    const snapshot = await capture(pane);
    const box = inspectComposerInput(snapshot, "codex");
    if (box.state === "text") return "its input box held text";
    if (box.state !== "empty" || !snapshot) return "its input box couldn't be read";
    if (classifyPaneActivity("", { runtime: "codex", composerSnapshot: snapshot }).state === "attention") return "it was showing a prompt";
    return null;
  };
  const first = await unusable(observed.pane);
  if (first) return { ok: false, why: first };
  // A check at the boundary refuses the write by throwing (the adapter then sends nothing); `refused` keeps why.
  const refusal: { why: string | null } = { why: null };
  const refuse = (why: string): never => { refusal.why = why; throw new Error(why); };
  // Typed as keys (no bracketed paste), as a person types it, so Codex reads a slash command.
  const typed: TmuxResult = await sendText(input.inputTarget, "/exit", undefined, { bracketed: false, beforePaste: async (pane) => {
    if (!await still(pane)) refuse("the process changed before input");
    const why = await unusable(pane);
    if (why) refuse(`${why} just before /exit was typed`);
  } });
  if (!typed.ok) return { ok: false, why: refusal.why ?? `typing failed (${typed.message})` };
  // Codex redraws its box a moment after the keys (about 0.2 s measured): read it back until it shows exactly /exit, for
  // at most a second. Other text there (a person typing at the same time) ends the wait.
  let owned = false;
  for (let waited = 0; ; waited += timing.pollMs) {
    const after = inspectComposerInput(await capture(observed.pane), "codex");
    if (composerContainsOwnedText(after, "/exit")) { owned = true; break; }
    if ((after.state === "text" && !after.rows.join("").startsWith("/")) || waited >= Math.min(timing.timeoutMs, READ_BACK_MS)) break;
    await timing.sleep(timing.pollMs);
  }
  if (!owned) return { ok: false, why: "the typed /exit wasn't read back alone in its input box, so Enter wasn't sent" };
  let entered: TmuxResult;
  try {
    entered = await sendKeys(input.inputTarget, ["Enter"], undefined, { beforeKeys: async (pane) => {
      if (!await still(pane)) refuse("the process changed before Enter");
      const snapshot = await capture(pane);
      if (!snapshot) refuse("its input box couldn't be read just before Enter");
      else if (classifyPaneActivity("", { runtime: "codex", composerSnapshot: snapshot }).state === "attention") refuse("it was showing a prompt just before Enter");
      else if (!composerContainsOwnedText(inspectComposerInput(snapshot, "codex"), "/exit")) refuse("the typed /exit no longer read alone in its input box just before Enter");
    } });
  } catch (error) {
    // Without a delivery guard, a refusal at the boundary rejects instead of returning a result.
    entered = { ok: false, code: "unknown", message: error instanceof Error ? error.message : String(error) };
  }
  if (!entered.ok) return { ok: false, why: refusal.why ?? `Enter failed (${entered.message})` };
  return { ok: true };
}
