import nodePath from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import {
  defaultResolveHomeDirByPid,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "../domain/codex-thread-id.js";
import { assessNativeResumeProbe, buildCodexResumeCore, type NativeResumeProbeResult } from "../domain/native-resume-probe.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { shellQuote } from "./shell-quote.js";

export interface CodexAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  homedir?: string;
}

/**
 * Codex runtime adapter. Projects resources to .agents/ targets (preserving
 * existing Codex filesystem contract) and delivers startup files.
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex";
  private tmux: TmuxAdapter;
  private fs: CodexAdapterFsOps;
  private listProcesses: () => Array<{ pid: number; ppid: number; command: string }>;
  private readThreadIdByPid: (pid: number) => string | undefined;
  private sleep: (ms: number) => Promise<void>;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  // OPR.0.4.1.10 FR-B — absolute path to the daemon's own shipped activity-relay.cjs,
  // resolved by startup from import.meta.dirname. Used by ensureCodexActivityHooks
  // (FR-A) to write config-layer [hooks] command entries that are cwd-independent and
  // version-matched to the running daemon (NOT ${PLUGIN_ROOT}, NOT a per-cwd copy).
  private activityRelayPath?: string;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: CodexAdapterFsOps;
    listProcesses?: () => Array<{ pid: number; ppid: number; command: string }>;
    readThreadIdByPid?: (pid: number) => string | undefined;
    resolveHomeDirByPid?: ResolveHomeDirByPid;
    sleep?: (ms: number) => Promise<void>;
    activityRelayPath?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.activityRelayPath = deps.activityRelayPath;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.readThreadIdByPid = deps.readThreadIdByPid ?? ((pid) => this.readThreadIdFromLogs(pid));
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * plugin-primitive Phase 3a slice 3.5 — ensure Codex feature flag.
   *
   * When `enabled` is true, idempotently writes `codex_hooks = true` under
   * `[features]` in `~/.codex/config.toml`, creating the file if missing.
   * When `enabled` is false, makes ZERO modifications — the operator is
   * managing Codex config independently and the daemon does not touch it.
   *
   * Replaces the activity-hook-injection-coupled feature-flag set call
   * that lived inside the auto-injected activity-hook provisioning path
   * pre-rip (plugin-primitive Phase 3a slice 3.1).
   */
  ensureCodexFeatureFlag(enabled: boolean, opts?: { codexVersion?: string }): void {
    if (!enabled) return;
    if (!opts?.codexVersion) return;
    if (isCodex013xOrLater(opts.codexVersion)) return;
    const homedir = this.fs.homedir;
    if (!homedir) return;
    const configPath = nodePath.join(homedir, ".codex", "config.toml");
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const updated = upsertCodexHooksFeature(existing);
    if (updated !== existing) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, updated);
    }
  }

  /**
   * OPR.0.4.1.10 FR-A — write the OpenRig activity hooks into Codex's config layer
   * (`~/.codex/config.toml` inline `[hooks]`) so an OpenRig-launched Codex seat is
   * hook-PRIMARY from clean shipped config. Idempotent managed-block upsert for the
   * four events SessionStart / UserPromptSubmit / Stop / PermissionRequest; each
   * command is `node "<activityRelayPath>"` (the daemon's OWN shipped relay, FR-B —
   * cwd-independent, version-matched, NOT `${PLUGIN_ROOT}` nor a per-cwd copy). Also
   * pins `[features].hooks = true` (canonical key; the deprecated `codex_hooks` alias
   * is intentionally NOT used here). Trust is granted at launch by the hook_trust_gate
   * auto-clear (dismissCodexInteractiveGates → "2" Trust all and continue, verified on
   * Codex 0.139). The relay inherits the seat's OPENRIG_* env from the tmux session.
   *
   * Fail-safe: skips + warns when the relay asset is missing — never writes a hook that
   * points at a nonexistent script. Verified-firsthand (Codex 0.139, dev1-qa AC-2 proof):
   * on the OpenRig-managed launch path — managed inline hooks + trusted + the relay env
   * delivered into the seat (OPENRIG_URL + OPENRIG_ACTIVITY_HOOK_TOKEN + session/node/runtime)
   * — all four events, SessionStart included, deliver as runtime_hook activity. Without the
   * relay env the hooks are still trusted/visible but no activity rows land. (A bare/manual
   * codex TUI launch lacks that context and may not deliver SessionStart — not how OpenRig
   * launches seats.)
   */
  ensureCodexActivityHooks(): void {
    const relay = this.activityRelayPath;
    if (!relay || !this.fs.exists(relay)) {
      if (relay) {
        console.error(`[openrig] codex activity hooks skipped: relay asset not found at ${relay}`);
      }
      return;
    }
    const homedir = this.fs.homedir;
    if (!homedir) return;
    const configPath = nodePath.join(homedir, ".codex", "config.toml");
    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const withHooks = upsertCodexActivityHooks(existing, relay);
    if (withHooks !== existing) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, withHooks);
    }
    // OPR.0.4.3.33 hook-trust-autoclear — pre-write Codex's OWN hook trust record
    // ([hooks.state."<key>"] trusted_hash) for exactly our 4 authored hooks, on the SAME
    // seam that provisions them, so the daemon's unmanaged inline hooks are trusted from
    // clean config on EVERY path a fresh Codex process reads config (launch/adopt/reconcile)
    // — not just the launch keystroke gate. Layer-2 floor (dismissCodexInteractiveGates)
    // stays as the fail-safe if a Codex-version drift changes the identity/hash. Idempotent
    // + non-clobbering; only touches our 4 keys. See applyCodexActivityHookTrust for the RTFM.
    const trusted = this.applyCodexActivityHookTrust(withHooks, configPath, relay);
    if (trusted !== withHooks) {
      this.fs.mkdirp(nodePath.dirname(configPath));
      this.fs.writeFile(configPath, trusted);
    }
  }

  /**
   * OPR.0.4.3.33 — compute + splice Codex's `[hooks.state."<key>"] trusted_hash` for our 4
   * authored activity hooks into `content`. `key_source` is the canonicalized config path
   * (Codex keys trust by `std::fs::canonicalize(config.toml).display()`); we best-effort
   * `realpathSync` the config path to match — on a miss (file not yet on real disk, or a mock
   * fs in tests) we fall back to the plain absolute path, and any resulting key mismatch just
   * degrades to the launch-time trust gate (Layer-2 floor), never a broken run. The command
   * string is the value Codex deserializes from our TOML literal `'node "<relay>"'` — i.e.
   * `node "<relay>"` WITHOUT the outer TOML quote delimiters. Timeout=5, matcher/status None.
   */
  private applyCodexActivityHookTrust(content: string, configPath: string, relay: string): string {
    let keySource = configPath;
    try {
      keySource = fs.realpathSync(configPath);
    } catch {
      // config.toml not on the real filesystem (first write / unit-test mock fs) — the plain
      // absolute path is the honest best guess; a canonicalization delta is fail-safe (gate reappears).
    }
    const command = `node "${relay}"`;
    let next = content;
    for (const event of OPENRIG_ACTIVITY_HOOK_EVENTS) {
      const { key, hash } = computeCodexHookTrust(event, { keySource, command, timeoutSec: 5 });
      next = upsertCodexHookTrust(next, key, hash);
    }
    return next;
  }

  /**
   * OPR.0.4.1.10 B3 — durable disable. When runtime.codex.hooks_enabled is false, strip the
   * OpenRig-managed activity-hooks sentinel block from ~/.codex/config.toml so a seat that was
   * previously provisioned with hooks does not keep firing them after the operator disables.
   * Removes ONLY the managed block — preserves any user-owned hooks and leaves [features].hooks
   * (the Codex 0.139 default) intact. Idempotent; no-op when the config or the block is absent.
   */
  removeCodexActivityHooks(): void {
    const homedir = this.fs.homedir;
    if (!homedir) return;
    const configPath = nodePath.join(homedir, ".codex", "config.toml");
    if (!this.fs.exists(configPath)) return;
    const existing = this.fs.readFile(configPath);
    const updated = stripCodexActivityHooks(existing);
    if (updated !== existing) {
      this.fs.writeFile(configPath, updated);
    }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
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
        const didProject = this.projectEntry(entry, binding.cwd);
        if (didProject) {
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
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[openrig] codex bootstrap warning: ${(err as Error).message}`);
    }

    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
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
        if (file.required) {
          failed.push({ path: file.path, error: (err as Error).message });
        }
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: import("../domain/runtime-adapter.js").ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Codex harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const profile = binding.codexConfigProfile?.trim();
    const profileArg = profile ? ` -p ${shellQuote(profile)}` : "";

    // OPR.0.3.4.7 — profile-LOAD probe before launch/resume. A legacy
    // [profiles.<name>] table or invalid TOML must fail BEFORE the opaque
    // `codex -p <profile> resume` failure. An absent .config.toml passes
    // (Codex default-layers it; advisor Option B).
    if (profile) {
      const { verifyCodexProfileLoads } = await import("../domain/codex-profile-preflight.js");
      const { execSync } = await import("node:child_process");
      const execFn = async (cmd: string) => execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 });
      const probeResult = await verifyCodexProfileLoads(profile, execFn);
      if (!probeResult.ok) {
        return {
          ok: false,
          error: `${probeResult.error}${probeResult.migrationHint ? `\n  Fix: ${probeResult.migrationHint}` : ""}`,
        };
      }
    }
    const gitDirArg = ` --add-dir ${shellQuote(nodePath.join(binding.cwd, ".git"))}`;
    const queueStateDirArg = this.buildQueueStateAddDirArg(opts.name);

    // Fork branch: `codex fork <parent_thread_id>`. Captures the NEW thread id
    // post-fork. Parent thread id is NOT persisted onto the new seat record
    // (identity-honesty bedrock).
    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `codex fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the prior conversation's thread id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "codex fork: forkSource.value is required (parent native_id)" };
      }
      const cmd = `codex${profileArg} fork${queueStateDirArg} ${shellQuote(parentId)}`;
      const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      await this.dismissCodexInteractiveGates(binding.tmuxSession);
      const threadId = await this.captureFreshThreadId(binding);
      if (!threadId) {
        return {
          ok: false,
          error: "codex fork: could not capture new post-fork thread id",
        };
      }
      return { ok: true, resumeToken: threadId, resumeType: "codex_id" };
    }

    const cmd = opts.resumeToken
      ? buildCodexResumeCore(opts.resumeToken, profile, false, queueStateDirArg.trim() || undefined)
      : profile
        ? `codex${profileArg} -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg}`
        : `codex -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg} -a on-request -s danger-full-access`;

    const textResult = await this.tmux.sendText(binding.tmuxSession, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }

    await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession);

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession, { resumeToken: opts.resumeToken });
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id" };
    }

    const threadId = await this.captureFreshThreadId(binding);
    if (threadId) {
      return { ok: true, resumeToken: threadId, resumeType: "codex_id" };
    }

    return { ok: true };
  }

  private buildQueueStateAddDirArg(sessionName: string): string {
    const identity = parseCanonicalSessionName(sessionName);
    if (!identity) return "";

    const sharedDocsRoot = process.env.OPENRIG_SHARED_DOCS_ROOT?.trim()
      // OPR.0.3.2.14 — subpath scrubbed (internal-team layout → generic placeholder).
      || nodePath.join(this.fs.homedir ?? os.homedir(), ".openrig", "shared-docs");
    const queueStateRoot = nodePath.join(sharedDocsRoot, "rigs", identity.rig, "state", identity.pod);
    return ` --add-dir ${shellQuote(queueStateRoot)}`;
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const probe = assessNativeResumeProbe({
      runtime: "codex",
      paneCommand,
      paneContent,
    });

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  private async dismissSkippableCodexUpdatePrompt(tmuxSession: string, attempts = 6): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "update_gate") {
        if (!isSkippableCodexUpdatePrompt(paneContent)) return false;

        const textResult = await this.tmux.sendText(tmuxSession, "3");
        if (!textResult.ok) return false;
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) return false;
        await this.sleep(500);
        return true;
      }

      if (probe.status === "resumed" || probe.code === "trust_gate") {
        return false;
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }

    return false;
  }

  private async dismissCodexInteractiveGates(tmuxSession: string, attempts = 8): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "update_gate") {
        if (!isSkippableCodexUpdatePrompt(paneContent)) return;
        const textResult = await this.tmux.sendText(tmuxSession, "3");
        if (!textResult.ok) return;
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) return;
        await this.sleep(500);
        continue;
      }

      if (probe.code === "hook_trust_gate") {
        const textResult = await this.tmux.sendText(tmuxSession, "2");
        if (!textResult.ok) return;
        const enterResult = await this.tmux.sendKeys(tmuxSession, ["Enter"]);
        if (!enterResult.ok) return;
        await this.sleep(500);
        continue;
      }

      if (probe.status === "resumed" || probe.code === "trust_gate") {
        return;
      }

      if (attempt < attempts - 1) {
        await this.sleep(200);
      }
    }
  }

  ensureManagedBootstrap(binding: { cwd?: string | null }): void {
    this.provisionWorkspaceTrust(binding.cwd ?? null);
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // HG-1.3 plugin runtime applicability filter (per DESIGN.md §5.1):
    // - explicit pluginType="claude" → skip Codex projection
    // - pluginType="auto" (or unset) + no .codex-plugin/ manifest dir → skip
    // - explicit pluginType="codex" → project regardless of manifest presence
    if (entry.category === "plugin" && !this.pluginAppliesToCodex(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      for (const file of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, file);
        const dest = nodePath.join(targetDir, file);
        const content = this.fs.readFile(src);
        if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) continue;
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.writeFile(dest, content);
      }
    } else {
      const content = this.fs.readFile(entry.absolutePath);
      const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) return true;
      this.fs.writeFile(destFile, content);
    }
    return true;
  }

  private pluginAppliesToCodex(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "codex") return true;
    if (explicit === "claude") return false;
    // auto: detect via .codex-plugin/plugin.json presence in the source tree
    return this.fs.exists(nodePath.join(entry.absolutePath, ".codex-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".agents"); // .agents/{id}.yaml per preserved contract
      case "plugin": return nodePath.join(cwd, ".codex", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".agents", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry): boolean {
    if (entry.resourceType !== "codex_config_fragment") {
      return false;
    }

    const home = this.fs.homedir ?? os.homedir();
    const configPath = nodePath.join(home, ".codex", "config.toml");
    this.fs.mkdirp(nodePath.dirname(configPath));

    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const fragment = this.fs.readFile(entry.absolutePath);
    this.fs.writeFile(configPath, upsertManagedCodexConfigFragment(existing, entry.effectiveId, fragment));
    return true;
  }

  /**
   * Merge a managed block into the target guidance file. Returns `true` when
   * the merge happened, `false` when intentionally skipped (rig-role). Callers
   * propagate the skip signal so ProjectionResult and StartupDeliveryResult
   * report honest counts.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors Claude Code adapter: the `rig-role` managed block collides across
    // pod-mates because the regenerator pairs (target-file × spec) without
    // seat correlation. Per-seat role content is delivered through `send_text`
    // startup instead. Refuse the merge loudly; silent skip would mask the
    // collision. See ADR-0006.
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

  private detectDeliveryHint(path: string, content: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content);
  }

  private provisionWorkspaceTrust(cwd: string | null): void {
    if (!cwd) return;
    const home = this.fs.homedir ?? os.homedir();
    if (!home) return;

    const configPath = nodePath.join(home, ".codex", "config.toml");
    this.fs.mkdirp(nodePath.dirname(configPath));

    let content = "";
    try {
      if (this.fs.exists(configPath)) content = this.fs.readFile(configPath);
    } catch {
      content = "";
    }

    for (const trustKey of this.workspaceTrustKeys(cwd)) {
      content = upsertCodexProjectTrust(content, trustKey);
    }

    this.fs.writeFile(configPath, content);
  }

  private readJsonObject(path: string): Record<string, unknown> {
    try {
      if (!this.fs.exists(path)) return {};
      const parsed = JSON.parse(this.fs.readFile(path));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private readJsonObjectField(source: Record<string, unknown>, key: string): Record<string, unknown> {
    const value = source[key];
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private workspaceTrustKeys(cwd: string): string[] {
    const keys = new Set<string>([nodePath.resolve(cwd)]);
    try {
      keys.add(fs.realpathSync.native(cwd));
    } catch {
      // Best-effort only.
    }
    return Array.from(keys);
  }

  private async captureFreshThreadId(binding: NodeBinding): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const shellPid = await this.tmux.getPanePid(target);
      if (shellPid) {
        const codexPids = this.findCodexDescendantPids(shellPid);
        for (const codexPid of codexPids) {
          const threadId = this.readThreadIdByPid(codexPid);
          if (threadId) return threadId;
        }
      }
      if (binding.tmuxSession) {
        await this.dismissCodexInteractiveGates(binding.tmuxSession, 1);
      }
      await this.sleep(250);
    }

    return undefined;
  }

  private async verifyResumeLaunch(tmuxSession: string, opts?: { resumeToken?: string }): Promise<HarnessLaunchResult> {
    const quickAttempts = 6;
    const extendedAttempts = 24;
    const quickSleepMs = 200;
    const extendedSleepMs = 500;

    // OPR.0.3.3.21 (FR-2): process-alive is NOT proof of a restored
    // conversation. verifyResumeLaunch must NOT return ok:true unless the probe
    // proves `resumed`. Unresolved operator-action gates (update/trust/model)
    // and a bounded poll that never reaches `resumed` are `attention_required`,
    // not launch success.
    //
    // OPR.0.3.4.13: a slow-but-valid Codex resume (boot-in-progress on the
    // original thread, no real gate) gets an extended poll window (~15s) beyond
    // the quick 1.2s. Genuine gates (auth/trust/model/update) still classify
    // within the quick window. Only the awaiting_runtime boot case extends.
    let lastUnresolved: NativeResumeProbeResult | null = null;
    let lastPaneContent = "";
    let sawRealGate = false;

    const totalAttempts = quickAttempts + extendedAttempts;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      // After the quick phase, only continue if we're in the boot-in-progress
      // case (awaiting_runtime, no real gate). Real gates won't self-resolve.
      if (attempt >= quickAttempts && (sawRealGate || lastUnresolved?.code !== "awaiting_runtime")) {
        break;
      }

      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = (await this.tmux.capturePaneContent(tmuxSession, 40)) ?? "";
      lastPaneContent = paneContent;
      const probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          error: "Codex resume failed: no saved session found for the requested session",
          recovery: "retry_fresh",
        };
      }

      if (probe.code === "returned_to_shell") {
        return {
          ok: false,
          error: "Codex resume failed: pane returned to shell instead of entering Codex",
          recovery: "retry_fresh",
        };
      }

      if (probe.status === "attention_required") {
        return {
          ok: false,
          error: probe.detail,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (probe.status === "resumed") {
        return {
          ok: true,
          resumeToken: opts?.resumeToken,
          resumeType: opts?.resumeToken ? "codex_id" : undefined,
        };
      }

      if (probe.code === "update_gate") {
        const dismissed = await this.dismissSkippableCodexUpdatePrompt(tmuxSession, 1);
        if (dismissed) {
          lastUnresolved = null;
          sawRealGate = false;
          const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
          if (attempt < totalAttempts - 1) await this.sleep(sleepMs);
          continue;
        }
        lastUnresolved = probe;
        sawRealGate = true;
      } else if (probe.status === "inconclusive") {
        lastUnresolved = probe;
        if (probe.code !== "awaiting_runtime") {
          sawRealGate = true;
        }
      }

      const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
      if (attempt < totalAttempts - 1) await this.sleep(sleepMs);
    }

    return {
      ok: false,
      error: lastUnresolved?.detail
        ?? "Codex resume could not be confirmed: the process is alive but a restored conversation was never proven.",
      recovery: "attention_required",
      evidence: lastPaneContent.split("\n").slice(-12).join("\n"),
    };
  }

  private findCodexDescendantPids(parentPid: number): number[] {
    const processes = this.listProcesses();
    return findCodexDescendantPids(processes, parentPid);
  }

  private readThreadIdFromLogs(pid: number): string | undefined {
    return readCodexThreadIdFromCandidateHomes(
      pid,
      [this.resolveHomeDirByPid(pid), this.fs.homedir, os.homedir()],
      (path) => this.fs.exists(path)
    );
  }
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function upsertCodexProjectTrust(content: string, projectPath: string): string {
  const header = `[projects.${JSON.stringify(projectPath)}]`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\ntrust_level = "trusted"\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const trustIndex = lines.findIndex((line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trust_level"));
  if (trustIndex >= 0) {
    lines[trustIndex] = 'trust_level = "trusted"';
  } else {
    lines.splice(headerIndex + 1, 0, 'trust_level = "trusted"');
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

// ── OPR.0.4.3.33 hook-trust-autoclear ────────────────────────────────────────────────────
// Pre-write Codex's OWN hook trust record so the daemon's provisioned (unmanaged) inline
// activity hooks are trusted on every path (launch/adopt/reconcile) without a manual `/hooks`
// "Trust all" keystroke. Codex is a private impl; the key+hash below are REPRODUCED from the
// open source (RTFM, cited) and are PROVISIONAL until pinned by a byte-for-byte read-back of a
// real Codex `[hooks.state]` after `/hooks`->"Trust all" (the QA VM proof — see the unit test
// fixture marked PIN-TO-VM). A mismatch is fail-safe: Codex re-shows the gate and the launch-time
// Layer-2 keystroke floor (dismissCodexInteractiveGates) clears it — never a false-trusted run.
//
// RTFM sources (cite):
//   - https://developers.openai.com/codex/hooks
//   - openai/codex PR #20321 "hook trust metadata and enforcement" (merge commit 0452dca;
//     typed-identity commit ffcc9cc) — key file codex-rs/hooks/src/engine/discovery.rs.
//   - openai/codex issue #21615 (the `[hooks.state]` pre-write workaround for exactly this
//     local-wrapper-installer case) + #23259 (positional path-keying fragility).
//
// KEY — codex-rs/hooks/src/lib.rs `hook_key`:
//   `{key_source}:{event_label}:{group_index}:{handler_index}`
//   - key_source: `std::fs::canonicalize(~/.codex/config.toml).display()` (the config source
//     layer identity; confirmed by codex-rs/app-server/tests/suite/v2/hooks_list.rs which keys
//     `{canonicalize(config.toml).display()}:pre_tool_use:0:0`).
//   - event_label: `hook_event_key_label()` — SessionStart→session_start,
//     UserPromptSubmit→user_prompt_submit, Stop→stop, PermissionRequest→permission_request.
//   - group_index/handler_index: positional. Our managed block writes exactly one
//     `[[hooks.<Ev>]]` group (0) with one `[[hooks.<Ev>.hooks]]` handler (0) per event ⇒ 0:0.
//     (Positional keying is a known upstream fragility (#23259); if a user pre-authored hooks
//     for the same event in the same layer our index would shift → gate reappears → fail-safe.)
//
// HASH — codex-rs/hooks/src/engine/discovery.rs `command_hook_hash`
//        → codex-rs/config/src/fingerprint.rs `version_for_toml`:
//   hash = "sha256:" + hex( sha256( canonical_json( toml_value( NormalizedHookIdentity ) ) ) )
//   NormalizedHookIdentity { event_name: <label>, #[serde(flatten)] group: MatcherGroup }
//   MatcherGroup { matcher: Option<String>, hooks: Vec<HookHandlerConfig> }
//   HookHandlerConfig::Command (codex-rs/config/src/hook_config.rs, `#[serde(tag="type")]`,
//     rename "command"): { command: String, commandWindows: Option, timeout(=timeout_sec):
//     Option<u64>, async: bool, statusMessage: Option }
//   Load-bearing serialization facts:
//     * `TomlValue::try_from` DROPS None fields (TOML has no null) → matcher / commandWindows /
//       statusMessage are omitted for our hooks; `async` is a plain bool (not Option) so
//       `async = false` IS present.
//     * event_name uses the snake_case label (session_start …), NOT the CamelCase event.
//     * `version_for_toml` converts the TomlValue → serde_json Value, `canonical_json` sorts
//       every object's keys recursively, then sha256's the COMPACT JSON bytes. serde_json's
//       compact output (no spaces, `/` unescaped, `"`/`\` JSON-escaped) matches JSON.stringify.
//   CONFIDENCE: the HASH is fully deterministic from the open source (JSON+sha256) — HIGH.
//   The KEY's exact key_source canonical form + the positional indices are what the VM
//   read-back must confirm — PROVISIONAL until then.

/** Recursively sort object keys (mirrors codex-rs fingerprint.rs `canonical_json`). */
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJsonValue);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalizeJsonValue(src[key]);
    return out;
  }
  return value;
}

