// The Oh My Pi (OMP) runtime adapter: OMP's own terminal UI, launched natively in the seat's tmux pane.

import nodePath from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile, InstalledResource, ProjectionResult, StartupDeliveryResult,
  ReadinessResult, HarnessLaunchResult, ForkSource, GuidanceChoice, PreparedInput,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { isPerSeatRoleGuidance, perSeatRoleSkipWarning } from "../domain/managed-blocks.js";
import { writeManagedGuidanceBlock, type ManagedBlockRecords } from "../domain/managed-block-records.js";
import { guidanceFileSharedByLink, lstatLinkInfo } from "../domain/restore-guidance.js";
import { insideMissingFolder } from "../domain/cwd-resolution.js";
import type { TmuxAdapter } from "./tmux.js";
import { paneAtShell, type OmpLaunchFsOps, type OmpSeatLauncher } from "./omp-seat-launch.js";
import { listNativeProcesses } from "../domain/native-process-lineage.js";
import { ompProcessInPane, ompPluginDirName, type OmpSeatState } from "./omp-seat-protocol.js";
import { insideSeatStorageFolder, seatSkillWriteRefusal } from "../domain/seat-skill-storage.js";


export interface OmpAdapterFsOps extends OmpLaunchFsOps {
  folderPresent?(path: string): boolean;
  rename?(source: string, destination: string): void;
  remove?(path: string): void;
  readBytes?(path: string): Buffer;
  copyFile(source: string, destination: string): void;
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  /** Whether a path is a symlink and its hard-link count, or null when it doesn't exist (an lstat). */
  linkInfo?(path: string): { link: boolean; nlink: number } | null;
}

export interface OmpTuiRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: OmpAdapterFsOps;
  /** The launch core, shared with the legacy resume adapter so both start OMP the same way. */
  launcher: OmpSeatLauncher;
  /** With it, every guidance block this adapter writes is checked against the record and recorded. */
  managedBlockRecords?: ManagedBlockRecords;
  boundPaneForSession?: (session: string) => string | null;
  listProcesses?: typeof listNativeProcesses;
  sleep?: (ms: number) => Promise<void>;
}

const RESUME_TYPE = "omp_tui_session_file";

