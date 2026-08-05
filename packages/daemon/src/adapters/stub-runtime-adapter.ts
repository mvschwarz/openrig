// OPR.0.5.1.1 — the stub runtime adapter (A5 / ContextMonitor settlement).
//
// Promotes the claude-stub seed to a first-class `runtime: stub`. Pi-shaped:
// a node-script runner hosted in the seat's normal tmux pane (stub-runner.ts),
// launched via tmux, its readiness read from a runner-authored sidecar — never
// pane heuristics. The stub RUNS the runtime-agnostic lifecycle (real projection
// + startup-file delivery to cwd); it does NOT fabricate outputs (A5 binding:
// the stub TRIGGERS real seams, never FABRICATES).
//
// Step-4 scope (A5 first-production-RED order item 4): the four RuntimeAdapter
// verbs + the runner + registration, turning STEP2/STEP3/FACT2/FACT3 green (and
// FACT4 restore + FACT5a-d readiness). The A5 ContextMonitor GAP-1/GAP-2 edits
// (ctx% via ContextUsageStore) and the four seeded behaviors are later RED-first
// increments (A5 items 5-8) — deliberately NOT here.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import { yoloEnabled, type ResolvedLaunchPosture } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  stubSeatSidecarPath, buildStubRunnerCommand, parseStubRunnerState,
  type StubRunnerState,
} from "./stub-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface StubAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface StubRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  /** Real filesystem operations. Absent in minimal/hermetic test constructions —
   *  the adapter then falls back to an in-memory launch record for readiness and
   *  performs NO real filesystem writes (so a `cwd: "."` binding never pollutes
   *  the daemon's own working directory). Production always wires this. */
  fsOps?: StubAdapterFsOps;
  /** Runtime label. Defaults to "stub"; accepted as a dep so a test can name it. */
  runtime?: string;
  /** Absolute path to the compiled stub-runner entry in the daemon dist. When
   *  present, launchHarness spawns the real runner (with a MANDATORY existence
   *  fail-fast); when absent, launchHarness takes the hermetic in-memory path. */
  runnerEntryPath?: string;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

/** In-memory launch record: the readiness fallback for the hermetic path (no
 *  fsOps, no runner). Keyed by tmux session. */
interface StubLaunchRecord {
  ready: boolean;
  launchId: string;
  exited?: { code: number | null };
}

export class StubRuntimeAdapter implements RuntimeAdapter {
  readonly runtime: string;
  private tmux: TmuxAdapter;
  private fsOps?: StubAdapterFsOps;
  private runnerEntryPath?: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;
  private readonly launchRecords = new Map<string, StubLaunchRecord>();

  constructor(deps: StubRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fsOps = deps.fsOps;
    this.runtime = deps.runtime ?? "stub";
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    // A fresh stub seat tracks nothing until projection runs; nothing durable to
    // enumerate at MVP (mirrors terminal/pi-with-no-skills). Honest empty.
    return [];
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        if (!this.fsOps) throw new Error("no fsOps configured — cannot read startup file content");
        const content = this.fsOps.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            if (!this.mergeGuidance(targetPath, file.path, content)) continue; // rig-role skip
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".openrig", "stub", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fsOps.mkdirp(targetDir);
            this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the stub harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.forkSource) {
      // The stub runtime has no native fork primitive (the seeded behaviors do not
      // include session fork); refuse clearly rather than guess (contract rule).
      return { ok: false, error: "stub runtime has no native fork primitive; remove session_source for stub members" };
    }

    const sessionName = binding.tmuxSession;
    const launchId = this.newLaunchId();

    if (this.runnerEntryPath) {
      // PRODUCTION path: spawn the real pane-hosted runner.
      // MANDATORY runner-existence fail-fast (A5 HIGH-6): a missing packaged runner
      // is a hard, immediate failure, never a silent hang.
      if (!this.fsOps || !this.fsOps.exists(this.runnerEntryPath)) {
        return { ok: false, error: `stub-runner entry not found at ${this.runnerEntryPath} — the daemon package is incomplete` };
      }
      const posture: ResolvedLaunchPosture = yoloEnabled(process.env, binding.launchPosture) ? "full_bypass" : "floor";
      const cmd = buildStubRunnerCommand({
        runnerEntryPath: this.runnerEntryPath,
        sessionName,
        cwd: binding.cwd,
        launchId,
        posture,
        resumeToken: opts.resumeToken,
      });
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) return { ok: false, error: `Failed to send stub launch command: ${textResult.message}` };
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };

      const ready = await this.waitForRunnerReady(binding, launchId);
      if (!ready.ok) return ready.failure;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "stub_session" : undefined };
    }

    // HERMETIC path (no runner configured): record the launch as the readiness
    // source and return. No real filesystem write — a `cwd: "."` binding never
    // pollutes the daemon's own working directory.
    this.launchRecords.set(sessionName, { ready: true, launchId });
    return { ok: true, resumeToken: opts.resumeToken, resumeType: opts.resumeToken ? "stub_session" : undefined };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    const sessionName = binding.tmuxSession;
    if (!sessionName) return { ready: false, reason: "No tmux session bound" };

    // Readiness EVIDENCE: the runner-authored sidecar when fsOps is wired
    // (production + FACT5), else the in-memory launch record (hermetic FACT3/FACT4).
    const state: StubRunnerState | StubLaunchRecord | null = this.fsOps
      ? this.readReadinessSidecar(binding.cwd)
      : this.launchRecords.get(sessionName) ?? null;

    if (!state) return { ready: false, reason: "stub seat has not reported readiness", code: "awaiting_runtime" };
    if (state.exited) {
      return { ready: false, reason: `stub-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (!state.ready) return { ready: false, reason: "stub-runner has not reported ready yet", code: "awaiting_runtime" };

    // Liveness cross-checks — ONLY where the tmux surface supports them (production
    // wires a full tmux; hermetic constructions pass a minimal/empty tmux, so the
    // in-memory record above is authoritative and tmux is never touched). A ready
    // sidecar/record does NOT prove current liveness on its own: a dead runner
    // leaves the pane at a shell, and a stale sidecar can outlive it.
    if (this.fsOps) {
      if (typeof this.tmux?.hasSession === "function") {
        if (!(await this.tmux.hasSession(sessionName))) {
          return { ready: false, reason: "tmux session not responsive" };
        }
      }
      if (typeof this.tmux?.getPaneCommand === "function") {
        const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
        if (SHELL_COMMANDS.has(paneCommand)) {
          return { ready: false, reason: "stub readiness is stale; the pane is back at a shell", code: "runner_exited" };
        }
      }
    }

    return { ready: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readReadinessSidecar(cwd: string): StubRunnerState | null {
    if (!this.fsOps) return null;
    const sidecarPath = stubSeatSidecarPath(cwd);
    if (!this.fsOps.exists(sidecarPath)) return null;
    try {
      return parseStubRunnerState(this.fsOps.readFile(sidecarPath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    binding: NodeBinding,
    launchId: string,
  ): Promise<{ ok: true } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // ~15s: runner boot + first sidecar write
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readReadinessSidecar(binding.cwd);
      // Launch-attempt scoping (Pi precedent): only THIS attempt's sidecar counts,
      // so a durable artifact from a prior runner instance cannot false-green or
      // false-fail this launch.
      if (state && state.launchId === launchId) {
        if (state.exited) {
          return {
            ok: false,
            failure: { ok: false, error: `stub launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`, recovery: "attention_required" },
          };
        }
        if (state.ready) return { ok: true };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "stub launch: timed out waiting for the runner to report ready", recovery: "attention_required" },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (!this.fsOps) return false;
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      return this.mergeGuidance(targetPath, entry.effectiveId, this.fsOps.readFile(entry.absolutePath));
    }
    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".openrig", "stub", "skills", entry.effectiveId);
      this.fsOps.mkdirp(targetDir);
      const isDir = this.fsOps.listFiles ? this.fsOps.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fsOps.listFiles) {
        for (const file of this.fsOps.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fsOps.mkdirp(nodePath.dirname(dest));
          this.fsOps.writeFile(dest, this.fsOps.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fsOps.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fsOps.readFile(entry.absolutePath));
      }
      return true;
    }
    // Plugins / subagents / runtime resources have no stub projection target at MVP.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    if (!this.fsOps) return false;
    // Per-seat rig-role content collides across pod-mates when merged into a shared
    // cwd file; it is delivered via send_text instead (mirrors the other adapters).
    if (blockId === "rig-role") return false;
    mergeManagedBlock(this.fsOps, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
