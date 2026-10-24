import { codexEnvelopeArgs } from "../domain/codex-rebuild-permissions.js";
import { operationalLaunchArg } from "./kernel-authority.js";
import nodePath from "node:path";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { parse as parseToml } from "smol-toml";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { codexPostureArg } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";
// Type-only — keeps the profile-preflight module's dynamic import lazy for
// production (no runtime import cost from this line).
import type { CodexProfileProbeResult } from "../domain/codex-profile-preflight.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { observeCodexSandbox, type AppliedLaunchObservation } from "../domain/permission-drift.js";
import {
  defaultResolveHomeDirByPid,
  CodexThreadIdResolver,
  lstartToMinTs,
  readCodexThreadIdFromCandidateHomes,
  type ResolveHomeDirByPid,
} from "../domain/codex-thread-id.js";
import { assessNativeResumeProbe, buildCodexResumeCore, hasCodexUpdateHeader, type NativeResumeProbeResult } from "../domain/native-resume-probe.js";
import { unknownDaemonSupportMessage, type CodexDaemonSupportDetector } from "../domain/codex-daemon-support.js";
import { CODEX_NETWORK_DEFAULT_OVERRIDE, codexNetworkDefaultArg, type CodexNetworkDefaultReader } from "../domain/codex-network-default.js";
import { resolveCodexGitAddDirs, type CodexGitAddDirResolver } from "../domain/codex-git-add-dirs.js";
import { isPerSeatRoleGuidance, mergeManagedBlock, perSeatRoleSkipWarning } from "../domain/managed-blocks.js";
import { excludeNewGeneratedFiles } from "../domain/generated-file-hygiene.js";
import { codexQueueStateRoot, codexTeamWorkspaceArg, type PrepareCodexTeamWorkspace } from "../domain/codex-team-workspace.js";
import { shellQuote } from "./shell-quote.js";
import { execRuntimeProbe } from "./runtime-probe-exec.js";
import { resolveReadinessTimeoutMs } from "../domain/readiness-timeout.js";
import type { SettingsStore } from "../domain/user-settings/settings-store.js";
import {
  CODEX_CORE_MARKETPLACE, CODEX_CORE_PLUGIN, CODEX_CORE_PLUGIN_KEY, CODEX_MARKETPLACE_MANIFEST_PATH,
  codexCoreMarketplaceManifest, codexCorePluginEnablement, codexReadableConfigLayers, recordedMarketplaceSource, userLayerEnablesCorePlugin,
  type CodexConfigLayerRead,
} from "../domain/codex-core-plugin-install.js";

/** Runs Codex's own CLI with the daemon's CODEX_HOME; tests inject a recorder. */
export type CodexCliRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<{ status: number | null; stdout: string; stderr: string }>;

const defaultCodexCli: CodexCliRunner = (args, env) => new Promise((resolve) => {
  execFile("codex", args, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    const status = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
    // A spawn failure (ENOENT, EACCES) has no exit code and empty output: keep its message as the reason.
    const err = String(stderr ?? "");
    resolve({ status, stdout: String(stdout ?? ""), stderr: err.trim() || !error ? err : error.message });
  });
});

// Codex's hook trust recipe (the key and hash Codex records for a trusted hook), kept in one script.
const codexHookTrust = createRequire(import.meta.url)("../../assets/plugins/openrig-core/hooks/scripts/codex-hook-trust.cjs") as {
  computeCodexHookTrust(event: string, input: CodexHookTrustInput): { key: string; hash: string };
  codexHookHash(eventLabel: string, handler: { command: string; timeoutSec: number; matcher?: string | null; statusMessage?: string | null }): string;
};

import { listNativeProcesses, observeCodexPaneProcess, observeCodexForkProcess, verifyCodexPaneProcess, verifyPaneIdleShell, type NativeProcessRow } from "../domain/native-process-lineage.js";
import { recordSeatSkillWrite, seatPluginSkillsLossNote, seatProjectionComplete, seatSkillWriteRefusal } from "../domain/seat-skill-storage.js";
import { codexPluginContentHash, planOwnedCodexContentApproval, recordOwnedCodexApproval } from "../domain/codex-owned-plugin-trust.js";

// Shared by all probes of ONE launch, never reset by a delayed screen or an
// ambiguous transport result. A separately requested launch gets a new attempt.
interface UpdatePromptAttempt {
  handled: boolean;
  failure?: Extract<HarnessLaunchResult, { ok: false }>;
  /** Reporting only: the latest screen the helper itself captured and classified, in capture order, so a report can
   *  name it rather than an older capture. `beforeInput` marks a screen the helper then sent (or tried to send) its key
   *  to, with no later capture. Never read by a polling or recovery decision. */
  observed?: { probe: NativeResumeProbeResult; paneContent: string; beforeInput?: true };
  /** Reporting only: whether the helper sent the update prompt's skip key on this launch, and how that send came out. */
  skipKey?: "sent" | "failed";
}

type CodexProcess = NativeProcessRow;

/** What a running Codex was launched with that a launch would otherwise decide by probing (the network
 *  reader, the --no-daemon support probe) or by preparing directories (add-dirs). A relaunch that must keep the
 *  running Codex's effective settings takes these from its argv instead. */
export interface RunningCodexLaunch {
  networkOverride: boolean;
  daemonOptOut: boolean;
  addDirs: string[];
}

interface PreparedCodexLaunch {
  ok: true;
  model: string | undefined;
  modelArg: string;
  effort: string | undefined;
  effortArg: string;
  profile: string | undefined;
  appliedLaunch: AppliedLaunchObservation;
  postureArg: string;
  queueStateDirArg: string;
  suppressAutoAddDirs: boolean;
  daemonOptOut: boolean;
  daemonArg: string;
  networkArg: string;
}

export interface CodexAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  /** Source file permission bits (for mode-preserving projection). Optional: mode preservation is a no-op if absent. */
  statMode?(path: string): number;
  /** Apply permission bits to a file (for mode-preserving projection). Optional: no-op if absent. */
  chmod?(path: string, mode: number): void;
  homedir?: string;
}

/** #1524 (b): what Codex's own records say about one process's conversation: its thread id, or why none was read
 *  (a capture diagnostic such as `no_log_row`, `no_cli_thread`, `ambiguous_threads` or `sqlite_unreadable`). */
export type CodexResumeEvidence = { threadId: string; reason?: undefined } | { threadId?: undefined; reason: string };

// The managed resume check's poll window: a quick phase, then an extended one for a slow boot.
const RESUME_QUICK_ATTEMPTS = 6;
const RESUME_EXTENDED_ATTEMPTS = 24;
const RESUME_QUICK_SLEEP_MS = 200;
const RESUME_EXTENDED_SLEEP_MS = 500;

/**
 * Codex runtime adapter. Projects resources to .agents/ targets (preserving
 * existing Codex filesystem contract) and delivers startup files.
 */
