// Muse runtime adapter (direct-CLI, no runner-in-a-pane shim).
//
// Unlike Pi (which needs the pane-hosted pi-runner to front `pi --mode rpc`),
// Muse exposes a headless-friendly CLI surface directly:
//   - `muse` (interactive TUI) ... persistent seat launch (never `exec`,
//     which is one-shot headless); the first prompt arrives via send_text
//   - `muse resume <id>` ......... exact session continuation (never a picker,
//     never --fork: Muse has no fork primitive)
//   - `muse session-message list --json` .. live session enumeration
//   - session JSONL logs .......... durable session identity on disk; the
//     post-launch capture reads the newest session.jsonl mtime from the store
// so the adapter types `muse` commands straight into the seat's tmux pane and
// reads back only Muse-authored surfaces — never TUI heuristics.
//
// CLI-surface assumption: the exact flag spellings below (`--workspace`,
// `--model, `--yolo`, `resume <id>`) are verified against the shipped `muse`
// CLI. If a flag is renamed, the pure builders below are the single place to
// adjust; the hermetic tests pin every builder byte-for-byte.
//
// Trust posture (BR-5 analogue): every managed launch carries an EXPLICIT
// posture segment from musePostureFlag (yolo-mode.ts) — YOLO / a per-seat
// resolved full_bypass selects ` --yolo` (maximally-permissive launch flag);
// otherwise the harness default floor applies (no flag). The same decision
// runs on fresh / resume / fork so posture is uniform, never path-dependent.

import nodePath from "node:path";
import { statSync } from "node:fs";
import os from "node:os";
import type { TmuxAdapter } from "./tmux.js";
import { musePostureFlag } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeMuseTrust } from "../domain/permission-drift.js";
import { shellQuote } from "./shell-quote.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface MuseAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  /** mtime in ms for the session-store scan (tests inject; default stats). */
  mtimeMs?(path: string): number | null;
}

export interface MuseRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: MuseAdapterFsOps;
  /** Trust posture selector input (mirrors the Pi adapter's trustPosture dep).
   *  Reserved for a future configured floor; today the floor is the harness
   *  default (no flag) and YOLO selects --yolo. Kept so the posture seam
   *  stays explicit and injectable in tests. */
  trustPosture?: "yolo" | "default";
  sleep?: (ms: number) => Promise<void>;
  /** Override for the post-launch session-id scan (tests inject; default
   *  walks the on-disk session store for the newest session.jsonl). */
  readLatestSessionId?: () => Promise<string | null>;
  /** Session-store root override (tests inject; default honors
   *  XDG_DATA_HOME, falling back to ~/.local/share/muse/sessions). */
  sessionStoreRoot?: string;
}

// ── Pure command builders (single source of truth; hermetically tested) ──

export interface MuseLaunchOpts {
  cwd: string;
  model?: string;
  /** Already-resolved posture segment (leading space) or "". */
  postureArg: string;
}

/** Fresh seat command: interactive `muse [--workspace <dir>] [--model <m>]
 *  [posture]`. The pane cwd is already the seat dir; --workspace gates tools
 *  to it. Persistent TUI — the first prompt arrives via send_text. */
export function buildMuseFreshCommand(opts: MuseLaunchOpts): string {
  const parts = ["muse"];
  if (opts.cwd?.trim()) {
    parts.push("--workspace", shellQuote(opts.cwd.trim()));
  }
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  const posture = opts.postureArg.trim();
  if (posture) parts.push(posture);
  return parts.join(" ");
}

/** Resume command: `muse resume <id> [--model <m>] [posture]`. No workspace
 *  flag: the session restores its own workspace. */
export function buildMuseResumeCommand(opts: MuseLaunchOpts & { sessionId: string }): string {
  const parts = ["muse", "resume", shellQuote(opts.sessionId)];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  const posture = opts.postureArg.trim();
  if (posture) parts.push(posture);
  return parts.join(" ");
}

const SESSION_ID_DIR = /^[0-9a-f-]{36}$/i;

function defaultSessionStoreRoot(): string {
  const base = process.env.XDG_DATA_HOME?.trim() || nodePath.join(os.homedir(), ".local", "share");
  return nodePath.join(base, "muse", "sessions");
}

