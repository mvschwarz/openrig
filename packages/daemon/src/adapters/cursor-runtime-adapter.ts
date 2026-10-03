// The Cursor CLI runtime adapter (`cursor-agent`, interactive TUI in the seat's pane).
//
// Cursor reads AGENTS.md and .agents/skills in its cwd, so guidance and skills use the
// same targets as Codex. Each seat gets its own CURSOR_CONFIG_DIR, because Cursor
// persists --model and approval flags into its config and would otherwise rewrite the
// operator's ~/.cursor/cli-config.json. The chat id is created before launch with
// `cursor-agent create-chat` and is the seat's resume token, so no post-launch
// discovery is needed. Activity comes from the user-scope hooks file (see
// cursor-activity-hooks.ts); forking is not supported.

import nodePath from "node:path";
import type { spawn } from "node:child_process";
import type { TmuxAdapter } from "./tmux.js";
import { shellQuote } from "./shell-quote.js";
import { cursorApprovalArg } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile, InstalledResource,
  ProjectionResult, StartupDeliveryResult, ReadinessResult, HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { assessNativeResumeProbe } from "../domain/native-resume-probe.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { upsertCursorActivityHooks, stripCursorActivityHooks, hasCursorActivityHooks } from "./cursor-activity-hooks.js";

export interface CursorAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  /** Mode primitives, so projected skill scripts keep their execute bit (as in the Codex adapter). */
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export type CursorCreateChat = (input: { configDir: string; cwd: string; launchPath?: string }) => Promise<string>;

export interface CursorRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: CursorAdapterFsOps;
  /** Root of the per-seat config dirs, normally <OPENRIG_HOME>/state/cursor. */
  stateRoot: string;
  /** Match the daemon's PATH even if the pane's login shell rewrites it. */
  launchPath?: string;
  createChat?: CursorCreateChat;
  sleep?: (ms: number) => Promise<void>;
  /** The operator's Cursor home, normally ~/.cursor. Only hooks.json is written there. */
  cursorHome?: string;
  /** Absolute path to the daemon's shipped activity-relay.cjs. */
  activityRelayPath?: string;
  /** runtime.cursor.hooks_enabled, read at each launch. Without it, launches never write hooks.json. */
  hooksEnabled?: () => boolean;
}

export function cursorSeatConfigDir(stateRoot: string, nodeId: string): string {
  return nodePath.join(stateRoot, nodeId);
}

// `exec` replaces the /bin/sh wrapper that sendShellCommand runs the command under; otherwise sh
// stays the pane's foreground process and the readiness probe would see a shell, not Cursor.
export function buildCursorLaunchCommand(input: {
  chatId: string; configDir: string; model?: string | null; approvalArg: string; launchPath?: string;
}): string {
  const env = [`CURSOR_CONFIG_DIR=${shellQuote(input.configDir)}`];
  if (input.launchPath) env.unshift(`PATH=${shellQuote(input.launchPath)}`);
  const model = input.model?.trim() ? ` --model ${shellQuote(input.model.trim())}` : "";
  return `exec env ${env.join(" ")} cursor-agent --resume ${shellQuote(input.chatId)} --trust${model}${input.approvalArg}`;
}

/**
 * Cursor persists `--auto-review` into the seat's `cli-config.json` as `"approvalMode": "auto-review"`,
 * and a later launch without the flag keeps it (`--force` does not persist; a fresh config starts at
 * `"allowlist"`). So unless the intended mode is auto_review, put a persisted non-allowlist mode back
 * to `"allowlist"` before the launch. `--model` persists the same way (`model` and `selectedModel`),
 * so a seat whose spec sets no model has those keys removed, and a new chat starts on Cursor's
 * default as in a fresh config. Every other key is kept. A missing or unparseable config is left
 * alone: Cursor creates a fresh config itself. Write errors propagate to the caller.
 *
 * A resumed chat still keeps the model it last used; Cursor stores that per chat.
 */