export class CodexRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "codex";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: CodexAdapterFsOps;
  private listProcesses: () => CodexProcess[] | Promise<CodexProcess[]>;
  private readThreadIdByPid: (pid: number, identity?: string, home?: string) => Promise<string | undefined> | string | undefined;
  private readResumeEvidence: (pid: number, identity: string, home?: string) => Promise<CodexResumeEvidence> | CodexResumeEvidence;
  private resumeProofWindowMs: number;
  private readinessSettings?: Pick<SettingsStore, "resolveOne">;
  private sleep: (ms: number) => Promise<void>;
  private resolveHomeDirByPid: ResolveHomeDirByPid;
  private codexHome?: string;
  /** A seat's own CODEX_HOME from its member or rig `env:`, when it declares one. */
  private seatHome?: (nodeId: string) => string | undefined;
  /** One thread-id resolver per Codex home its seats use, the daemon's included. */
  private threadResolvers = new Map<string, CodexThreadIdResolver>();
  private launchPath?: string;
  // Housekeeping B1 fixback (guard-blocking, arch HK-AR-1 = whole-probe DI):
  // the Codex profile-LOAD probe is an injectable dep in the adapter's
  // established optional-deps shape. Default = the REAL probe
  // (defaultProfilePreflight, module-private); tests inject a controlled probe
  // so no real codex subprocess runs. Contract not weakened — production uses
  // the real probe by default.
  private verifyProfilePreflight: (profile: string, cwd: string, home?: string) => Promise<CodexProfileProbeResult>;
  // #69: whether the installed Codex supports --no-daemon. Startup wires the real probe;
  // absent (unit tests, other embedders) keeps the existing invocation unchanged.
  private detectDaemonSupport?: CodexDaemonSupportDetector;
  // #275: Codex's own answer on whether the plain floor may get network access. Startup wires the
  // real reader; absent keeps every invocation unchanged.
  private readNetworkDefault?: CodexNetworkDefaultReader;
  // Issue #121: git metadata dirs for the fresh-launch `--add-dir`s (a linked worktree's `.git` is a file).
  // Default = the real resolver; tests may inject a controlled one.
  private resolveGitAddDirs: CodexGitAddDirResolver;
  private prepareTeamWorkspace?: PrepareCodexTeamWorkspace;
  private resolveManagedConfigSettings?: () => Promise<{ enabled: boolean; codexVersion?: string }>;
  private resolveHooksEnabled?: () => Promise<boolean>;
  // OPR.0.4.1.10 FR-B — absolute path to the daemon's own shipped activity-relay.cjs,
  // resolved by startup from import.meta.dirname. Used by ensureCodexActivityHooks
  // (FR-A) to write config-layer [hooks] command entries that are cwd-independent and
  // version-matched to the running daemon (NOT ${PLUGIN_ROOT}, NOT a per-cwd copy).
  private activityRelayPath?: string;
  // The vendored openrig-core plugin directory, resolved when the install step runs (vendoring happens at startup).
  private resolveCorePluginDir?: () => string | undefined;
  // Whether a node's resolved plugin selection includes openrig-core (the test that also gives it OPENRIG_SEAT_PROJECT_DIR).
  private resolveCorePluginSelected?: (nodeId: string) => boolean;
  private runCodexCli: CodexCliRunner;
  // One Codex config.toml per adapter: launches, the boot step and resume all write it (and Codex's install writes it too),
  // so each of those runs its whole setup under this one lock, one after another.
  private configLock: Promise<unknown> = Promise.resolve();
  private codexSystemConfigDir: string;

  /** Build the Codex launch adapter with injectable filesystem, process, and CLI seams for isolated checks. */
  constructor(deps: {
    tmux: TmuxAdapter;
    seatLaunchEnvironment?: SeatLaunchEnvironment;
    fsOps: CodexAdapterFsOps;
    listProcesses?: () => CodexProcess[] | Promise<CodexProcess[]>;
    readThreadIdByPid?: (pid: number, identity?: string, home?: string) => Promise<string | undefined> | string | undefined;
    /** #1524 (b): the conversation Codex's own records name for one process (pid and start time), or why none
     *  could be read. Default: the identity-gated thread reader for the launched process. */
    readResumeEvidence?: (pid: number, identity: string, home?: string) => Promise<CodexResumeEvidence> | CodexResumeEvidence;
    /** The managed resume check's whole window in ms. Default: the existing poll window (tests shorten it). */
    resumeProofWindowMs?: number;
    readinessSettings?: Pick<SettingsStore, "resolveOne">;
    resolveHomeDirByPid?: ResolveHomeDirByPid;
    sleep?: (ms: number) => Promise<void>;
    activityRelayPath?: string;
    /** Explicit CODEX_HOME; absent preserves the legacy OS/PID home behavior. */
    codexHome?: string;
    /** A seat's own CODEX_HOME (an absolute path its member or rig `env:` declares). It wins over `codexHome` for that seat. */
    seatHome?: (nodeId: string) => string | undefined;
    /** Match the daemon's prerequisite probe even if the pane's login shell rewrites PATH. */
    launchPath?: string;
    verifyProfilePreflight?: (profile: string, cwd?: string, home?: string) => Promise<CodexProfileProbeResult>;
    detectDaemonSupport?: CodexDaemonSupportDetector;
    readNetworkDefault?: CodexNetworkDefaultReader;
    resolveGitAddDirs?: CodexGitAddDirResolver;
    prepareTeamWorkspace?: PrepareCodexTeamWorkspace;
    /** Resolves the hooks setting and Codex version that ensureManagedConfig applies. Absent: no managed config write. */
    resolveManagedConfigSettings?: () => Promise<{ enabled: boolean; codexVersion?: string }>;
    /** Whether runtime.codex.hooks_enabled is on, without resolving the Codex version. Absent: nothing is stripped. */
    resolveHooksEnabled?: () => Promise<boolean>;
    /** The vendored openrig-core directory. Absent: the plugin is never installed into Codex. */
    resolveCorePluginDir?: () => string | undefined;
    /** Whether the node's resolved plugin selection includes openrig-core. Absent: no launch ever installs it. */
    resolveCorePluginSelected?: (nodeId: string) => boolean;
    runCodexCli?: CodexCliRunner;
    /** Where Codex's system and legacy managed config files live (default /etc/codex). */
    codexSystemConfigDir?: string;
  }) {
    this.resolveCorePluginDir = deps.resolveCorePluginDir;
    this.resolveCorePluginSelected = deps.resolveCorePluginSelected;
    this.runCodexCli = deps.runCodexCli ?? defaultCodexCli;
    this.codexSystemConfigDir = deps.codexSystemConfigDir ?? "/etc/codex";
    this.tmux = deps.tmux;
    this.resolveManagedConfigSettings = deps.resolveManagedConfigSettings;
    this.resolveHooksEnabled = deps.resolveHooksEnabled;
    this.prepareTeamWorkspace = deps.prepareTeamWorkspace;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.codexHome = deps.codexHome;
    this.seatHome = deps.seatHome;
    this.launchPath = deps.launchPath;
    this.detectDaemonSupport = deps.detectDaemonSupport;
    this.readNetworkDefault = deps.readNetworkDefault;
    this.resolveGitAddDirs = deps.resolveGitAddDirs ?? resolveCodexGitAddDirs;
    this.activityRelayPath = deps.activityRelayPath;
    this.listProcesses = deps.listProcesses ?? defaultListProcesses;
    this.resolveHomeDirByPid = deps.resolveHomeDirByPid ?? defaultResolveHomeDirByPid;
    // A seat with its own CODEX_HOME logs its threads there, so each read names the home it searches.
    this.readThreadIdByPid = deps.readThreadIdByPid ?? ((pid, identity, home) => identity === undefined
      ? this.readThreadIdFromLogs(pid, home) : this.threadResolverFor(home).resolveForkChild(pid, identity));
    // A just-launched resume may log only inside its start second, so this reads like a fork child's ("by-process").
    this.readResumeEvidence = deps.readResumeEvidence ?? (deps.readThreadIdByPid
      ? async (pid, identity, home) => {
        const threadId = (await deps.readThreadIdByPid!(pid, identity, home))?.trim();
        return threadId ? { threadId } : { reason: "no_log_row" };
      }
      : async (pid, identity, home) => {
        let reason: string | undefined;
        const threadId = (await this.threadResolverFor(home).resolveForkChild(pid, identity, (d) => { reason = d.reason; }))?.trim();
        return threadId ? { threadId } : { reason: reason ?? "no_log_row" };
      });
    this.resumeProofWindowMs = deps.resumeProofWindowMs ?? RESUME_QUICK_ATTEMPTS * RESUME_QUICK_SLEEP_MS + RESUME_EXTENDED_ATTEMPTS * RESUME_EXTENDED_SLEEP_MS;
    this.readinessSettings = deps.readinessSettings;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.verifyProfilePreflight = deps.verifyProfilePreflight ?? ((profile, cwd, home) => {
      const selected = home ?? this.codexHome;
      return defaultProfilePreflight(profile, selected ? { cwd, codexHome: selected, launchPath: this.launchPath } : undefined);
    });
  }

  /** The home a seat's Codex uses: its own from its member or rig `env:`, else the daemon's explicit CODEX_HOME. Undefined
   *  keeps the legacy OS/PID home behavior. */
  private homeFor(binding: { nodeId?: string } | undefined): string | undefined {
    return this.ownHome(binding) ?? this.codexHome;
  }

  /** Only the seat's own CODEX_HOME, undefined when it declares none. Probes and readers get it as an extra argument
   *  only when it's set, so a seat without one calls them exactly as before. */
  private ownHome(binding: { nodeId?: string } | undefined): string | undefined {
    return binding?.nodeId ? this.seatHome?.(binding.nodeId) : undefined;
  }

  private ownHomeCommandOpt(binding: { nodeId?: string }): { codexHome?: string } {
    const own = this.ownHome(binding);
    return own ? { codexHome: own } : {};
  }

  private ownHomeOpt(binding: { nodeId?: string }): { home?: string } {
    const own = this.ownHome(binding);
    return own ? { home: own } : {};
  }

  /** A thread id read for this seat's process, in the seat's own home when it declares one. */
  private readThreadIdForSeat(binding: { nodeId?: string }, pid: number, identity?: string): Promise<string | undefined> | string | undefined {
    const own = this.ownHome(binding);
    if (own) return this.readThreadIdByPid(pid, identity, own);
    return identity === undefined ? this.readThreadIdByPid(pid) : this.readThreadIdByPid(pid, identity);
  }

  /** The thread-id resolver for one Codex home (undefined: the daemon's), kept so its process-home cache is reused. */
  private threadResolverFor(home: string | undefined): CodexThreadIdResolver {
    const selected = home ?? this.codexHome;
    let resolver = this.threadResolvers.get(selected ?? "");
    if (!resolver) {
      resolver = new CodexThreadIdResolver({ defaultHome: this.fs.homedir ?? os.homedir(), codexHome: selected,
        resolveHomeDirByPid: this.resolveHomeDirByPid });
      this.threadResolvers.set(selected ?? "", resolver);
    }
    return resolver;
  }

  /**
   * Bring the Codex config.toml to the state OpenRig-managed seats need: feature flag,
   * activity hooks and their trust, or the stripped block when hooks are disabled. Runs when
   * a daemon has Codex seats (boot) or is about to launch one, never for a daemon without
   * them: a rig with no Codex seat leaves the user's config alone. A failure warns and does
   * not block the launch.
   */
  async ensureManagedConfig(home?: string): Promise<{ hooksEnabled: boolean } | undefined> {
    return this.withConfigLock(() => this.applyManagedConfig(home));
  }

  /** Run `task` after every earlier config setup on this adapter has finished, whatever its outcome. */
  private withConfigLock<T>(task: () => Promise<T>): Promise<T> {
    const run = this.configLock.then(task, task);
    this.configLock = run.catch(() => undefined);
    return run;
  }

  private async applyManagedConfig(home?: string): Promise<{ hooksEnabled: boolean } | undefined> {
    if (!this.resolveManagedConfigSettings) return undefined;
    try {
      const { enabled, codexVersion } = await this.resolveManagedConfigSettings();
      this.ensureCodexFeatureFlag(enabled, { codexVersion }, home);
      if (enabled) this.ensureCodexActivityHooks(home);
      else this.removeCodexActivityHooks(home);
      return { hooksEnabled: enabled };
    } catch (err) {
      console.error(`[openrig] runtime setup warning: ${(err as Error).message}`);
      return undefined;
    }
  }

  /**
   * Boot step, run after the plugin is vendored: install openrig-core into Codex only when hooks are enabled and some
   * Codex seat's resolved selection includes it. A daemon whose Codex seats didn't select it never installs it.
   */
  async ensureCodexCorePluginAtBoot(anySeatSelected: boolean): Promise<void> {
    if (!anySeatSelected || !this.resolveHooksEnabled) return;
    const resolveHooksEnabled = this.resolveHooksEnabled;
    await this.withConfigLock(async () => {
      try {
        if (await resolveHooksEnabled()) await this.ensureCodexCorePlugin();
      } catch (err) {
        console.error(`[openrig] runtime setup warning: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Install the vendored openrig-core plugin into Codex through Codex's own commands, so a seat that selected it gets its
   * refocus and skills, trusting exact shipped hooks on first install and renewing proven owned content approvals. It runs only when the person's config
   * doesn't disable the plugin (codexCorePluginEnablement), and only when the installed version differs from the vendored
   * one. Codex owns its plugin cache; its immutable legacy trust baseline is never rewritten.
   */
  async ensureCodexCorePlugin(home?: string): Promise<{ outcome: "installed" | "current" | "skipped"; reason: string }> {
    const report = (outcome: "installed" | "current" | "skipped", reason: string) => {
      if (outcome !== "current") console.error(`[openrig] codex core plugin ${outcome}: ${reason}`);
      return { outcome, reason };
    };
    const pluginDir = this.resolveCorePluginDir?.();
    if (!pluginDir) return { outcome: "skipped", reason: "the openrig-core plugin isn't vendored" };
    let version: unknown;
    try { version = (JSON.parse(this.fs.readFile(nodePath.join(pluginDir, ".codex-plugin", "plugin.json"))) as { version?: unknown }).version; }
    catch { return report("skipped", "the vendored plugin has no readable Codex manifest"); }
    if (typeof version !== "string" || !/^[0-9A-Za-z._-]+$/.test(version)) return report("skipped", "the vendored plugin's Codex manifest has no usable version");

    const shipped = nodePath.resolve(import.meta.dirname, "../../assets/plugins/openrig-core");
    const ownFiles: string[] = [];
    const collect = (dir: string, relative = "hooks") => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = nodePath.join(relative, entry.name);
        if (entry.isDirectory()) collect(nodePath.join(dir, entry.name), child);
        else ownFiles.push(child);
      }
    };
    collect(nodePath.join(shipped, "hooks"));
    ownFiles.push(".codex-plugin/plugin.json");
    const matchesShipped = (dir: string) => ownFiles.every(relative => {
      try { return fs.readFileSync(nodePath.join(dir, relative)).equals(fs.readFileSync(nodePath.join(shipped, relative))); }
      catch { return false; }
    });
    if (!matchesShipped(pluginDir)) return report("skipped", "vendored hook files differ from this daemon's shipped plugin; existing choices are left alone");
    // Installation retains the hook-file predicate; any approval requires the complete shipped tree.
    const matchesShippedTree = (dir: string) => {
      try { return codexPluginContentHash(dir, true) === codexPluginContentHash(shipped, true); }
      catch { return false; }
    };

    const codexHome = nodePath.dirname(this.resolveCodexConfigPath(home));
    const readLayers = (): CodexConfigLayerRead[] => codexReadableConfigLayers(codexHome, this.codexSystemConfigDir).map((layer) => {
      if (!this.fs.exists(layer.path)) return { ...layer, state: "absent" as const };
      try { return { ...layer, state: "read" as const, content: this.fs.readFile(layer.path) }; }
      catch (error) { return { ...layer, state: "unreadable" as const, reason: (error as Error).message }; }
    });
    const layers = readLayers();
    const enablement = codexCorePluginEnablement(layers);
    if (enablement.decision !== "allow") return report("skipped", enablement.reason);

    const pluginsDir = nodePath.dirname(pluginDir);
    const userLayer = layers.find((layer) => layer.name === "user config");
    const userConfig = userLayer?.state === "read" ? userLayer.content : null;
    const recorded = recordedMarketplaceSource(userConfig);
    // Compared as real paths, so a marketplace recorded through a symlink to the plugins folder is the same source.
    const canonical = (p: string) => { try { return fs.realpathSync.native(nodePath.resolve(p)); } catch { return nodePath.resolve(p); } };
    if (recorded !== undefined && (recorded === null || canonical(recorded) !== canonical(pluginsDir))) {
      return report("skipped", `a marketplace named ${CODEX_CORE_MARKETPLACE} is already configured with another source; it's left alone`);
    }

    // Current only when Codex would load it: the vendored version is in its store AND the user config still registers it
    // (our marketplace, and an explicit enabled = true, which Codex's install writes). Codex loads only configured
    // plugins, so a cache left behind after the entry or the marketplace was removed is installed again.
    const cacheRoot = nodePath.join(codexHome, "plugins", "cache", CODEX_CORE_MARKETPLACE, CODEX_CORE_PLUGIN);
    const cachedDir = nodePath.join(cacheRoot, version);
    const cached = this.fs.exists(cachedDir);
    // Codex's "continue without trusting" choice writes no state. An existing install/configuration may therefore be a
    // decline even with no hooks.state entry. Absent grants still stay under native review. A proven owned grant may
    // renew its content approval; an unrecorded skip of that exact owned upgrade cannot be distinguished from pending approval.
    const firstInstall = !this.fs.exists(cacheRoot) && !layers.some(layer => layer.state === "read"
      && Object.hasOwn((parseToml(layer.content).plugins ?? {}) as object, CODEX_CORE_PLUGIN_KEY));
    const renewContentApproval = (freshGrant = false) => {
      const configPath = this.resolveCodexConfigPath(home);
      const currentLayers = readLayers();
      if (codexCorePluginEnablement(currentLayers).decision !== "allow") return;
      const before = this.fs.readFile(configPath);
      const currentSource = recordedMarketplaceSource(before);
      if (currentSource == null || canonical(currentSource) !== canonical(pluginsDir) || !userLayerEnablesCorePlugin(before)) return;
      let content = before;
      const planned = planOwnedCodexContentApproval({ configPath, content, layers: currentLayers, shipped, installed: cachedDir, freshGrant });
      if (!planned) return;
      for (const [key, hash] of Object.entries(planned.hashes)) content = upsertCodexHookTrust(content, key, hash, "trusted_content_hash");
      // The line writer must not alter examples in strings or duplicate quoted keys.
      try {
        const expected = parseToml(before) as { hooks: { state: Record<string, Record<string, unknown>> } };
        for (const [key, hash] of Object.entries(planned.hashes)) expected.hooks.state[key]!.trusted_content_hash = hash;
        if (!isDeepStrictEqual(parseToml(content), expected)) return;
      } catch { return; } // Leave native review and owner bytes intact for unsupported TOML spellings.
      if (this.fs.readFile(configPath) !== before) return; // A concurrent native choice wins.
      if (content !== before) this.fs.writeFile(configPath, content);
      recordOwnedCodexApproval(configPath, planned.approval);
    };
    if (cached && recorded !== undefined && userLayerEnablesCorePlugin(userConfig)) {
      renewContentApproval();
      return report("current", `${CODEX_CORE_PLUGIN_KEY} ${version} is installed and registered`);
    }
    const manifestPath = nodePath.join(pluginsDir, CODEX_MARKETPLACE_MANIFEST_PATH);
    const manifest = codexCoreMarketplaceManifest();
    if (!this.fs.exists(manifestPath) || this.fs.readFile(manifestPath) !== manifest) {
      this.fs.mkdirp(nodePath.dirname(manifestPath));
      this.fs.writeFile(manifestPath, manifest);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: codexHome, ...(this.launchPath ? { PATH: this.launchPath } : {}) };
    if (recorded === undefined) {
      const added = await this.runCodexCli(["plugin", "marketplace", "add", pluginsDir], env);
      if (added.status !== 0) return report("skipped", `codex plugin marketplace add failed: ${(added.stderr || added.stdout).trim() || `exit ${added.status}`}`);
    }
    const installed = await this.runCodexCli(["plugin", "add", CODEX_CORE_PLUGIN_KEY], env);
    if (installed.status !== 0) return report("skipped", `codex plugin add failed: ${(installed.stderr || installed.stdout).trim() || `exit ${installed.status}`}`);
    // First install grants declarations; Codex0.164 also requires full-bundle content approval. Existing declaration
    // choices are never rewritten. No cache files or native baseline files are rewritten here.
    let freshGrants = 0;
    const grantLayers = readLayers();
    if (firstInstall && codexCorePluginEnablement(grantLayers).decision === "allow" && matchesShippedTree(cachedDir)) {
      let content = this.fs.readFile(this.resolveCodexConfigPath(home));
      const hookManifest = JSON.parse(fs.readFileSync(nodePath.join(shipped, "hooks/codex.json"), "utf8"));
      for (const [event, groups] of Object.entries(hookManifest.hooks) as Array<[string, Array<{ matcher?: string; hooks: Array<{ command: string; timeout: number }> }>]> ) {
        groups.forEach((group, groupIndex) => group.hooks.forEach((handler, handlerIndex) => {
          const { key, hash } = codexHookTrust.computeCodexHookTrust(event, {
            ...handler, timeoutSec: handler.timeout, matcher: group.matcher,
            keySource: `${CODEX_CORE_PLUGIN_KEY}:hooks/codex.json`, groupIndex, handlerIndex,
          });
          // Any existing choice in any readable layer/profile wins; never overwrite enabled=false or an old hash.
          const hasChoice = (doc: unknown): boolean => {
            if (!doc || typeof doc !== "object") return false;
            const value = doc as { hooks?: { state?: Record<string, unknown> } };
            return Object.hasOwn(value.hooks?.state ?? {}, key) || Object.values(doc).some(hasChoice);
          };
          if (!hasChoice(parseToml(content)) && !grantLayers.some(layer => layer.state === "read" && hasChoice(parseToml(layer.content)))) {
            content = upsertCodexHookTrust(content, key, hash);
            freshGrants++;
          }
        }));
      }
      this.fs.writeFile(this.resolveCodexConfigPath(home), content);
    }
    renewContentApproval(freshGrants === 6);
    return report("installed", `${CODEX_CORE_PLUGIN_KEY} ${version} through Codex's own install (${enablement.reason})`);
  }

  /**
   * Boot step for a daemon without Codex seats: when runtime.codex.hooks_enabled is false,
   * strip OpenRig's managed hooks block, as every boot did before. Removal writes only when
   * the block is present, so a config without it stays byte-identical, and with hooks enabled
   * nothing is touched. Without this an operator with no Codex seat has no OpenRig way to
   * remove a stale block. A failure warns.
   */
  async stripManagedHooksIfDisabled(): Promise<void> {
    if (!this.resolveHooksEnabled) return;
    try {
      if (!(await this.resolveHooksEnabled())) this.removeCodexActivityHooks();
    } catch (err) {
      console.error(`[openrig] runtime setup warning: ${(err as Error).message}`);
    }
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
  ensureCodexFeatureFlag(enabled: boolean, opts?: { codexVersion?: string }, home?: string): void {
    if (!enabled) return;
    if (!opts?.codexVersion) return;
    if (isCodex013xOrLater(opts.codexVersion)) return;
    const configPath = this.resolveCodexConfigPath(home);
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
   * is intentionally NOT used here). Trust is scoped to the exact authored hook
   * hashes below; remaining native review prompts require an operator decision.
   * The relay inherits the seat's OPENRIG_* env from the tmux session.
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
  ensureCodexActivityHooks(home?: string): void {
    const relay = this.activityRelayPath;
    if (!relay || !this.fs.exists(relay)) {
      if (relay) {
        console.error(`[openrig] codex activity hooks skipped: relay asset not found at ${relay}`);
      }
      return;
    }
    const configPath = this.resolveCodexConfigPath(home);
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
    // — without a blanket native trust keystroke. If native identity/hash semantics
    // change, the remaining review is surfaced for a decision. Idempotent
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
      keySource = fs.realpathSync.native(configPath);
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
  removeCodexActivityHooks(home?: string): void {
    const configPath = this.resolveCodexConfigPath(home);
    if (!this.fs.exists(configPath)) return;
    const existing = this.fs.readFile(configPath);
    const updated = stripCodexActivityHooks(existing);
    if (updated !== existing) {
      this.fs.writeFile(configPath, updated);
    }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = binding.seatSkillsRoot ?? nodePath.join(binding.cwd, ".agents", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd, warnings, binding.seatSkillsRoot, binding.seatSkillsRefused, this.homeFor(binding));
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    try { this.ensureManagedBootstrap(binding); } catch (err) {
      console.error(`[openrig] codex bootstrap warning: ${(err as Error).message}`);
    }

    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? this.detectDeliveryHint(file.path, content, file.orientation) : file.deliveryHint;

        switch (hint) {
          case "guidance_merge": {
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content, warnings);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.seatSkillsRoot ?? nodePath.join(binding.cwd, ".agents", "skills"), nodePath.basename(nodePath.dirname(file.absolutePath)));
            const skillTarget = nodePath.join(targetDir, nodePath.basename(file.path));
            // OPR.0.7.0.13: never write through a link out of the seat's storage.
            const refusal = binding.seatSkillsRoot ? binding.seatSkillsRefused ?? seatSkillWriteRefusal(binding.seatSkillsRoot, skillTarget) : undefined;
            if (refusal) { warnings.push(`skill_install: ${refusal}`); continue; }
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(skillTarget, content);
            if (binding.seatSkillsRoot) recordSeatSkillWrite(binding.seatSkillsRoot, skillTarget, file.absolutePath, content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
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

    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
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

    const updatePrompt: UpdatePromptAttempt = { handled: false };
    // Only a launch that starts a conversation may install the core plugin; a resume never does.
    const prepared = await this.prepareLaunch(binding, opts.name, undefined, { installCorePlugin: !opts.resumeToken });
    if (!prepared.ok) return prepared;
    const { modelArg, effortArg, appliedLaunch, postureArg, queueStateDirArg, daemonArg, networkArg, suppressAutoAddDirs } = prepared;

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
      // OPR.0.4.8.2: the FORK path uses the SAME posture decision (codexPostureArg) — YOLO forces
      // -s danger-full-access on every seat; otherwise the named profile, or OpenRig's explicit
      // -s workspace-write floor flag.
      // 0.5.2-07 A2-3: the FORK path threads the SPEC model too (fork-instantiate reverted it before).
      const cmd = `codex${daemonArg}${postureArg}${networkArg}${modelArg}${effortArg} fork${queueStateDirArg} ${shellQuote(parentId)}`;
      const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, await this.seatCommand(binding, cmd));
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt, 8);
      if (updatePrompt.failure) return updatePrompt.failure;
      // A handover keeps its own capture and checks (#1216). Any other fork saves an id and sends its
      // role only for the child `rig seat continue` would also verify: a foreground chain forking this
      // parent, whose own start-time-gated record supplies the id.
      const threadId = opts.forkSource.pendingIdAllowed
        ? await this.captureFreshThreadId(binding, updatePrompt)
        : await this.captureVerifiedForkId(binding, updatePrompt, parentId,
          resolveReadinessTimeoutMs(undefined, this.readinessSettings));
      if (updatePrompt.failure) return updatePrompt.failure;
      if (!threadId) {
        // For a handover a missed capture is pending metadata, not a failed launch: the fork returns
        // without a token and the handover's readiness checks still decide success. Any other fork
        // keeps its unsent context pending for `rig seat continue`, which verifies the child first.
        if (opts.forkSource.pendingIdAllowed) return { ok: true, appliedLaunch };
        return {
          ok: false,
          error: "codex fork: could not capture new post-fork thread id",
          recovery: "attention_required",
          forkIdentityPending: true,
        };
      }
      return { ok: true, resumeToken: threadId, resumeType: "codex_id", appliedLaunch };
    }

    // OPR.0.4.8.2: one posture decision (codexPostureArg) for the fresh launch too — YOLO forces
    // -s danger-full-access (overrides even a named profile); otherwise the named profile, or
    // OpenRig's explicit -s workspace-write floor flag.
    // Issue #121: only the fresh launch adds git metadata dirs; resume and fork never did.
    const gitDirArg = opts.resumeToken || binding.codexRebuildPermissions
      ? ""
      : suppressAutoAddDirs ? "" : (await this.resolveGitAddDirs(binding.cwd)).map((dir) => ` --add-dir ${shellQuote(dir)}`).join("");
    const cmd = opts.resumeToken
      // 0.5.2-07 A2-3: the pod-aware RESUME path threads the SPEC model too (reverted before — the
      // grounding map assumed codex parity with the claude adapter, but only fresh emitted -m).
      ? this.resumeCore(prepared, opts.resumeToken, binding)
      : `codex${daemonArg}${postureArg}${networkArg} -C ${shellQuote(binding.cwd)}${gitDirArg}${queueStateDirArg}${modelArg}${effortArg}`;

    const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, await this.seatCommand(binding, cmd));
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt);
    if (updatePrompt.failure) return updatePrompt.failure;

    if (opts.resumeToken) {
      const verification = await this.verifyResumeLaunch(binding.tmuxSession, updatePrompt, { resumeToken: opts.resumeToken, ...this.ownHomeOpt(binding) });
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: opts.resumeToken, resumeType: "codex_id", appliedLaunch,
        ...(verification.resumedProcess ? { resumedProcess: verification.resumedProcess } : {}) };
    }

    const threadId = await this.captureFreshThreadId(binding, updatePrompt);
    if (updatePrompt.failure) return updatePrompt.failure;
    if (threadId) {
      return { ok: true, resumeToken: threadId, resumeType: "codex_id", appliedLaunch };
    }

    return { ok: true, appliedLaunch };
  }

  /** The command launchHarness would type to resume `resumeToken`, wrapped in the seat launch environment,
   *  for a caller that runs it itself (a respawned direct-native pane). Nothing is sent to the pane. */
  async buildResumeCommand(
    binding: NodeBinding,
    opts: { name: string; resumeToken: string; running?: RunningCodexLaunch },
  ): Promise<{ ok: true; command: string; core: string; appliedLaunch: AppliedLaunchObservation } | { ok: false; error: string }> {
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound — cannot build a Codex resume command" };
    // Building a resume command (the in-place restart's) never installs the core plugin.
    const prepared = await this.prepareLaunch(binding, opts.name, opts.running, { installCorePlugin: false });
    if (!prepared.ok) return prepared;
    const core = this.resumeCore(prepared, opts.resumeToken, binding);
    return { ok: true, command: await this.seatCommand(binding, core), core, appliedLaunch: prepared.appliedLaunch };
  }

  /** Type a command buildResumeCommand built into the pane's shell, then verify the resume as launchHarness
   *  does. Nothing is prepared again, so the command runs exactly as it was built and checked. */
  async sendResumeCommand(tmuxSession: string, command: string, resumeToken: string, nodeId?: string): Promise<HarnessLaunchResult> {
    const textResult = await this.tmux.sendShellCommand(tmuxSession, command);
    if (!textResult.ok) return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    return this.verifyResumeInPane(tmuxSession, resumeToken, nodeId);
  }

  /** launchHarness's resume verification for a resume the caller started itself: dismiss a skippable update
   *  prompt, then require a proven resumed conversation (never process-alive alone). The proof reads the seat's
   *  own CODEX_HOME when `nodeId` names a seat that declares one, where its resumed Codex logs. */
  async verifyResumeInPane(tmuxSession: string, resumeToken: string, nodeId?: string): Promise<HarnessLaunchResult> {
    const updatePrompt: UpdatePromptAttempt = { handled: false };
    await this.dismissSkippableCodexUpdatePrompt(tmuxSession, updatePrompt);
    if (updatePrompt.failure) return updatePrompt.failure;
    return this.verifyResumeLaunch(tmuxSession, updatePrompt, { resumeToken, ...this.ownHomeOpt({ nodeId }) });
  }

  /** Launch flags shared by fresh, fork and resume, decided once per launch. With `running`, the probed and
   *  prepared parts come from the running Codex instead, and no Codex process is started to decide them. */
  private async prepareLaunch(binding: NodeBinding, name: string, running: RunningCodexLaunch | undefined,
    opts: { installCorePlugin: boolean }): Promise<PreparedCodexLaunch | { ok: false; error: string }> {
    // The config write and, for a seat that selected openrig-core, its install run as one step under the config lock, so
    // concurrent launches never interleave them. An unselected seat's launch never installs.
    // A seat with its own CODEX_HOME gets OpenRig's managed config (hooks, feature flag) and plugin in that home.
    const home = this.homeFor(binding);
    const own = this.ownHome(binding);
    await this.withConfigLock(async () => {
      const managed = await this.applyManagedConfig(home);
      if (opts.installCorePlugin && managed?.hooksEnabled && this.resolveCorePluginSelected?.(binding.nodeId)) {
        try { await this.ensureCodexCorePlugin(home); }
        catch (err) { console.error(`[openrig] runtime setup warning: ${(err as Error).message}`); }
      }
    });
    const model = binding.model?.trim();
    const modelArg = model ? ` -m ${shellQuote(model)}` : "";
    const effort = binding.effort?.trim();
    const effortArg = effort ? ` -c ${shellQuote(`model_reasoning_effort="${effort}"`)}` : "";
    const profile = binding.codexConfigProfile?.trim();
    const profileArg = profile ? ` -p ${shellQuote(profile)}` : "";
    const posture = binding.codexRebuildPermissions
      ? profileArg + codexEnvelopeArgs(binding.codexRebuildPermissions)
      : codexPostureArg(profileArg, process.env, binding.launchPosture);
    const appliedLaunch: AppliedLaunchObservation = binding.codexRebuildPermissions
      ? { runtime: "codex", axis: "sandbox", state: "observed", value: binding.codexRebuildPermissions.sandboxPolicy.type,
          reason: "emitted_launch_arguments", ...(binding.codexRebuildPermissions.approvalPolicy === "never" ? { approvalPolicy: "never" } : {}) }
      : observeCodexSandbox(posture);
    const postureArg = posture + operationalLaunchArg(this.runtime, binding);

    if (running) {
      // The running Codex already loaded its profile; drift in -p is the caller's to compare.
      return { ok: true, model, modelArg, effort, effortArg, profile, appliedLaunch, postureArg,
        queueStateDirArg: running.addDirs.map((dir) => ` --add-dir ${shellQuote(dir)}`).join(""),
        suppressAutoAddDirs: false,
        daemonOptOut: running.daemonOptOut, daemonArg: running.daemonOptOut ? " --no-daemon" : "",
        networkArg: running.networkOverride ? ` -c ${shellQuote(CODEX_NETWORK_DEFAULT_OVERRIDE)}` : "" };
    }

    // OPR.0.3.4.7 — profile-LOAD probe before launch/resume. A legacy
    // [profiles.<name>] table or invalid TOML must fail BEFORE the opaque
    // `codex -p <profile> resume` failure. An absent .config.toml passes
    // (Codex default-layers it; advisor Option B).
    if (profile) {
      const probeResult = await (own ? this.verifyProfilePreflight(profile, binding.cwd, own) : this.verifyProfilePreflight(profile, binding.cwd));
      if (!probeResult.ok) {
        return {
          ok: false,
          error: `${probeResult.error}${probeResult.migrationHint ? `\n  Fix: ${probeResult.migrationHint}` : ""}`,
        };
      }
    }
    // Codex rejects writable --add-dir roots under a read-only sandbox. Only
    // suppress OpenRig's generated roots when later project layers cannot make it writable.
    const suppressAutoAddDirs = Boolean(!binding.codexRebuildPermissions && profile
      && posture === profileArg && this.profileRemainsReadOnly(profile, binding.cwd, home));
    const teamWorkspaceArg = !binding.codexRebuildPermissions && binding.teamPermissionDefault && !profile
      && appliedLaunch.state === "observed" && appliedLaunch.value === "workspace-write"
      ? codexTeamWorkspaceArg(this.prepareTeamWorkspace, name) : "";
    const queueStateDirArg = binding.codexRebuildPermissions || suppressAutoAddDirs
      ? "" : teamWorkspaceArg || this.buildQueueStateAddDirArg(name);
    // #69: one daemon-support decision for this launch, for the Codex the seat pane runs
    // (its cwd, the launch PATH), applied to fresh, fork and resume.
    const daemonSupport = this.detectDaemonSupport ? await (own ? this.detectDaemonSupport(binding.cwd, own) : this.detectDaemonSupport(binding.cwd)) : undefined;
    if (daemonSupport?.kind === "unknown") {
      return { ok: false, error: unknownDaemonSupportMessage(daemonSupport.detail) };
    }
    const daemonOptOut = daemonSupport?.kind === "supported";
    const daemonArg = daemonOptOut ? " --no-daemon" : "";
    // #275: on the plain floor, network access unless Codex reports an opt-out or policy.
    const networkArg = binding.codexRebuildPermissions ? ""
      : await codexNetworkDefaultArg(own && this.readNetworkDefault ? ((cwd: string) => this.readNetworkDefault!(cwd, own)) : this.readNetworkDefault, appliedLaunch, binding.cwd, name);

    // The launch facts keep the probed daemon choice, so a printed recovery command can repeat it; no probe, no fact.
    const launchFacts = daemonSupport ? { ...appliedLaunch, daemonOptOut } : appliedLaunch;
    return { ok: true, model, modelArg, effort, effortArg, profile, appliedLaunch: launchFacts, postureArg, queueStateDirArg, suppressAutoAddDirs, daemonOptOut, daemonArg, networkArg };
  }

  private resumeCore(prepared: PreparedCodexLaunch, resumeToken: string, binding: NodeBinding): string {
    const { profile, queueStateDirArg, model, postureArg, networkArg, daemonOptOut, effort } = prepared;
    return buildCodexResumeCore(resumeToken, profile, false, queueStateDirArg.trim() || undefined, binding.launchPosture, model, `${postureArg}${networkArg}`, daemonOptOut, effort);
  }

  private async seatCommand(binding: NodeBinding, cmd: string): Promise<string> {
    return this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(binding.tmuxSession!, cmd, { codexCwd: binding.cwd, nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: this.runtime, ...this.ownHomeCommandOpt(binding) })
      : this.launchCommand(cmd, this.homeFor(binding));
  }

  private buildQueueStateAddDirArg(sessionName: string): string {
    const sharedDocsRoot = process.env.OPENRIG_SHARED_DOCS_ROOT?.trim()
      || nodePath.join(this.fs.homedir ?? os.homedir(), ".openrig", "shared-docs");
    const root = codexQueueStateRoot(sessionName, sharedDocsRoot);
    return root ? ` --add-dir ${shellQuote(root)}` : "";
  }

  /**
   * Return true only when visible config proves a read-only profile within Codex's default project root.
   * Unknown markers or unreadable layers retain the generated roots for native launch handling.
   */
  private profileRemainsReadOnly(profile: string, cwd: string, home: string | undefined = this.codexHome): boolean {
    const root = home ?? nodePath.join(this.fs.homedir ?? os.homedir(), ".codex");
    const path = nodePath.join(root, `${profile}.config.toml`);
    const userPath = nodePath.join(root, "config.toml");
    if (!this.fs.exists(path)) return false;
    try {
      const value = parseToml(this.fs.readFile(path));
      if (value.sandbox_mode !== "read-only" || value.default_permissions !== undefined || !nodePath.isAbsolute(cwd)) return false;
      // A custom marker set may change the project boundary; leave the prior
      // generated roots in place unless this default-marker scan proves it.
      if (value.project_root_markers !== undefined) return false;
      // Codex merges fixed system/user/legacy-managed layers before choosing
      // project markers. Any visible override or unreadable layer keeps roots.
      for (const fixedPath of [
        nodePath.join(this.codexSystemConfigDir, "config.toml"),
        userPath,
        nodePath.join(this.codexSystemConfigDir, "managed_config.toml"),
      ]) {
        if (!this.fs.exists(fixedPath)) continue;
        const fixed = parseToml(this.fs.readFile(fixedPath));
        if (fixed.default_permissions !== undefined || fixed.project_root_markers !== undefined) return false;
      }
      // Codex's default root is the nearest .git file or a .git directory
      // containing HEAD. When none exists, Codex uses cwd itself.
      let projectRoot = nodePath.normalize(cwd);
      for (let dir = projectRoot;;) {
        const marker = nodePath.join(dir, ".git");
        if (this.fs.exists(marker)) {
          if (!this.fs.statMode) return false;
          const kind = this.fs.statMode(marker) & fs.constants.S_IFMT;
          // statMode may expose permission bits alone; that cannot prove a file.
          if (kind !== fs.constants.S_IFREG && kind !== fs.constants.S_IFDIR) return false;
          if (kind === fs.constants.S_IFREG || this.fs.exists(nodePath.join(marker, "HEAD"))) { projectRoot = dir; break; }
        }
        const parent = nodePath.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      // Trust can exclude a closer project file, leaving a writable ancestor active.
      // Keep roots if any visible applicable ancestor could make the launch writable.
      for (let dir = nodePath.normalize(cwd);;) {
        const projectPath = nodePath.join(dir, ".codex", "config.toml");
        // At the home ancestor this is the user config, which loaded before the profile.
        if (projectPath !== userPath && this.fs.exists(projectPath)) {
          const project = parseToml(this.fs.readFile(projectPath));
          if (project.default_permissions !== undefined) return false;
          if (project.sandbox_mode !== undefined && project.sandbox_mode !== "read-only") return false;
        }
        if (dir === projectRoot) return true;
        dir = nodePath.dirname(dir);
      }
    } catch {
      // Preflight owns profile errors; unreadable user or project state keeps prior roots.
      return false;
    }
  }

  private async captureProbeScreen(target: string): Promise<string> {
    // Current readiness belongs to the rendered screen. Scrollback may retain
    // dismissed prompts, loading headers, or refusals from earlier attempts.
    if (this.tmux.capturePaneScreen) return await this.tmux.capturePaneScreen(target) ?? "";
    return await this.tmux.capturePaneContent(target, 40) ?? "";
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
    const paneContent = await this.captureProbeScreen(binding.tmuxSession);
    let probe = assessNativeResumeProbe({
      runtime: "codex",
      paneCommand,
      paneContent,
    });

    if (probe.code === "returned_to_shell" || probe.code === "awaiting_runtime") {
      const process = await verifyCodexPaneProcess({ target: binding.tmuxSession, tmux: this.tmux as { getPanePid(target: string): Promise<number | null> },
        listProcesses: this.listProcesses as never });
      if (process) {
        const currentPaneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
        const currentPaneContent = await this.captureProbeScreen(binding.tmuxSession);
        probe = assessNativeResumeProbe({ runtime: "codex", paneCommand: currentPaneCommand,
          paneContent: currentPaneContent, codexProcessVerified: true });
      }
    }

    if (probe.code === "returned_to_shell") {
      const isIdleShell = await verifyPaneIdleShell({
        target: binding.tmuxSession,
        tmux: this.tmux,
        listProcesses: this.listProcesses,
      });
      if (!isIdleShell) {
        return {
          ready: false,
          reason: "The pane shows a shell that is not a proven idle shell; a launch script may still be starting Codex.",
          code: "awaiting_runtime",
        };
      }
    }

    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  async captureForkIdentity(binding: NodeBinding, parentToken: string): Promise<{ resumeToken: string; resumeType: string } | null> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return null;
    const input = { target, tmux: this.tmux, listProcesses: this.listProcesses, parentToken };
    const before = await observeCodexForkProcess(input);
    if (!before || lstartToMinTs(before.process.startedAt) === undefined) return null;
    // Gate PID logs by process start time, then re-observe the whole foreground
    // chain. Neither a reused PID nor a replacement pane proves this child.
    const child = (await this.readThreadIdForSeat(binding, before.process.pid, before.process.startedAt))?.trim();
    if (!child || child === parentToken) return null;
    const after = await observeCodexForkProcess(input);
    return after?.fingerprint === before.fingerprint ? { resumeToken: child, resumeType: "codex_id" } : null;
  }

  private async dismissSkippableCodexUpdatePrompt(
    tmuxSession: string, updatePrompt: UpdatePromptAttempt, attempts = 6,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = await this.tmux.getPaneCommand(tmuxSession);
      const paneContent = await this.captureProbeScreen(tmuxSession);
      const probe = assessNativeResumeProbe({ runtime: "codex", paneCommand, paneContent });
      updatePrompt.observed = { probe, paneContent };

      if (probe.code === "update_gate") {
        if (updatePrompt.handled || !isSkippableCodexUpdatePrompt(paneContent)) return false;
        const identity = await this.observeMenuProcess(tmuxSession, paneCommand);
        if (!identity) return false;
        // The npm launcher may be foreground Node with a native Codex child.
        // Recheck identity and CURRENT screen after sampling, never scrollback.
        const currentCommand = await this.tmux.getPaneCommand(tmuxSession);
        if (await this.observeMenuProcess(tmuxSession, currentCommand) !== identity) {
          updatePrompt.handled = true;
          return false;
        }
        const currentScreen = await this.tmux.capturePaneScreen?.(tmuxSession);
        const currentProbe = currentScreen ? assessNativeResumeProbe({ runtime: "codex", paneCommand: currentCommand, paneContent: currentScreen }) : null;
        if (currentScreen && currentProbe) updatePrompt.observed = { probe: currentProbe, paneContent: currentScreen };
        if (!currentScreen || !isSkippableCodexUpdatePrompt(currentScreen) || currentProbe?.code !== "update_gate") {
          updatePrompt.handled = true;
          return false;
        }

        // Codex 0.155.1 ignores Paste; Key3 selects AND submits DontRemind
        // (including its version-cache write). An Enter would hit the next
        // screen. Consume the attempt before sending, even if delivery fails.
        updatePrompt.handled = true;
        const result = await this.tmux.sendKeys(tmuxSession, ["3"]);
        updatePrompt.skipKey = result.ok ? "sent" : "failed";
        // The screen just recorded preceded this input; a later capture on this launch replaces it.
        if (updatePrompt.observed) updatePrompt.observed.beforeInput = true;
        if (!result.ok) {
          updatePrompt.failure = {
            gate: "update_gate", gateChoice: true, verifierInput: "update_skip_key_failed", screenBeforeInput: true,
            ok: false, recovery: "attention_required",
            error: `Could not send the update prompt's skip key (3): ${result.message}; its effect is unknown. Inspect the session before retrying.`,
            evidence: (currentScreen ?? paneContent).split("\n").slice(-12).join("\n"),
          };
          return false;
        }
        await this.sleep(500);
        continue; // Observe transition; never send a second choice on this launch.
      }

      // Readiness or another native decision closes update automation. A later
      // stale capture must not reopen it. Trust/auth decisions remain in-pane.
      if (probe.status === "resumed" || probe.status === "attention_required"
        || probe.code === "trust_gate" || probe.code === "hook_trust_gate") {
        updatePrompt.handled = true;
        return probe.status === "resumed";
      }
      if (attempt < attempts - 1) await this.sleep(200);
    }
    return false;
  }

  private async observeMenuProcess(target: string, paneCommand: string | null): Promise<string | null> {
    // tmux may name the shell wrapper; native ancestry and foreground group decide identity.
    if (!paneCommand) return null;
    const observation = await observeCodexPaneProcess({ target, tmux: this.tmux, listProcesses: this.listProcesses });
    return observation ? JSON.stringify([paneCommand, observation.fingerprint]) : null;
  }

  ensureManagedBootstrap(binding: { cwd?: string | null; nodeId?: string }): void {
    this.provisionWorkspaceTrust(binding.cwd ?? null, this.homeFor(binding));
  }

  private projectEntry(entry: ProjectionEntry, cwd: string, warnings: string[], seatSkillsRoot?: string, seatSkillsRefused?: string,
    home?: string): boolean {
    if (entry.category === "runtime_resource" && this.applyRuntimeResource(entry, home)) {
      return true;
    }

    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content, warnings, entry.absolutePath);
    }

    // HG-1.3 plugin runtime applicability filter (per DESIGN.md §5.1):
    // - explicit pluginType="claude" → skip Codex projection
    // - pluginType="auto" (or unset) + no .codex-plugin/ manifest dir → skip
    // - explicit pluginType="codex" → project regardless of manifest presence
    if (entry.category === "plugin" && !this.pluginAppliesToCodex(entry)) {
      return false;
    }

    const targetDir = this.resolveTargetDir(entry, cwd, seatSkillsRoot);
    if (!targetDir) return true;
    // OPR.0.7.0.13: never write through a link out of the seat's storage.
    // A refused seat storage refuses every skill meant for it, named; otherwise each destination is checked.
    const refusal = seatSkillsRoot && entry.category === "skill"
      ? seatSkillsRefused ?? seatSkillWriteRefusal(seatSkillsRoot, nodePath.join(targetDir, "SKILL.md")) : undefined;
    if (refusal) { warnings.push(`${entry.effectiveId}: ${refusal}`); return false; }
    // OPR.0.7.0.13: destinations refused below (a link on the way); an entry with any is reported incomplete, not projected.
    const notProjected: string[] = [];
    // OPR.0.7.0.13: a skill written to the seat's own storage is recorded, so cleanup and restore know it as OpenRig's.
    const record = seatSkillsRoot && entry.category === "skill"
      ? (dest: string, src: string, content: string) => recordSeatSkillWrite(seatSkillsRoot, dest, src, content)
      : () => {};

    this.fs.mkdirp(targetDir);
    let isDir = false;
    if (this.fs.listFiles) {
      try {
        isDir = this.fs.listFiles(entry.absolutePath).length > 0;
      } catch {
        // File-shaped sources make the production listFiles (recursive
        // fs.readdirSync walk) throw ENOTDIR — treat the entry as file-shaped.
        isDir = false;
      }
    }

    const createdFiles: string[] = [];
    try {
      if (isDir && this.fs.listFiles) {
        let skippedPluginSkills = 0;
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          // OPR.0.7.0.13: a seat with its own storage gets a selected plugin's bundled skills there, through its loadout, so
          // the project's copy of the plugin leaves its skills out; its manifest, hooks and settings are copied as before.
          if (seatSkillsRoot && entry.category === "plugin" && file.split(/[\\/]/)[0] === "skills") { skippedPluginSkills++; continue; }
          const src = nodePath.join(entry.absolutePath, file);
          const dest = nodePath.join(targetDir, file);
          // OPR.0.7.0.13: each destination in a seat's storage is checked before it's recorded, written or re-moded, so a
          // helper folder or file found to be a link is not written through (the identical-content, mode-only branch included).
          const refusedDest = seatSkillsRoot && entry.category === "skill" ? seatSkillWriteRefusal(seatSkillsRoot, dest) : undefined;
          if (refusedDest) { warnings.push(`${entry.effectiveId}: ${refusedDest}`); notProjected.push(dest); continue; }
          const content = this.fs.readFile(src);
          record(dest, src, content);
          // Reconcile mode even when the content write is skipped: a byte-identical dest
          // projected earlier may still carry the wrong (default) mode.
          if (this.fs.exists(dest) && hashContent(content) === hashContent(this.fs.readFile(dest))) {
            this.preserveMode(src, dest);
            continue;
          }
          const existed = this.fs.exists(dest);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, content);
          if (!existed) createdFiles.push(dest);
          this.preserveMode(src, dest);
        }
        const pluginLoss = seatSkillsRefused ? seatPluginSkillsLossNote(entry.effectiveId, skippedPluginSkills, seatSkillsRefused) : undefined;
        if (pluginLoss) warnings.push(pluginLoss);
      } else {
        const destFile = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
        const refusedFile = seatSkillsRoot && entry.category === "skill" ? seatSkillWriteRefusal(seatSkillsRoot, destFile) : undefined;
        if (refusedFile) { warnings.push(`${entry.effectiveId}: ${refusedFile}`); return false; }
        const content = this.fs.readFile(entry.absolutePath);
        record(destFile, entry.absolutePath, content);
        if (this.fs.exists(destFile) && hashContent(content) === hashContent(this.fs.readFile(destFile))) {
          this.preserveMode(entry.absolutePath, destFile);
          return true;
        }
        const existed = this.fs.exists(destFile);
        this.fs.writeFile(destFile, content);
        if (!existed) createdFiles.push(destFile);
        this.preserveMode(entry.absolutePath, destFile);
      }
    } finally {
      if (entry.category === "plugin") warnings.push(...excludeNewGeneratedFiles(cwd, createdFiles));
    }
    return seatProjectionComplete(entry.effectiveId, notProjected, warnings);
  }

  /**
   * Reapply the source file's permission bits to the projected dest. Plain
   * readFile+writeFile (writeFileSync) creates the dest with the process default
   * mode, dropping executable bits on nested plugin helpers (e.g. the
   * claude-compaction-restore/scripts/*.mjs 0755 hooks). No-op when the fs adapter
   * does not expose mode primitives (keeps existing mock-fs callers unaffected).
   */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  private pluginAppliesToCodex(entry: ProjectionEntry): boolean {
    const explicit = entry.pluginType ?? "auto";
    if (explicit === "codex") return true;
    if (explicit === "claude") return false;
    // auto: detect via .codex-plugin/plugin.json presence in the source tree
    return this.fs.exists(nodePath.join(entry.absolutePath, ".codex-plugin", "plugin.json"));
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string, seatSkillsRoot?: string): string | null {
    switch (entry.category) {
      case "skill": return nodePath.join(seatSkillsRoot ?? nodePath.join(cwd, ".agents", "skills"), entry.effectiveId);
      case "guidance": return null; // handled via merge
      case "subagent": return nodePath.join(cwd, ".agents"); // .agents/{id}.yaml per preserved contract
      case "plugin": return nodePath.join(cwd, ".codex", "plugins", entry.effectiveId);
      case "runtime_resource": return nodePath.join(cwd, ".agents", "extensions", entry.effectiveId);
      default: return null;
    }
  }

  private applyRuntimeResource(entry: ProjectionEntry, home?: string): boolean {
    if (entry.resourceType !== "codex_config_fragment") {
      return false;
    }

    const configPath = this.resolveCodexConfigPath(home);
    this.fs.mkdirp(nodePath.dirname(configPath));

    const existing = this.fs.exists(configPath) ? this.fs.readFile(configPath) : "";
    const fragment = this.fs.readFile(entry.absolutePath);
    // Before anything is dropped: a fragment that is invalid on its own must
    // fail loudly, never be "resolved" by the collision filter deleting it.
    assertFragmentParsesStandalone(fragment, entry.absolutePath, entry.effectiveId);
    // Ordered after the parse: an unparseable fragment gets the TOML error that
    // names its line and column, not a root-scope complaint about wreckage.
    assertFragmentOpensWithTable(fragment, entry.absolutePath, entry.effectiveId);
    const rendered = upsertManagedCodexConfigFragment(existing, entry.effectiveId, fragment);
    assertRendersAsLoadableToml(rendered, configPath, entry.effectiveId);
    this.fs.writeFile(configPath, rendered);
    return true;
  }

  /**
   * Merge a managed block into the target guidance file. Returns `true` when
   * the merge happened, `false` when intentionally skipped (rig-role). Callers
   * propagate the skip signal so ProjectionResult and StartupDeliveryResult
   * report honest counts.
   */
  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[], sourcePath?: string): boolean {
    // Mirrors Claude Code adapter: the `rig-role` managed block collides across
    // pod-mates because the regenerator pairs (target-file × spec) without
    // seat correlation. Per-seat role content is delivered through `send_text`
    // startup instead. Refuse the merge loudly; silent skip would mask the
    // collision. See ADR-0006.
    if (isPerSeatRoleGuidance(blockId, sourcePath)) {
      console.log(
        `[openrig] skip: effectiveId is ${blockId}, a seat's own role; per-seat delivery via send_text path required (target=${targetPath})`
      );
      const warning = perSeatRoleSkipWarning(blockId, targetPath);
      if (warning) warnings.push(warning);
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }

  private detectDeliveryHint(path: string, content: string, orientation?: string): "guidance_merge" | "skill_install" | "send_text" {
    return resolveConcreteHint(path, content, orientation);
  }

  private provisionWorkspaceTrust(cwd: string | null, home?: string): void {
    if (!cwd) return;
    const configPath = this.resolveCodexConfigPath(home);
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

  private resolveCodexConfigPath(home: string | undefined = this.codexHome): string {
    const root = home
      ?? nodePath.join(this.fs.homedir ?? os.homedir(), ".codex");
    return nodePath.join(root, "config.toml");
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

  private async captureFreshThreadId(binding: NodeBinding, updatePrompt: UpdatePromptAttempt): Promise<string | undefined> {
    const target = binding.tmuxPane ?? binding.tmuxSession;
    if (!target || !this.tmux.getPanePid) return undefined;

    for (let attempt = 0; attempt < 20; attempt++) {
      const shellPid = await this.tmux.getPanePid(target);
      if (shellPid) {
        const codexPids = await this.findCodexDescendantPids(shellPid);
        for (const codexPid of codexPids) {
          const threadId = await this.readThreadIdForSeat(binding, codexPid);
          if (threadId) return threadId;
        }
      }
      if (binding.tmuxSession) {
        await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt, 1);
        if (updatePrompt.failure) return undefined;
      }
      await this.sleep(250);
    }

    return undefined;
  }

  /** `work`'s result, or null once `deadline` (epoch ms) passes first. The late result is ignored. */
  private async withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** A fork's own id at launch, from a verified child only (see {@link captureForkIdentity}). Polls for up
   *  to `timeoutMs`, because a fork's record can appear well after the process starts. */
  private async captureVerifiedForkId(binding: NodeBinding, updatePrompt: UpdatePromptAttempt, parentId: string,
    timeoutMs: number): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    const attempts = Math.max(1, Math.ceil(timeoutMs / 250));
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0 && Date.now() >= deadline) break;
      // Each attempt may wait on a home probe; bound it by the time left, so a stuck probe ends in attention on time.
      const identity = await this.withinDeadline(this.captureForkIdentity(binding, parentId), deadline);
      if (identity) return identity.resumeToken;
      if (binding.tmuxSession) {
        await this.dismissSkippableCodexUpdatePrompt(binding.tmuxSession, updatePrompt, 1);
        if (updatePrompt.failure) return undefined;
      }
      const remaining = Math.min(250, deadline - Date.now());
      if (remaining <= 0) break;
      await this.sleep(remaining);
    }
    return undefined;
  }

  /**
   * #1524 (b): whether the pane's resumed Codex process is proven to hold `resumeToken`. Codex's own records for that
   * exact process (pid and start time) must name the token, read before `deadline`, with the same process observed
   * before and after the read, so a reused pid or a replaced pane proves nothing. A different conversation is a
   * mismatch; anything unread is unknown, never a mismatch or a match.
   */
  /** #1524 (b): `work` under the resume check's deadline. It isn't started at or after the deadline, it races the
   *  deadline, and a value that arrives at or after it is not used (null). It cancels nothing: work already started
   *  runs to its end (an async step may go on to its next read, and synchronous work such as the default record
   *  reader's SQLite queries can't be interrupted at all), so the check can return after the deadline. */
  private async beforeResumeDeadline<T>(work: () => Promise<T> | T, deadline: number): Promise<T | null> {
    if (Date.now() >= deadline) return null;
    const value = await this.withinDeadline(Promise.resolve().then(work), deadline);
    return Date.now() >= deadline ? null : value;
  }

  private async proveResumedProcess(tmuxSession: string, resumeToken: string, deadline: number, home?: string):
    Promise<{ kind: "match"; process: { pid: number; startedAt: string } } | { kind: "mismatch"; threadId: string } | { kind: "unknown"; reason: string; windowEnded?: true }> {
    if (!this.tmux.getPanePid) return { kind: "unknown", reason: "the pane's process can't be read" };
    if (Date.now() >= deadline) return { kind: "unknown", reason: "the resume window ended", windowEnded: true };
    const input = { target: tmuxSession, tmux: this.tmux as { getPanePid(target: string): Promise<number | null> },
      listProcesses: this.listProcesses as never, expectedToken: resumeToken, requireResume: true };
    const before = await this.beforeResumeDeadline(() => observeCodexPaneProcess(input), deadline);
    if (!before && Date.now() >= deadline) return { kind: "unknown", reason: "the resume window ended", windowEnded: true };
    if (!before) return { kind: "unknown", reason: "no single Codex process resuming this conversation was observed in the pane" };
    if (lstartToMinTs(before.process.startedAt) === undefined) {
      return { kind: "unknown", reason: "the resumed Codex process has no readable start time" };
    }
    let evidence: CodexResumeEvidence | null;
    try {
      evidence = await this.beforeResumeDeadline(() => home ? this.readResumeEvidence(before.process.pid, before.process.startedAt!, home) : this.readResumeEvidence(before.process.pid, before.process.startedAt!), deadline);
    } catch (err) {
      return { kind: "unknown", reason: `Codex's records couldn't be read (${(err as Error).message})` };
    }
    if (!evidence) return { kind: "unknown", reason: "reading Codex's records didn't finish inside the resume window", windowEnded: true };
    const after = await this.beforeResumeDeadline(() => observeCodexPaneProcess(input), deadline);
    if (!after && Date.now() >= deadline) return { kind: "unknown", reason: "the resume window ended", windowEnded: true };
    if (after?.fingerprint !== before.fingerprint) {
      return { kind: "unknown", reason: "the resumed Codex process changed during the check" };
    }
    if (!evidence.threadId) return { kind: "unknown", reason: evidence.reason ?? "no_log_row" };
    // A decision is only as current as its last observation: at or past the deadline it decides nothing.
    if (Date.now() >= deadline) return { kind: "unknown", reason: "the resume window ended", windowEnded: true };
    return evidence.threadId === resumeToken
      ? { kind: "match", process: { pid: before.process.pid, startedAt: before.process.startedAt! } }
      : { kind: "mismatch", threadId: evidence.threadId };
  }

  private async verifyResumeLaunch(tmuxSession: string, updatePrompt: UpdatePromptAttempt, opts?: { resumeToken?: string; home?: string }): Promise<HarnessLaunchResult> {
    const quickAttempts = RESUME_QUICK_ATTEMPTS;
    const extendedAttempts = RESUME_EXTENDED_ATTEMPTS;
    const quickSleepMs = RESUME_QUICK_SLEEP_MS;
    const extendedSleepMs = RESUME_EXTENDED_SLEEP_MS;
    // #1524 (b): a managed resume of a known conversation is proven from Codex's own records, inside one wall-clock
    // deadline for the whole existing window. Why it is still unproven, for the attention text at the bound.
    // With a conversation to prove, the deadline prevents acceptance of late wrapped poll or proof values, or of a late
    // match or mismatch. Ordinary poll sleeps request at most the remaining time. Work already started is not cancelled,
    // and scheduling or synchronous work can delay return. The existing update-prompt helper has its own reads,
    // reporting and guarded one-key behaviour outside this deadline.
    const resumeToken = opts?.resumeToken;
    const deadline = Date.now() + this.resumeProofWindowMs;
    let unproven: string | null = null;
    // Ordinary poll sleeps request at most the remaining time; scheduling can delay their completion. False once no time
    // is left.
    const pause = async (ms: number): Promise<boolean> => {
      if (!resumeToken) { await this.sleep(ms); return true; }
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await this.sleep(Math.min(ms, left));
      return Date.now() < deadline;
    };

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
    // Reporting only: the newest screen observed, in capture order (the loop's own capture, then the update helper's
    // later ones in the same iteration), so the result names what was seen last. A resumed or booting screen replaces an
    // older gate. The loop's decisions keep using lastUnresolved.
    let report: { probe: NativeResumeProbeResult; paneContent: string; beforeInput?: true } | null = null;
    // Reporting only: what this verification typed into the pane (only the update helper ever types here).
    const verifierInput = (): "none" | "update_skip_key_sent" | "update_skip_key_failed" =>
      updatePrompt.skipKey === "sent" ? "update_skip_key_sent" : updatePrompt.skipKey === "failed" ? "update_skip_key_failed" : "none";
    const gateFields = (p: NativeResumeProbeResult, pane: string) => ({
      ...(p.code ? { gate: p.code } : {}),
      ...(p.code === "update_gate" ? { gateChoice: isSkippableCodexUpdatePrompt(pane) } : {}),
    });
    let sawRealGate = false;

    const totalAttempts = quickAttempts + extendedAttempts;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      // After the quick phase, only continue if we're in the boot-in-progress
      // case (awaiting_runtime, no real gate). Real gates won't self-resolve.
      if (attempt >= quickAttempts && (sawRealGate || lastUnresolved?.code !== "awaiting_runtime")) {
        break;
      }

      // #1524 (b): with a conversation to prove, no capture starts at or after the deadline, and one that ends after it
      // isn't used (a capture already started isn't cancelled: its second read may still run, its value discarded).
      let paneCommand: Awaited<ReturnType<TmuxAdapter["getPaneCommand"]>>;
      let paneContent: string;
      if (resumeToken) {
        const captured = await this.beforeResumeDeadline(async () =>
          ({ command: await this.tmux.getPaneCommand(tmuxSession), content: await this.captureProbeScreen(tmuxSession) }), deadline);
        if (!captured) break;
        paneCommand = captured.command;
        paneContent = captured.content;
      } else {
        paneCommand = await this.tmux.getPaneCommand(tmuxSession);
        paneContent = await this.captureProbeScreen(tmuxSession);
      }
      lastPaneContent = paneContent;
      let probe = assessNativeResumeProbe({
        runtime: "codex",
        paneCommand,
        paneContent,
      });

      if (probe.code === "returned_to_shell" || probe.code === "awaiting_runtime") {
        const process = resumeToken
          ? await this.beforeResumeDeadline(() => verifyCodexPaneProcess({ target: tmuxSession, tmux: this.tmux as { getPanePid(target: string): Promise<number | null> },
            listProcesses: this.listProcesses as never }), deadline)
          : await verifyCodexPaneProcess({ target: tmuxSession, tmux: this.tmux as { getPanePid(target: string): Promise<number | null> },
            listProcesses: this.listProcesses as never });
        if (process) {
          const current = resumeToken
            ? await this.beforeResumeDeadline(async () => ({
              command: await this.tmux.getPaneCommand(tmuxSession),
              content: await this.captureProbeScreen(tmuxSession),
            }), deadline)
            : { command: await this.tmux.getPaneCommand(tmuxSession), content: await this.captureProbeScreen(tmuxSession) };
          if (!current) break;
          paneCommand = current.command;
          paneContent = current.content;
          lastPaneContent = paneContent;
          probe = assessNativeResumeProbe({ runtime: "codex", paneCommand, paneContent, codexProcessVerified: true });
        }
      }

      if (probe.code === "no_saved_session") {
        return {
          ok: false,
          error: "Codex resume failed: no saved session found for the requested session",
          recovery: "retry_fresh",
          missingConversation: true,
        };
      }

      if (probe.code === "returned_to_shell") {
        // sendShellCommand starts asynchronously, and a shell can remain the
        // pane's wrapper while Codex loads. Use the existing bounded boot wait;
        // this label proves neither launch failure nor readiness. A usable
        // screen is still required here, followed by joined native identity
        // proof in restore before the seat is reported resumed.
        probe = {
          status: "inconclusive", code: "awaiting_runtime",
          detail: "Codex resume has not yet reached an interactive conversation in the launch pane.",
        };
      }

      if (probe.status === "attention_required") {
        return {
          ok: false,
          error: probe.detail,
          recovery: "attention_required",
          ...gateFields(probe, paneContent),
          verifierInput: verifierInput(),
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }

      if (probe.status === "resumed" && !resumeToken) {
        return { ok: true, resumeToken: undefined, resumeType: undefined };
      }
      if (probe.status === "resumed" && resumeToken) {
        const proof = await this.proveResumedProcess(tmuxSession, resumeToken, deadline, opts?.home);
        if (proof.kind === "match") return { ok: true, resumeToken, resumeType: "codex_id", resumedProcess: proof.process };
        if (proof.kind === "mismatch") {
          return {
            ok: false,
            error: `Codex resume opened a different conversation: the resumed process's records name ${proof.threadId}, not the requested ${resumeToken}. The session was preserved; nothing was restarted.`,
            recovery: "attention_required",
            resumeMismatch: { opened: proof.threadId },
            verifierInput: verifierInput(),
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          };
        }
        // Unknown is not a failure yet: keep polling inside the window, as a boot still in progress does. The
        // window ending says nothing new, so it doesn't replace the last reason a read gave.
        if (!("windowEnded" in proof) || !unproven) unproven = proof.reason;
        lastUnresolved = { status: "inconclusive", code: "awaiting_runtime", detail: `Codex resume not yet proven: ${proof.reason}.` };
        report = { probe, paneContent };
        if (Date.now() >= deadline) break;
        const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
        if (attempt < totalAttempts - 1 && !(await pause(sleepMs))) break;
        continue;
      }

      report = { probe, paneContent }; // resumed returned above, so this screen is unresolved
      if (probe.code === "update_gate") {
        updatePrompt.observed = undefined;
        const dismissed = await this.dismissSkippableCodexUpdatePrompt(tmuxSession, updatePrompt, 1);
        // The helper's own captures came after this one: report its newest, whatever it showed.
        const helperSaw = helperObservation(updatePrompt);
        if (helperSaw) report = helperSaw;
        if (updatePrompt.failure) return updatePrompt.failure;
        if (dismissed) {
          lastUnresolved = null;
          sawRealGate = false;
          const sleepMs = attempt < quickAttempts ? quickSleepMs : extendedSleepMs;
          if (attempt < totalAttempts - 1 && !(await pause(sleepMs))) break;
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
      if (attempt < totalAttempts - 1 && !(await pause(sleepMs))) break;
    }

    // Report the newest screen observed; a resumed or booting one names no gate. The loop's own decisions above used
    // lastUnresolved. The text follows the newest screen too, so an older gate's text never stands for a newer screen.
    const shown = report && report.probe.status !== "resumed" && report.probe.code !== "awaiting_runtime" ? report : null;
    const unprovenText = unproven && report?.probe.status === "resumed"
      ? `Codex resume could not be proven within the resume window: ${unproven}. The session was preserved; nothing was restarted.`
      : null;
    const newestText = unprovenText ? unprovenText : shown ? shown.probe.detail
      : report?.probe.status === "resumed" ? "Codex resume could not be confirmed: the last screen observed looked ready, but the resume check ended before proving a restored conversation."
        : report ? report.probe.detail
          : lastUnresolved?.detail;
    return {
      ok: false,
      error: newestText
        ?? "Codex resume could not be confirmed: the process is alive but a restored conversation was never proven.",
      recovery: "attention_required",
      // The gate on that screen, if any. A boot still in progress names no gate.
      ...(shown ? gateFields(shown.probe, shown.paneContent) : {}),
      ...(shown?.beforeInput ? { screenBeforeInput: true as const } : {}),
      // With a conversation to prove and no gate on the newest screen, the end is "not proven": whatever the last frame
      // was (a boot, a ready screen, or no capture at all before the deadline), the resumed Codex may be running.
      ...(resumeToken && !shown ? { resumeUnproven: true as const } : {}),
      verifierInput: verifierInput(),
      evidence: (report?.paneContent ?? lastPaneContent).split("\n").slice(-12).join("\n"),
    };
  }

  private async findCodexDescendantPids(parentPid: number): Promise<number[]> {
    const processes = await this.listProcesses();
    return findCodexDescendantPids(processes, parentPid);
  }

  private async readThreadIdFromLogs(pid: number, home: string | undefined = this.codexHome): Promise<string | undefined> {
    return readCodexThreadIdFromCandidateHomes(
      pid,
      home ? [] : [await this.resolveHomeDirByPid(pid), this.fs.homedir, os.homedir()],
      (path) => this.fs.exists(path),
      home,
    );
  }

  private launchCommand(command: string, home: string | undefined = this.codexHome): string {
    const env = [this.launchPath ? `PATH=${shellQuote(this.launchPath)}` : "", home ? `CODEX_HOME=${shellQuote(home)}` : ""].filter(Boolean);
    return env.length ? `env ${env.join(" ")} ${command}` : command;
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
// review remains visible for the operator — never a blanket trust keystroke.
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
  // NormalizedHookIdentity exactly as `TomlValue::try_from` would build it (None fields dropped), hashed by the shared
  // recipe in codex-hook-trust.cjs.
  return { key, hash: codexHookTrust.codexHookHash(label, input) };
}

/**
 * OPR.0.4.3.33 — idempotent, non-clobbering, section-scoped writer for a single
 * `[hooks.state."<key>"] trusted_hash = "<hash>"` record. Mirrors upsertCodexProjectTrust:
 * find/create the exact table header, splice ONLY its `trusted_hash` line, leave every other
 * `[hooks.state]` / `[projects]` entry and the managed hook block byte-identical. Same key+hash
 * ⇒ no-op. Only called for our authored inline or verified owned plugin keys (never blanket trust).
 */
export function upsertCodexHookTrust(content: string, key: string, hash: string, field: "trusted_hash" | "trusted_content_hash" = "trusted_hash"): string {
  const header = `[hooks.state.${JSON.stringify(key)}]`;
  const trustLine = `${field} = ${JSON.stringify(hash)}`;
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
    (line, index) => index > headerIndex && index < nextSectionIndex && line.trim().startsWith(field),
  );
  if (hashIndex >= 0) {
    lines[hashIndex] = trustLine;
  } else {
    lines.splice(headerIndex + 1, 0, trustLine);
  }

  return field === "trusted_content_hash" ? lines.join("\n") : `${lines.join("\n").replace(/\n*$/, "\n")}`;
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
    return next.replace(pattern, () => block); // literal: a string would expand `$` patterns in the path
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
  return content.replace(pattern, "\n");
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

/**
 * For each line, whether it BEGINS at document level — outside every string AND
 * outside every array or inline table. At document level, TOML grammar allows
 * nothing but a table header to start with `[`, so that one bit is the whole
 * header test; anywhere else a `[` is value syntax.
 *
 * Both halves were learned the hard way, each from a silent wrong answer:
 *  - strings: `\"""` inside a multiline basic string read as the string's end,
 *    promoting the next line to a header (review50-r2, 2026-09-01).
 *  - nesting: a continuation row of a multi-line array (`  [1, 2],`) read as a
 *    header, so a valid fragment was split apart and refused (review50-r2,
 *    2026-09-01). Depth is what separates the two, not the line's own text.
 */
function lineStartsAtDocumentLevel(content: string): boolean[] {
  const out: boolean[] = [true];
  let multiline: '"""' | "'''" | null = null;
  let depth = 0;
  let i = 0;
  while (i < content.length) {
    const ch = content[i]!;
    if (multiline) {
      // A multiline BASIC string honours backslash escapes, so `\"""` is an
      // escaped quote followed by two more — NOT the closing delimiter. A
      // multiline LITERAL string ('''), by contrast, has no escapes at all.
      // Missing this read `\"""` as the string's end and promoted the next
      // line to a table header (review50-r2, 2026-09-01).
      if (multiline === '"""' && ch === "\\") {
        // Count an escaped newline so the line index stays aligned.
        if (content[i + 1] === "\n") out.push(false);
        i += 2;
        continue;
      }
      if (content.startsWith(multiline, i)) { multiline = null; i += 3; continue; }
      if (ch === "\n") out.push(false);
      i += 1;
      continue;
    }
    if (content.startsWith('"""', i)) { multiline = '"""'; i += 3; continue; }
    if (content.startsWith("'''", i)) { multiline = "'''"; i += 3; continue; }
    if (ch === "#") { while (i < content.length && content[i] !== "\n") i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      // Single-line strings cannot span a newline; stopping at one keeps the
      // line index honest on malformed input instead of swallowing the rest.
      while (i < content.length && content[i] !== quote && content[i] !== "\n") {
        if (quote === '"' && content[i] === "\\") i += 1;
        i += 1;
      }
      if (content[i] === quote) i += 1;
      continue;
    }
    // A header's own brackets open and close on its line, so depth is back to 0
    // by the newline; a multi-line array leaves it raised for its whole body.
    if (ch === "[" || ch === "{") { depth += 1; i += 1; continue; }
    if (ch === "]" || ch === "}") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (ch === "\n") { out.push(depth === 0); i += 1; continue; }
    i += 1;
  }
  return out;
}

/** A fragment split at its table headers: a leading preamble, then one entry per table. */
function splitAtTableHeaders(fragment: string): Array<{ header: string | null; text: string }> {
  const structural = lineStartsAtDocumentLevel(fragment);
  const blocks: Array<{ header: string | null; lines: string[] }> = [{ header: null, lines: [] }];
  fragment.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    if (structural[index] === true && trimmed.startsWith("[")) {
      blocks.push({ header: trimmed, lines: [line] });
      return;
    }
    blocks[blocks.length - 1]!.lines.push(line);
  });
  return blocks.map((b) => ({ header: b.header, text: b.lines.join("\n") }));
}

