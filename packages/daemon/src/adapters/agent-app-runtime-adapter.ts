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
import { isAgentAppRuntime, loadAgentAppPreset, agentAppsDir } from "../domain/agent-app-presets.js";
import { agentAppOf } from "../domain/built-in-runtimes.js";

interface AgentAppAdapterDeps {
  tmux: Pick<TmuxAdapter, "hasSession" | "getPaneCommand" | "sendShellCommand">;
  seatLaunchEnvironment?: Pick<SeatLaunchEnvironment, "command">;
  presetsDir?: () => string;
}

/**
 * A community agent app, launched from its installed preset (`domain/agent-app-presets.ts`). It types the preset's
 * command into the seat's pane and is ready while the pane runs something other than a shell. That's readiness, not
 * identity: a process alone doesn't prove which session it is. It projects nothing, and refuses resume and fork,
 * which a launch-only preset doesn't support.
 */
export class AgentAppRuntimeAdapter implements RuntimeAdapter {
  constructor(readonly runtime: string, private readonly deps: AgentAppAdapterDeps) {}

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
    if (opts.resumeToken) {
      return { ok: false, error: `Resume is unsupported: community harness "${this.runtime}" is launch-only. No session was started.` };
    }
    const found = loadAgentAppPreset(this.runtime, this.deps.presetsDir?.() ?? agentAppsDir());
    if (!found.ok) return { ok: false, error: found.message };
    const session = binding.tmuxSession ?? opts.name;
    const command = this.deps.seatLaunchEnvironment
      ? await this.deps.seatLaunchEnvironment.command(session, found.preset.command, { runtime: this.runtime })
      : found.preset.command;
    const sent = await this.deps.tmux.sendShellCommand(session, command, undefined, { stageIfLong: true, execInScript: true });
    if (!sent.ok) return { ok: false, error: `Couldn't start community harness "${this.runtime}": ${sent.message}` };
    return { ok: true };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const session = binding.tmuxSession;
    if (!session || !(await this.deps.tmux.hasSession(session))) {
      return { ready: false, reason: "The seat's tmux session isn't there.", code: "session_missing" };
    }
    const command = await this.deps.tmux.getPaneCommand(session);
    if (!command || isShellForeground(command)) {
      return { ready: false, reason: `Community harness "${this.runtime}" isn't running: the pane is at a shell.`, code: "app_not_running" };
    }
    return { ready: true };
  }
}

/**
 * The runtime adapter map, extended with community agent apps: a runtime name that isn't built in resolves to an
 * AgentAppRuntimeAdapter while its preset is installed. The built-in entries are returned as they are, and the map's
 * own keys stay the built-ins.
 */
export function withAgentApps<T extends Record<string, RuntimeAdapter>>(builtIns: T, deps: AgentAppAdapterDeps): T {
  const installed = (key: string | symbol): key is string =>
    typeof key === "string" && !Object.hasOwn(builtIns, key) && isAgentAppRuntime(key)
      && loadAgentAppPreset(key, deps.presetsDir?.() ?? agentAppsDir()).ok;
  return new Proxy(builtIns, {
    get: (target, key, receiver) => installed(key) ? new AgentAppRuntimeAdapter(key, deps) : Reflect.get(target, key, receiver),
    has: (target, key) => Reflect.has(target, key) || installed(key),
  });
}

/** The hidden key of a relaunch map's agent-app resolver; a symbol, so the map's own keys stay the built-ins. */
const AGENT_APP_RESOLVER = Symbol("agent-app-resolver");

/**
 * The runtime adapter map for relaunches (restore, seat lifecycle): exactly the built-ins, plus a hidden resolver for a
 * community agent app. Only `seatAdapter`, given a seat's recorded selection, reaches that resolver, so a seat whose
 * runtime merely matches an installed preset's name (a free-text self-attach) gets no adapter, as before.
 */
export function withAgentAppResolver<T extends Record<string, RuntimeAdapter>>(builtIns: T, deps: AgentAppAdapterDeps): T {
  Object.defineProperty(builtIns, AGENT_APP_RESOLVER, {
    enumerable: false,
    value: (runtime: string) => isAgentAppRuntime(runtime) && loadAgentAppPreset(runtime, deps.presetsDir?.() ?? agentAppsDir()).ok
      ? new AgentAppRuntimeAdapter(runtime, deps) : undefined,
  });
  return builtIns;
}

/** The adapter to relaunch a seat with: its runtime's built-in adapter, or, for a seat launched for a community agent
 *  app (`agentAppOf`), that app's adapter while its preset is installed. */
export function seatAdapter(map: Record<string, RuntimeAdapter> | undefined, runtime: string | null | undefined,
  agentApp: string | null | undefined): RuntimeAdapter | undefined {
  if (!map || !runtime) return undefined;
  if (Object.hasOwn(map, runtime)) return map[runtime];
  const resolve = (map as Record<symbol, ((runtime: string) => RuntimeAdapter | undefined) | undefined>)[AGENT_APP_RESOLVER];
  return agentAppOf(agentApp, runtime) && resolve ? resolve(runtime) : undefined;
}
