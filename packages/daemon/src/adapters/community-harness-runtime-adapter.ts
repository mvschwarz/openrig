import type {
  RuntimeAdapter,
  InstalledResource,
  NodeBinding,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  ResolvedStartupFile,
  HarnessLaunchResult,
  ForkSource,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan } from "../domain/projection-planner.js";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { isShellForeground } from "../domain/shell-classifier.js";
import { isCommunityHarnessRuntime, loadCommunityHarnessPreset, communityHarnessesDir } from "../domain/community-harness-presets.js";
import { communityHarnessOf } from "../domain/built-in-runtimes.js";
import { launchResultRoot, newLaunchAttempt, waitForLaunchResult, type LaunchAttempt } from "../domain/community-harness-launch-result.js";
import { writeFirstInput, type FirstInputPassed } from "../domain/community-harness-first-input.js";
import type { CommunityHarnessPreset } from "../domain/community-harness-presets.js";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { shellQuote } from "./shell-quote.js";

interface CommunityHarnessAdapterDeps {
  tmux: Pick<TmuxAdapter, "hasSession" | "getPaneCommand" | "sendShellCommand">;
  seatLaunchEnvironment?: Pick<SeatLaunchEnvironment, "command">;
  presetsDir?: () => string;
  /** Where launch-result records go (tests); defaults to $OPENRIG_HOME/state/launch-results. */
  launchResultRoot?: () => string;
  /** How long to wait for a launcher's record (tests). */
  launchResultWait?: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> };
}

/**
 * A community harness, launched from its installed preset (`domain/community-harness-presets.ts`). It types the preset's
 * command into the seat's pane and is ready while the pane runs something other than a shell. That's readiness, not
 * identity: a process alone doesn't prove which session it is. It projects nothing and refuses fork. It resumes only a
 * preset that declares `resume`. With `launch_result`, its launcher is told the conversation to reopen and reports what it
 * did, and a conversation it says is gone is never replaced by a new one. With `names_conversation`, OpenRig names each new
 * conversation and passes the saved name back on a resume. Nothing reports back, so a named seat's readiness is
 * process-only: its saved name is unverified until something observes it.
 */