export class MuseRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "muse";
  private tmux: TmuxAdapter;
  private fs: MuseAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private readLatestSessionId: () => Promise<string | null>;
  private sessionStoreRoot: string;

  constructor(deps: MuseRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.sessionStoreRoot = deps.sessionStoreRoot ?? defaultSessionStoreRoot();
    this.readLatestSessionId = deps.readLatestSessionId ?? (async () => this.scanSessionStore());
  }

  /** Session-id reader shape resume-token-capture consumes
   *  (deriveResumeToken's museSessionStore dep). */
  async readSessionId(_sessionName: string): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    const id = await this.readLatestSessionId();
    if (!id) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId: id };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".muse", "skills");
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
            const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
            const merged = this.mergeGuidance(targetPath, file.path, content);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".muse", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
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
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the Muse harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    const postureArg = musePostureFlag(process.env, binding.launchPosture);
    const appliedLaunch = observeMuseTrust(postureArg);
    const sessionName = binding.tmuxSession;

    if (opts.forkSource) {
      // The Muse CLI has no fork primitive (no `resume --fork`), and the
      // adapter contract requires refusal over guessing: launch fresh or
      // resume the parent instead.
      return {
        ok: false,
        error: "muse fork is not supported in v1 (the Muse CLI has no fork primitive); launch fresh or resume the parent session",
      };
    }

    if (opts.resumeToken) {
      // Validity floor before we type anything into the pane.
      const validation = validateResumeToken("muse", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `muse resume: ${validation.error}` };
      }
      const cmd = buildMuseResumeCommand({
        sessionId: validation.token, cwd: binding.cwd, model: binding.model, postureArg,
      });
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      const verification = await this.verifyLaunch(sessionName);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: validation.token, resumeType: "muse_id", appliedLaunch };
    }

    const cmd = buildMuseFreshCommand({ cwd: binding.cwd, model: binding.model, postureArg });
    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }
    const verification = await this.verifyLaunch(sessionName);
    if (!verification.ok) return verification;
    // Fresh-launch capture: the seat's session dir exists by the time the
    // pane verifies ready, so the newest session id is (almost surely) this
    // seat's. Newest-wins is an approximation — pod-mates sharing a HOME
    // store that boot in the same instant could collide — but daemon node
    // startup is sequential, and a missed read simply leaves the token null
    // (honest fresh fallback at restore) rather than fabricating one.
    const freshId = await this.readLatestSessionId().catch(() => null);
    return {
      ok: true,
      appliedLaunch,
      ...(freshId ? { resumeToken: freshId, resumeType: "muse_id" as const } : {}),
    };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    return assessMusePane(paneCommand, paneContent);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".muse", "skills", entry.effectiveId);
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

    // Plugins / subagents / runtime resources have no Muse projection target
    // at MVP — an honest skip, never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex/Pi adapters: per-seat `rig-role` content
    // collides across pod-mates when merged into a shared cwd file; it is
    // delivered via send_text instead. See ADR-0006.
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

  private async verifyLaunch(sessionName: string): Promise<HarnessLaunchResult> {
    const pollMs = 250;
    const attempts = 20; // ~5s: muse boot into the seat pane
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
      const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
      const verdict = assessMusePane(paneCommand, paneContent);
      if (verdict.ready) return { ok: true };
      if (verdict.code === "muse_error" || verdict.code === "login_required") {
        return {
          ok: false,
          error: `muse launch failed: ${verdict.reason}`,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      error: "muse launch: timed out waiting for Muse to become active",
      recovery: "attention_required",
    };
  }

  /** Newest session id by session.jsonl mtime under the store root
   *  (<root>/YYYY/MM/DD/<uuid>/session.jsonl). `session-message list`
   *  carries no timestamps, so the on-disk log is the recency source. */
  private scanSessionStore(): string | null {
    return this.listSessionCandidates()[0]?.sessionId ?? null;
  }

  /** All session candidates under the store root, newest first. */
  private listSessionCandidates(): Array<{ sessionId: string; log: string }> {
    const list = this.fs.listFiles;
    const mtime = this.fs.mtimeMs ?? defaultMtimeMs;
    if (!list) return [];
    const found: Array<{ sessionId: string; log: string; stamp: number }> = [];
    for (const year of safeList(list, this.sessionStoreRoot)) {
      for (const month of safeList(list, nodePath.join(this.sessionStoreRoot, year))) {
        for (const day of safeList(list, nodePath.join(this.sessionStoreRoot, year, month))) {
          for (const sessionId of safeList(list, nodePath.join(this.sessionStoreRoot, year, month, day))) {
            if (!SESSION_ID_DIR.test(sessionId)) continue;
            const log = nodePath.join(this.sessionStoreRoot, year, month, day, sessionId, "session.jsonl");
            if (!this.fs.exists(log)) continue;
            const stamp = mtime(log);
            if (stamp !== null) found.push({ sessionId, log, stamp });
          }
        }
      }
    }
    found.sort((a, b) => b.stamp - a.stamp);
    return found;
  }

  /** Cwd-scoped session read: newest session (by session.jsonl mtime)
   *  whose log records this workspace_root. The log embeds
   *  `"workspace_root":"<cwd>"` (JSON-escaped) within the first frames, so
   *  distinct cwds disambiguate; pod-mates sharing the exact cwd still
   *  collide (documented newest-wins). Newest-first with early exit plus a
   *  50-candidate cap — the adoption path runs rarely. */
  async readSessionIdForCwd(cwd: string | null): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    if (!cwd) return { ok: false, reason: "missing_sidecar" };
    const needle = `"workspace_root":${JSON.stringify(cwd)}`;
    let checked = 0;
    for (const candidate of this.listSessionCandidates()) {
      if (checked >= 50) break;
      checked += 1;
      let content: string;
      try {
        content = this.fs.readFile(candidate.log);
      } catch {
        continue;
      }
      if (content.includes(needle)) return { ok: true, sessionId: candidate.sessionId };
    }
    return { ok: false, reason: "missing_sidecar" };
  }
}

