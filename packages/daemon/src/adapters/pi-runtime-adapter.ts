// OPR.0.4.6.PI1 — the Pi runtime adapter (RPC-first, runner-in-a-pane).
//
// The adapter launches the OpenRig-owned pi-runner inside the seat's normal
// tmux pane; the runner hosts `pi --mode rpc` (headless JSONL — Pi's
// first-class integration surface). send/capture stay tmux-native and are NOT
// adapter methods (the runner forwards pane stdin to RPC prompt/steer and
// mirrors a legible transcript to pane stdout); activity + session identity
// come from Pi's typed RPC events + get_state via the runner's sidecar and
// bus emission — never pane scraping (BR-1). TUI-native Pi is a SEPARATE
// future contract, never a hidden mode here (BR-2).

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  piSeatPaths, parsePiRunnerState, buildPiRunnerCommand, buildPendingRunnerState,
  PI_RUNNER_READY_MARKER, PI_RUNNER_ERROR_MARKER, PI_RUNNER_EXIT_MARKER,
  type PiRunnerState,
} from "./pi-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface PiAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface PiRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: PiAdapterFsOps;
  /** Root under which every Pi seat gets its isolated state dir (FR-7).
   *  Typically <OPENRIG_HOME>/state/pi. */
  stateRoot: string;
  /** Absolute path to the compiled pi-runner entry in the daemon dist. */
  runnerEntryPath: string;
  /** Trust posture for managed launches (BR-5 — always explicit; ambient
   *  `ask` silently skips in RPC mode). Default: "no-approve" (the
   *  conservative floor; seat-level guidance/skills live in the seat's
   *  managed agent dir, which needs no project trust). */
  trustPosture?: "approve" | "no-approve";
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