function parsesAsToml(candidate: string): boolean {
  try { parseToml(candidate); return true; } catch { return false; }
}

/**
 * Refuse a fragment that declares keys before its first table header.
 *
 * TOML HAS NO ROOT-REOPEN SYNTAX. The managed block is appended at the end of
 * the user's document, so once their file has opened any table there is no way
 * for appended text to bind a key at document root — the key silently joins
 * whatever table the user was last inside. This is not a limitation we can
 * engineer around inside this seam: prepending the block inverts the same bug
 * onto the managed content, and re-serializing the whole document would destroy
 * the user's comments and formatting. So the honest contract is to refuse.
 *
 * REFUSAL IS DETERMINISTIC — it never consults the user's file. A fragment
 * author cannot see user state, so a rule that depended on it would pass in
 * testing and fail in the field for reasons the author could not reproduce.
 *
 * Detected from the fragment's PREAMBLE (everything ahead of its first
 * document-level table header) rather than from the parsed object's value
 * shapes. The ruling proposed the latter; the preamble is the same intent with
 * a tighter edge, because a parsed root key holding an inline table (`x = [{a=1}]`)
 * is indistinguishable from an array-of-tables after parsing, and would slip
 * through — while it binds into the user's table exactly like any other root key.
 */
function assertFragmentOpensWithTable(fragment: string, sourcePath: string, id: string): void {
  const preamble = splitAtTableHeaders(fragment)[0];
  const declaresSomething = (preamble?.text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.startsWith("#"));
  if (!declaresSomething) return;
  throw new Error(
    `Codex config fragment '${id}' declares root-level keys before its first table header ` +
    `(${sourcePath}); appended TOML cannot bind at document root — open a table first. ` +
    `Nothing was projected and the existing config was left unchanged.`,
  );
}