const CODEX_HOOK_EVENT_KEY_LABEL: Record<(typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number], string> = {
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
  PermissionRequest: "permission_request",
};

export interface CodexHookTrustInput {
  /** Codex hook_key source identity: canonicalized `~/.codex/config.toml` path. */
  keySource: string;
  /** The command as Codex DESERIALIZES it — `node "<relay>"` (no outer TOML quote delimiters). */
  command: string;
  /** Our authored hook timeout (seconds). */
  timeoutSec: number;
  /** None for our hooks; folded into the hash when present (kept for faithful reproduction). */
  matcher?: string | null;
  /** None for our hooks; folded into the hash when present. */
  statusMessage?: string | null;
  /** Positional group index within the event's matcher-group list (our hooks: 0). */
  groupIndex?: number;
  /** Positional handler index within the group's handler list (our hooks: 0). */
  handlerIndex?: number;
}

/**
 * Reproduce Codex's persisted hook trust `{ key, trusted_hash }` for one authored activity
 * hook. Pure + deterministic. See the block comment above for the full RTFM derivation and the
 * PROVISIONAL-until-VM-read-back caveat.
 */
export function computeCodexHookTrust(
  event: (typeof OPENRIG_ACTIVITY_HOOK_EVENTS)[number],
  input: CodexHookTrustInput,
): { key: string; hash: string } {
  const label = CODEX_HOOK_EVENT_KEY_LABEL[event];
  const groupIndex = input.groupIndex ?? 0;
  const handlerIndex = input.handlerIndex ?? 0;
  const key = `${input.keySource}:${label}:${groupIndex}:${handlerIndex}`;

  // Build NormalizedHookIdentity exactly as `TomlValue::try_from` would: None fields dropped.
  const handler: Record<string, unknown> = {
    type: "command",
    command: input.command,
    timeout: input.timeoutSec,
    async: false,
  };
  if (input.statusMessage != null) handler.statusMessage = input.statusMessage;
  const identity: Record<string, unknown> = { event_name: label, hooks: [handler] };
  if (input.matcher != null) identity.matcher = input.matcher;

  const serialized = JSON.stringify(canonicalizeJsonValue(identity));
  const hex = createHash("sha256").update(serialized, "utf8").digest("hex");
  return { key, hash: `sha256:${hex}` };
}