export class PiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "pi";
  private tmux: TmuxAdapter;
  private fs: PiAdapterFsOps;
  private stateRoot: string;
  private runnerEntryPath: string;
  private trustPosture: "approve" | "no-approve";
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;

  constructor(deps: PiRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.trustPosture = deps.trustPosture ?? "no-approve";
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** The pi-runner sidecar reader shape resume-token-capture consumes
   *  (deriveResumeToken's piRunnerStateStore dep). */
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      const { runnerStatePath } = piSeatPaths(this.stateRoot, sessionName);
      return this.fs.exists(runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (!state.sessionFile) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.sessionFile };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const sessionName = binding.tmuxSession;
    if (!sessionName) return results;
    const { agentDir } = piSeatPaths(this.stateRoot, sessionName);
    const skillsDir = nodePath.join(agentDir, "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
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
        if (this.projectEntry(entry, binding)) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
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
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // ADDITIVE context-file merge (Omnigent best-practice: never
            // replace Pi's default system prompt). Pi reads AGENTS.md from
            // the managed cwd as a project context file.
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the Pi seat state dir");
            const { agentDir } = piSeatPaths(this.stateRoot, binding.tmuxSession);
            const targetDir = nodePath.join(agentDir, "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              // The runner reads pane stdin and forwards as RPC prompt (FR-3).
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
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the Pi harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    let forkRef: string | undefined;
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `pi fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent session file path or session id`,
        };
      }
      forkRef = opts.forkSource.value?.trim();
      if (!forkRef) {
        return { ok: false, error: "pi fork: forkSource.value is required (parent session file path or session id)" };
      }
    }

    if (opts.resumeToken) {
      // Validity floor before we type anything into the pane.
      const validation = validateResumeToken("pi", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `pi resume: ${validation.error}` };
      }
      if (!this.fs.exists(opts.resumeToken)) {
        // Session file gone — the honest outcome is the caller's stop-and-ask
        // (awaiting-decision), never a silent fresh start (BR-6).
        return { ok: false, error: "pi resume: the persisted session file no longer exists", recovery: "retry_fresh" };
      }
    }

    const sessionName = binding.tmuxSession;
    const paths = piSeatPaths(this.stateRoot, sessionName);
    this.fs.mkdirp(paths.agentDir);
    this.fs.mkdirp(paths.sessionsDir);

    // Launch-attempt scoping (guard fold): overwrite any stale sidecar from a
    // prior runner instance with a pending record BEFORE the command is typed,
    // and only trust sidecar states stamped with THIS attempt's launchId.
    // The prior record is read FIRST so the durable catch-up cursor
    // (lastEntryId, FR-5) survives the reset.
    const launchId = this.newLaunchId();
    const prior = this.readRunnerState(sessionName);
    this.fs.writeFile(
      paths.runnerStatePath,
      JSON.stringify(buildPendingRunnerState(launchId, new Date().toISOString(), prior)),
    );

    const cmd = buildPiRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      cwd: binding.cwd,
      model: binding.model,
      trust: this.trustPosture,
      sessionFile: opts.resumeToken,
      forkRef,
      launchId,
    });

    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    // The runner writes the sidecar after its first successful get_state;
    // that sidecar (not pane content) is the token source of truth (FR-5).
    const state = await this.waitForRunnerReady(sessionName, launchId);
    if (!state.ok) return state.failure;

    const sessionFile = state.value.sessionFile;
    if (!sessionFile) {
      return { ok: false, error: "pi launch: the runner became ready but reported no session file" };
    }
    if (forkRef && sessionFile === forkRef) {
      // The adapter contract requires the NEW post-fork token, never the
      // parent's (runtime-adapter.ts fork rule).
      return { ok: false, error: "pi fork: the runner reported the parent session file instead of the post-fork child" };
    }
    const validation = validateResumeToken("pi", sessionFile);
    if (!validation.ok) {
      return { ok: false, error: `pi launch: the runner reported a malformed session file (${validation.error})` };
    }

    return { ok: true, resumeToken: validation.token, resumeType: "pi_session_file" };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // Guard fold (stale artifacts): a sidecar or scrollback marker can outlive
    // the runner process, so a ready signal counts ONLY while the pane's
    // foreground process is not back at a shell (a dead runner leaves the
    // pane at the shell; READY scrollback and a stale ready sidecar do not
    // make a stopped seat ready).
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(binding.tmuxSession);
    if (state?.exited) {
      return { ready: false, reason: `pi-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "pi-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" };
      }
      return { ready: true };
    }
    // Runner-authored pane marker as the secondary signal (FR-2) — still the
    // runner's own output, never Pi TUI heuristics; same foreground guard.
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    if (paneContent.includes(PI_RUNNER_ERROR_MARKER)) {
      return { ready: false, reason: "pi-runner reported an error in the pane", code: "runner_error" };
    }
    if (paneContent.includes(PI_RUNNER_EXIT_MARKER)) {
      return { ready: false, reason: "pi-runner exited", code: "runner_exited" };
    }
    if (paneContent.includes(PI_RUNNER_READY_MARKER)) {
      if (atShell) {
        return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: "pi-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readRunnerState(sessionName: string): PiRunnerState | null {
    const { runnerStatePath } = piSeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parsePiRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
  ): Promise<{ ok: true; value: PiRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    const attempts = 60; // ~15s: runner boot + pi spawn + first get_state
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readRunnerState(sessionName);
      // Launch-attempt scoping: only THIS attempt's sidecar states count.
      // Stale ready/exited records from prior instances are ignored, and
      // stale pane markers in scrollback are never consulted here — the
      // launch-scoped sidecar is authoritative (the runner writes a pending
      // record immediately at startup and exited on death).
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `pi launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: {
        ok: false,
        error: "pi launch: timed out waiting for the runner to report ready",
        recovery: "attention_required",
      },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      if (!binding.tmuxSession) return false;
      const { agentDir } = piSeatPaths(this.stateRoot, binding.tmuxSession);
      const targetDir = nodePath.join(agentDir, "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
        }
      } else {
        this.fs.writeFile(
          nodePath.join(targetDir, nodePath.basename(entry.absolutePath)),
          this.fs.readFile(entry.absolutePath),
        );
      }
      return true;
    }

    // Plugins / subagents / runtime resources have no Pi projection target at
    // MVP (PRD §7 out-of-scope) — an honest skip, never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex adapters: per-seat `rig-role` content collides
    // across pod-mates when merged into a shared cwd file; it is delivered via
    // send_text instead. See ADR-0006.
    if (blockId === "rig-role") {
      console.log(
        `[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`
      );
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