/**
 * A managed fragment must be a valid TOML document on its own, checked BEFORE
 * any collision filtering. Without this, an authoring error in the fragment is
 * indistinguishable from a user collision and gets silently dropped — the
 * write then succeeds precisely because the bad input was deleted, which is the
 * opposite of what the render guard is for.
 */
function assertFragmentParsesStandalone(fragment: string, sourcePath: string, id: string): void {
  try {
    parseToml(fragment);
  } catch (err) {
    throw new Error(
      `Codex config fragment '${id}' is not valid TOML on its own (${sourcePath}); ` +
      `nothing was projected and the existing config was left unchanged. ${(err as Error).message}`,
    );
  }
}

/**
 * Drop the fragment tables that would collide with the user's own.
 *
 * THE COLLISION DECISION IS THE PARSER'S, NOT OURS. For each table the fragment
 * declares, we ask smol-toml whether the user's document still parses with that
 * table appended. A duplicate declaration is exactly what TOML rejects, so the
 * question the parser answers IS the question we need, on the arbitrary input —
 * the user's file — where a lexical guess is least defensible.
 *
 * The earlier version scanned the USER's document for header lines and compared
 * paths. That scanner mishandled a backslash-escaped delimiter inside a
 * multiline basic string, so `\"""` read as the string's end, the next line read
 * as a declared table, and a genuinely non-conflicting managed table was dropped
 * while projection reported success (review50-r2, 2026-09-01, reproduced). A
 * lexer over user input can be wrong in that silent direction; the parser cannot.
 *
 * The user's values are never merged, rewritten or overwritten — a colliding
 * managed table simply stands down.
 *
 * CALLERS MUST VALIDATE THE FRAGMENT STANDALONE FIRST. "Appending this block
 * makes the document unparseable" has two causes — the user owns a conflicting
 * path, or the block is malformed on its own — and this predicate cannot tell
 * them apart. Left unguarded it answered both with "collides" and DELETED an
 * invalid authored fragment, turning a resource error into a clean-looking empty
 * managed block while the receipt said projected (review50-r2, 2026-09-01,
 * reproduced). `assertFragmentParsesStandalone` eliminates the second cause
 * before we get here, so a failure that survives to this point is a real
 * collision.
 *
 * Keys ahead of the fragment's first header never reach here: OPR.0.5.8.15
 * refuses that shape upstream in `assertFragmentOpensWithTable`, because an
 * appended root key cannot bind at document root and would silently join the
 * user's last table. Every block this function sees is therefore a table.
 */