function safeList(
  list: (dirPath: string) => string[] | undefined,
  dirPath: string,
): string[] {
  try {
    return list(dirPath) ?? [];
  } catch {
    return [];
  }
}

function defaultMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Pane-state verdict for a Muse seat. Pure — shared by checkReady and the
 *  launch verifier so the two never disagree. */
export function assessMusePane(
  paneCommand: string,
  paneContent: string,
): ReadinessResult {
  const cmd = (paneCommand ?? "").trim().toLowerCase();
  const content = paneContent ?? "";
  // The `muse` launcher execs a versioned `muse-bin-<version>` child, so
  // tmux reports e.g. `muse-bin-1.3.0-R3401.1` as the foreground command.
  const runtimeOwnsPane = cmd === "muse" || cmd.startsWith("muse ") || cmd.startsWith("muse-bin");
  // A running runtime is up even when agent output contains error-like text
  // (test runs print "exit code 1", tracebacks, ...): the generic markers
  // below apply only when the runtime does NOT own the pane (e.g. the CLI
  // exited, leaving crash text + a shell). Narrow auth phrases still count
  // while the runtime owns the pane — an auth-dead TUI is not operable.
  if (runtimeOwnsPane) {
    if (/login required|not authenticated|authentication (failed|required)|please run `?muse login`?/i.test(content)) {
      return { ready: false, reason: "Muse reports missing or expired authentication", code: "login_required" };
    }
    return { ready: true };
  }
  if (/login required|not authenticated|authentication (failed|required)|please run `?muse login`?/i.test(content)) {
    return { ready: false, reason: "Muse reports missing or expired authentication", code: "login_required" };
  }
  if (/\[muse\] error|muse: (error|failed)|exit(ed)?( with)? code \d+|traceback/i.test(content)) {
    return { ready: false, reason: "Muse reported an error in the pane", code: "muse_error" };
  }
  if (SHELL_COMMANDS.has(cmd)) {
    return { ready: false, reason: "Muse has not started yet (pane is at a shell)", code: "awaiting_runtime" };
  }
  if (cmd.length === 0) {
    return { ready: false, reason: "Muse has not started yet", code: "awaiting_runtime" };
  }
  return { ready: false, reason: `Muse pane is running an unexpected foreground process (${paneCommand})`, code: "awaiting_runtime" };
}
