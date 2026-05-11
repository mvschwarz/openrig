// V0.3.1 slice 05 kernel-rig-as-default — kernel auto-boot path.
//
// Composes into rig daemon start per IMPL-PRD §6.1: probes runtime
// auth state, selects a variant (dual / claude-only / codex-only),
// and fires the in-process bootstrap pipeline IN THE BACKGROUND.
// Short-circuits cleanly when:
//   - OPENRIG_NO_KERNEL=1 is set (operator opt-out / test fixture)
//   - A managed rig named `kernel` already exists in the DB
//   - Both runtimes are unauthenticated (auth_blocked terminal state)
//   - The selected variant's spec file is missing
//
// Forward-fix #3 architectural amendment (IMPL-PRD §16 amended):
// The bootstrap promise is NOT awaited. KernelBootTracker is returned
// immediately so createDaemon can finish + server.ts can bind healthz.
// A broken kernel agent therefore can no longer keep the daemon's HTTP
// surface from starting — operators see "daemon ready; kernel <state>"
// rather than "daemon failed to start".

import nodePath from "node:path";
import { existsSync } from "node:fs";
import type { RigRepository } from "./rig-repository.js";
import type { BootstrapOrchestrator } from "./bootstrap-orchestrator.js";
import type { EventBus } from "./event-bus.js";
import type { SessionRegistry } from "./session-registry.js";
import { KernelBootTracker } from "./kernel-boot-tracker.js";

export type RuntimeAuthStatus = "ok" | "unavailable";

export interface RuntimeProbeResult {
  claudeCode: RuntimeAuthStatus;
  codex: RuntimeAuthStatus;
}

export interface KernelBootDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  bootstrapOrchestrator: BootstrapOrchestrator;
  /** Absolute path to the daemon's specs dir (passed in so tests can
   *  inject a fixture root). Production callsite resolves to the
   *  packaged `packages/daemon/specs/` location. */
  specsDir: string;
  /** cwdOverride passed to BootstrapOrchestrator.bootstrap. Kernel
   *  members run against the operator's environment, not the daemon
   *  installation tree — without this override, the bootstrap path
   *  refuses with `cwd is inside the OpenRig installation`. Production
   *  callsite passes the resolved workspace.root setting; tests inject
   *  a fixture path. */
  cwdOverride: string;
  /** Runtime auth probe — defaults to live shellouts; tests inject. */
  probeRuntimes?: () => Promise<RuntimeProbeResult>;
  /** Logger sink; defaults to console.log/warn so daemon stdout/stderr
   *  carry the boot trace. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Degraded-timer override (ms). Forward-fix #3 default 90s; tests
   *  pass short values to exercise the timer path quickly. */
  degradedTimeoutMs?: number;
}

/** Entry point. Idempotent: safe to call on every daemon startup.
 *  Returns the tracker immediately; bootstrap (if fired) runs in the
 *  background. Callers should NOT await the tracker's internal
 *  bootstrap promise — that's the whole point of the architectural
 *  decoupling. Tracker state is observable via getStatus() and the
 *  /api/kernel/status route. */