/**
 * OPR.0.4.3.33 — idempotent, non-clobbering, section-scoped writer for a single
 * `[hooks.state."<key>"] trusted_hash = "<hash>"` record. Mirrors upsertCodexProjectTrust:
 * find/create the exact table header, splice ONLY its `trusted_hash` line, leave every other
 * `[hooks.state]` / `[projects]` entry and the managed hook block byte-identical. Same key+hash
 * ⇒ no-op. Only ever called for OUR 4 authored hook keys (never a blanket/wildcard trust).
 */
export function upsertCodexHookTrust(content: string, key: string, hash: string): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const trustLine = `trusted_hash = ${JSON.stringify(hash)}`;
  const lines = content.length > 0 ? content.split("\n") : [];
  const headerIndex = lines.findIndex((line) => line.trim() === header);

  if (headerIndex === -1) {
    const trimmed = content.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}${header}\n${trustLine}\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const hashIndex = lines.findIndex(
    (line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith("trusted_hash"),
  );
  if (hashIndex >= 0) {
    lines[hashIndex] = trustLine;
  } else {
    lines.splice(headerIndex + 1, 0, trustLine);
  }

  return `${lines.join("\n").replace(/\n*$/, "\n")}`;
}

function parseCanonicalSessionName(sessionName: string): { pod: string; member: string; rig: string } | null {
  const trimmed = sessionName.trim();
  const atIndex = trimmed.indexOf("@");
  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf("@") || atIndex === trimmed.length - 1) return null;

  const local = trimmed.slice(0, atIndex);
  const rig = trimmed.slice(atIndex + 1);
  const separatorIndex = local.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === local.length - 1) return null;

  const pod = local.slice(0, separatorIndex);
  const member = local.slice(separatorIndex + 1);
  if (!isSafeQueueSegment(pod) || !isSafeQueueSegment(member) || !isSafeQueueSegment(rig)) return null;

  return { pod, member, rig };
}