export class CommunityHarnessRuntimeAdapter implements RuntimeAdapter {
  constructor(readonly runtime: string, private readonly deps: CommunityHarnessAdapterDeps) {}

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }

  async project(plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    const skipped = plan.entries.map(entry => entry.effectiveId);
    return {
      projected: [], skipped, failed: [],
      ...(skipped.length ? { warnings: [`Community harness "${this.runtime}" places no resources; ${skipped.length} not placed: ${skipped.join(", ")}`] } : {}),
    };
  }

  async deliverStartup(files: ResolvedStartupFile[], _binding: NodeBinding): Promise<StartupDeliveryResult> {
    return {
      delivered: 0, failed: [],
      ...(files.length ? { warnings: [`Community harness "${this.runtime}" takes no startup files; ${files.length} not delivered: ${files.map(file => file.path).join(", ")}`] } : {}),
    };
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; resumeType?: string; forkSource?: ForkSource; firstInputText?: string }): Promise<HarnessLaunchResult> {
    if (opts.forkSource) {
      return { ok: false, error: `Fork is unsupported: community harness "${this.runtime}" is launch-only. Remove session_source for this member.` };
    }
    const found = loadCommunityHarnessPreset(this.runtime, this.deps.presetsDir?.() ?? communityHarnessesDir());
    const resumeRef = opts.resumeToken?.trim();
    // Only this harness's own conversation is ever handed to its launcher: a former runtime's id (a Codex thread, say) isn't.
    if (resumeRef && found.ok && found.preset.resume && opts.resumeType !== `community:${this.runtime}`) {
      return { ok: false, recovery: "retry_fresh",
        error: `Resume isn't possible: the saved conversation is a "${opts.resumeType ?? "unknown"}" id, not one community harness "${this.runtime}" reported, so it isn't passed to its launcher. A new conversation starts only where the caller allows a fresh start; a restore stops and asks.` };
    }
    if (resumeRef && !(found.ok && found.preset.resume)) {
      // A conversation id its launcher reported earlier doesn't make a launch-only harness resumable: say so, and let the
      // caller start a new conversation as it did before (it never resumes one silently).
      return found.ok && (found.preset.launchResult || found.preset.namesConversation)
        ? { ok: false, recovery: "retry_fresh",
          error: `Resume is unsupported: community harness "${this.runtime}" is launch-only, so its ${found.preset.launchResult ? "reported" : "named"} conversation isn't reopened. A new conversation starts only where the caller allows a fresh start; a restore stops and asks.` }
        : { ok: false, error: `Resume is unsupported: community harness "${this.runtime}" is launch-only. No session was started.` };
    }
    if (!found.ok) return { ok: false, error: found.message };
    const session = binding.tmuxSession ?? opts.name;
    let firstInput: FirstInputPassed | undefined;
    try {
      if (found.preset.firstInput && opts.firstInputText !== undefined) {
        firstInput = writeFirstInput(session, opts.firstInputText,
          this.deps.launchResultRoot ? join(dirname(this.deps.launchResultRoot()), "first-input") : undefined);
      }
    } catch (error) {
      return { ok: false, error: `Couldn't prepare the first input for community harness "${this.runtime}": ${(error as Error).message}; nothing was started.` };
    }
    const preset = found.preset.firstInput ? { ...found.preset, command: firstInput
      ? `/usr/bin/env OPENRIG_FIRST_INPUT=${shellQuote(firstInput.path)} ${found.preset.command}`
      : `/usr/bin/env -u OPENRIG_FIRST_INPUT ${found.preset.command}` } : found.preset;
    let passed = false;
    try {
      const result = await this.launchPreset(session, preset, resumeRef, firstInput ? () => { passed = true; } : undefined);
      return { ...result, ...(passed ? { firstInput } : {}) };
    } catch (error) {
      if (!passed) throw error;
      return { ok: false, firstInput, error: `Community harness "${this.runtime}" launch is uncertain: ${(error as Error).message}` };
    }
  }

  private async launchPreset(session: string, preset: CommunityHarnessPreset, resumeRef: string | undefined, beforeInput?: () => void): Promise<HarnessLaunchResult> {
    if (preset.namesConversation) return this.launchNamed(session, preset.command, resumeRef, beforeInput);
    let attempt: LaunchAttempt | undefined;
    let program = preset.command;
    // The record is optional: a folder that can't be made leaves the identity unavailable, and the harness still launches.
    let storageNote: string | undefined;
    if (preset.launchResult) {
      try {
        attempt = newLaunchAttempt(session, this.deps.launchResultRoot?.() ?? launchResultRoot());
        program = `/usr/bin/env OPENRIG_LAUNCH_RESULT=${shellQuote(attempt.file)} OPENRIG_LAUNCH_ATTEMPT=${attempt.attempt}`
          + `${resumeRef ? ` OPENRIG_RESUME_REF=${shellQuote(resumeRef)}` : ""} ${program}`;
      } catch (error) {
        // A resume needs its record: without it the launcher can't be told what to reopen, so nothing starts.
        if (resumeRef) {
          return { ok: false, error: `Couldn't resume community harness "${this.runtime}": its launch-result folder couldn't be made (${(error as Error).message}); nothing was started.` };
        }
        storageNote = `community harness "${this.runtime}": its launch identity is unavailable: its launch-result folder couldn't be made (${(error as Error).message})`;
      }
    }
    const command = this.deps.seatLaunchEnvironment
      ? await this.deps.seatLaunchEnvironment.command(session, program, { runtime: this.runtime })
      : program;
    const sent = await this.deps.tmux.sendShellCommand(session, command, beforeInput, { stageIfLong: true, execInScript: true });
    if (!sent.ok) return { ok: false, error: `Couldn't start community harness "${this.runtime}": ${sent.message}` };
    if (!attempt) return storageNote ? { ok: true, warnings: [storageNote] } : { ok: true };
    const read = await waitForLaunchResult(attempt, this.runtime, { ...this.deps.launchResultWait, root: this.deps.launchResultRoot?.() ?? launchResultRoot() });
    if (resumeRef) {
      // A conversation that's gone is never replaced by a new one: nothing started, and the person decides.
      if (!read.ok && "missing" in read) {
        return { ok: false, missingConversation: true, error: `Couldn't resume community harness "${this.runtime}": conversation ${resumeRef}: ${read.reason}.` };
      }
      // Unconfirmed or different: the seat keeps the conversation it asked for, and the person decides. No retry.
      if (!read.ok) {
        return { ok: false, recovery: "attention_required", resumeUnproven: true,
          error: `Community harness "${this.runtime}": resuming conversation ${resumeRef} isn't confirmed: ${read.reason}. The seat keeps conversation ${resumeRef}; nothing was restarted.` };
      }
      if (read.nativeRef !== resumeRef) {
        return { ok: false, recovery: "attention_required", resumeMismatch: { opened: read.nativeRef },
          error: `Community harness "${this.runtime}": asked to resume conversation ${resumeRef}, its launcher reports conversation ${read.nativeRef} instead. The seat keeps conversation ${resumeRef}, and OpenRig doesn't switch it to ${read.nativeRef}. Nothing was restarted.` };
      }
    }
    return read.ok
      ? { ok: true, resumeToken: read.nativeRef, resumeType: `community:${this.runtime}`, resumeProvenance: "launcher" }
      : { ok: true, warnings: [`community harness "${this.runtime}": its launch identity is unavailable: ${read.reason}`] };
  }

  /** OpenRig names the conversation: a new one gets a fresh name in OPENRIG_CONVERSATION, and a resume passes the saved name
   *  in OPENRIG_RESUME_REF. Nothing reports back, so the name is recorded as passed, not observed, and readiness says only
   *  that a process runs: a harness that hasn't yet found a gone conversation reads as ready. Never creating one on a
   *  resume is the launcher's job; OpenRig never asks for a new conversation on a resume. */
  private async launchNamed(session: string, preset: string, resumeRef: string | undefined, beforeInput?: () => void): Promise<HarnessLaunchResult> {
    const name = resumeRef ?? conversationName(session);
    const program = `/usr/bin/env ${resumeRef ? "OPENRIG_RESUME_REF" : "OPENRIG_CONVERSATION"}=${shellQuote(name)} ${preset}`;
    const command = this.deps.seatLaunchEnvironment
      ? await this.deps.seatLaunchEnvironment.command(session, program, { runtime: this.runtime })
      : program;
    const sent = await this.deps.tmux.sendShellCommand(session, command, beforeInput, { stageIfLong: true, execInScript: true });
    if (!sent.ok) return { ok: false, error: `Couldn't start community harness "${this.runtime}": ${sent.message}` };
    return { ok: true, resumeToken: name, resumeType: `community:${this.runtime}`, resumeProvenance: "passed" };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const session = binding.tmuxSession;
    if (!session || !(await this.deps.tmux.hasSession(session))) {
      return { ready: false, reason: "The seat's tmux session isn't there.", code: "session_missing" };
    }
    const command = await this.deps.tmux.getPaneCommand(session);
    if (!command || isShellForeground(command)) {
      return { ready: false, reason: `Community harness "${this.runtime}" isn't running: the pane is at a shell.`, code: "harness_not_running" };
    }
    return { ready: true };
  }

  /** Snapshot this launch's declaration before composing its first turn. */
  firstInput(): boolean {
    const found = loadCommunityHarnessPreset(this.runtime, this.deps.presetsDir?.() ?? communityHarnessesDir());
    return found.ok && found.preset.firstInput;
  }

  /** A process running isn't proof that the startup paste was submitted. */
  startupAssisted(): boolean {
    const found = loadCommunityHarnessPreset(this.runtime, this.deps.presetsDir?.() ?? communityHarnessesDir());
    return found.ok && found.preset.startupAssisted;
  }
}

