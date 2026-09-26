// OpenCode runtime adapter (direct-CLI, no runner-in-a-pane shim).
//
// Unlike Pi (which needs the pane-hosted pi-runner to front `pi --mode rpc`),
// opencode exposes session resume/attach primitives directly on its CLI
// (verified against the installed `opencode --help`, v1.18.31):
//   - `opencode <project>` .......... fresh TUI seat in <project> (positional
//     `project` = "path to start opencode in")
//   - `opencode <project> --session <id>` ... exact session continuation
//     (never bare `--continue`, which resumes the LAST session — the
//     picker-equivalent, forbidden in managed paths, mirroring Pi's
//     never---resume rule)
//   - `opencode <project> --session <id> --fork` ... whole-session fork with
//     parent linkage (same spelling as `opencode run --fork` / attach --fork)
//   - `opencode serve` .............. headless server (NOT used here — the
//     managed seat is the TUI in the pane, same as every other adapter)
// so the adapter types `opencode` commands straight into the seat's tmux pane
// and reads back only opencode-authored surfaces — never TUI heuristics.
//
// Session identity: sessions live in the opencode.db sqlite store (`session`
// table: id `ses_*`, directory, time_created/time_updated ms). Fresh-launch
// capture reads that store cwd-scoped (a read, same posture as the
// claude-code status-line sidecar); resume/fork tokens are the `ses_*`
// session ids (`opencode_session_id`, id-shaped like codex/muse tokens).
//
// Trust posture: every managed launch carries an EXPLICIT posture segment
// from opencodePostureFlag (yolo-mode.ts) — YOLO / a per-seat resolved
// full_bypass selects ` --auto` (auto-approve permissions that are not
// explicitly denied — opencode marks it dangerous); otherwise the harness
// default floor applies (no flag, interactive approvals). The same decision
// runs on fresh / resume / fork so posture is uniform, never path-dependent.

import nodePath from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import type { TmuxAdapter } from "./tmux.js";
import { opencodePostureFlag } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, ProjectionResult, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeOpencodeApproval } from "../domain/permission-drift.js";
import { shellQuote } from "./shell-quote.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface OpencodeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

export interface OpencodeRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  fsOps: OpencodeAdapterFsOps;
  sleep?: (ms: number) => Promise<void>;
  /** Absolute path to the opencode.db sqlite store. Defaults to the
   *  XDG-resolved data dir (<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db,
   *  matching `opencode db path`). Tests inject. */
  opencodeDbPath?: string;
  /** Home dir for the default db-path resolution. Defaults to os.homedir(). */
  homedir?: string;
  /** Session-id reader override (cwd-scoped newest; tests inject; the default
   *  queries the opencode.db `session` table read-only and returns null on
   *  ANY failure — capture is best-effort, never a launch failure). */
  readLatestSessionId?: (cwd: string | null, minTimeCreatedMs?: number | null) => Promise<string | null>;
  /** Fork-candidate lister override (all ids created at/after a timestamp;
   *  tests inject; the default queries opencode.db read-only, [] on ANY
   *  failure). */
  listSessionIdsSince?: (cwd: string | null, minTimeCreatedMs: number) => Promise<string[]>;
}

// ── Pure command builders (single source of truth; hermetically tested) ──

export interface OpencodeLaunchOpts {
  cwd: string;
  model?: string;
  /** Already-resolved posture segment (leading space) or "". */
  postureArg: string;
}

/** Fresh seat command: `opencode '<cwd>' [--model '<m>'] [--auto]`. */
export function buildOpencodeFreshCommand(opts: OpencodeLaunchOpts): string {
  const parts = ["opencode", shellQuote(opts.cwd)];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  const posture = opts.postureArg.trim();
  if (posture) parts.push(posture);
  return parts.join(" ");
}

/** Resume command: `opencode '<cwd>' --session '<id>' [--model '<m>'] [--auto]`.
 *  Exact-id resume — never bare `--continue` (last-session picker). */
export function buildOpencodeResumeCommand(opts: OpencodeLaunchOpts & { sessionId: string }): string {
  const parts = ["opencode", shellQuote(opts.cwd), "--session", shellQuote(opts.sessionId)];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  const posture = opts.postureArg.trim();
  if (posture) parts.push(posture);
  return parts.join(" ");
}

/** Fork command: `opencode '<cwd>' --session '<parent>' --fork …` so opencode
 *  derives a child session; the NEW child id (never the parent's) is the
 *  resume token. */