export async function bootKernelIfNeeded(deps: KernelBootDeps): Promise<KernelBootTracker> {
  const log = deps.log ?? defaultLog;
  const tracker = new KernelBootTracker({
    eventBus: deps.eventBus,
    sessionRegistry: deps.sessionRegistry,
    rigRepo: deps.rigRepo,
    degradedTimeoutMs: deps.degradedTimeoutMs,
  });

  // 1. --no-kernel opt-out (CLI flag projected via OPENRIG_NO_KERNEL).
  // VITEST env additionally short-circuits the live runtime probe
  // path so daemon-composition tests don't block 5s+ on shelled-out
  // claude/codex CLI calls — real production probes complete in
  // ~100ms; this is an explicit test-fast escape hatch so individual
  // test files don't each have to remember to set OPENRIG_NO_KERNEL=1.
  // The auto-skip is suppressed when deps.probeRuntimes is injected:
  // kernel-boot's own unit tests inject a fast deterministic probe
  // and explicitly want to exercise the full logic.
  const probeInjected = typeof deps.probeRuntimes === "function";
  if (process.env["OPENRIG_NO_KERNEL"] === "1" || (process.env["VITEST"] === "true" && !probeInjected)) {
    const reason = process.env["OPENRIG_NO_KERNEL"] === "1" ? "OPENRIG_NO_KERNEL=1" : "VITEST=true";
    log("info", `kernel-boot: ${reason} — skipping kernel auto-boot`);
    tracker.setSkipped(reason);
    return tracker;
  }

  // 2. Already-managed short-circuit. If a rig named `kernel` exists
  // (e.g., from a prior boot or operator-migrated substrate kernel),
  // the builtin path stays out of the way.
  if (kernelAlreadyManaged(deps.rigRepo)) {
    log("info", "kernel-boot: kernel rig already managed; skipping builtin boot");
    tracker.setSkipped("kernel rig already managed");
    return tracker;
  }

  // 3. Probe runtime auth state to pick a variant.
  const probe = await (deps.probeRuntimes ?? defaultProbeRuntimes)();

  if (probe.claudeCode === "unavailable" && probe.codex === "unavailable") {
    const msg = authBlockMessage();
    log("error", msg);
    tracker.setAuthBlocked(msg);
    return tracker;
  }

  const variant = selectVariant(probe);
  const specPath = nodePath.join(deps.specsDir, "rigs/launch/kernel", variant);

  if (!existsSync(specPath)) {
    log("warn", `kernel-boot: spec missing at ${specPath} — skipping`);
    tracker.setSpecMissing(specPath);
    return tracker;
  }

  // 4. Cold boot via the in-process bootstrap pipeline — FIRED, not awaited.
  log("info", `kernel-boot: booting kernel rig from ${variant}`);
  const bootstrapPromise = deps.bootstrapOrchestrator.bootstrap({
    mode: "apply",
    sourceRef: specPath,
    sourceKind: "rig_spec",
    autoApprove: true,
    cwdOverride: deps.cwdOverride,
  });
  tracker.startBooting(variant, bootstrapPromise);
  return tracker;
}

/** True when a rig named `kernel` already exists in the DB. */
export function kernelAlreadyManaged(rigRepo: RigRepository): boolean {
  const rigs = rigRepo.listRigs();
  return rigs.some((r) => r.name === "kernel");
}

/** Choose a rig variant from the auth probe. */
export function selectVariant(probe: RuntimeProbeResult): string {
  if (probe.claudeCode === "ok" && probe.codex === "ok") return "rig.yaml";
  if (probe.claudeCode === "ok") return "rig-claude-only.yaml";
  if (probe.codex === "ok") return "rig-codex-only.yaml";
  // Caller is expected to short-circuit before reaching here on the
  // both-unavailable path; defensive default keeps the type narrow.
  return "rig.yaml";
}

/** Default auth probe — shells out to the runtime CLIs. */
async function defaultProbeRuntimes(): Promise<RuntimeProbeResult> {
  const { exec } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execAsync = promisify(exec);

  async function tryProbe(cmd: string): Promise<RuntimeAuthStatus> {
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 5000 });
      const out = `${stdout}\n${stderr}`.toLowerCase();
      // Conservative parse: any indicator the CLI considers itself
      // unauthenticated marks the runtime unavailable. Tighter parsing
      // can land in a follow-up.
      if (out.includes("not logged") || out.includes("not authenticated") || out.includes("login required")) {
        return "unavailable";
      }
      return "ok";
    } catch {
      return "unavailable";
    }
  }

  const [claudeCode, codex] = await Promise.all([
    tryProbe("claude auth status"),
    tryProbe("codex login status"),
  ]);

  return { claudeCode, codex };
}

/** Honest 3-part-error message for the auth-block path. Per IMPL-PRD
 *  §6.3 + the building-agent-software skill discipline. */
export function authBlockMessage(): string {
  return [
    "Error: Kernel rig cannot boot — no AI runtime is authenticated.",
    "Reason: Kernel rig requires at least one of Claude Code or Codex authenticated. Both are unavailable.",
    "Fix: Run `claude auth login` to authenticate Claude Code, OR `codex login` to authenticate Codex. Then run `rig daemon start` (or `rig setup`) again.",
  ].join("\n");
}

function defaultLog(level: "info" | "warn" | "error", message: string): void {
  if (level === "error") console.error(message);
  else if (level === "warn") console.warn(message);
  else console.log(message);
}