function isSafeQueueSegment(segment: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment);
}

export function isCodex013xOrLater(version: string): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = parseInt(match[1]!, 10);
  const minor = parseInt(match[2]!, 10);
  if (major > 0) return true;
  return minor >= 130;
}

// OPR.0.4.1.10 B2 — true for a real TOML `[features]` table header in ANY valid spelling.
// Normalize-and-compare (not incremental regex): a table header is `[ <key> ]` optionally
// followed by a comment. Per the TOML v1.0.0 spec (toml.io/en/v1.0.0, Keys/Table): whitespace
// around the bracketed key is ignored (`[ features ]` == `[features]`), and the key may be bare
// (`features`) or quoted as a basic/literal string (`"features"` / `'features'`) — all denote the
// same `features` table. A leading-`#` line is a comment, never a section. The `[^[\]]*` body
// excludes the array-of-tables `[[...]]` form. Used by BOTH feature upserts (DRY) so no header
// spelling is missed — a missed header appends a duplicate table that Codex 0.139 --strict-config
// rejects (config-could-not-be-loaded).
function isCodexFeaturesHeader(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("#")) return false;
  const match = /^\[([^[\]]*)\]\s*(#.*)?$/.exec(trimmed);
  if (!match) return false;
  let key = match[1]!.trim();
  if (
    key.length >= 2 &&
    ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
  ) {
    key = key.slice(1, -1);
  }
  return key === "features";
}

