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
 * identity: a process alone doesn't prove which session it is. It projects nothing, and refuses resume and fork,
 * which a launch-only preset doesn't support.
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

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; forkSource?: ForkSource }): Promise<HarnessLaunchResult> {
    if (opts.forkSource) {
      return { ok: false, error: `Fork is unsupported: community harness "${this.runtime}" is launch-only. Remove session_source for this member.` };
    }
    const found = loadCommunityHarnessPreset(this.runtime, this.deps.presetsDir?.() ?? communityHarnessesDir());
    if (opts.resumeToken) {
      // A conversation id its launcher reported earlier doesn't make a launch-only harness resumable: say so, and let the
      // caller start a new conversation as it did before (it never resumes one silently).
      return found.ok && found.preset.launchResult
        ? { ok: false, recovery: "retry_fresh",
          error: `Resume is unsupported: community harness "${this.runtime}" is launch-only, so its reported conversation isn't reopened. A new conversation starts only where the caller allows a fresh start; a restore stops and asks.` }
        : { ok: false, error: `Resume is unsupported: community harness "${this.runtime}" is launch-only. No session was started.` };
    }
    if (!found.ok) return { ok: false, error: found.message };
    const session = binding.tmuxSession ?? opts.name;
    let attempt: LaunchAttempt | undefined;
    let program = found.preset.command;
    // The record is optional: a folder that can't be made leaves the identity unavailable, and the harness still launches.
    let storageNote: string | undefined;
    if (found.preset.launchResult) {
      try {
        attempt = newLaunchAttempt(session, this.deps.launchResultRoot?.() ?? launchResultRoot());
        program = `/usr/bin/env OPENRIG_LAUNCH_RESULT=${shellQuote(attempt.file)} OPENRIG_LAUNCH_ATTEMPT=${attempt.attempt} ${program}`;
      } catch (error) {
        storageNote = `community harness "${this.runtime}": its launch identity is unavailable: its launch-result folder couldn't be made (${(error as Error).message})`;
      }
    }
    const command = this.deps.seatLaunchEnvironment
      ? await this.deps.seatLaunchEnvironment.command(session, program, { runtime: this.runtime })
      : program;
    const sent = await this.deps.tmux.sendShellCommand(session, command, undefined, { stageIfLong: true, execInScript: true });
    if (!sent.ok) return { ok: false, error: `Couldn't start community harness "${this.runtime}": ${sent.message}` };
    if (!attempt) return storageNote ? { ok: true, warnings: [storageNote] } : { ok: true };
    const read = await waitForLaunchResult(attempt, this.runtime, { ...this.deps.launchResultWait, root: this.deps.launchResultRoot?.() ?? launchResultRoot() });
    return read.ok
      ? { ok: true, resumeToken: read.nativeRef, resumeType: `community:${this.runtime}`, resumeProvenance: "launcher" }
      : { ok: true, warnings: [`community harness "${this.runtime}": its launch identity is unavailable: ${read.reason}`] };
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
