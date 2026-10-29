import { describe, it, expect, beforeEach } from "vitest";
import type {
  RuntimeAdapter,
  NodeBinding,
  ResolvedStartupFile,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  HarnessLaunchResult,
  ForkSource,
  InstalledResource,
} from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import {
  HarnessRegistry,
  HarnessRegistryError,
  harnessRegistryFromAdapters,
} from "../src/domain/harness-registry.js";
import { BUILT_IN_RUNTIMES } from "../src/domain/built-in-runtimes.js";
import { preflightValidatedSpec } from "../src/domain/rigspec-preflight.js";
import type { RigSpec as PodRigSpec } from "../src/domain/types.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";

/** Synthetic harness outside core — registered via capabilities, not allowlist edits. */
class SyntheticHarnessAdapter implements RuntimeAdapter {
  readonly runtime = "synthetic";
  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }
  async project(_plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    return { projected: [], skipped: [], failed: [] };
  }
  async deliverStartup(
    _files: ResolvedStartupFile[],
    _binding: NodeBinding,
  ): Promise<StartupDeliveryResult> {
    return { delivered: 0, failed: [] };
  }
  async launchHarness(
    _binding: NodeBinding,
    _opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    return { ok: true, resumeToken: "synthetic-token" };
  }
  async checkReady(_binding: NodeBinding): Promise<ReadinessResult> {
    return { ready: true };
  }
}

class NamedAdapter implements RuntimeAdapter {
  constructor(readonly runtime: string) {}
  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    return [];
  }
  async project(_plan: ProjectionPlan, _binding: NodeBinding): Promise<ProjectionResult> {
    return { projected: [], skipped: [], failed: [] };
  }
  async deliverStartup(
    _files: ResolvedStartupFile[],
    _binding: NodeBinding,
  ): Promise<StartupDeliveryResult> {
    return { delivered: 0, failed: [] };
  }
  async launchHarness(
    _binding: NodeBinding,
    _opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    return { ok: true };
  }
  async checkReady(_binding: NodeBinding): Promise<ReadinessResult> {
    return { ready: true };
  }
}

function terminalSpec(runtime: string): PodRigSpec {
  return {
    version: "0.2",
    name: "registry-preflight",
    pods: [{
      id: "dev",
      label: "Dev",
      members: [{
        id: "shell",
        agentRef: "builtin:terminal",
        profile: "none",
        runtime,
        cwd: "/tmp",
      }],
      edges: [],
    }],
    edges: [],
  };
}

const fsOps: AgentResolverFsOps = {
  readFile: () => {
    throw new Error("unexpected read");
  },
  exists: () => false,
};

describe("HarnessRegistry (interim toward #43)", () => {
  let registry: HarnessRegistry;

  beforeEach(() => {
    registry = new HarnessRegistry();
  });

  it("registers a synthetic harness without editing core allowlists", () => {
    registry.register(new SyntheticHarnessAdapter(), [
      "runtime",
      "launch",
      "project",
      "synthetic",
      "workflow_agent",
    ]);
    expect(registry.has("synthetic")).toBe(true);
    expect(registry.hasCapability("synthetic", "workflow_agent")).toBe(true);
    expect(registry.listRuntimes()).toEqual(["synthetic"]);
  });

  it("requireSupported refuses unsupported runtime before mutation", () => {
    expect(() => registry.requireSupported("not-a-runtime")).toThrow(HarnessRegistryError);
    try {
      registry.requireSupported("not-a-runtime");
    } catch (err) {
      expect((err as HarnessRegistryError).code).toBe("unsupported_runtime");
    }
  });

  it("requireSupported refuses missing capability before mutation", () => {
    registry.register(new SyntheticHarnessAdapter(), ["runtime", "synthetic"]);
    expect(() => registry.requireSupported("synthetic", "launch")).toThrow(HarnessRegistryError);
    try {
      registry.requireSupported("synthetic", "launch");
    } catch (err) {
      expect((err as HarnessRegistryError).code).toBe("capability_missing");
    }
  });

  it("adaptersAsRecord exposes the registered adapter for orchestrators", () => {
    const adapter = new SyntheticHarnessAdapter();
    registry.register(adapter, ["runtime", "launch"]);
    expect(registry.adaptersAsRecord().synthetic).toBe(adapter);
  });

  it("capabilityMatrix covers exactly current built-in runtimes (no prime-agent)", () => {
    const matrix = HarnessRegistry.capabilityMatrix();
    expect(new Set(Object.keys(matrix))).toEqual(BUILT_IN_RUNTIMES);
    expect(matrix).not.toHaveProperty("prime-agent");
    expect(matrix.omp).toEqual(["runtime", "project", "launch"]);
    expect(matrix.stub).toContain("synthetic");
  });

  it("harnessRegistryFromAdapters seeds builtin capabilities", () => {
    const seeded = harnessRegistryFromAdapters({
      "claude-code": new NamedAdapter("claude-code"),
      terminal: new NamedAdapter("terminal"),
    });
    expect(seeded.hasCapability("claude-code", "workflow_agent")).toBe(true);
    expect(seeded.hasCapability("terminal", "launch")).toBe(true);
    expect(seeded.hasCapability("terminal", "workflow_agent")).toBe(false);
  });
});

describe("HarnessRegistry optional preflight hook", () => {
  it("without registry, built-in terminal still admits and unknown still fails closed", async () => {
    const ok = await preflightValidatedSpec(terminalSpec("terminal"), {
      rigRoot: "/tmp",
      fsOps,
      materializeOnly: true,
    });
    expect(ok.errors.filter((e) => e.includes("unsupported runtime"))).toEqual([]);

    const bad = await preflightValidatedSpec(terminalSpec("not-registered"), {
      rigRoot: "/tmp",
      fsOps,
      materializeOnly: true,
    });
    expect(bad.errors.some((e) => e.includes('unsupported runtime "not-registered"'))).toBe(true);
  });

  it("with registry, synthetic harness admitted by capability registration", async () => {
    const registry = new HarnessRegistry();
    registry.register(new SyntheticHarnessAdapter(), ["runtime", "launch", "synthetic"]);

    const result = await preflightValidatedSpec(terminalSpec("synthetic"), {
      rigRoot: "/tmp",
      fsOps,
      materializeOnly: true,
      harnessRegistry: registry,
    });
    expect(result.errors.filter((e) => e.includes("unsupported runtime"))).toEqual([]);
  });

  it("with registry, missing registration fails closed before community fallback for terminal seats", async () => {
    const registry = new HarnessRegistry();
    registry.register(new NamedAdapter("terminal"), ["runtime", "launch"]);

    const result = await preflightValidatedSpec(terminalSpec("ghost-runtime"), {
      rigRoot: "/tmp",
      fsOps,
      materializeOnly: true,
      harnessRegistry: registry,
    });
    expect(result.errors.some((e) => e.includes('unsupported runtime "ghost-runtime"'))).toBe(true);
  });
});