export function resetCursorSeatConfig(
  fs: Pick<CursorAdapterFsOps, "readFile" | "writeFile" | "exists">,
  configDir: string,
  permissionMode?: string,
  model?: string | null,
): void {
  const configPath = nodePath.join(configDir, "cli-config.json");
  let config: unknown;
  try {
    if (!fs.exists(configPath)) return;
    config = JSON.parse(fs.readFile(configPath));
  } catch {
    return;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const record = { ...(config as Record<string, unknown>) };
  let changed = false;
  if (permissionMode !== "auto_review" && record.approvalMode !== "allowlist") {
    record.approvalMode = "allowlist";
    changed = true;
  }
  if (!model?.trim()) {
    for (const key of ["model", "selectedModel"]) {
      if (key in record) { delete record[key]; changed = true; }
    }
  }
  if (changed) fs.writeFile(configPath, `${JSON.stringify(record, null, 2)}\n`);
}

/**
 * Cursor stores the approval mode per chat, and a resumed chat keeps it: `--auto-review` or
 * `--force` can raise a chat's mode, but no flag lowers it. So OpenRig records, in its own file in
 * the seat config dir, the approval arg each chat it launched last ran with. A resume whose arg
 * differs, or of a chat the record does not know (an older snapshot's chat from before the record,
 * or one set by hand), must start a fresh chat instead. Cursor's own chat store is never edited.
 */
export const CURSOR_CHAT_LAUNCH_FILE = "openrig-chat-launch.json";

/** Most chats remembered per seat; the oldest are dropped first. */
const CURSOR_CHAT_LAUNCH_MAX = 100;

/**
 * Chat id → approval arg. A missing, unreadable or malformed file reads as empty. The one-chat
 * shape written by earlier builds (`{ chatId, approvalArg }`) is still read.
 */
export function readCursorChatLaunches(
  fs: Pick<CursorAdapterFsOps, "readFile" | "exists">,
  configDir: string,
): Record<string, string> {
  const path = nodePath.join(configDir, CURSOR_CHAT_LAUNCH_FILE);
  let parsed: unknown;
  try {
    if (!fs.exists(path)) return {};
    parsed = JSON.parse(fs.readFile(path));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const { chats, chatId, approvalArg } = parsed as Record<string, unknown>;
  if (chats && typeof chats === "object" && !Array.isArray(chats)) {
    const out: Record<string, string> = {};
    for (const [id, arg] of Object.entries(chats as Record<string, unknown>)) {
      if (typeof arg === "string") out[id] = arg;
    }
    return out;
  }
  if (typeof chatId === "string" && typeof approvalArg === "string") return { [chatId]: approvalArg };
  return {};
}

/** Records the chat's approval arg, keeping the other chats. Write errors propagate to the caller. */
export function recordCursorChatLaunch(
  fs: Pick<CursorAdapterFsOps, "readFile" | "writeFile" | "exists">,
  configDir: string,
  chatId: string,
  approvalArg: string,
): void {
  const chats = readCursorChatLaunches(fs, configDir);
  delete chats[chatId];
  chats[chatId] = approvalArg;
  const kept = Object.entries(chats).slice(-CURSOR_CHAT_LAUNCH_MAX);
  fs.writeFile(
    nodePath.join(configDir, CURSOR_CHAT_LAUNCH_FILE),
    `${JSON.stringify({ chats: Object.fromEntries(kept) }, null, 2)}\n`,
  );
}

/** True unless the record shows this chat last ran under this same approval arg. */
export function cursorChatApprovalChanged(
  fs: Pick<CursorAdapterFsOps, "readFile" | "exists">,
  configDir: string,
  chatId: string,
  approvalArg: string,
): boolean {
  return readCursorChatLaunches(fs, configDir)[chatId] !== approvalArg;
}

const CHAT_ID_LINE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Longest stderr snippet carried into a create-chat error message. */
const STDERR_SNIPPET_MAX = 200;

function capStderr(line: string): string {
  return line.length > STDERR_SNIPPET_MAX ? `${line.slice(0, STDERR_SNIPPET_MAX)}…` : line;
}

/**
 * `cursor-agent create-chat` prints the chat id at once but then does not exit, so take the
 * id from the first UUID line and kill the child instead of waiting for it to finish.
 */
export function runCreateChat(
  spawnFn: typeof spawn,
  input: { configDir: string; cwd: string; launchPath?: string; timeoutMs?: number },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let lastStderr = "";
    const child = spawnFn("cursor-agent", ["create-chat"], {
      cwd: input.cwd,
      env: { ...process.env, CURSOR_CONFIG_DIR: input.configDir, ...(input.launchPath ? { PATH: input.launchPath } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (err: Error | null, id?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(id!);
    };
    const kill = () => { try { child.kill("SIGTERM"); } catch { /* already gone */ } };
    const stderrSuffix = () => (lastStderr ? `: ${capStderr(lastStderr)}` : "");
    const timer = setTimeout(() => {
      kill();
      finish(new Error(`timed out waiting for a chat id${stderrSuffix()}`));
    }, input.timeoutMs ?? 30_000);
    // An unhandled 'error' on a pipe would crash the daemon; reject (once) and stop the child instead.
    const onStreamError = (stream: string) => (err: Error) => {
      if (settled) return;
      kill();
      finish(new Error(`cursor-agent create-chat ${stream} failed: ${err.message}`));
    };
    child.stdout?.on("error", onStreamError("stdout"));
    child.stderr?.on("error", onStreamError("stderr"));
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (CHAT_ID_LINE.test(line.trim())) {
          kill();
          finish(null, line.trim());
          return;
        }
      }
      // An id with no trailing newline yet is only taken once the line is complete.
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const last = chunk.toString().split("\n").map((l) => l.trim()).filter(Boolean).pop();
      if (last) lastStderr = last;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(new Error(err.code === "ENOENT" ? "cursor-agent not found on PATH" : err.message));
    });
    child.on("close", (code: number | null) => {
      if (!settled && CHAT_ID_LINE.test(stdout.trim())) { finish(null, stdout.trim()); return; }
      finish(new Error(`cursor-agent create-chat exited (code ${code}) before printing a chat id${stderrSuffix()}`));
    });
  });
}

const defaultCreateChat: CursorCreateChat = async (input) => {
  const { spawn: realSpawn } = await import("node:child_process");
  return runCreateChat(realSpawn, input);
};

export class CursorRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "cursor";
  private tmux: TmuxAdapter;
  private fs: CursorAdapterFsOps;
  private stateRoot: string;
  private launchPath?: string;
  private cursorHome?: string;
  private activityRelayPath?: string;
  private hooksEnabled?: () => boolean;
  private createChat: CursorCreateChat;
  private sleep: (ms: number) => Promise<void>;

  constructor(deps: CursorRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.launchPath = deps.launchPath;
    this.cursorHome = deps.cursorHome;
    this.activityRelayPath = deps.activityRelayPath;
    this.hooksEnabled = deps.hooksEnabled;
    this.createChat = deps.createChat ?? defaultCreateChat;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Daemon start: keep entries that are already there current (an upgrade moves the relay path),
   * but never add them. They are added by the first Cursor seat launch, so a machine with only the
   * Cursor IDE never runs OpenRig's relay.
   */
  refreshCursorActivityHooks(): void {
    if (!this.cursorHome) return;
    const hooksPath = nodePath.join(this.cursorHome, "hooks.json");
    try {
      if (!this.fs.exists(hooksPath) || !hasCursorActivityHooks(this.fs.readFile(hooksPath))) return;
    } catch (err) {
      console.error(`[openrig] cursor activity hooks skipped: ${(err as Error).message}`);
      return;
    }
    this.ensureCursorActivityHooks();
  }

  ensureCursorActivityHooks(): void {
    const relay = this.activityRelayPath;
    if (!relay || !this.cursorHome) return;
    // Cursor not installed (no ~/.cursor): never create the directory just for the hooks file.
    if (!this.fs.exists(this.cursorHome)) return;
    if (!this.fs.exists(relay)) {
      console.error(`[openrig] cursor activity hooks skipped: relay asset not found at ${relay}`);
      return;
    }
    const hooksPath = nodePath.join(this.cursorHome, "hooks.json");
    // Parse refusals and fs errors (unreadable or unwritable file) are logged, never thrown, so a
    // problem with ~/.cursor cannot stop the rest of the daemon's runtime setup.
    try {
      const existing = this.fs.exists(hooksPath) ? this.fs.readFile(hooksPath) : "";
      const next = upsertCursorActivityHooks(existing, relay);
      if (next !== existing) this.fs.writeFile(hooksPath, next);
    } catch (err) {
      console.error(`[openrig] cursor activity hooks skipped: ${(err as Error).message}`);
    }
  }

  removeCursorActivityHooks(): void {
    if (!this.cursorHome) return;
    const hooksPath = nodePath.join(this.cursorHome, "hooks.json");
    try {
      if (!this.fs.exists(hooksPath)) return;
      const existing = this.fs.readFile(hooksPath);
      const next = stripCursorActivityHooks(existing);
      if (next !== existing) this.fs.writeFile(hooksPath, next);
    } catch (err) {
      console.error(`[openrig] cursor activity hooks cleanup skipped: ${(err as Error).message}`);
    }
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    if (!this.fs.exists(skillsDir) || !this.fs.listFiles) return [];
    return this.fs.listFiles(skillsDir).map((file) => ({
      effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file),
    }));
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];
    for (const entry of plan.entries) {
      if (entry.classification === "no_op") { skipped.push(entry.effectiveId); continue; }
      try {
        if (this.projectEntry(entry, binding.cwd)) projected.push(entry.effectiveId);
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
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        if (hint === "guidance_merge") {
          if (!this.mergeGuidance(nodePath.join(binding.cwd, "AGENTS.md"), file.path, content)) continue;
        } else if (hint === "skill_install") {
          const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
          this.fs.mkdirp(targetDir);
          const dest = nodePath.join(targetDir, nodePath.basename(file.path));
          this.fs.writeFile(dest, content);
          this.preserveMode(file.absolutePath, dest);
        } else if (binding.tmuxSession) {
          // Cursor's TUI does not submit text and Enter sent as one burst; type, pause, then submit.
          const typed = await this.tmux.sendText(binding.tmuxSession, content);
          if (!typed.ok) throw new Error(typed.message);
          await this.sleep(200);
          const submitted = await this.tmux.sendKeys(binding.tmuxSession, ["C-m"]);
          if (!submitted.ok) throw new Error(submitted.message);
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
    if (!binding.tmuxSession) return { ok: false, error: "No tmux session bound — cannot launch Cursor harness" };
    if (opts.resumeToken && opts.forkSource) return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    if (opts.forkSource) return { ok: false, error: "cursor: forking a session is not supported" };

    const configDir = cursorSeatConfigDir(this.stateRoot, binding.nodeId);
    try {
      this.fs.mkdirp(configDir);
    } catch (err) {
      return { ok: false, error: `cursor: could not create the seat config dir: ${(err as Error).message}` };
    }

    let approvalArg: string;
    try {
      approvalArg = cursorApprovalArg(process.env, binding.launchPosture, binding.permissionMode);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    let chatId = opts.resumeToken?.trim();
    // A fresh chat is the caller's decision, not the adapter's: restore must not report it resumed.
    if (chatId && cursorChatApprovalChanged(this.fs, configDir, chatId, approvalArg)) {
      return {
        ok: false,
        error: "Cursor permission mode changed since this chat last ran (or OpenRig has no record of its mode); a fresh chat is required for the new mode to apply.",
        recovery: "retry_fresh",
      };
    }
    if (!chatId) {
      const created = await this.createSeatChat(configDir, binding.cwd);
      if (!created.ok) return { ok: false, error: created.error };
      chatId = created.chatId;
    }

    try {
      resetCursorSeatConfig(this.fs, configDir, binding.permissionMode, binding.model);
    } catch (err) {
      return { ok: false, error: `cursor: could not reset the seat config: ${(err as Error).message}` };
    }
    // Recorded before the launch is sent: without the record a later mode change could not be detected.
    try {
      recordCursorChatLaunch(this.fs, configDir, chatId, approvalArg);
    } catch (err) {
      return { ok: false, error: `cursor: could not record the chat launch: ${(err as Error).message}` };
    }

    // Logged, never thrown: a hooks problem must not stop the seat launching.
    if (this.hooksEnabled?.()) this.ensureCursorActivityHooks();

    const command = buildCursorLaunchCommand({ chatId, configDir, model: binding.model, approvalArg, launchPath: this.launchPath });
    const sent = await this.tmux.sendShellCommand(binding.tmuxSession, command);
    if (!sent.ok) return { ok: false, error: `Failed to send launch command: ${sent.message}` };
    return { ok: true, resumeToken: chatId, resumeType: "cursor_chat_id" };
  }

  private async createSeatChat(configDir: string, cwd: string): Promise<{ ok: true; chatId: string } | { ok: false; error: string }> {
    let printed: string;
    try {
      printed = await this.createChat({ configDir, cwd, launchPath: this.launchPath });
    } catch (err) {
      return { ok: false, error: `cursor create-chat failed: ${(err as Error).message}` };
    }
    const candidate = printed.trim().split("\n").pop()?.trim() ?? "";
    const validation = validateResumeToken("cursor", candidate);
    if (!validation.ok) return { ok: false, error: `cursor create-chat returned an unusable chat id: ${validation.error}` };
    return { ok: true, chatId: validation.token };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) return { ready: false, reason: "tmux session not responsive" };
    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = this.tmux.capturePaneScreen
      ? await this.tmux.capturePaneScreen(binding.tmuxSession) ?? ""
      : await this.tmux.capturePaneContent(binding.tmuxSession, 40) ?? "";
    const probe = assessNativeResumeProbe({ runtime: "cursor", paneCommand, paneContent });
    if (probe.status === "resumed") return { ready: true };
    return { ready: false, reason: probe.detail, code: probe.code };
  }

  /** Skills and managed-block guidance only; plugins and runtime resources are not projected for Cursor in v1. */
  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(nodePath.join(cwd, "AGENTS.md"), entry.effectiveId, this.fs.readFile(entry.absolutePath));
    }
    if (entry.category !== "skill") return false;
    const targetDir = nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
    this.fs.mkdirp(targetDir);
    const files = this.fs.listFiles ? safeList(this.fs, entry.absolutePath) : [];
    if (files.length === 0) {
      const dest = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
      this.fs.writeFile(dest, this.fs.readFile(entry.absolutePath));
      this.preserveMode(entry.absolutePath, dest);
      return true;
    }
    for (const file of files) {
      const src = nodePath.join(entry.absolutePath, file);
      const dest = nodePath.join(targetDir, file);
      this.fs.mkdirp(nodePath.dirname(dest));
      this.fs.writeFile(dest, this.fs.readFile(src));
      this.preserveMode(src, dest);
    }
    return true;
  }

  /** writeFile creates the dest with the default mode; reapply the source's bits (no-op without mode primitives). */
  private preserveMode(src: string, dest: string): void {
    if (!this.fs.statMode || !this.fs.chmod) return;
    const srcMode = this.fs.statMode(src) & 0o777;
    if ((this.fs.statMode(dest) & 0o777) !== srcMode) this.fs.chmod(dest, srcMode);
  }

  /** Mirrors the Codex adapter: the shared `rig-role` block is delivered per seat via send_text instead. */
  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    if (blockId === "rig-role") {
      console.log(`[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`);
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}

function safeList(fs: CursorAdapterFsOps, path: string): string[] {
  try { return fs.listFiles!(path); } catch { return []; }
}
