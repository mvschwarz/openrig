import type { RuntimeAdapter } from "./runtime-adapter.js";
import { BUILT_IN_RUNTIMES } from "./built-in-runtimes.js";

/**
 * In-process harness registry (interim toward Discussion #43 / closed #23).
 *
 * Capabilities — not scattered name allowlists — decide whether a runtime may
 * participate as a seat runtime, workflow agent, projector, or launcher.
 * Registering a synthetic harness for tests does not require editing every
 * domain allowlist; unsupported / missing capabilities fail closed before
 * mutation.
 *
 * This is **not** a plugin protocol. Community harnesses stay on the existing
 * preset path when a runtime is absent from the registry. OMP is listed only
 * because it is already a built-in on main (PR #35); this module does not ship
 * adapters. Prime-agent / meta_harness policy are intentionally out of scope.
 */

export const HARNESS_CAPABILITIES = [
  /** May be selected as a seat runtime in a rigspec. */
  "runtime",
  /** May be pinned as a workflow agent harness. */
  "workflow_agent",
  /** May project seat-local resources. */
  "project",
  /** May launch a harness subprocess / pane. */
  "launch",
  /** Synthetic / test-only harness (contract tests, DEV fixtures). */
  "synthetic",
] as const;

export type HarnessCapability = (typeof HARNESS_CAPABILITIES)[number];

export interface HarnessRegistration {
  runtime: string;
  adapter: RuntimeAdapter;
  capabilities: ReadonlySet<HarnessCapability>;
}

export class HarnessRegistryError extends Error {
  readonly code: string;
  readonly meta: Record<string, unknown> | undefined;
  constructor(code: string, message: string, meta?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

export class HarnessRegistry {
  private readonly byRuntime = new Map<string, HarnessRegistration>();

  register(
    adapter: RuntimeAdapter,
    capabilities: readonly HarnessCapability[],
  ): void {
    const runtime = adapter.runtime;
    if (!runtime?.trim()) {
      throw new HarnessRegistryError("invalid_runtime", "adapter.runtime is required");
    }
    if (this.byRuntime.has(runtime)) {
      throw new HarnessRegistryError(
        "runtime_already_registered",
        `harness runtime '${runtime}' is already registered`,
        { runtime },
      );
    }
    if (!capabilities.length) {
      throw new HarnessRegistryError(
        "capabilities_required",
        `harness '${runtime}' must declare at least one capability`,
        { runtime },
      );
    }
    this.byRuntime.set(runtime, {
      runtime,
      adapter,
      capabilities: new Set(capabilities),
    });
  }

  has(runtime: string): boolean {
    return this.byRuntime.has(runtime);
  }

  get(runtime: string): HarnessRegistration | undefined {
    return this.byRuntime.get(runtime);
  }

  list(): HarnessRegistration[] {
    return [...this.byRuntime.values()].sort((a, b) => a.runtime.localeCompare(b.runtime));
  }

  listRuntimes(): string[] {
    return this.list().map((r) => r.runtime);
  }

  hasCapability(runtime: string, capability: HarnessCapability): boolean {
    return this.byRuntime.get(runtime)?.capabilities.has(capability) ?? false;
  }

  /**
   * Refuse unsupported runtimes / missing capabilities before mutation.
   * Call at preflight / launch / project boundaries when a registry is injected.
   */
  requireSupported(runtime: string, capability: HarnessCapability = "runtime"): HarnessRegistration {
    const reg = this.byRuntime.get(runtime);
    if (!reg) {
      throw new HarnessRegistryError(
        "unsupported_runtime",
        `harness runtime '${runtime}' is not registered; refuse before mutation`,
        { runtime, registered: this.listRuntimes() },
      );
    }
    if (!reg.capabilities.has(capability)) {
      throw new HarnessRegistryError(
        "capability_missing",
        `harness '${runtime}' lacks capability '${capability}'; refuse before mutation`,
        { runtime, capability, capabilities: [...reg.capabilities] },
      );
    }
    return reg;
  }

  /** Record<runtime, adapter> shape consumed by existing orchestrators. */
  adaptersAsRecord(): Record<string, RuntimeAdapter> {
    const out: Record<string, RuntimeAdapter> = {};
    for (const reg of this.byRuntime.values()) {
      out[reg.runtime] = reg.adapter;
    }
    return out;
  }

  /**
   * Builtin capability matrix for shipped adapters on current main.
   * Matches {@link BUILT_IN_RUNTIMES}; no prime-agent / meta_harness.
   */
  static builtinCapabilities(runtime: string): HarnessCapability[] {
    switch (runtime) {
      case "claude-code":
      case "codex":
        return ["runtime", "workflow_agent", "project", "launch"];
      case "pi":
      case "omp":
        return ["runtime", "project", "launch"];
      case "stub":
        return ["runtime", "workflow_agent", "project", "launch", "synthetic"];
      case "terminal":
        return ["runtime", "launch"];
      default:
        return ["runtime"];
    }
  }

  /** Capability matrix snapshot for regression tests / operator docs. */
  static capabilityMatrix(): Record<string, HarnessCapability[]> {
    const out: Record<string, HarnessCapability[]> = {};
    for (const runtime of [...BUILT_IN_RUNTIMES].sort()) {
      out[runtime] = HarnessRegistry.builtinCapabilities(runtime);
    }
    return out;
  }
}

/**
 * Seed a registry from an existing adapters map (startup / tests).
 * Unknown runtimes get a minimal `runtime` capability only.
 */
export function harnessRegistryFromAdapters(
  adapters: Record<string, RuntimeAdapter>,
): HarnessRegistry {
  const registry = new HarnessRegistry();
  for (const [runtime, adapter] of Object.entries(adapters)) {
    const caps = HarnessRegistry.builtinCapabilities(adapter.runtime || runtime);
    registry.register(adapter, caps);
  }
  return registry;
}