export class OmpTuiRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "omp-tui" as const;
  private readonly tmux: TmuxAdapter;
  private readonly fs: OmpAdapterFsOps;
  private readonly launcher: OmpSeatLauncher;
  private readonly managedBlockRecords: ManagedBlockRecords | undefined;
  private readonly boundPaneForSession: OmpTuiRuntimeAdapterDeps["boundPaneForSession"];
  private readonly listProcesses: typeof listNativeProcesses;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(deps: OmpTuiRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.launcher = deps.launcher;
    this.managedBlockRecords = deps.managedBlockRecords;
    this.boundPaneForSession = deps.boundPaneForSession;
    this.listProcesses = deps.listProcesses ?? listNativeProcesses;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The seat's resumable conversation, as the extension last reported it. OMP names a new session's file before it
   *  writes the first turn; a file that isn't on disk yet has no history to resume and is not a token. */
  readSessionFile(sessionName: string, expectedGeneration?: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const state = this.launcher.readState(sessionName);
    if (state === null) {
      return this.fs.exists(this.launcher.paths(sessionName).statePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (expectedGeneration && state.generation !== expectedGeneration) return { ok: false, reason: "generation_mismatch" };
    if (state.exited || !state.sessionFile || !this.fs.exists(state.sessionFile)) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.sessionFile };
  }

  /** A retained file can outlive its process. Adoption and readiness need the current pane's writer. */
  private async liveState(session: string, target: string, purpose: "identity" | "readiness", switchCommittedAt?: string): Promise<OmpSeatState | null> {
    const initial = this.launcher.readState(session);
    if (!initial?.ready || initial.exited) return null;
    try {
      const panePid = await this.tmux.getPanePid(target);
      if (!panePid) return null;
      const writer = ompProcessInPane(await this.listProcesses(), panePid, initial);
      const startedAt = Date.parse(writer?.startedAt ?? "");
      if (!writer || !(startedAt <= Date.parse(initial.updatedAt))) return null;
      // Even a newer sidecar with the same PID cannot make a process born after cutover the original writer.
      if (switchCommittedAt && !(startedAt <= Date.parse(switchCommittedAt))) return null;
      if (await this.tmux.getPanePid(target) !== panePid) return null;
      if (purpose === "identity" && ompProcessInPane(await this.listProcesses(), panePid, initial)?.startedAt !== writer.startedAt) return null;
      const latest = this.launcher.readState(session);
      return latest?.ready && !latest.exited && latest.launchId === initial.launchId && latest.pid === initial.pid ? latest : null;
    } catch { return null; }
  }

  /** Claim/reconcile, self-attach and the next readiness poll can recover an already running switched writer.
   * Only this read-only probe looks at the previous occupant's storage before verification. */
  async verifyAdoptedStorage(session: string, boundPane?: string): Promise<OmpSeatState | null> {
    const pending = this.launcher.location(session).pendingAdoption;
    if (!pending || (boundPane && boundPane !== pending.pane)) return null;
    const state = await this.liveState(pending.storageSession, pending.pane, "identity", pending.committedAt);
    return state?.nodeId === pending.nodeId && state.generation === pending.writerGeneration && pending.confirm() ? state : null;
  }

  async readLiveSessionFile(session: string, expectedGeneration?: string, boundPane?: string): Promise<{ ok: true; sessionFile: string } | { ok: false; reason: string }> {
    const pane = boundPane ?? this.boundPaneForSession?.(session);
    if (!pane) return { ok: false, reason: "process_unreadable" };
    const state = await this.verifyAdoptedStorage(session, pane) ?? await this.liveState(session, pane, "identity");
    if (!boundPane && this.boundPaneForSession?.(session) !== pane) return { ok: false, reason: "process_unreadable" };
    return state?.sessionFile && (!expectedGeneration || state.generation === expectedGeneration) && this.fs.exists(state.sessionFile)
      ? { ok: true, sessionFile: state.sessionFile } : { ok: false, reason: "process_unreadable" };
  }

  /** The seat's sidecar, for readers that report what the seat's OMP said about itself. */
  readSeatState(sessionName: string): OmpSeatState | null {
    return this.launcher.readState(sessionName);
  }

  /** Snapshot before paste; tmux accepting bytes is not evidence OMP has ingested them. */
  prepareInput(sessionName: string, text: string): PreparedInput {
    const before = this.launcher.readState(sessionName);
    if (!before?.ready || !before.launchId || before.inputProtocol !== 1) {
      throw new Error("OMP input acknowledgement unavailable; relaunch this seat with the current extension. No text was sent.");
    }
    const sequence = before.inputReceipt?.sequence ?? 0;
    const sha256 = createHash("sha256").update(text).digest("hex");
    const id = randomUUID();
    const requestPath = `${this.launcher.paths(sessionName).statePath}.input.json`;
    let pending;
    try { pending = JSON.parse(this.fs.readFile(requestPath)); } catch { /* First input, or an expired malformed request. */ }
    if (pending?.launchId === before.launchId && pending.expiresAt > Date.now()) {
      throw new Error("Another OMP paste is still pending; no text was sent.");
    }
    this.fs.writeFile(requestPath, JSON.stringify({ id, launchId: before.launchId, sha256, expiresAt: Date.now() + 15_000 }));
    const cancel = () => {
      try {
        if (JSON.parse(this.fs.readFile(requestPath)).id === id) this.fs.writeFile(requestPath, "{}");
      } catch { /* Expiry also prevents a completed request being reused. */ }
    };
    const received: PreparedInput = async () => {
      try {
        for (let attempt = 0; attempt < 300; attempt++) {
          const current = this.launcher.readState(sessionName);
          if (!current?.ready || current.launchId !== before.launchId || current.sessionId !== before.sessionId || current.exited) {
            throw new Error("OMP changed or exited during input delivery; Enter was not sent. Inspect the staged input before retrying.");
          }
          const receipt = current.inputReceipt;
          if (receipt && receipt.requestId === id && receipt.sequence > sequence && receipt.sha256 === sha256) {
            if (receipt.stagedSha256 && receipt.stagedSha256 !== sha256) return "OMP normalized tabs or line endings in the staged text.";
            return;
          }
          await this.sleep(50);
        }
        throw new Error("OMP has not acknowledged the complete paste within 15 seconds; Enter was not sent. Text may be staged; inspect it before retrying.");
      } finally {
        cancel();
      }
    };
    received.cancel = cancel;
    return received;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    if (!binding.tmuxSession) return results;
    const paths = this.launcher.paths(binding.tmuxSession);
    const skillsDir = binding.seatSkillsRoot ?? this.launcher.skillRoot(binding.tmuxSession) ?? nodePath.join(paths.agentDir, "skills");
    for (const id of this.topLevelEntries(skillsDir)) {
      results.push({ effectiveId: id, category: "skill", installedPath: nodePath.join(skillsDir, id) });
    }
    for (const root of this.launcher.pluginRoots(binding.tmuxSession)) {
      results.push({ effectiveId: decodeURIComponent(nodePath.basename(root)), category: "plugin", installedPath: root });
    }
    return results;
  }

  /** Conflict detection must inspect this seat's copy, not a Claude sibling's in a shared working directory. */
  skillTargetPath(tmuxSession: string | null, effectiveId: string): string | null {
    if (!tmuxSession) return null;
    return nodePath.join(this.launcher.skillRoot(tmuxSession) ?? nodePath.join(this.launcher.paths(tmuxSession).agentDir, "skills"), effectiveId, "SKILL.md");
  }

  /** A seat's managed guidance goes into its own agent folder's AGENTS.md, which OMP loads as user-level context
   *  (PI_CODING_AGENT_DIR is that folder), so the person's tracked repository AGENTS.md is never written. The
   *  repository file stays when there's no session yet, or when the folder or its AGENTS.md is a link: through a link,
   *  other sessions would read this rig's guidance. */
  guidanceFileFor(binding: NodeBinding): GuidanceChoice {
    if (!binding.tmuxSession) return { file: null };
    const file = nodePath.join(this.launcher.paths(binding.tmuxSession).agentDir, "AGENTS.md");
    const linked = guidanceFileSharedByLink(file, (path) => this.fs.linkInfo?.(path) ?? null);
    return linked ? { file: null, note: `omp: ${linked} is a link, so this seat's managed guidance stays in its repository AGENTS.md` } : { file };
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    const selectedPlugins: string[] = [];
    const paths = binding.tmuxSession ? this.launcher.paths(binding.tmuxSession) : null;
    const selection = binding.tmuxSession ? this.launcher.readPluginSelection(binding.tmuxSession) : undefined;
    if (selection?.warning) warnings.push(selection.warning);
    const previousPlugins = new Set(selection?.roots.map(root => nodePath.basename(root)));
    const skills = binding.seatSkillsRoot ?? (paths && nodePath.join(paths.agentDir, "skills"));
    const pluginIds = new Set(plan.entries.filter(entry => entry.category === "plugin").map(entry => entry.effectiveId));
    const selectedSkills = new Set(plan.entries.filter(entry => entry.category === "skill").map(entry => entry.effectiveId));
    if (paths) {
      if (!selection?.warning) this.requireWritable(paths.seatRoot, paths.selectedPluginsPath);
      this.fs.mkdirp(paths.seatRoot);
    }

    if (binding.seatSkillsRoot && !insideSeatStorageFolder(nodePath.dirname(binding.seatSkillsRoot), binding.seatSkillsRoot)) {
      return { projected, skipped, failed: plan.entries.map(entry => ({ effectiveId: entry.effectiveId, error: "OMP seat skill storage has a linked or invalid path" })),
        ...(warnings.length ? { warnings } : {}) };
    }
    for (const entry of plan.entries) {
      // The planner compares only SKILL.md for a directory skill, and nothing inside a plugin. Their other files can
      // change independently, so the selected directory is still copied on reapply.
      const directoryResource = (entry.category === "skill" && this.fs.exists(nodePath.join(entry.absolutePath, "SKILL.md")))
        || entry.category === "plugin";
      if (entry.classification === "no_op" && !directoryResource) {
        skipped.push(entry.effectiveId);
        continue;
      }
      let projectingPortableSkills = false;
      try {
        if (entry.category === "skill" && entry.classification === "operator_conflict") {
          skipped.push(entry.effectiveId);
          warnings.push(`omp: kept edited skill ${entry.effectiveId}`);
          continue;
        }
        if (entry.category === "plugin" && !this.pluginAppliesToOmp(entry, previousPlugins.has(ompPluginDirName(entry.effectiveId)))) {
          projectingPortableSkills = true;
          const root = nodePath.join(entry.absolutePath, "skills");
          let copied = false;
          for (const id of this.topLevelEntries(root, true)) {
            if (!binding.tmuxSession || !this.fs.exists(nodePath.join(root, id, "SKILL.md"))) continue;
            if (plan.entries.some(other => other.category === "skill" && other.effectiveId === id)) continue;
            if (!skills) continue;
            selectedSkills.add(id);
            const target = nodePath.join(skills, id);
            const owner = nodePath.join(target, ".openrig-plugin");
            this.requireWritable(skills, owner);
            const source = nodePath.join(root, id);
            const receipt = this.readSkillReceipt(owner);
            if (this.fs.exists(target) && (!receipt || (receipt.id !== entry.effectiveId && pluginIds.has(receipt.id))
              || receipt.digest !== this.treeDigest(target))) {
              warnings.push(`omp: kept existing skill ${id}; plugin ${entry.effectiveId} did not overwrite it`);
              continue;
            }
            this.replaceDirectory(target, stage => {
              this.copyResource(source, stage);
              const digest = this.treeDigest(stage);
              this.fs.writeFile(nodePath.join(stage, ".openrig-plugin"), JSON.stringify({ id: entry.effectiveId, digest }));
            });
            copied = true;
          }
          (copied ? projected : skipped).push(entry.effectiveId);
        } else if (this.projectEntry(entry, binding, warnings)) {
          projected.push(entry.effectiveId);
          if (entry.category === "plugin") selectedPlugins.push(ompPluginDirName(entry.effectiveId));
        }
        else skipped.push(entry.effectiveId);
      } catch (err) {
        if (entry.category === "plugin") {
          if (selection?.warning && !projectingPortableSkills) {
            skipped.push(entry.effectiveId);
            warnings.push(`OMP could not refresh native plugin ${entry.effectiveId}: ${(err as Error).message}`);
            continue;
          }
          const dir = ompPluginDirName(entry.effectiveId);
          if (previousPlugins.has(dir)) selectedPlugins.push(dir);
        }
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    if (paths) {
      if (!selection?.warning) {
        const temporary = paths.selectedPluginsPath + "." + randomUUID();
        this.fs.writeFile(temporary, JSON.stringify(selectedPlugins));
        this.rename(temporary, paths.selectedPluginsPath);
      }
      if (skills) for (const id of this.topLevelEntries(skills)) {
        const target = nodePath.join(skills, id);
        const owner = nodePath.join(target, ".openrig-plugin");
        if (selectedSkills.has(id) || !this.fs.exists(owner)) continue;
        try {
          this.requireWritable(skills, owner);
          const receipt = this.readSkillReceipt(owner);
          if (receipt && pluginIds.has(receipt.id)) continue;
          if (receipt && receipt.digest === this.treeDigest(target)) this.remove(target);
          else warnings.push("omp: kept edited or unverified portable skill " + id);
        } catch (error) {
          warnings.push("omp: could not retire portable skill " + id + ": " + (error as Error).message);
        }
      }
    }
    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding, sendInteractiveText?: (text: string) => Promise<void>): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      let sendingInput = false;
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content, file.orientation) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            // Additive context: OMP's own system prompt is never replaced.
            const targetPath = this.guidanceTarget(binding, warnings, file.path);
            if (!targetPath) continue;
            if (!this.mergeGuidance(targetPath, file.path, content, warnings)) continue; // a seat's own role: sent as text
            break;
          }
          case "skill_install": {
            if (!binding.tmuxSession) throw new Error("No tmux session bound — cannot resolve the OMP seat's home");
            const { agentDir } = this.launcher.paths(binding.tmuxSession);
            const targetDir = nodePath.join(binding.seatSkillsRoot ?? nodePath.join(agentDir, "skills"), nodePath.basename(nodePath.dirname(file.absolutePath)));
            const destination = nodePath.join(targetDir, nodePath.basename(file.path));
            this.requireWritable(binding.seatSkillsRoot ?? nodePath.join(agentDir, "skills"), destination);
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(destination, content);
            break;
          }
          case "send_text": {
            sendingInput = true;
            if (sendInteractiveText) { await sendInteractiveText(content); break; }
            if (!binding.tmuxSession) throw new Error("No tmux session bound; no input was sent");
            {
              // Pasted into OMP's composer as one block, then submitted: one message, newlines included.
              const received = this.prepareInput(binding.tmuxSession, content);
              try {
                const textResult = await this.tmux.sendText(binding.tmuxSession, content);
                if (!textResult.ok) throw new Error(textResult.message);
                const warning = await received();
                if (warning) warnings.push(warning);
                const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
                if (!submitResult.ok) throw new Error(submitResult.message);
              } finally { received.cancel?.(); }
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required || sendingInput) failed.push({ path: file.path, error: (err as Error).message });
        // Even optional input can already be staged. Never append later files or submit them over that uncertainty.
        if (sendingInput) break;
      }
    }

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource; beforeNativeDispatch?: () => boolean },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the OMP harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    let forkRef: string | undefined;
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `omp fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent session file path or session id`,
        };
      }
      forkRef = opts.forkSource.value?.trim();
      if (!forkRef) {
        return { ok: false, error: "omp fork: forkSource.value is required (parent session file path or session id)" };
      }
    }

    if (opts.resumeToken) {
      // Validity floor before anything is typed into the pane.
      const validation = validateResumeToken(this.runtime, opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `omp resume: ${validation.error}` };
      if (!this.fs.exists(opts.resumeToken)) {
        // The session file is gone. The honest outcome is the caller's stop-and-ask, never a silent fresh start.
        return { ok: false, error: "omp resume: the persisted session file no longer exists", recovery: "retry_fresh", missingConversation: true };
      }
    }

    const outcome = await this.launcher.launch({
      sessionName: binding.tmuxSession,
      cwd: binding.cwd,
      model: binding.model,
      effort: binding.effort,
      seatSkillsRoot: binding.seatSkillsRoot,
      launchPosture: binding.launchPosture,
      launchWrapper: binding.launchWrapper,
      nodeId: binding.nodeId,
      generation: binding.launchGeneration,
      beforeNativeDispatch: opts.beforeNativeDispatch,
      sessionFile: opts.resumeToken,
      forkRef,
    });
    if (!outcome.ok) {
      if (outcome.reason === "send_failed") return { ok: false, error: outcome.message };
      if (outcome.reason === "session_not_found") {
        return { ok: false, error: `omp ${opts.resumeToken ? "resume" : "launch"}: ${outcome.message}`, recovery: "retry_fresh", missingConversation: true };
      }
      return {
        ok: false,
        error: `omp launch${outcome.reason === "timeout" ? "" : " failed"}: ${outcome.message}`,
        recovery: "attention_required",
        ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      };
    }

    const { appliedLaunch, warnings } = outcome;
    const sessionFile = outcome.state.sessionFile;
    if (!sessionFile) {
      return { ok: false, error: "omp launch: OMP became ready but reported no session file" };
    }
    if (opts.resumeToken && sessionFile !== opts.resumeToken) {
      // An exact resume must continue the requested history; an OMP that came up on any other file started a
      // different session.
      return { ok: false, recovery: "attention_required", error: "omp resume: OMP is ready but does not report the requested session file" };
    }
    if (forkRef && (sessionFile === forkRef || outcome.state.sessionId === forkRef)) {
      // The contract requires the new post-fork token, never the parent's.
      return { ok: false, recovery: "attention_required", error: "omp fork: OMP reported the parent session file or ID instead of the post-fork child" };
    }
    const validation = validateResumeToken(this.runtime, sessionFile);
    if (!validation.ok) {
      return { ok: false, error: `omp launch: OMP reported a malformed session file (${validation.error})` };
    }

    // OMP writes a new session's file with its first turn. The seat is ready, but until then there is no history to
    // resume; the extension reports the file to the daemon once it exists.
    return { ok: true, appliedLaunch, ...(warnings ? { warnings } : {}),
      ...(this.fs.exists(validation.token) ? { resumeToken: validation.token, resumeType: RESUME_TYPE } : {}) };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) return { ready: false, reason: "tmux session not responsive" };

    // The sidecar outlives the process that wrote it, so a ready record counts only while the pane's foreground is
    // not back at a shell: an OMP that was killed leaves the pane there, with its last sidecar still saying ready.
    const boundPane = binding.tmuxPane ?? this.boundPaneForSession?.(binding.tmuxSession);
    const target = boundPane ?? binding.tmuxSession;
    const atShell = paneAtShell(await this.tmux.getPaneCommand(target));
    const recovered = atShell ? null : await this.verifyAdoptedStorage(binding.tmuxSession, boundPane ?? undefined);
    const state = recovered ?? this.launcher.readState(binding.tmuxSession);
    if (state?.exited) {
      return { ready: false, reason: `omp exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (!state?.ready) {
      return atShell
        ? { ready: false, reason: "omp is not running: the pane is at a shell", code: "runner_exited" }
        : { ready: false, reason: "omp has not reported ready yet", code: "awaiting_runtime" };
    }
    if (atShell) {
      return { ready: false, reason: "the seat sidecar says ready but the pane is back at a shell (the omp process is gone)", code: "runner_exited" };
    }
    const current = recovered ?? await this.liveState(binding.tmuxSession, target, "readiness");
    if (!current) return { ready: false, code: "awaiting_runtime", reason: "the native OMP writer could not be verified in the bound pane" };
    if (current.auth === "missing") {
      // OMP is at its prompt, but it has no credentials for its model and would fail the first message.
      return {
        ready: false,
        code: "login_required",
        reason: `omp has no credentials for ${state.model ?? "its model"}: use /login in the seat, or allow the provider's key for this seat`,
      };
    }
    return { ready: true };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private topLevelEntries(dir: string, requireInventory = false): string[] {
    if (!requireInventory && !this.fs.exists(dir)) return [];
    try {
      if (!this.fs.listFiles) throw new Error("Cannot list files in " + dir);
      return [...new Set(this.fs.listFiles(dir).map((file) => file.split(nodePath.sep)[0]!))].sort();
    } catch (error) {
      if (requireInventory && ((error as NodeJS.ErrnoException).code !== "ENOENT" || this.fs.exists(dir))) throw error;
      return [];
    }
  }

  /** A restored seat may still have its agent folder even when its former project folder is missing. */
  private guidanceTarget(binding: NodeBinding, warnings: string[], blockId: string): string | null {
    const target = binding.guidanceFile ?? nodePath.join(binding.cwd, "AGENTS.md");
    if (this.fs.folderPresent && insideMissingFolder(target, binding.cwd, this.fs.folderPresent)) {
      warnings.push(`${blockId}: not written, because ${binding.cwd} doesn't exist on this machine`);
      return null;
    }
    if (!binding.guidanceFile) return target;
    const linked = guidanceFileSharedByLink(binding.guidanceFile, (path) => this.fs.linkInfo?.(path) ?? null);
    if (!linked) return binding.guidanceFile;
    warnings.push(`omp: ${linked} is now a link, so this seat's managed guidance wasn't written to ${binding.guidanceFile}, which other sessions could read`);
    return null;
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = this.guidanceTarget(binding, warnings, entry.effectiveId);
      if (!targetPath) return false;
      return this.mergeGuidance(targetPath, entry.effectiveId, this.fs.readFile(entry.absolutePath), warnings, entry.absolutePath);
    }

    if (!binding.tmuxSession) return false;
    const paths = this.launcher.paths(binding.tmuxSession);

    if (entry.category === "skill") {
      const skills = binding.seatSkillsRoot ?? nodePath.join(paths.agentDir, "skills");
      this.copyResource(entry.absolutePath, nodePath.join(skills, entry.effectiveId), skills);
      return true;
    }

    if (entry.category === "plugin") {
      // OMP loads a plugin as an extension package: a directory whose package.json declares its extension entries,
      // with its skills beside them. Foreign plugins' portable skills are handled separately.
      const target = nodePath.join(paths.pluginsDir, ompPluginDirName(entry.effectiveId));
      this.requireWritable(paths.seatRoot, nodePath.join(target, "package.json"));
      this.replaceDirectory(target, stage => this.copyResource(entry.absolutePath, stage));
      return true;
    }

    // Subagents and runtime resources have no OMP projection target: an honest skip, never a misdelivery.
    return false;
  }

  /** An explicit `plugin_type` names another runtime; `auto` (the default) applies when the plugin's package.json
   *  declares OMP extensions (`omp.extensions`, or Pi's `pi.extensions`, which OMP also loads). */
  private pluginAppliesToOmp(entry: ProjectionEntry, previouslyNative: boolean): boolean {
    if (entry.pluginType && entry.pluginType !== "auto") return false;
    const manifest = nodePath.join(entry.absolutePath, "package.json");
    if (!previouslyNative && !this.fs.exists(manifest)) return false;
    const parsed = JSON.parse(this.fs.readFile(manifest)) as { omp?: { extensions?: unknown }; pi?: { extensions?: unknown } };
    const declared = (parsed.omp ?? parsed.pi)?.extensions;
    return Array.isArray(declared) && declared.length > 0;
  }

  private rename(source: string, dest: string): void {
    (this.fs.rename ?? fs.renameSync)(source, dest);
  }

  private remove(target: string): void {
    if (this.fs.remove) this.fs.remove(target);
    else fs.rmSync(target, { recursive: true, force: true });
  }

  private requireWritable(root: string, target: string): void {
    if (!nodePath.resolve(target).startsWith(nodePath.resolve(root) + nodePath.sep)) throw new Error("OMP projection escaped its root");
    const refusal = seatSkillWriteRefusal(root, target);
    if (refusal) throw new Error(refusal);
    if (((this.fs.linkInfo ?? lstatLinkInfo)(target)?.nlink ?? 0) > 1) {
      throw new Error(target + " is hard-linked; not written");
    }
  }

  // Copy before displacing a working tree. Synchronous renames keep concurrent daemon projections serialized.
  private replaceDirectory(target: string, fill: (stage: string) => void): void {
    const scratch = nodePath.join(nodePath.dirname(nodePath.dirname(target)), ".omp-projection-" + randomUUID());
    const stage = nodePath.join(scratch, "new");
    const backup = nodePath.join(scratch, "previous");
    this.fs.mkdirp(stage);
    try { fill(stage); } catch (error) { this.remove(scratch); throw error; }
    this.fs.mkdirp(nodePath.dirname(target));
    const exists = this.fs.exists(target);
    if (exists) this.rename(target, backup);
    try { this.rename(stage, target); } catch (error) {
      if (exists) this.rename(backup, target);
      this.remove(scratch);
      throw error;
    }
    this.remove(scratch);
  }

  private treeDigest(target: string): string {
    const hash = createHash("sha256");
    if (!this.fs.listFiles) throw new Error("Cannot verify portable skill contents");
    for (const file of this.fs.listFiles(target).sort()) {
      if (file === ".openrig-plugin") continue;
      const path = nodePath.join(target, file);
      this.requireWritable(target, path);
      const bytes = this.fs.readBytes ? this.fs.readBytes(path) : this.fs.readFile(path);
      hash.update(JSON.stringify([file, this.fs.statMode?.(path), createHash("sha256").update(bytes).digest("hex")]));
    }
    return hash.digest("hex");
  }

  private readSkillReceipt(marker: string): { id: string; digest: string } | null {
    if (!this.fs.exists(marker)) return null;
    const raw = this.fs.readFile(marker);
    try {
      const owner = JSON.parse(raw);
      return typeof owner?.id === "string" && typeof owner.digest === "string" ? owner : null;
    } catch { return null; }
  }

  /** Copy a file or a directory tree into `targetDir`, keeping each file's mode. */
  private copyResource(source: string, targetDir: string, skillsRoot?: string): void {
    let files: string[] = [];
    if (this.fs.listFiles) {
      try {
        files = this.fs.listFiles(source);
      } catch {
        files = []; // a file-shaped source: listing it throws ENOTDIR
      }
    }
    // Preflight every destination before the first copy, including nested helper links.
    if (skillsRoot) for (const file of files.length ? files : [nodePath.basename(source)]) {
      this.requireWritable(skillsRoot, nodePath.join(targetDir, file));
    }
    this.fs.mkdirp(targetDir);
    if (files.length === 0) {
      const dest = nodePath.join(targetDir, nodePath.basename(source));
      this.fs.copyFile(source, dest);
      this.preserveMode(source, dest);
      return;
    }
    for (const file of files) {
      const dest = nodePath.join(targetDir, file);
      this.fs.mkdirp(nodePath.dirname(dest));
      this.fs.copyFile(nodePath.join(source, file), dest);
      this.preserveMode(nodePath.join(source, file), dest);
    }
  }

  private preserveMode(source: string, target: string): void {
    if (this.fs.statMode && this.fs.chmod) this.fs.chmod(target, this.fs.statMode(source) & 0o777);
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[], sourcePath?: string): boolean {
    // As for the other adapters: a seat's own `rig-role` content collides across pod-mates when merged into a shared
    // file, so it is delivered as text instead. See ADR-0006.
    if (isPerSeatRoleGuidance(blockId, sourcePath)) {
      console.log(
        `[openrig] skip: effectiveId is ${blockId}, a seat's own role; per-seat delivery via send_text path required (target=${targetPath})`
      );
      const warning = perSeatRoleSkipWarning(blockId, targetPath);
      if (warning) warnings.push(warning);
      return false;
    }
    // A block a person edited since OpenRig wrote it is kept and named, not counted as merged.
    return writeManagedGuidanceBlock(this.fs, targetPath, blockId, content, {
      records: this.managedBlockRecords, sourcePath, warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
  }
}