function upsertCodexHooksFeature(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex(isCodexFeaturesHeader);

  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\ncodex_hooks = true\n`;
  }

  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) {
      nextSectionIndex = i;
      break;
    }
  }

  const flagIndex = lines.findIndex((line, index) =>
    index > featuresIndex &&
    index < nextSectionIndex &&
    line.trim().startsWith("codex_hooks")
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "codex_hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
  }

  return `${lines.join("\n")}\n`;
}

// OPR.0.4.1.10 FR-A — config-layer activity-hook projection.
const OPENRIG_ACTIVITY_HOOKS_BEGIN = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOKS_END = "# END OPENRIG MANAGED ACTIVITY HOOKS";
const OPENRIG_ACTIVITY_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "PermissionRequest"] as const;

/**
 * Idempotently write the OpenRig activity hooks into a Codex config.toml: pin
 * `[features].hooks = true` (canonical key) and a sentinel-wrapped managed block of
 * inline `[[hooks.<Event>]]` stanzas (one representation per layer — never a sibling
 * hooks.json). Re-running with the same relay path is a no-op; a changed daemon path
 * replaces the block. `command` is a TOML literal string so the absolute relay path
 * needs no escaping; the inner double-quotes quote the path arg for the shell Codex
 * runs the hook under. No matcher (verified on 0.139: no-matcher fires for every
 * turn-scope event).
 */
function upsertCodexActivityHooks(content: string, relayPath: string): string {
  const command = `'node "${relayPath}"'`;
  const stanzas = OPENRIG_ACTIVITY_HOOK_EVENTS
    .map((ev) => `[[hooks.${ev}]]\n[[hooks.${ev}.hooks]]\ntype = "command"\ncommand = ${command}\ntimeout = 5`)
    .join("\n\n");
  const block = `${OPENRIG_ACTIVITY_HOOKS_BEGIN}\n${stanzas}\n${OPENRIG_ACTIVITY_HOOKS_END}\n`;

  let next = upsertCodexFeaturesHooksEnabled(content);

  const pattern = new RegExp(
    `${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}\\n?`,
    "m"
  );
  if (pattern.test(next)) {
    return next.replace(pattern, block);
  }
  const prefix = next.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/**
 * OPR.0.4.1.10 B3 — remove the OpenRig-managed activity-hooks sentinel block (durable disable).
 * Strips ONLY the BEGIN..END block (plus the leading blank-line separator it was appended with);
 * leaves all other content — user-owned hooks, [features], project trust — untouched. Returns the
 * input unchanged when the block is absent.
 */
function stripCodexActivityHooks(content: string): string {
  const pattern = new RegExp(
    `\\n*${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENRIG_ACTIVITY_HOOKS_END)}[ \\t]*\\n?`,
    "m"
  );
  if (!pattern.test(content)) return content;
  return content.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** Ensure `[features].hooks = true` (canonical key; not the deprecated codex_hooks alias). */
function upsertCodexFeaturesHooksEnabled(content: string): string {
  const lines = content.length > 0 ? content.replace(/\n*$/, "").split("\n") : [];
  const featuresIndex = lines.findIndex(isCodexFeaturesHeader);
  if (featuresIndex === -1) {
    const prefix = lines.length > 0 ? `${lines.join("\n")}\n\n` : "";
    return `${prefix}[features]\nhooks = true\n`;
  }
  let nextSectionIndex = lines.length;
  for (let i = featuresIndex + 1; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith("[")) { nextSectionIndex = i; break; }
  }
  const flagIndex = lines.findIndex(
    (line, index) => index > featuresIndex && index < nextSectionIndex && /^\s*hooks\s*=/.test(line)
  );
  if (flagIndex >= 0) {
    lines[flagIndex] = "hooks = true";
  } else {
    lines.splice(featuresIndex + 1, 0, "hooks = true");
  }
  return `${lines.join("\n")}\n`;
}

function upsertManagedCodexConfigFragment(content: string, id: string, fragment: string): string {
  const start = `# BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const end = `# END OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const block = `${start}\n${fragment.replace(/\n*$/, "")}\n${end}\n`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  const prefix = content.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function defaultListProcesses(): Array<{ pid: number; ppid: number; command: string }> {
  try {
    const output = execFileSync("ps", ["-Ao", "pid,ppid,command"], { encoding: "utf-8" });
    return output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(.*)$/);
        if (!match) return null;
        return {
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3] ?? "",
        };
      })
      .filter((row): row is { pid: number; ppid: number; command: string } => row !== null);
  } catch {
    return [];
  }
}

function findCodexDescendantPids(
  processes: Array<{ pid: number; ppid: number; command: string }>,
  parentPid: number
): number[] {
  const childrenByParent = new Map<number, Array<{ pid: number; command: string }>>();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ppid) ?? [];
    siblings.push({ pid: proc.pid, command: proc.command });
    childrenByParent.set(proc.ppid, siblings);
  }

  const matches: number[] = [];
  const visit = (pid: number): void => {
    for (const child of childrenByParent.get(pid) ?? []) {
      visit(child.pid);
      if (commandLooksLikeCodex(child.command)) {
        matches.push(child.pid);
      }
    }
  };

  visit(parentPid);
  return matches;
}

function commandLooksLikeCodex(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return tokens.some((token) => {
    const unquoted = token.replace(/^['"]|['"]$/g, "");
    const base = nodePath.basename(unquoted);
    return base === "codex";
  });
}

function isSkippableCodexUpdatePrompt(paneContent: string): boolean {
  return paneContent.includes("Update available!")
    && paneContent.includes("Skip until next version");
}
