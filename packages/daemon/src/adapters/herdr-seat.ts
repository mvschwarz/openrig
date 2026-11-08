// The Herdr seat adapter: runs a seat's pane in a Herdr workspace instead of a tmux session.
//
// Herdr is AGPL. As with upstream's views adapter (domain/terminal/herdr-adapter.ts), OpenRig integrates it at arm's
// length: JSON over the local control socket of the person's installed Herdr (domain/terminal/herdr-transport.ts),
// never importing, linking or vendoring Herdr code.
//
// It subclasses TmuxAdapter so every guarded write path (delivery guard, leases, draft checks, shell-command staging)
// stays single-sourced in the base class; only the terminal primitives are replaced. A tmux verb with no Herdr
// counterpart is refused with `herdr_unsupported`, never with an absence code (R1).
//
// Identity (R4): a seat is its stored Herdr workspace id and pane id (bindings.herdr_workspace, bindings.tmux_pane).
// The workspace label (the seat's session name) is display, checked before acting. Endpoint (R3, D3): the socket a
// seat was created on is stored in bindings.herdr_socket and used for every later call; new seats use the
// `terminal.herdr_socket` setting. HERDR_SOCKET_PATH / HERDR_SESSION are never read here.
import type Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TmuxAdapter, type SessionProbe, type TmuxCursorPosition, type TmuxPane, type TmuxResult, type TmuxSession, type TmuxWindow } from "./tmux.js";
import type { ComposerSnapshot } from "../domain/composer-prompts.js";
import { createHerdrSocketRpc, HerdrRpcError, type HerdrResult, type HerdrSocketRpc } from "../domain/terminal/herdr-transport.js";

/** A refusal with a stated code, which classifyWriteError keeps (never read as absence). */
export class HerdrSeatError extends Error {
  constructor(readonly resultCode: "herdr_unsupported" | "transport_unavailable" | "guard_target_changed" | "session_not_found" | "duplicate_session", message: string) {
    super(message);
    this.name = "HerdrSeatError";
  }
}

const HERDR_PANE_ID = /^w\d+:p\d+$/;
/** tmux key names the daemon sends, as Herdr's logical keys. */
const KEY_MAP: Record<string, string> = {
  Enter: "enter", "C-m": "enter", Escape: "esc", "C-c": "ctrl+c", "C-u": "ctrl+u", "C-d": "ctrl+d", "C-l": "ctrl+l",
  "C-a": "ctrl+a", "C-e": "ctrl+e", "C-k": "ctrl+k", "C-w": "ctrl+w", "C-z": "ctrl+z", BSpace: "backspace", Tab: "tab",
  BTab: "shift+tab", Up: "up", Down: "down", Left: "left", Right: "right", Space: "space", Home: "home", End: "end",
  PageUp: "pageup", PageDown: "pagedown", PPage: "pageup", NPage: "pagedown",
};

interface SeatRecord { session: string; pane: string | null; workspace: string | null; socket: string }
interface HerdrPaneInfo { pane_id: string; workspace_id: string; cwd?: string; focused?: boolean; agent_status?: string; revision?: number }
interface HerdrWorkspaceInfo { workspace_id: string; label?: string; pane_count?: number }

/** Herdr's default-session socket under the daemon's own config home, never an inherited HERDR_* variable. */
export function defaultHerdrSeatSocket(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"] ? path.resolve(env["XDG_CONFIG_HOME"]) : path.join(env["HOME"] || os.homedir(), ".config");
  return path.join(configHome, "herdr", "herdr.sock");
}

export interface HerdrSeatAdapterDeps {
  db: Database.Database;
  /** The endpoint for NEW seats (setting terminal.herdr_socket, else defaultHerdrSeatSocket()). */
  socketForNewSeats: () => string;
  rpcFor?: (socketPath: string) => HerdrSocketRpc;
  timeoutMs?: number;
  /** Transcript capture cadence; 0 disables the timer (tests call captureTranscripts directly). */
  transcriptIntervalMs?: number;
  appendFile?: (file: string, text: string) => void;
  readFile?: (file: string) => string;
  now?: () => number;
}

/** The longest k such that the last k lines of `prev` are the first k lines of `next`. */
export function overlap(prev: readonly string[], next: readonly string[]): number {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    let same = true;
    for (let i = 0; i < k; i++) if (prev[prev.length - k + i] !== next[i]) { same = false; break; }
    if (same) return k;
  }
  return 0;
}