function dropCollidingFragmentTables(
  fragment: string,
  userOwned: string,
): { kept: string; dropped: string[] } {
  const userParses = parsesAsToml(userOwned);
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const block of splitAtTableHeaders(fragment)) {
    const collides =
      block.header !== null &&
      userParses &&
      !parsesAsToml(`${userOwned}\n${block.text}`);
    if (collides) dropped.push(block.header!);
    else kept.push(block.text);
  }
  return {
    kept: kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n*$/, ""),
    dropped,
  };
}

function upsertManagedCodexConfigFragment(content: string, id: string, fragment: string): string {
  const start = `# BEGIN OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const end = `# END OPENRIG MANAGED CODEX CONFIG FRAGMENT: ${id}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}\\n?`, "m");

  // Everything outside THIS block is what the fragment must not collide with.
  // Our own previous block is excluded because re-projection replaces it
  // wholesale — counting it would make the second projection drop everything
  // the first one legitimately landed.
  const userOwned = content.replace(pattern, "");
  const { kept } = dropCollidingFragmentTables(fragment, userOwned);
  const block = `${start}\n${kept}\n${end}\n`;

  if (pattern.test(content)) {
    return content.replace(pattern, () => block); // literal: a string would expand `$` patterns in the fragment
  }

  const prefix = content.replace(/\n*$/, "");
  return prefix.length > 0 ? `${prefix}\n\n${block}` : block;
}

