// V0.3.1 slice 05 kernel-rig-as-default — kernel auto-boot tests.
//
// Covers HG-2 (variant selection), HG-3 (auth-block 3-part error),
// HG-4 (already-managed short-circuit), HG-6 (--no-kernel flag via
// OPENRIG_NO_KERNEL env). Lifecycle in production is bootstrap-driven
// (BootstrapOrchestrator.bootstrap()); these tests inject a mocked
// orchestrator + probe so the logic is exercised without invoking the
// in-process bootstrap pipeline.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootKernelIfNeeded,
  selectVariant,
  kernelAlreadyManaged,
  authBlockMessage,
  type KernelBootDeps,
  type RuntimeProbeResult,
} from "../src/domain/kernel-boot.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";

function makeRigRepo(existingRigs: Array<{ name: string }>): RigRepository {
  return { listRigs: () => existingRigs } as unknown as RigRepository;
}

function makeBootstrapMock(result?: { errors?: string[]; throwError?: Error }) {
  return {
    bootstrap: vi.fn(async () => {
      if (result?.throwError) throw result.throwError;
      return {
        runId: "test",
        status: "ok",
        stages: [],
        errors: result?.errors ?? [],
        warnings: [],
      };
    }),
  } as unknown as BootstrapOrchestrator;
}

let tmpSpecsDir: string;

beforeEach(() => {
  tmpSpecsDir = mkdtempSync(join(tmpdir(), "kernel-boot-"));
  // Populate the 3 variant files so existsSync(specPath) succeeds.
  const kernelDir = join(tmpSpecsDir, "rigs/launch/kernel");
  mkdirSync(kernelDir, { recursive: true });
  writeFileSync(join(kernelDir, "rig.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-claude-only.yaml"), "name: kernel\n");
  writeFileSync(join(kernelDir, "rig-codex-only.yaml"), "name: kernel\n");
});

afterEach(() => {
  delete process.env.OPENRIG_NO_KERNEL;
  if (tmpSpecsDir) rmSync(tmpSpecsDir, { recursive: true, force: true });
});

describe("selectVariant — auth-state → variant mapping", () => {
  it("picks rig.yaml when both runtimes available", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "ok" })).toBe("rig.yaml");
  });
  it("picks rig-claude-only.yaml when only Claude available", () => {
    expect(selectVariant({ claudeCode: "ok", codex: "unavailable" })).toBe("rig-claude-only.yaml");
  });
  it("picks rig-codex-only.yaml when only Codex available", () => {
    expect(selectVariant({ claudeCode: "unavailable", codex: "ok" })).toBe("rig-codex-only.yaml");
  });
});

describe("kernelAlreadyManaged — short-circuit predicate", () => {
  it("returns true when a rig named 'kernel' exists", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "kernel" }, { name: "other" }]))).toBe(true);
  });
  it("returns false when no rig is named 'kernel' (case-sensitive)", () => {
    expect(kernelAlreadyManaged(makeRigRepo([{ name: "Kernel" }, { name: "other" }]))).toBe(false);
  });
  it("returns false on an empty rig list", () => {
    expect(kernelAlreadyManaged(makeRigRepo([]))).toBe(false);
  });
});

describe("authBlockMessage — 3-part error contract", () => {
  it("includes Error/Reason/Fix lines per building-agent-software skill discipline", () => {
    const msg = authBlockMessage();
    expect(msg).toMatch(/^Error:/m);
    expect(msg).toMatch(/^Reason:/m);
    expect(msg).toMatch(/^Fix:/m);
    expect(msg).toContain("claude auth login");
    expect(msg).toContain("codex login");
  });
});

describe("bootKernelIfNeeded — short-circuit branches", () => {
  it("skips with outcome=skipped_no_kernel_flag when OPENRIG_NO_KERNEL=1", async () => {
    process.env.OPENRIG_NO_KERNEL = "1";
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: makeBootstrapMock(),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("skipped_no_kernel_flag");
    expect((deps.bootstrapOrchestrator as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("skips with outcome=skipped_already_managed when a kernel rig already exists", async () => {
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([{ name: "kernel" }]),
      bootstrapOrchestrator: makeBootstrapMock(),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("skipped_already_managed");
    expect((deps.bootstrapOrchestrator as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns auth_blocked when neither runtime is available", async () => {
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: makeBootstrapMock(),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "unavailable" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("auth_blocked");
    expect(result.detail).toMatch(/^Error: Kernel rig cannot boot/);
    expect((deps.bootstrapOrchestrator as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns spec_missing when the chosen variant file doesn't exist", async () => {
    rmSync(join(tmpSpecsDir, "rigs/launch/kernel/rig.yaml"));
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: makeBootstrapMock(),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("spec_missing");
  });
});

describe("bootKernelIfNeeded — happy path", () => {
  it("invokes BootstrapOrchestrator.bootstrap with the dual variant when both runtimes available", async () => {
    const bootstrap = makeBootstrapMock();
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: bootstrap,
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("booted");
    expect(result.variant).toBe("rig.yaml");
    const bootstrapMock = (bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap;
    expect(bootstrapMock).toHaveBeenCalledOnce();
    const opts = bootstrapMock.mock.calls[0]![0];
    expect(opts.mode).toBe("apply");
    expect(opts.sourceRef).toBe(join(tmpSpecsDir, "rigs/launch/kernel", "rig.yaml"));
    expect(opts.sourceKind).toBe("rig_spec");
    expect(opts.autoApprove).toBe(true);
    // V0.3.1 slice 05 forward-fix: cwdOverride threads through to
    // bootstrap so kernel members run against the operator's
    // workspace, not the daemon installation tree.
    expect(opts.cwdOverride).toBe(tmpSpecsDir);
  });

  it("returns bootstrap_failed and surfaces error detail when orchestrator reports errors", async () => {
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: makeBootstrapMock({ errors: ["preflight: tmux missing"] }),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("bootstrap_failed");
    expect(result.detail).toContain("tmux missing");
  });

  it("returns bootstrap_failed and surfaces thrown error message", async () => {
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: makeBootstrapMock({ throwError: new Error("network blip") }),
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("bootstrap_failed");
    expect(result.detail).toBe("network blip");
  });

  it("uses the claude-only variant when only Claude is available", async () => {
    const bootstrap = makeBootstrapMock();
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: bootstrap,
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "unavailable" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("booted");
    expect(result.variant).toBe("rig-claude-only.yaml");
  });

  it("uses the codex-only variant when only Codex is available", async () => {
    const bootstrap = makeBootstrapMock();
    const deps: KernelBootDeps = {
      rigRepo: makeRigRepo([]),
      bootstrapOrchestrator: bootstrap,
      specsDir: tmpSpecsDir,
      cwdOverride: tmpSpecsDir,
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "ok" }),
      log: () => {},
    };
    const result = await bootKernelIfNeeded(deps);
    expect(result.outcome).toBe("booted");
    expect(result.variant).toBe("rig-codex-only.yaml");
  });
});