/** A new conversation's name: the seat's session name, made safe, and 8 random hex digits, at most 100 characters. */
function conversationName(session: string): string {
  const seat = session.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "seat";
  return `openrig-${seat}-${randomBytes(4).toString("hex")}`;
}

/**
 * The runtime adapter map, extended with community harnesses: a runtime name that isn't built in resolves to an
 * CommunityHarnessRuntimeAdapter while its preset is installed. The built-in entries are returned as they are, and the map's
 * own keys stay the built-ins.
 */
export function withCommunityHarnesses<T extends Record<string, RuntimeAdapter>>(builtIns: T, deps: CommunityHarnessAdapterDeps): T {
  const installed = (key: string | symbol): key is string =>
    typeof key === "string" && !Object.hasOwn(builtIns, key) && isCommunityHarnessRuntime(key)
      && loadCommunityHarnessPreset(key, deps.presetsDir?.() ?? communityHarnessesDir()).ok;
  return new Proxy(builtIns, {
    get: (target, key, receiver) => installed(key) ? new CommunityHarnessRuntimeAdapter(key, deps) : Reflect.get(target, key, receiver),
    has: (target, key) => Reflect.has(target, key) || installed(key),
  });
}

/** The hidden key of a relaunch map's community-harness resolver; a symbol, so the map's own keys stay the built-ins. */
const COMMUNITY_HARNESS_RESOLVER = Symbol("community-harness-resolver");

/**
 * The runtime adapter map for relaunches (restore, seat lifecycle): exactly the built-ins, plus a hidden resolver for a
 * community harness. Only `seatAdapter`, given a seat's recorded selection, reaches that resolver, so a seat whose
 * runtime merely matches an installed preset's name (a free-text self-attach) gets no adapter, as before.
 */
export function withCommunityHarnessResolver<T extends Record<string, RuntimeAdapter>>(builtIns: T, deps: CommunityHarnessAdapterDeps): T {
  Object.defineProperty(builtIns, COMMUNITY_HARNESS_RESOLVER, {
    enumerable: false,
    value: (runtime: string) => isCommunityHarnessRuntime(runtime) && loadCommunityHarnessPreset(runtime, deps.presetsDir?.() ?? communityHarnessesDir()).ok
      ? new CommunityHarnessRuntimeAdapter(runtime, deps) : undefined,
  });
  return builtIns;
}

/** The adapter to relaunch a seat with: its runtime's built-in adapter, or, for a seat launched for a community
 *  harness (`communityHarnessOf`), that harness's adapter while its preset is installed. */
export function seatAdapter(map: Record<string, RuntimeAdapter> | undefined, runtime: string | null | undefined,
  communityHarness: string | null | undefined): RuntimeAdapter | undefined {
  if (!map || !runtime) return undefined;
  if (Object.hasOwn(map, runtime)) return map[runtime];
  const resolve = (map as Record<symbol, ((runtime: string) => RuntimeAdapter | undefined) | undefined>)[COMMUNITY_HARNESS_RESOLVER];
  return communityHarnessOf(communityHarness, runtime) && resolve ? resolve(runtime) : undefined;
}