export function buildOpencodeForkCommand(opts: OpencodeLaunchOpts & { parentId: string }): string {
  const parts = ["opencode", shellQuote(opts.cwd), "--session", shellQuote(opts.parentId), "--fork"];
  if (opts.model?.trim()) {
    parts.push("--model", shellQuote(opts.model.trim()));
  }
  const posture = opts.postureArg.trim();
  if (posture) parts.push(posture);
  return parts.join(" ");
}

/** Default opencode.db location: <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db. */
export function defaultOpencodeDbPath(homedir?: string): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim()
    || nodePath.join(homedir ?? os.homedir(), ".local", "share");
  return nodePath.join(dataHome, "opencode", "opencode.db");
}

/** Best-effort newest session id for a directory (or global latest when cwd
 *  is null) from the opencode.db `session` table. `minTimeCreatedMs`
 *  restricts to rows created at/after a launch timestamp: OpenCode may
 *  delay the session-row insert until the first prompt, so an unfiltered
 *  read right after launch can return a stale row (previous generation or
 *  pod-mate). Returns null on ANY failure (missing db, locked db, unknown
 *  schema) or when no row qualifies — capture must never fail or block its
 *  lifecycle op. */
export function queryLatestOpencodeSessionId(
  dbPath: string,
  cwd: string | null,
  minTimeCreatedMs?: number | null,
): string | null {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (cwd) {
        clauses.push("directory = ?");
        params.push(cwd);
      }
      if (typeof minTimeCreatedMs === "number") {
        clauses.push("time_created >= ?");
        params.push(minTimeCreatedMs);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const row = db.prepare(
        `SELECT id FROM session ${where} ORDER BY time_updated DESC LIMIT 1`,
      ).get(...params) as { id: string } | undefined;
      const id = row?.id?.trim() ?? "";
      return id.length > 0 ? id : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** All session ids for a directory created at/after a timestamp, newest
 *  first. The fork waiter uses the full list (not LIMIT 1) so ambiguity —
 *  two qualifying rows, e.g. a pod-mate's session created inside the fork
 *  window — resolves to null (loud unresolved) instead of silently
 *  accepting the wrong conversation. */
export function queryOpencodeSessionIdsSince(
  dbPath: string,
  cwd: string | null,
  minTimeCreatedMs: number,
): string[] {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const clauses: string[] = ["time_created >= ?"];
      const params: unknown[] = [minTimeCreatedMs];
      if (cwd) {
        clauses.push("directory = ?");
        params.push(cwd);
      }
      const rows = db.prepare(
        `SELECT id FROM session WHERE ${clauses.join(" AND ")} ORDER BY time_updated DESC`,
      ).all(...params) as Array<{ id: string }>;
      return rows.map((r) => r.id?.trim() ?? "").filter((id) => id.length > 0);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export class OpencodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "opencode";
  private tmux: TmuxAdapter;
  private fs: OpencodeAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private opencodeDbPath: string;
  private readLatestSessionId: (cwd: string | null, minTimeCreatedMs?: number | null) => Promise<string | null>;
  private listSessionIdsSince: (cwd: string | null, minTimeCreatedMs: number) => Promise<string[]>;

  constructor(deps: OpencodeRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.opencodeDbPath = deps.opencodeDbPath ?? defaultOpencodeDbPath(deps.homedir);
    const dbPath = this.opencodeDbPath;
    this.readLatestSessionId = deps.readLatestSessionId
      ?? (async (cwd, minTimeCreatedMs) => queryLatestOpencodeSessionId(dbPath, cwd, minTimeCreatedMs));
    this.listSessionIdsSince = deps.listSessionIdsSince
      ?? (async (cwd, minTimeCreatedMs) => queryOpencodeSessionIdsSince(dbPath, cwd, minTimeCreatedMs));
  }

  /** Session-id reader shape resume-token-capture consumes
   *  (deriveResumeToken's opencodeSessionStore dep). Seat-agnostic global
   *  latest — same posture as the Muse adapter's reader; the launch path
   *  and the metadata refresher prefer the cwd-scoped read below where the
   *  cwd is known. */
  async readSessionId(_sessionName: string): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    const id = await this.readLatestSessionId(null);
    if (!id) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId: id };
  }

  /** Cwd-scoped session-id read (opencode.db `session` rows key on
   *  directory) — seat-precise for multi-seat rigs sharing a HOME store.
   *  Consumed by the resume-metadata refresher, which knows each seat's
   *  cwd, and the launch/fork paths, which pass their start timestamp so
   *  only rows created at/after launch qualify. */
  async readSessionIdForCwd(cwd: string | null, minTimeCreatedMs?: number | null): Promise<{ ok: true; sessionId: string } | { ok: false; reason: string }> {
    const id = await this.readLatestSessionId(cwd, minTimeCreatedMs ?? null);
    if (!id) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionId: id };
  }

  async listInstalled(_binding: NodeBinding): Promise<InstalledResource[]> {
    // No seat-scoped opencode projection target at MVP (guidance merges into
    // the shared <cwd>/AGENTS.md, which opencode reads natively; plugin
    // install is operator-side `opencode plugin`) — honest empty inventory,
    // never a fabricated list.
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
            // No verified opencode skills target at MVP (unlike Muse's
            // .muse/skills) — an honest skip, never a misdelivery.
            console.log(
              `[openrig] skip: skill_install has no verified opencode target at MVP (path=${file.path})`,
            );
            continue;
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
      return { ok: false, error: "No tmux session bound — cannot launch the OpenCode harness" };
    }
    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }

    const postureArg = opencodePostureFlag(process.env, binding.launchPosture);
    const appliedLaunch = observeOpencodeApproval(postureArg);
    const sessionName = binding.tmuxSession;

    if (opts.forkSource) {
      if (opts.forkSource.kind !== "native_id") {
        return {
          ok: false,
          error: `opencode fork: ref.kind="${opts.forkSource.kind}" is not supported in v1; use ref.kind="native_id" with the parent opencode session id`,
        };
      }
      const parentId = opts.forkSource.value?.trim();
      if (!parentId) {
        return { ok: false, error: "opencode fork: forkSource.value is required (parent opencode session id)" };
      }
      // Validity floor before we type anything into the pane (same as resume).
      const parentValidation = validateResumeToken("opencode", parentId);
      if (!parentValidation.ok) {
        return { ok: false, error: `opencode fork: ${parentValidation.error}` };
      }
      const cmd = buildOpencodeForkCommand({
        parentId: parentValidation.token, cwd: binding.cwd, model: binding.model, postureArg,
      });
      // Fork timestamp BEFORE typing: the waiter below only accepts rows
      // created at/after this instant, so a pod-mate's newer pre-existing
      // row can never be mistaken for the fork child.
      const forkStartedAt = Date.now();
      const textResult = await this.tmux.sendText(sessionName, cmd);
      if (!textResult.ok) {
        return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
      }
      const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
      if (!enterResult.ok) {
        return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
      }
      const childId = await this.waitForNewSessionId(binding.cwd, parentValidation.token, forkStartedAt);
      if (!childId) {
        return { ok: false, error: "opencode fork: could not capture the new post-fork session id", recovery: "attention_required" };
      }
      return { ok: true, resumeToken: childId, resumeType: "opencode_session_id", appliedLaunch };
    }

    if (opts.resumeToken) {
      // Validity floor before we type anything into the pane.
      const validation = validateResumeToken("opencode", opts.resumeToken);
      if (!validation.ok) {
        return { ok: false, error: `opencode resume: ${validation.error}` };
      }
      const cmd = buildOpencodeResumeCommand({
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
      const verification = await this.verifyLaunch(sessionName, true);
      if (!verification.ok) return verification;
      return { ok: true, resumeToken: validation.token, resumeType: "opencode_session_id", appliedLaunch };
    }

    const cmd = buildOpencodeFreshCommand({ cwd: binding.cwd, model: binding.model, postureArg });
    // Launch timestamp BEFORE typing: the capture below only accepts rows
    // created at/after this instant, so a delayed row insert (first prompt)
    // can never resolve to a stale previous-generation or pod-mate session.
    const launchStartedAt = Date.now();
    const textResult = await this.tmux.sendText(sessionName, cmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }
    const enterResult = await this.tmux.sendKeys(sessionName, ["Enter"]);
    if (!enterResult.ok) {
      return { ok: false, error: `Failed to send Enter: ${enterResult.message}` };
    }
    const verification = await this.verifyLaunch(sessionName, false);
    if (!verification.ok) return verification;
    // Fresh-launch capture, cwd-scoped (the opencode.db `session` row keys
    // on directory, so this is seat-precise even for pod-mates sharing a
    // HOME store). A missed read leaves the token null (honest fresh
    // fallback at restore), never fabricated.
    const freshId = await this.readLatestSessionId(binding.cwd ?? null, launchStartedAt).catch(() => null);
    return {
      ok: true,
      appliedLaunch,
      ...(freshId ? { resumeToken: freshId, resumeType: "opencode_session_id" as const } : {}),
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
    return assessOpencodePane(paneCommand, paneContent);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      return this.mergeGuidance(targetPath, entry.effectiveId, content);
    }

    // Skills / plugins / subagents / runtime resources have no verified
    // opencode projection target at MVP (opencode reads AGENTS.md natively;
    // plugin install is operator-side `opencode plugin`) — an honest skip,
    // never a misdelivery.
    return false;
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string): boolean {
    // Mirrors the Claude/Codex/Pi/Muse adapters: per-seat `rig-role` content
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

  private async verifyLaunch(sessionName: string, isResume: boolean): Promise<HarnessLaunchResult> {
    const pollMs = 250;
    const attempts = 20; // ~5s: opencode boot into the seat pane
    for (let attempt = 0; attempt < attempts; attempt++) {
      const paneCommand = (await this.tmux.getPaneCommand(sessionName)) ?? "";
      const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
      const verdict = assessOpencodePane(paneCommand, paneContent);
      if (verdict.ready) return { ok: true };
      if (verdict.code === "no_saved_session" && isResume) {
        return {
          ok: false,
          error: "opencode resume: no saved session found for the requested id",
          recovery: "retry_fresh",
        };
      }
      if (verdict.code === "opencode_error" || verdict.code === "login_required") {
        return {
          ok: false,
          error: `opencode launch failed: ${verdict.reason}`,
          recovery: "attention_required",
          evidence: paneContent.split("\n").slice(-12).join("\n"),
        };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      error: "opencode launch: timed out waiting for OpenCode to become active",
      recovery: "attention_required",
    };
  }

  private async waitForNewSessionId(cwd: string, parentId: string, minTimeCreatedMs: number): Promise<string | null> {
    const pollMs = 250;
    const attempts = 20; // ~5s for the forked child to register in opencode.db
    for (let attempt = 0; attempt < attempts; attempt++) {
      const candidates = (await this.listSessionIdsSince(cwd, minTimeCreatedMs).catch(() => [] as string[]))
        .filter((id) => id !== parentId);
      // Ambiguity (a pod-mate's session created inside the fork window) is
      // a loud unresolved null — never a silent accept of the wrong
      // conversation. v1 fork children carry no parent linkage, so
      // exactly-one-candidate is the only safe accept.
      if (candidates.length > 1) return null;
      const latest = candidates[0];
      // The adapter contract requires the NEW post-fork token, never the parent's.
      if (latest) {
        const validation = validateResumeToken("opencode", latest);
        if (validation.ok) return validation.token;
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return null;
  }
}

/** Pane-state verdict for an OpenCode seat. Pure — shared by checkReady and
 *  the launch verifier so the two never disagree. */
export function assessOpencodePane(
  paneCommand: string,
  paneContent: string,
): ReadinessResult {
  const cmd = (paneCommand ?? "").trim().toLowerCase();
  const content = paneContent ?? "";
  // A dead resume id must win even inside a running TUI (the error renders
  // in-pane while `opencode` still owns it).
  if (/no (saved )?session found|unknown session|session (id )?not found|no such session/i.test(content)) {
    return { ready: false, reason: "OpenCode reports no saved session for the requested id", code: "no_saved_session" };
  }
  const runtimeOwnsPane = cmd === "opencode" || cmd.startsWith("opencode ");
  // A running runtime is up even when agent output contains error-like text
  // (test runs print "exit code 1", tracebacks, ...): the generic markers
  // below apply only when the runtime does NOT own the pane. Narrow auth
  // phrases still count while it does — an auth-dead TUI is not operable.
  if (runtimeOwnsPane) {
    if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
      return { ready: false, reason: "OpenCode reports missing or expired authentication", code: "login_required" };
    }
    return { ready: true };
  }
  if (/login required|not authenticated|authentication (failed|required)|please run `?opencode (auth|login)`?/i.test(content)) {
    return { ready: false, reason: "OpenCode reports missing or expired authentication", code: "login_required" };
  }
  if (/\[opencode\] error|opencode: (error|failed)|exit(ed)?( with)? code \d+|traceback/i.test(content)) {
    return { ready: false, reason: "OpenCode reported an error in the pane", code: "opencode_error" };
  }
  if (SHELL_COMMANDS.has(cmd)) {
    return { ready: false, reason: "OpenCode has not started yet (pane is at a shell)", code: "awaiting_runtime" };
  }
  if (cmd.length === 0) {
    return { ready: false, reason: "OpenCode has not started yet", code: "awaiting_runtime" };
  }
  return { ready: false, reason: `OpenCode pane is running an unexpected foreground process (${paneCommand})`, code: "awaiting_runtime" };
}