export class HerdrSeatAdapter extends TmuxAdapter {
  private readonly rpcs = new Map<string, HerdrSocketRpc>();
  private counter = 0;
  /** Seats created by this adapter whose binding may not carry the Herdr ids yet. */
  private readonly created = new Map<string, { workspace: string; pane: string; socket: string }>();

  private readonly deps: Required<Pick<HerdrSeatAdapterDeps, "appendFile" | "readFile">> & HerdrSeatAdapterDeps;
  private readonly clock: () => number;

  constructor(deps: HerdrSeatAdapterDeps) {
    const refuse = async (cmd: string | string[]): Promise<string> => {
      const text = Array.isArray(cmd) ? cmd.join(" ") : cmd;
      throw new HerdrSeatError("herdr_unsupported", `This seat runs on Herdr, which has no equivalent of: ${text.slice(0, 120)}`);
    };
    super(refuse, undefined, refuse);
    this.deps = {
      ...deps,
      appendFile: deps.appendFile ?? ((file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, text); }),
      readFile: deps.readFile ?? ((file) => fs.readFileSync(file, "utf8")),
    };
    this.clock = deps.now ?? (() => Date.now());
  }

  // --- Transport --------------------------------------------------------------------------------

  private rpc(socket: string): HerdrSocketRpc {
    let rpc = this.rpcs.get(socket);
    if (!rpc) {
      rpc = this.deps.rpcFor ? this.deps.rpcFor(socket) : createHerdrSocketRpc(socket, this.deps.timeoutMs ?? 5000);
      this.rpcs.set(socket, rpc);
    }
    return rpc;
  }

  /** One request. Herdr's own errors stay HerdrRpcError; anything else is transport_unavailable. */
  private async call<T = HerdrResult>(socket: string, method: string, params: unknown): Promise<T> {
    try {
      return await this.rpc(socket)({ id: `openrig-seat-${(this.counter += 1)}`, method, params }) as T;
    } catch (error) {
      if (error instanceof HerdrRpcError) throw error;
      throw new HerdrSeatError("transport_unavailable", `Herdr at ${socket} is not reachable: ${(error as Error).message}`);
    }
  }

  private static notFound(error: unknown): boolean {
    return error instanceof HerdrRpcError && !!error.code && /not_found$/.test(error.code);
  }

  // --- Seat records -----------------------------------------------------------------------------

  /** The seat a target (session name or Herdr pane id) belongs to: its binding, else a seat this adapter created. */
  private seat(target: string): SeatRecord | null {
    const bare = target.replace(/^=/, "").replace(/:$/, "");
    const row = this.deps.db.prepare(`
      SELECT b.tmux_session AS session, b.tmux_pane AS pane, b.herdr_workspace AS workspace, b.herdr_socket AS socket
      FROM bindings b JOIN nodes n ON n.id = b.node_id
      WHERE n.terminal_substrate = 'herdr' AND (b.tmux_session = ? OR b.tmux_pane = ?)
      LIMIT 1
    `).get(bare, bare) as { session: string | null; pane: string | null; workspace: string | null; socket: string | null } | undefined;
    const made = row?.session ? this.created.get(row.session) : this.created.get(bare)
      ?? [...this.created.entries()].find(([, v]) => v.pane === bare)?.[1];
    if (row && row.session) {
      // Fill the Herdr ids into a binding the launcher wrote without them.
      if ((!row.workspace || !row.socket) && made) {
        this.deps.db.prepare("UPDATE bindings SET herdr_workspace = ?, herdr_socket = ? WHERE tmux_session = ? AND herdr_workspace IS NULL")
          .run(made.workspace, made.socket, row.session);
        return { session: row.session, pane: row.pane ?? made.pane, workspace: made.workspace, socket: made.socket };
      }
      return { session: row.session, pane: row.pane, workspace: row.workspace, socket: row.socket ?? this.deps.socketForNewSeats() };
    }
    const sessionName = this.created.has(bare) ? bare : [...this.created.entries()].find(([, v]) => v.pane === bare)?.[0];
    if (made && sessionName) return { session: sessionName, pane: made.pane, workspace: made.workspace, socket: made.socket };
    if (HERDR_PANE_ID.test(bare)) return { session: bare, pane: bare, workspace: bare.split(":")[0]!, socket: this.deps.socketForNewSeats() };
    return { session: bare, pane: null, workspace: null, socket: this.deps.socketForNewSeats() };
  }

  /** The seat's workspace, checked to still be the seat's (R4/D3). null on positive absence. */
  private async workspaceOf(seat: SeatRecord): Promise<HerdrWorkspaceInfo | null> {
    if (seat.workspace) {
      try {
        const ws = (await this.call<{ workspace: HerdrWorkspaceInfo }>(seat.socket, "workspace.get", { workspace_id: seat.workspace })).workspace;
        if (HERDR_PANE_ID.test(seat.session) || ws.label === seat.session) return ws;
        // Herdr doesn't reuse ids, so another label means the seat's workspace is gone.
        return null;
      } catch (error) {
        if (HerdrSeatAdapter.notFound(error)) return null;
        throw error;
      }
    }
    const all = (await this.call<{ workspaces: HerdrWorkspaceInfo[] }>(seat.socket, "workspace.list", {})).workspaces ?? [];
    const matches = all.filter(w => w.label === seat.session);
    if (matches.length > 1) throw new HerdrSeatError("guard_target_changed", `${matches.length} Herdr workspaces are labelled "${seat.session}"; nothing was done.`);
    return matches[0] ?? null;
  }

  private async panesOf(socket: string, workspaceId: string): Promise<HerdrPaneInfo[]> {
    try {
      return (await this.call<{ panes: HerdrPaneInfo[] }>(socket, "pane.list", { workspace_id: workspaceId })).panes ?? [];
    } catch (error) {
      if (HerdrSeatAdapter.notFound(error)) return [];
      throw error;
    }
  }

  /** The pane to write to or read from, after checking it is still in the seat's workspace. */
  private async paneFor(target: string): Promise<{ socket: string; pane: string } | null> {
    const seat = this.seat(target);
    if (!seat) return null;
    const ws = await this.workspaceOf(seat);
    if (!ws) return null;
    const panes = await this.panesOf(seat.socket, ws.workspace_id);
    const wanted = seat.pane ?? (HERDR_PANE_ID.test(target.replace(/^=/, "")) ? target.replace(/^=/, "") : null);
    const pane = wanted ? panes.find(p => p.pane_id === wanted) : panes.length === 1 ? panes[0] : undefined;
    if (!pane) {
      if (wanted && panes.length > 0) throw new HerdrSeatError("guard_target_changed", `Pane ${wanted} is no longer in the seat's Herdr workspace; nothing was done.`);
      if (!wanted && panes.length > 1) throw new HerdrSeatError("guard_target_changed", `The seat's Herdr workspace has ${panes.length} panes and no recorded pane; nothing was done.`);
      return null;
    }
    return { socket: seat.socket, pane: pane.pane_id };
  }

  /** The Herdr workspaces that belong to seats in this DB, by endpoint. Whole-server reads never go wider (D4). */
  private knownWorkspaces(): Map<string, Map<string, string>> {
    const rows = this.deps.db.prepare(`
      SELECT b.tmux_session AS session, b.herdr_workspace AS workspace, b.herdr_socket AS socket
      FROM bindings b JOIN nodes n ON n.id = b.node_id
      WHERE n.terminal_substrate = 'herdr' AND b.tmux_session IS NOT NULL
    `).all() as Array<{ session: string; workspace: string | null; socket: string | null }>;
    const out = new Map<string, Map<string, string>>();
    for (const row of rows) {
      const made = this.created.get(row.session);
      const workspace = row.workspace ?? made?.workspace;
      const socket = row.socket ?? made?.socket ?? this.deps.socketForNewSeats();
      if (!workspace) continue;
      if (!out.has(socket)) out.set(socket, new Map());
      out.get(socket)!.set(workspace, row.session);
    }
    return out;
  }

  hasSeats(): boolean { return this.knownWorkspaces().size > 0 || this.created.size > 0; }

  // --- Server and sessions ------------------------------------------------------------------------

  override async startServer(): Promise<TmuxResult> {
    const socket = this.deps.socketForNewSeats();
    try { await this.call(socket, "ping", {}); return { ok: true }; }
    catch (error) { return { ok: false, code: "tmux_unavailable", message: `Herdr is not reachable at ${socket}: ${(error as Error).message}` }; }
  }

  override async probeSession(name: string): Promise<SessionProbe> {
    const seat = this.seat(name);
    if (!seat) return { state: "absent" };
    try { return (await this.workspaceOf(seat)) ? { state: "present" } : { state: "absent" }; }
    catch (error) { return { state: "transport_unavailable", cause: (error as Error).message }; }
  }

  override async hasSession(name: string): Promise<boolean> {
    return (await this.probeSession(name)).state === "present";
  }

  /** Throws on transport failure (R2): an unreachable Herdr is not an empty one. */
  override async listPanes(target: string): Promise<TmuxPane[]> {
    const seat = this.seat(target);
    if (!seat) return [];
    const ws = await this.workspaceOf(seat);
    if (!ws) return [];
    const panes = await this.panesOf(seat.socket, ws.workspace_id);
    const bare = target.replace(/^=/, "").replace(/:$/, "");
    const shown = HERDR_PANE_ID.test(bare) ? panes.filter(p => p.pane_id === bare) : panes;
    return shown.map((p, index) => ({ id: p.pane_id, index, cwd: p.cwd ?? "", width: 0, height: 0, active: p.focused ?? index === 0 }));
  }

  override async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    const seat = this.seat(sessionName);
    const ws = seat ? await this.workspaceOf(seat) : null;
    return ws ? [{ index: 0, name: sessionName, panes: ws.pane_count ?? 1, active: true }] : [];
  }

  /** The Herdr seats known to this DB, per endpoint. A seat whose endpoint can't be reached makes the read fail. */
  override async listSessions(): Promise<TmuxSession[]> {
    const out: TmuxSession[] = [];
    for (const [socket, workspaces] of this.knownWorkspaces()) {
      const live = (await this.call<{ workspaces: HerdrWorkspaceInfo[] }>(socket, "workspace.list", {})).workspaces ?? [];
      for (const ws of live) {
        const session = workspaces.get(ws.workspace_id);
        if (session && ws.label === session) out.push({ name: session, windows: 1, created: "", attached: false });
      }
    }
    return out;
  }

  override async readAllPaneProcesses(): Promise<Map<string, { pid: number | null; command: string | null; dead?: boolean }> | null> {
    const out = new Map<string, { pid: number | null; command: string | null }>();
    for (const [socket, workspaces] of this.knownWorkspaces()) {
      for (const workspace of workspaces.keys()) {
        for (const pane of await this.panesOf(socket, workspace)) {
          const info = await this.processInfo(socket, pane.pane_id);
          out.set(pane.pane_id, { pid: info?.shell_pid ?? null, command: info?.foreground_processes?.at(-1)?.name ?? null });
        }
      }
    }
    return out;
  }

  // --- Activity: each pane's output revision, stamped with the daemon's receive time (S1) ----------
  //
  // Herdr pushes no event for plain output (pane.updated stays quiet; agent_status_changed only fires for a
  // recognised agent), but every pane carries a revision that advances on output. A sample reads each DB-known
  // seat's pane; a changed revision records "now" as that seat's last activity. A seat whose endpoint can't be read
  // is left out of the map, which the activity poller reads as unknown, never idle or stale-active.

  private readonly revisions = new Map<string, number>();
  private readonly lastActivity = new Map<string, number>();
  private readonly agentStatuses = new Map<string, string>();

  private async sampleRevisions(): Promise<void> {
    const now = Math.floor(this.clock() / 1000);
    for (const [socket, workspaces] of this.knownWorkspaces()) {
      try {
        for (const [workspace, session] of workspaces) {
          const pane = this.seat(session)?.pane ?? (await this.panesOf(socket, workspace))[0]?.pane_id;
          if (!pane) { this.lastActivity.delete(session); continue; }
          let info: HerdrPaneInfo;
          try { info = (await this.call<{ pane: HerdrPaneInfo }>(socket, "pane.get", { pane_id: pane })).pane; }
          catch (error) { if (HerdrSeatAdapter.notFound(error)) { this.lastActivity.delete(session); continue; } throw error; }
          if (info.agent_status) this.agentStatuses.set(session, info.agent_status);
          const rev = typeof info.revision === "number" ? info.revision : null;
          if (rev === null) continue;
          const seen = this.revisions.get(pane);
          this.revisions.set(pane, rev);
          if (seen !== undefined && seen !== rev) this.lastActivity.set(session, now);
        }
      } catch {
        // This endpoint is unreachable: its seats read unknown until it answers again.
        for (const session of workspaces.values()) this.lastActivity.delete(session);
      }
    }
  }

  override async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    await this.sampleRevisions();
    return new Map(this.lastActivity);
  }

  override async readAllSessionWindows(): Promise<Map<string, { activity: number; size: string }> | null> {
    await this.sampleRevisions();
    return new Map([...this.lastActivity].map(([session, activity]) => [session, { activity, size: "" }]));
  }

  override async readPaneLastActivity(paneId: string): Promise<number | null> {
    const session = this.seat(paneId)?.session;
    return session ? this.lastActivity.get(session) ?? null : null;
  }

  /** Herdr's own last-read agent status for a seat (evidence only in the MVP; hooks still arbitrate). */
  lastAgentStatus(sessionName: string): string | null { return this.agentStatuses.get(sessionName) ?? null; }

  override async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const socket = this.deps.socketForNewSeats();
    try {
      const all = (await this.call<{ workspaces: HerdrWorkspaceInfo[] }>(socket, "workspace.list", {})).workspaces ?? [];
      if (all.some(w => w.label === name)) return { ok: false, code: "duplicate_session", message: `duplicate session: ${name} (a Herdr workspace already has this label)` };
      const seatEnv = { OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", ...env };
      const created = await this.call<{ workspace: HerdrWorkspaceInfo; root_pane: HerdrPaneInfo }>(socket, "workspace.create",
        { label: name, ...(cwd ? { cwd } : {}), env: seatEnv, focus: false });
      const workspace = created.workspace?.workspace_id ?? created.root_pane.workspace_id;
      const pane = created.root_pane.pane_id;
      this.created.set(name, { workspace, pane, socket });
      for (const [key, value] of Object.entries(seatEnv)) this.writeMeta(name, "env", key, value);
      if (this.deliveryGuard && env?.OPENRIG_NODE_ID) {
        this.deliveryGuard.noteFreshLifecyclePane(env.OPENRIG_NODE_ID, pane);
        this.freshManaged.set(name, { nodeId: env.OPENRIG_NODE_ID, pane });
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof HerdrSeatError) return { ok: false, code: error.resultCode, message: error.message };
      return { ok: false, code: "session_not_created", message: (error as Error).message };
    }
  }

  override async killSession(name: string, beforeEffect?: () => void): Promise<TmuxResult> {
    const kill = async (): Promise<TmuxResult> => {
      const seat = this.seat(name);
      if (!seat) return { ok: false, code: "session_not_found", message: `can't find session: ${name}` };
      let ws: HerdrWorkspaceInfo | null;
      try { ws = await this.workspaceOf(seat); }
      catch (error) { return { ok: false, code: error instanceof HerdrSeatError ? error.resultCode : "transport_unavailable", message: (error as Error).message, stopPhase: "none" }; }
      if (!ws) return { ok: false, code: "session_not_found", message: `can't find session: ${name}`, stopPhase: "none" };
      beforeEffect?.();
      try {
        await this.call(seat.socket, "workspace.close", { workspace_id: ws.workspace_id });
      } catch (error) {
        if (HerdrSeatAdapter.notFound(error)) return { ok: false, code: "session_not_found", message: (error as Error).message, stopPhase: "kill_attempted" };
        return { ok: false, code: error instanceof HerdrSeatError ? error.resultCode : "kill_failed", message: (error as Error).message, stopPhase: "kill_attempted" };
      }
      this.created.delete(name); this.freshManaged.delete(name);
      this.deps.db.prepare("DELETE FROM herdr_session_meta WHERE session_name = ?").run(name);
      return { ok: true, stopPhase: "kill_attempted" };
    };
    if (!this.deliveryGuard) return kill();
    try { return await this.deliveryGuard.input(this.freshManaged.get(name)?.nodeId ?? name, kill); }
    catch (error) { return { ok: false, code: (error as { code?: string }).code ?? "guard_target_unknown", message: (error as Error).message }; }
  }

  // --- Input (the base class's guarded paths call these) ------------------------------------------

  protected override async sendTextUnchecked(target: string, text: string, beforeWrite: () => void, bracketed = true,
    policy?: { beforePaste: () => Promise<void>; afterPaste: () => Promise<void> }): Promise<TmuxResult> {
    try {
      const found = await this.paneFor(target);
      if (!found) return { ok: false, code: "session_not_found", message: `can't find pane: ${target}` };
      if (policy) await policy.beforePaste();
      beforeWrite();
      // Herdr doesn't report a pane's paste mode, so bracketed sends are always framed (documented limit).
      await this.call(found.socket, "pane.send_text", { pane_id: found.pane, text: bracketed ? `\u001b[200~${text}\u001b[201~` : text });
      if (policy) await policy.afterPaste();
      return { ok: true };
    } catch (error) {
      return this.writeRefusal(error);
    }
  }

  protected override async sendKeysUnchecked(target: string, keys: string[]): Promise<TmuxResult> {
    const mapped: Array<{ key: string } | { text: string }> = [];
    for (const key of keys) {
      if (KEY_MAP[key]) mapped.push({ key: KEY_MAP[key]! });
      else if (/^[\x20-\x7e]$/.test(key)) mapped.push({ text: key });
      else return { ok: false, code: "herdr_unsupported", message: `The tmux key "${key}" has no Herdr equivalent; nothing was sent.` };
    }
    try {
      const found = await this.paneFor(target);
      if (!found) return { ok: false, code: "session_not_found", message: `can't find pane: ${target}` };
      for (const step of mapped) {
        if ("key" in step) await this.call(found.socket, "pane.send_keys", { pane_id: found.pane, keys: [step.key] });
        else await this.call(found.socket, "pane.send_text", { pane_id: found.pane, text: step.text });
      }
      return { ok: true };
    } catch (error) {
      return this.writeRefusal(error);
    }
  }

  private writeRefusal(error: unknown): TmuxResult {
    if (error instanceof HerdrSeatError) return { ok: false, code: error.resultCode, message: error.message };
    if (HerdrSeatAdapter.notFound(error)) return { ok: false, code: "session_not_found", message: (error as Error).message };
    return { ok: false, code: "unknown", message: (error as Error).message };
  }

  // --- Reading -----------------------------------------------------------------------------------

  private async read(target: string, source: "visible" | "recent" | "recent_unwrapped", lines: number | null, ansi: boolean): Promise<string | null> {
    try {
      const found = await this.paneFor(target);
      if (!found) return null;
      const result = await this.call<Record<string, unknown>>(found.socket, "pane.read",
        { pane_id: found.pane, source, ...(lines !== null ? { lines } : {}), format: ansi ? "ansi" : "text", strip_ansi: !ansi });
      const read = (result["read"] ?? result) as Record<string, unknown>;
      const text = read["text"] ?? read["content"] ?? read["output"];
      return typeof text === "string" && text ? text : null;
    } catch {
      return null;
    }
  }

  override async capturePaneContent(paneId: string, lines = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> {
    return this.read(paneId, opts?.joinWrappedLines ? "recent_unwrapped" : "recent", lines, opts?.escapeSequences === true);
  }

  override async capturePaneScreen(paneId: string, opts?: { escapeSequences?: boolean }): Promise<string | null> {
    return this.read(paneId, "visible", null, opts?.escapeSequences === true);
  }

  override async capturePaneHistory(paneTarget: string): Promise<string | null> {
    return this.read(paneTarget, "recent", 10_000, false);
  }

  override async capturePaneHistoryParts(paneTarget: string): Promise<{ history: string; all: string } | null> {
    const all = await this.read(paneTarget, "recent", 10_000, false);
    return all === null ? null : { history: all, all };
  }

  /** Batched capture: null sends callers to their per-pane fallback, which routes per seat. */
  override async capturePanesContent(): Promise<null> { return null; }

  /** Herdr reports no cursor position, so the composer can't be proven; callers treat null as unknown. */
  override async getPaneCursorPosition(): Promise<TmuxCursorPosition | null> { return null; }
  override async captureComposerSnapshot(): Promise<ComposerSnapshot | null> { return null; }

  private async processInfo(socket: string, pane: string): Promise<{ shell_pid?: number; foreground_processes?: Array<{ pid: number; name: string }> } | null> {
    try {
      return (await this.call<{ process_info: { shell_pid?: number; foreground_processes?: Array<{ pid: number; name: string }> } }>(socket, "pane.process_info", { pane_id: pane })).process_info;
    } catch { return null; }
  }

  override async getPanePid(paneId: string): Promise<number | null> {
    const found = await this.paneFor(paneId).catch(() => null);
    return found ? (await this.processInfo(found.socket, found.pane))?.shell_pid ?? null : null;
  }

  override async getPaneCommand(paneId: string): Promise<string | null> {
    const found = await this.paneFor(paneId).catch(() => null);
    return found ? (await this.processInfo(found.socket, found.pane))?.foreground_processes?.at(-1)?.name ?? null : null;
  }

  /** Dead only on positive absence; an unreachable Herdr is not a dead pane (R2). */
  override async isPaneDead(paneId: string): Promise<boolean> {
    try { return (await this.paneFor(paneId)) === null; }
    catch (error) { return error instanceof HerdrSeatError && error.resultCode === "session_not_found"; }
  }

  override async isPaneInMode(): Promise<boolean | null> { return false; }
  override async cancelPaneMode(): Promise<TmuxResult> { return { ok: true }; }
  override async getDefaultShell(): Promise<string | null> { return process.env["SHELL"] || "/bin/sh"; }
  override async resizeWindow(): Promise<TmuxResult> { return { ok: true }; }

  /** Herdr's own lifecycle reading for the agent in a seat's pane (idle | working | blocked | done | unknown). */
  async agentStatus(sessionName: string): Promise<string | null> {
    try {
      const found = await this.paneFor(sessionName);
      if (!found) return null;
      return (await this.call<{ pane: HerdrPaneInfo }>(found.socket, "pane.get", { pane_id: found.pane })).pane.agent_status ?? null;
    } catch { return null; }
  }

  // --- Session environment and options (DB-backed: herdr_session_meta) -------------------------

  private writeMeta(session: string, kind: "env" | "option", key: string, value: string): void {
    this.deps.db.prepare(`INSERT INTO herdr_session_meta (session_name, kind, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_name, kind, key) DO UPDATE SET value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(session, kind, key, value);
  }

  private readMeta(session: string, kind: "env" | "option", key: string): string | undefined {
    const row = this.deps.db.prepare("SELECT value FROM herdr_session_meta WHERE session_name = ? AND kind = ? AND key = ?")
      .get(session.replace(/^=/, ""), kind, key) as { value: string } | undefined;
    return row?.value;
  }

  override async getSessionEnv(session: string, key: string): Promise<string | undefined> { return this.readMeta(session, "env", key); }
  override async setSessionEnv(session: string, key: string, value: string): Promise<void> { this.writeMeta(session.replace(/^=/, ""), "env", key, value); }
  override async unsetSessionEnv(session: string, key: string): Promise<void> {
    this.deps.db.prepare("DELETE FROM herdr_session_meta WHERE session_name = ? AND kind = 'env' AND key = ?").run(session.replace(/^=/, ""), key);
  }
  override async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    const value = this.readMeta(sessionName, "env", varName);
    return value === undefined ? false : value.trim().length > 0;
  }
  override async hasSessionEnvBatch(sessionName: string, varNames: readonly string[]): Promise<Record<string, boolean | null>> {
    return Object.fromEntries(await Promise.all(varNames.map(async n => [n, await this.hasSessionEnv(sessionName, n)] as const)));
  }
  override async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    this.writeMeta(sessionName.replace(/^=/, ""), "option", key, value);
    return { ok: true };
  }
  override async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    return this.readMeta(sessionName, "option", key) ?? null;
  }

  // --- Transcripts: read on each revision change (Herdr has no pipe-pane) --------------------------
  //
  // Degraded by design: a read returns the last TRANSCRIPT_LINES lines, so output that scrolls past more than that
  // between two reads is lost. Only complete lines are written (the last line of a read can still change), and a
  // read is joined to what was written by its longest overlap, so a repeated read appends nothing.

  private static readonly TRANSCRIPT_OPTION = "openrig.transcript_path";
  private static readonly TRANSCRIPT_LINES = 400;
  private transcriptTimer: ReturnType<typeof setInterval> | null = null;
  private readonly transcriptTail = new Map<string, string[]>();
  private readonly transcriptRevision = new Map<string, number>();

  override async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    const session = sessionName.replace(/^=/, "").replace(/:$/, "");
    this.writeMeta(session, "option", HerdrSeatAdapter.TRANSCRIPT_OPTION, outputPath);
    this.ensureTranscriptTimer();
    return { ok: true, warnings: ["Herdr has no pipe-pane: this seat's transcript is captured by reading its pane on each output change, and can miss lines under fast scrolling."] };
  }

  override async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const session = sessionName.replace(/^=/, "").replace(/:$/, "");
    this.deps.db.prepare("DELETE FROM herdr_session_meta WHERE session_name = ? AND kind = 'option' AND key = ?").run(session, HerdrSeatAdapter.TRANSCRIPT_OPTION);
    this.transcriptTail.delete(session); this.transcriptRevision.delete(session);
    return { ok: true };
  }

  /** Start capturing for seats registered before a daemon restart. Called by the daemon once at boot. */
  resumeTranscripts(): void {
    const any = this.deps.db.prepare("SELECT 1 FROM herdr_session_meta WHERE kind = 'option' AND key = ? LIMIT 1").get(HerdrSeatAdapter.TRANSCRIPT_OPTION);
    if (any) this.ensureTranscriptTimer();
  }

  private ensureTranscriptTimer(): void {
    if (this.transcriptTimer || this.deps.transcriptIntervalMs === 0) return;
    this.transcriptTimer = setInterval(() => { void this.captureTranscripts(); }, this.deps.transcriptIntervalMs ?? 2000);
    this.transcriptTimer.unref?.();
  }

  stopTranscripts(): void {
    if (this.transcriptTimer) clearInterval(this.transcriptTimer);
    this.transcriptTimer = null;
  }

  /** One capture pass over every seat with a transcript path. Exposed for tests. */
  async captureTranscripts(): Promise<void> {
    const rows = this.deps.db.prepare("SELECT session_name, value FROM herdr_session_meta WHERE kind = 'option' AND key = ?")
      .all(HerdrSeatAdapter.TRANSCRIPT_OPTION) as Array<{ session_name: string; value: string }>;
    for (const { session_name: session, value: file } of rows) {
      try {
        const found = await this.paneFor(session);
        if (!found) continue;
        const info = (await this.call<{ pane: HerdrPaneInfo }>(found.socket, "pane.get", { pane_id: found.pane })).pane;
        if (typeof info.revision === "number" && this.transcriptRevision.get(session) === info.revision) continue;
        const text = await this.read(session, "recent_unwrapped", HerdrSeatAdapter.TRANSCRIPT_LINES, false);
        if (typeof info.revision === "number") this.transcriptRevision.set(session, info.revision);
        if (text === null) continue;
        const complete = text.split("\n");
        complete.pop(); // the last line may still change
        const prev = this.transcriptTail.get(session) ?? this.readFileTail(file, HerdrSeatAdapter.TRANSCRIPT_LINES);
        const fresh = complete.slice(overlap(prev, complete));
        if (fresh.length > 0) this.deps.appendFile(file, fresh.join("\n") + "\n");
        this.transcriptTail.set(session, [...prev, ...fresh].slice(-HerdrSeatAdapter.TRANSCRIPT_LINES));
      } catch {
        /* this seat is unreachable now; try again on the next pass */
      }
    }
  }

  private readFileTail(file: string, lines: number): string[] {
    try {
      const all = this.deps.readFile(file).split("\n");
      if (all.at(-1) === "") all.pop();
      return all.slice(-lines);
    } catch { return []; }
  }

  // --- Verbs Herdr has no counterpart for (explicit refusals, R1) ---------------------------------

  private unsupported(what: string): TmuxResult {
    return { ok: false, code: "herdr_unsupported", message: `This seat runs on Herdr, which has no ${what}; nothing was done.` };
  }
  override async respawnPane(): Promise<TmuxResult> { return this.unsupported("respawn-pane (restart in place)"); }
  override async setRemainOnExit(): Promise<TmuxResult> { return this.unsupported("remain-on-exit"); }
  override async signalPaneProcess(): Promise<TmuxResult> { return this.unsupported("pane signal"); }
  override async swapRuntimeSwitchPanes(): Promise<TmuxResult> { return this.unsupported("pane swap for a runtime switch"); }
  override async adoptRuntimeSwitchStaging(): Promise<TmuxResult> { return this.unsupported("staging adoption for a runtime switch"); }
  override async setRuntimeSwitchEnvironment(): Promise<TmuxResult> { return this.unsupported("runtime-switch environment"); }
  override async createProbeSession(): Promise<TmuxResult> { return this.unsupported("probe session"); }
  override async switchClient(): Promise<TmuxResult> { return this.unsupported("switch-client"); }
  override async setWindowOption(): Promise<TmuxResult> { return this.unsupported("window option"); }
  override async restoreWindowOption(): Promise<TmuxResult> { return this.unsupported("window option"); }
  override async restorePaneOption(): Promise<TmuxResult> { return this.unsupported("pane option"); }
  override async getWindowLocalOption(): Promise<string | null | undefined> { return undefined; }
  override async getPaneLocalOption(): Promise<string | null | undefined> { return undefined; }
  override async readWindow(): Promise<{ id: string; userOption: string } | null> { return null; }
  override async listClients(): Promise<[]> { return []; }
}