/**
 * Refuse to hand Codex a config it cannot load. Throwing here (rather than
 * writing and hoping) is what keeps a malformed render off disk entirely:
 * `project()` records the entry as failed and the existing file is untouched.
 */
function assertRendersAsLoadableToml(rendered: string, configPath: string, id: string): void {
  try {
    parseToml(rendered);
  } catch (err) {
    throw new Error(
      `Codex config projection '${id}' would write a config Codex cannot parse; ` +
      `${configPath} left unchanged. ${(err as Error).message}`,
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Module-private (P1 pin — NEVER exported). The REAL Codex profile-LOAD probe,
// extracted verbatim from launchHarness: dynamic imports keep it lazy for
// production, execFn runs the real `codex -p <profile> mcp list` through
// execRuntimeProbe (utf-8, 10s bound, off the event loop). Injected as the
// adapter's default verifyProfilePreflight; tests substitute a controlled stub.
async function defaultProfilePreflight(profile: string, selected?: { cwd: string; codexHome: string; launchPath?: string }): Promise<CodexProfileProbeResult> {
  const { verifyCodexProfileLoads } = await import("../domain/codex-profile-preflight.js");
  const execFn = (cmd: string) => execRuntimeProbe("codex.runtime.profile_preflight", cmd,
    selected ? { cwd: selected.cwd, env: { ...process.env, CODEX_HOME: selected.codexHome, ...(selected.launchPath ? { PATH: selected.launchPath } : {}) } } : {});
  return verifyCodexProfileLoads(profile, execFn, undefined, selected?.codexHome);
}

// Exported for unit test (B12-T): the REAL async sampling path — the anti-vacuity test drives
// this default directly (every other suite injects sync stubs) and asserts the non-blocking
// property that the pre-B12 sync implementation violated.
export async function defaultListProcesses(): Promise<CodexProcess[]> {
  return listNativeProcesses();
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

/** The update helper's latest capture, read through a function so flow narrowing doesn't hide the helper's write. */
function helperObservation(attempt: UpdatePromptAttempt): UpdatePromptAttempt["observed"] {
  return attempt.observed;
}

function isSkippableCodexUpdatePrompt(paneContent: string): boolean {
  return hasCodexUpdateHeader(paneContent)
    && /^\s*[›>]?\s*3\. Skip until next version\s*$/m.test(paneContent);
}
