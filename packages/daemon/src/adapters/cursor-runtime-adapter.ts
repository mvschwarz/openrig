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
import { upsertCursorActivityHooks, stripCursorActivityHooks } from "./cursor-activity-hooks.js";

export interface CursorAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  deleteFile?(path: string): void;
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
 * to `"allowlist"` before the launch, keeping every other key. A missing or unparseable config is left
 * alone: Cursor creates a fresh allowlist config itself. Write errors propagate to the caller.
 *
 * `--model` persists the same way and is deliberately not reset: a seat with no model set keeps the
 * last model it was launched with (a documented limitation).
 */
export function resetCursorSeatApprovalMode(
  fs: Pick<CursorAdapterFsOps, "readFile" | "writeFile" | "exists">,
  configDir: string,
  permissionMode?: string,
): void {
  if (permissionMode === "auto_review") return;
  const configPath = nodePath.join(configDir, "cli-config.json");
  let config: unknown;
  try {
    if (!fs.exists(configPath)) return;
    config = JSON.parse(fs.readFile(configPath));
  } catch {
    return;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return;
  const record = config as Record<string, unknown>;
  if (record.approvalMode === "allowlist") return;
  fs.writeFile(configPath, `${JSON.stringify({ ...record, approvalMode: "allowlist" }, null, 2)}\n`);
}

/**
 * Cursor stores the approval mode per chat, and a resumed chat keeps it: `--auto-review` or
 * `--force` can raise a chat's mode, but no flag lowers it. So OpenRig records, in its own file in
 * the seat config dir, the approval arg each chat was last launched with; a resume whose arg differs
 * must start a fresh chat instead. Cursor's own chat store is never edited.
 */
export interface CursorChatLaunchRecord {
  chatId: string;
  approvalArg: string;
}

export const CURSOR_CHAT_LAUNCH_FILE = "openrig-chat-launch.json";

/** A missing, unreadable or malformed sidecar reads as null (no record). */
export function readCursorChatLaunch(
  fs: Pick<CursorAdapterFsOps, "readFile" | "exists">,
  configDir: string,
): CursorChatLaunchRecord | null {
  const path = nodePath.join(configDir, CURSOR_CHAT_LAUNCH_FILE);
  let parsed: unknown;
  try {
    if (!fs.exists(path)) return null;
    parsed = JSON.parse(fs.readFile(path));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { chatId, approvalArg } = parsed as Record<string, unknown>;
  if (typeof chatId !== "string" || typeof approvalArg !== "string") return null;
  return { chatId, approvalArg };
}

/** Write errors propagate to the caller. */
export function writeCursorChatLaunch(
  fs: Pick<CursorAdapterFsOps, "writeFile">,
  configDir: string,
  record: CursorChatLaunchRecord,
): void {
  fs.writeFile(
    nodePath.join(configDir, CURSOR_CHAT_LAUNCH_FILE),
    `${JSON.stringify({ chatId: record.chatId, approvalArg: record.approvalArg }, null, 2)}\n`,
  );
}

/** True when the sidecar shows this chat last ran under a different approval arg. */
export function cursorChatApprovalChanged(
  fs: Pick<CursorAdapterFsOps, "readFile" | "exists">,
  configDir: string,
  chatId: string,
  approvalArg: string,
): boolean {
  const record = readCursorChatLaunch(fs, configDir);
  return !!record && record.chatId === chatId && record.approvalArg !== approvalArg;
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
  private createChat: CursorCreateChat;
  private sleep: (ms: number) => Promise<void>;

  constructor(deps: CursorRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.launchPath = deps.launchPath;
    this.cursorHome = deps.cursorHome;
    this.activityRelayPath = deps.activityRelayPath;
    this.createChat = deps.createChat ?? defaultCreateChat;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
      if (next === null) this.fs.deleteFile?.(hooksPath);
      else if (next !== existing) this.fs.writeFile(hooksPath, next);
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
          this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
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
    if (chatId && cursorChatApprovalChanged(this.fs, configDir, chatId, approvalArg)) {
      console.log(`[openrig] cursor: permission mode changed since chat ${chatId.slice(0, 8)}…; starting a fresh chat so the new mode applies`);
      chatId = undefined;
    }
    if (!chatId) {
      const created = await this.createSeatChat(configDir, binding.cwd);
      if (!created.ok) return { ok: false, error: created.error };
      chatId = created.chatId;
    }

    try {
      resetCursorSeatApprovalMode(this.fs, configDir, binding.permissionMode);
    } catch (err) {
      return { ok: false, error: `cursor: could not reset the seat approval mode: ${(err as Error).message}` };
    }
    // Recorded before the launch is sent: without the record a later mode change could not be detected.
    try {
      writeCursorChatLaunch(this.fs, configDir, { chatId, approvalArg });
    } catch (err) {
      return { ok: false, error: `cursor: could not record the chat launch: ${(err as Error).message}` };
    }

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
      this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(entry.absolutePath)), this.fs.readFile(entry.absolutePath));
      return true;
    }
    for (const file of files) {
      const dest = nodePath.join(targetDir, file);
      this.fs.mkdirp(nodePath.dirname(dest));
      this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
    }
    return true;
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
