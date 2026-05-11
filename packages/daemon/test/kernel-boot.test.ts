// V0.3.1 slice 05 kernel-rig-as-default — kernel auto-boot tests.
//
// Covers HG-2 (variant selection), HG-3 (auth-block 3-part error),
// HG-4 (already-managed short-circuit), HG-6 (--no-kernel flag via
// OPENRIG_NO_KERNEL env). Forward-fix #3 architectural amendment:
// bootKernelIfNeeded now returns a KernelBootTracker; the bootstrap
// runs in the background. Tests await microtasks to observe the
// post-bootstrap tracker state.

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
} from "../src/domain/kernel-boot.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import type { BootstrapOrchestrator } from "../src/domain/bootstrap-orchestrator.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";

function makeRigRepo(existingRigs: Array<{ id?: string; name: string }>): RigRepository {
  return {
    listRigs: () => existingRigs,
    findRigsByName: (name: string) => existingRigs.filter((r) => r.name === name),
  } as unknown as RigRepository;
}

function makeSessionRegistry(sessionsByRig: Record<string, Array<{ sessionName: string; runtime?: string; startupStatus: string }>> = {}): SessionRegistry {
  return {
    getSessionsForRig: (rigId: string) => sessionsByRig[rigId] ?? [],
  } as unknown as SessionRegistry;
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ type: string }> } {
  const emitted: Array<{ type: string }> = [];
  const bus = {
    emit: (event: { type: string }) => {
      emitted.push(event);
      return event;
    },
  } as unknown as EventBus;
  return { bus, emitted };
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

/** Await pending microtasks so tracker's bootstrap-promise handlers can
 *  fire before status is read. The setImmediate hop is enough for
 *  vi.fn-wrapped async mocks that resolve in the same tick. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function makeBaseDeps(
  overrides: Partial<KernelBootDeps>,
  specsDir: string,
): KernelBootDeps {
  return {
    rigRepo: makeRigRepo([]),
    sessionRegistry: makeSessionRegistry(),
    eventBus: makeEventBus().bus,
    bootstrapOrchestrator: makeBootstrapMock(),
    specsDir,
    cwdOverride: specsDir,
    probeRuntimes: async () => ({ claudeCode: "ok", codex: "ok" }),
    log: () => {},
    degradedTimeoutMs: 0, // disable degraded timer for default tests
    ...overrides,
  };
}

let tmpSpecsDir: string;

beforeEach(() => {
  tmpSpecsDir = mkdtempSync(join(tmpdir(), "kernel-boot-"));
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
  it("returns skipped tracker when OPENRIG_NO_KERNEL=1", async () => {
    process.env.OPENRIG_NO_KERNEL = "1";
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toBe("OPENRIG_NO_KERNEL=1");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns skipped tracker when a kernel rig is already managed", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      rigRepo: makeRigRepo([{ name: "kernel" }]),
      bootstrapOrchestrator: bootstrap,
    }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("skipped");
    expect(tracker.getStatus().detail).toContain("already managed");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns auth_blocked tracker when neither runtime is available", async () => {
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: bootstrap,
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "unavailable" }),
    }, tmpSpecsDir));
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("auth_blocked");
    expect(status.detail).toMatch(/^Error: Kernel rig cannot boot/);
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });

  it("returns spec_missing tracker when the chosen variant file doesn't exist", async () => {
    rmSync(join(tmpSpecsDir, "rigs/launch/kernel/rig.yaml"));
    const bootstrap = makeBootstrapMock();
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("spec_missing");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).not.toHaveBeenCalled();
  });
});

describe("bootKernelIfNeeded — fire-and-forget bootstrap", () => {
  it("fires bootstrap in the background with the resolved variant + correct opts", async () => {
    // Hold the bootstrap mock open so we can observe the in-flight
    // booting state deterministically before the promise resolves.
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    const bootstrap = {
      bootstrap: vi.fn(async () => {
        await blocked;
        return { runId: "t", status: "ok", stages: [], errors: [], warnings: [] };
      }),
    } as unknown as BootstrapOrchestrator;
    const tracker = await bootKernelIfNeeded(makeBaseDeps({ bootstrapOrchestrator: bootstrap }, tmpSpecsDir));
    expect(tracker.getStatus().kernelState).toBe("booting");
    expect(tracker.getStatus().variant).toBe("rig.yaml");
    expect((bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap).toHaveBeenCalledOnce();
    const opts = (bootstrap as unknown as { bootstrap: ReturnType<typeof vi.fn> }).bootstrap.mock.calls[0]![0];
    expect(opts.mode).toBe("apply");
    expect(opts.sourceRef).toBe(join(tmpSpecsDir, "rigs/launch/kernel", "rig.yaml"));
    expect(opts.sourceKind).toBe("rig_spec");
    expect(opts.autoApprove).toBe(true);
    expect(opts.cwdOverride).toBe(tmpSpecsDir);
    release();
    tracker.stop();
  });

  it("transitions to bootstrap_failed when orchestrator returns errors (post-flush)", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ errors: ["preflight: tmux missing"] }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toContain("tmux missing");
    tracker.stop();
  });

  it("transitions to bootstrap_failed and surfaces thrown error message (post-flush)", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      bootstrapOrchestrator: makeBootstrapMock({ throwError: new Error("network blip") }),
    }, tmpSpecsDir));
    await flushPromises();
    const status = tracker.getStatus();
    expect(status.kernelState).toBe("bootstrap_failed");
    expect(status.detail).toBe("network blip");
    tracker.stop();
  });

  it("uses the claude-only variant when only Claude is available", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "ok", codex: "unavailable" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-claude-only.yaml");
    tracker.stop();
  });

  it("uses the codex-only variant when only Codex is available", async () => {
    const tracker = await bootKernelIfNeeded(makeBaseDeps({
      probeRuntimes: async () => ({ claudeCode: "unavailable", codex: "ok" }),
    }, tmpSpecsDir));
    expect(tracker.getStatus().variant).toBe("rig-codex-only.yaml");
    tracker.stop();
  });
});
