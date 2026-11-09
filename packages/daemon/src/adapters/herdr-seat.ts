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
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { removeParentSessionEnv } from "../domain/parent-session-env.js";
import { addSeatRuntimeDir } from "../domain/seat-runtime-dir.js";
import { shellQuote } from "./shell-quote.js";
import { defaultTmuxFileOps, TmuxAdapter, type TmuxFileOps, type SessionProbe, type TmuxCursorPosition, type TmuxPane, type TmuxResult, type TmuxSession, type TmuxWindow } from "./tmux.js";
import type { ComposerSnapshot } from "../domain/composer-prompts.js";
import { createHerdrSocketRpc, HerdrRpcError, type HerdrResult, type HerdrSocketRpc } from "../domain/terminal/herdr-transport.js";

/** A refusal with a stated code, which classifyWriteError keeps (never read as absence). */
export class HerdrSeatError extends Error {
  constructor(readonly resultCode: "herdr_unsupported" | "transport_unavailable" | "guard_target_changed" | "guard_target_unknown" | "session_not_found" | "duplicate_session", message: string) {
    super(message);
    this.name = "HerdrSeatError";
  }
}

// Herdr ids are opaque and not always decimal (e.g. w3A:p2).
const HERDR_PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/** The session-environment names OpenRig reads back by value (seat-launch-environment, claude-managed-launch,
 *  pi-resume, restart-in-place, session-transport's reachability check). None is a secret. */
const READ_BACK_ENV = new Set([
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION", "OPENRIG_SEAT_ENV_KEYS",
  "CODEX_HOME", "OPENRIG_URL", "OPENRIG_PORT", "RIGGED_URL", "RIGGED_PORT", "RIGGED_RUNTIME",
]);

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
  now?: () => number;
  /** The staged-environment file writer (tests inject one). */
  fileOps?: TmuxFileOps;
}

/** tmux's default update-environment names: the scoped tmux launch carries these from the daemon too. */
const TMUX_DEFAULT_UPDATE_ENVIRONMENT = ["DISPLAY", "KRB5CCNAME", "SSH_ASKPASS", "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CONNECTION", "WINDOWID", "XAUTHORITY"];
/** What Herdr itself sets per pane; the scoped launch keeps these, as tmux's keeps TMUX, TMUX_PANE and TERM. */
const HERDR_PANE_ENV = ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "SHELL", "HERDR_ENV", "HERDR_BIN_PATH",
  "HERDR_SESSION", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_PANE_ID"];


export class HerdrSeatAdapter extends TmuxAdapter {
  private readonly rpcs = new Map<string, HerdrSocketRpc>();
  private counter = 0;
  /** Seats created by this adapter whose binding may not carry the Herdr ids yet. */
  private readonly created = new Map<string, { workspace: string; pane: string; socket: string }>();

  private readonly deps: HerdrSeatAdapterDeps;
  private readonly clock: () => number;

  constructor(deps: HerdrSeatAdapterDeps) {
    const refuse = async (cmd: string | string[]): Promise<string> => {
      const text = Array.isArray(cmd) ? cmd.join(" ") : cmd;
      throw new HerdrSeatError("herdr_unsupported", `This seat runs on Herdr, which has no equivalent of: ${text.slice(0, 120)}`);
    };
    super(refuse, undefined, refuse);
    this.deps = deps;
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

  /** Whether Herdr itself answered that the target doesn't exist (positive absence, not a transport failure). */
  private static notFound(error: unknown): boolean {
    return error instanceof HerdrRpcError && !!error.code && /not_found$/.test(error.code);
  }

  // --- Seat records -----------------------------------------------------------------------------

  /** The seat a target (session name or Herdr pane id) belongs to: its binding, else a seat this adapter created. */
  private seat(target: string): SeatRecord | null {
    const bare = target.replace(/^=/, "").replace(/:$/, "");
    const rows = this.deps.db.prepare(`
      SELECT b.tmux_session AS session, b.tmux_pane AS pane, b.herdr_workspace AS workspace, b.herdr_socket AS socket
      FROM bindings b JOIN nodes n ON n.id = b.node_id
      WHERE n.terminal_substrate = 'herdr' AND (b.tmux_session = ? OR b.tmux_pane = ?)
    `).all(bare, bare) as Array<{ session: string | null; pane: string | null; workspace: string | null; socket: string | null }>;
    // Pane ids are unique only per Herdr server: the same id bound on two endpoints names no seat (S4).
    if (rows.length > 1 && !rows.some(r => r.session === bare)) return null;
    const row = rows.find(r => r.session === bare) ?? rows[0];
    const made = row?.session ? this.created.get(row.session) : this.created.get(bare)
      ?? [...this.created.entries()].find(([, v]) => v.pane === bare)?.[1];
    if (row && row.session) {
      // Fill the Herdr ids into a binding the launcher wrote without them, from memory or the durable creation
      // record (F5); never from the current endpoint setting.
      const known = (!row.workspace || !row.socket) ? (made ?? this.durableSeat(row.session)) : null;
      if (known && known.workspace && known.socket) {
        this.deps.db.prepare("UPDATE bindings SET herdr_workspace = ?, herdr_socket = ? WHERE tmux_session = ? AND herdr_workspace IS NULL")
          .run(known.workspace, known.socket, row.session);
        return { session: row.session, pane: row.pane ?? known.pane, workspace: known.workspace, socket: known.socket };
      }
      return { session: row.session, pane: row.pane, workspace: row.workspace, socket: row.socket ?? this.deps.socketForNewSeats() };
    }
    const sessionName = this.created.has(bare) ? bare : [...this.created.entries()].find(([, v]) => v.pane === bare)?.[0];
    if (made && sessionName) return { session: sessionName, pane: made.pane, workspace: made.workspace, socket: made.socket };
    // The durable record written at creation (F5): a restart before the binding carries the ids still finds them.
    const durable = this.durableSeat(bare);
    if (durable) return durable;
    // A Herdr pane id that belongs to no known seat is never acted on: it could be the person's own workspace (F4).
    if (HERDR_PANE_ID.test(bare)) return null;
    return { session: bare, pane: null, workspace: null, socket: this.deps.socketForNewSeats() };
  }

  /** The ids written when this adapter created the seat (kind 'seat'), by session name or pane id. */
  private durableSeat(target: string): SeatRecord | null {
    const rows = this.deps.db.prepare(`SELECT session_name, key, value FROM herdr_session_meta WHERE kind = 'seat'
      AND session_name IN (SELECT session_name FROM herdr_session_meta WHERE kind = 'seat' AND (session_name = ? OR (key = 'pane' AND value = ?)))`)
      .all(target, target) as Array<{ session_name: string; key: string; value: string }>;
    if (rows.length === 0) return null;
    if (new Set(rows.map(r => r.session_name)).size > 1) return null; // ambiguous pane id across seats (S4)
    const get = (k: string) => rows.find(r => r.key === k)?.value ?? null;
    const socket = get("socket");
    if (!socket) return null;
    return { session: rows[0]!.session_name, pane: get("pane"), workspace: get("workspace"), socket };
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

  /** The panes of a workspace; empty when Herdr says the workspace is gone, throws on transport failure. */
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
    if (!seat) throw new HerdrSeatError("guard_target_unknown", `${target} is not a Herdr seat this daemon knows; nothing was done.`);
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
      // Binding columns first, then this process's memory, then the durable creation record (a restart before the
      // binding was backfilled), and only then the endpoint for new seats.
      const made = this.created.get(row.session);
      const durable = !row.workspace || !row.socket ? this.durableSeat(row.session) : null;
      const workspace = row.workspace ?? made?.workspace ?? durable?.workspace ?? undefined;
      const socket = row.socket ?? made?.socket ?? durable?.socket ?? this.deps.socketForNewSeats();
      if (!workspace) continue;
      if (!out.has(socket)) out.set(socket, new Map());
      out.get(socket)!.set(workspace, row.session);
    }
    return out;
  }

  /** Whether any Herdr seat is known to this DB or was created by this process (gates merged reads). */
  hasSeats(): boolean { return this.knownWorkspaces().size > 0 || this.created.size > 0; }

  // --- Server and sessions ------------------------------------------------------------------------

  override async startServer(): Promise<TmuxResult> {
    const socket = this.deps.socketForNewSeats();
    try { await this.call(socket, "ping", {}); return { ok: true }; }
    catch (error) { return { ok: false, code: "tmux_unavailable", message: `Herdr is not reachable at ${socket}: ${(error as Error).message}` }; }
  }

  /** present / absent / transport_unavailable for a seat's workspace; absent only on positive absence. */
  override async probeSession(name: string): Promise<SessionProbe> {
    const seat = this.seat(name);
    if (!seat) return { state: "absent" };
    try { return (await this.workspaceOf(seat)) ? { state: "present" } : { state: "absent" }; }
    catch (error) { return { state: "transport_unavailable", cause: (error as Error).message }; }
  }

  /** Whether the seat's workspace is present. */
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
    const sizes = shown.length > 0 ? await this.paneSizes(seat.socket, shown[0]!.pane_id) : new Map<string, { width: number; height: number }>();
    return shown.map((p, index) => ({ id: p.pane_id, index, cwd: p.cwd ?? "", width: sizes.get(p.pane_id)?.width ?? 0,
      height: sizes.get(p.pane_id)?.height ?? 0, active: p.focused ?? index === 0 }));
  }

  /** Pane sizes from Herdr's layout of the tab holding `pane` (cells). Best effort: an unreadable layout is 0x0. */
  private async paneSizes(socket: string, pane: string): Promise<Map<string, { width: number; height: number }>> {
    const out = new Map<string, { width: number; height: number }>();
    try {
      const layout = await this.call<Record<string, unknown>>(socket, "pane.layout", { pane_id: pane });
      const visit = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(visit); return; }
        const obj = node as Record<string, unknown>;
        const rect = obj["rect"] as { width?: unknown; height?: unknown } | undefined;
        if (typeof obj["pane_id"] === "string" && rect && typeof rect.width === "number" && typeof rect.height === "number") {
          out.set(obj["pane_id"], { width: rect.width, height: rect.height });
        }
        for (const value of Object.values(obj)) if (value && typeof value === "object") visit(value);
      };
      visit(layout);
    } catch { /* sizes stay unknown */ }
    return out;
  }

  /** One logical window per Herdr workspace, for callers that ask tmux for windows. */
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

  /** Shell pid and foreground command for every pane of the DB-known Herdr seats. */
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

  // --- Activity: a fingerprint of each pane's visible screen, stamped with the daemon's receive time (S1) ----
  //
  // Herdr 0.9.5 pushes no event for plain output (pane.updated stays quiet; agent_status_changed fires only for a
  // recognised agent), and a pane's `revision` does NOT advance on output (measured in the M4 sandbox). So a sample
  // reads each DB-known seat's visible screen and compares a hash with the previous one; a change records "now" as
  // that seat's last activity, as tmux's window_activity also counts any redraw. A seat whose endpoint can't be read
  // is left out of the map, which the activity poller reads as unknown, never idle or stale-active.

  private readonly fingerprints = new Map<string, string>();
  private readonly lastActivity = new Map<string, number>();
  private readonly agentStatuses = new Map<string, string>();

  /** Sample each DB-known seat's visible screen and update its last-activity time on a change. */
  private async sampleRevisions(): Promise<void> {
    const now = Math.floor(this.clock() / 1000);
    for (const [socket, workspaces] of this.knownWorkspaces()) {
      try {
        for (const [workspace, session] of workspaces) {
          const pane = this.seat(session)?.pane ?? (await this.panesOf(socket, workspace))[0]?.pane_id;
          if (!pane) { this.lastActivity.delete(session); continue; }
          let info: HerdrPaneInfo;
          let screen: string;
          try {
            info = (await this.call<{ pane: HerdrPaneInfo }>(socket, "pane.get", { pane_id: pane })).pane;
            const read = await this.call<Record<string, unknown>>(socket, "pane.read", { pane_id: pane, source: "visible", format: "text", strip_ansi: true });
            const body = (read["read"] ?? read) as Record<string, unknown>;
            screen = typeof body["text"] === "string" ? body["text"] : "";
          } catch (error) { if (HerdrSeatAdapter.notFound(error)) { this.lastActivity.delete(session); continue; } throw error; }
          if (info.agent_status) this.agentStatuses.set(session, info.agent_status);
          const print = createHash("sha1").update(screen).digest("hex");
          const seen = this.fingerprints.get(pane);
          this.fingerprints.set(pane, print);
          // A seat with no reading (first sight, or after an outage dropped it) gets a baseline, so a quiet seat reads
          // idle once the silence window passes instead of unknown forever (S1); a later screen change moves it.
          if (!this.lastActivity.has(session) || (seen !== undefined && seen !== print)) this.lastActivity.set(session, now);
        }
      } catch {
        // This endpoint is unreachable: its seats read unknown until it answers again.
        for (const session of workspaces.values()) this.lastActivity.delete(session);
      }
    }
  }

  /** Last-activity times (epoch seconds) for Herdr seats, from screen samples. */
  override async readAllSessionWindowActivity(): Promise<Map<string, number> | null> {
    await this.sampleRevisions();
    return new Map(this.lastActivity);
  }

  /** The same activity readings in the window-hint shape transcript rotation reads. */
  override async readAllSessionWindows(): Promise<Map<string, { activity: number; size: string }> | null> {
    await this.sampleRevisions();
    return new Map([...this.lastActivity].map(([session, activity]) => [session, { activity, size: "" }]));
  }

  /** The last sampled activity time for one seat, or null when there is no reading. */
  override async readPaneLastActivity(paneId: string): Promise<number | null> {
    const session = this.seat(paneId)?.session;
    return session ? this.lastActivity.get(session) ?? null : null;
  }

  /** Herdr's own last-read agent status for a seat (evidence only in the MVP; hooks still arbitrate). */
  lastAgentStatus(sessionName: string): string | null { return this.agentStatuses.get(sessionName) ?? null; }

  /** Create the seat's Herdr workspace, labelled with its session name, and record its ids and env. */
  override async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    if (this.deliveryGuard && (!env?.OPENRIG_NODE_ID || !this.deliveryGuard.ownsLifecycle(env.OPENRIG_NODE_ID))) {
      return { ok: false, code: "guard_lease_required", message: "Managed launch requires a lifecycle lease before terminal creation." };
    }
    const socket = this.deps.socketForNewSeats();
    try {
      const all = (await this.call<{ workspaces: HerdrWorkspaceInfo[] }>(socket, "workspace.list", {})).workspaces ?? [];
      if (all.some(w => w.label === name)) return { ok: false, code: "duplicate_session", message: `duplicate session: ${name} (a Herdr workspace already has this label)` };
      const seatEnv = { OPENRIG_TRANSCRIPTS_LINES: "", OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS: "", ...env };
      // Like a tmux seat, a managed seat must not inherit its terminal server's environment: the person's Herdr server
      // may carry another CLAUDE_CONFIG_DIR (another account, no trust records, none of the seat's conversations).
      const scoped = await this.scopedLaunch(seatEnv, cwd);
      // The staged file holds the seat's values (tokens included): remove it if the pane that would read it never starts.
      const discard = async () => { if (scoped) await (this.deps.fileOps ?? defaultTmuxFileOps()).unlink(scoped[4]!).catch(() => {}); };
      let created: { workspace: HerdrWorkspaceInfo; root_pane: HerdrPaneInfo };
      try {
        // With a scoped launch the root shell only lives until it is closed below: it gets none of the seat's values.
        created = await this.call<{ workspace: HerdrWorkspaceInfo; root_pane: HerdrPaneInfo }>(socket, "workspace.create",
          { label: name, ...(cwd ? { cwd } : {}), ...(scoped ? {} : { env: seatEnv }), focus: false });
      } catch (error) {
        await discard();
        throw error;
      }
      const workspace = created.workspace?.workspace_id ?? created.root_pane.workspace_id;
      let pane = created.root_pane.pane_id;
      if (scoped) {
        // workspace.create always starts the server's own shell; a layout pane runs our argv instead. Then the plain
        // root pane goes, leaving one tab with the scoped pane.
        try {
          const applied = await this.call<{ layout: { root?: { pane_id?: string } } }>(socket, "layout.apply",
            { workspace_id: workspace, tab_label: name, focus: false, root: { type: "pane", label: name, ...(cwd ? { cwd } : {}), command: scoped } });
          const scopedPane = applied.layout?.root?.pane_id;
          if (!scopedPane) throw new Error("Herdr did not report the seat's pane");
          await this.call(socket, "pane.close", { pane_id: pane });
          pane = scopedPane;
        } catch (error) {
          await discard();
          try { await this.call(socket, "workspace.close", { workspace_id: workspace }); } catch { /* reported below */ }
          return { ok: false, code: "session_not_created", message: `The seat's scoped Herdr pane could not be started, so its workspace was closed: ${(error as Error).message}` };
        }
      }
      try {
        this.created.set(name, { workspace, pane, socket });
        for (const [key, value] of Object.entries({ workspace, pane, socket })) this.writeMeta(name, "seat", key, value);
        // Only identity values OpenRig reads back are kept; any other variable (tokens, provider auth) is kept as
        // presence only, never its value (F3).
        for (const [key, value] of Object.entries(seatEnv)) {
          if (READ_BACK_ENV.has(key)) this.writeMeta(name, "env", key, value);
          else this.writeMeta(name, "env_present", key, value.trim() ? "1" : "0");
        }
        if (this.deliveryGuard && env?.OPENRIG_NODE_ID) {
          this.deliveryGuard.noteFreshLifecyclePane(env.OPENRIG_NODE_ID, pane);
          this.freshManaged.set(name, { nodeId: env.OPENRIG_NODE_ID, pane });
        }
      } catch (error) {
        // Don't leave the workspace this call made behind: the next launch would refuse it as a duplicate (S2).
        this.created.delete(name); this.freshManaged.delete(name);
        try { this.deps.db.prepare("DELETE FROM herdr_session_meta WHERE session_name = ?").run(name); } catch { /* best effort */ }
        try { await this.call(socket, "workspace.close", { workspace_id: workspace }); } catch { /* reported below */ }
        return { ok: false, code: "session_not_created", message: `The Herdr workspace was created, but recording it failed, so it was closed again: ${(error as Error).message}` };
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof HerdrSeatError) return { ok: false, code: error.resultCode, message: error.message };
      return { ok: false, code: "session_not_created", message: (error as Error).message };
    }
  }

  /** The argv that starts a managed seat's shell with the scoped environment a tmux seat gets (launchEnvironment, unless
   *  terminal.inherit_tmux_environment is on): the daemon's launch values plus the seat's own, from a 0600 file the
   *  shell removes, under env -i keeping only what Herdr sets per pane. Null keeps the server's environment (legacy).
   *  A failure to stage it refuses the launch: unlike tmux, a Herdr server is the person's own and may hold another
   *  account. */
  private async scopedLaunch(seatEnv: Record<string, string>, cwd?: string): Promise<string[] | null> {
    if (!this.launchEnvironment || !seatEnv["OPENRIG_NODE_ID"]) return null;
    const policy = this.launchEnvironment();
    if (policy.inheritTmuxEnvironment) return null;
    const baseline: Record<string, string | undefined> = {
      ...Object.fromEntries(TMUX_DEFAULT_UPDATE_ENVIRONMENT.map(key => [key, process.env[key]])), ...policy.env };
    removeParentSessionEnv(baseline);
    const selected: Record<string, string | undefined> = { ...baseline, ...seatEnv };
    addSeatRuntimeDir(selected, policy.runtimeDir);
    const exports = Object.entries(selected)
      .filter((entry): entry is [string, string] => entry[1] !== undefined && !HERDR_PANE_ENV.includes(entry[0]) && entry[0] !== "TMUX" && entry[0] !== "TMUX_PANE")
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new HerdrSeatError("transport_unavailable", "Invalid environment name");
        return `export ${key}=${shellQuote(value)}`;
      });
    const fileOps = this.deps.fileOps ?? defaultTmuxFileOps();
    const file = fileOps.tmpName();
    const cd = cwd ? `cd -- ${shellQuote(cwd)} || exit 1\n` : "";
    await fileOps.writeFile(file, `/bin/rm -f -- ${shellQuote(file)}\n${exports.join("\n")}\n${cd}exec "$@"\n`, { mode: 0o600, flag: "wx" });
    const keep = HERDR_PANE_ENV.map(key => `${key}="\${${key}-}"`).join(" ");
    const shell = (await this.getDefaultShell()) ?? "/bin/sh";
    return ["/bin/sh", "-c", `exec /usr/bin/env -i -- ${keep} /bin/sh "$@"`, "sh", file, shell, "-l"];
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

  /** Send tmux key names as Herdr logical keys (printable keys as text); unknown names are refused. */
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

  /** Map an error from a write to a TmuxResult, keeping stated codes and positive absence. */
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

  /** The last `lines` lines of the seat's pane, from Herdr's recent output. */
  override async capturePaneContent(paneId: string, lines = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }): Promise<string | null> {
    return this.read(paneId, opts?.joinWrappedLines ? "recent_unwrapped" : "recent", lines, opts?.escapeSequences === true);
  }

  /** The seat's currently visible screen. */
  override async capturePaneScreen(paneId: string, opts?: { escapeSequences?: boolean }): Promise<string | null> {
    return this.read(paneId, "visible", null, opts?.escapeSequences === true);
  }

  /** Up to 10,000 recent lines of the seat's pane. */
  override async capturePaneHistory(paneTarget: string): Promise<string | null> {
    return this.read(paneTarget, "recent", 10_000, false);
  }

  /** Recent history in the history/all shape; Herdr has no separate visible-only part. */
  override async capturePaneHistoryParts(paneTarget: string): Promise<{ history: string; all: string } | null> {
    const all = await this.read(paneTarget, "recent", 10_000, false);
    return all === null ? null : { history: all, all };
  }

  /** Batched capture: null sends callers to their per-pane fallback, which routes per seat. */
  override async capturePanesContent(): Promise<null> { return null; }

  /** Herdr reports no cursor position, so the composer can't be proven; callers treat null as unknown. */
  override async getPaneCursorPosition(): Promise<TmuxCursorPosition | null> { return null; }
  /** Always null: Herdr exposes no cursor position, so the composer can't be proven. */
  override async captureComposerSnapshot(): Promise<ComposerSnapshot | null> { return null; }

  /** Herdr's process info for a pane, or null when it can't be read. */
  private async processInfo(socket: string, pane: string): Promise<{ shell_pid?: number; foreground_processes?: Array<{ pid: number; name: string }> } | null> {
    try {
      return (await this.call<{ process_info: { shell_pid?: number; foreground_processes?: Array<{ pid: number; name: string }> } }>(socket, "pane.process_info", { pane_id: pane })).process_info;
    } catch { return null; }
  }

  /** The pane's shell pid. */
  override async getPanePid(paneId: string): Promise<number | null> {
    const found = await this.paneFor(paneId).catch(() => null);
    return found ? (await this.processInfo(found.socket, found.pane))?.shell_pid ?? null : null;
  }

  /** The name of the pane's foreground process. */
  override async getPaneCommand(paneId: string): Promise<string | null> {
    const found = await this.paneFor(paneId).catch(() => null);
    return found ? (await this.processInfo(found.socket, found.pane))?.foreground_processes?.at(-1)?.name ?? null : null;
  }

  /** Dead only on positive absence; an unreachable Herdr is not a dead pane (R2). */
  override async isPaneDead(paneId: string): Promise<boolean> {
    try { return (await this.paneFor(paneId)) === null; }
    catch (error) { return error instanceof HerdrSeatError && error.resultCode === "session_not_found"; }
  }

  /** Always false: Herdr panes have no tmux copy mode. */
  override async isPaneInMode(): Promise<boolean | null> { return false; }
  /** No-op: there is no copy mode to cancel. */
  override async cancelPaneMode(): Promise<TmuxResult> { return { ok: true }; }
  /** The daemon's shell, used where tmux would report its default-shell option. */
  override async getDefaultShell(): Promise<string | null> { return process.env["SHELL"] || "/bin/sh"; }
  /** No-op: Herdr owns its layout. */
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

  private writeMeta(session: string, kind: "env" | "env_present" | "option" | "seat", key: string, value: string): void {
    this.deps.db.prepare(`INSERT INTO herdr_session_meta (session_name, kind, key, value) VALUES (?, ?, ?, ?)
      ON CONFLICT (session_name, kind, key) DO UPDATE SET value = excluded.value,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).run(session, kind, key, value);
  }

  /** Read one stored session value (env, env presence, option or seat record). */
  private readMeta(session: string, kind: "env" | "env_present" | "option" | "seat", key: string): string | undefined {
    const row = this.deps.db.prepare("SELECT value FROM herdr_session_meta WHERE session_name = ? AND kind = ? AND key = ?")
      .get(session.replace(/^=/, ""), kind, key) as { value: string } | undefined;
    return row?.value;
  }

  /** A stored session-environment value; only identity values are stored by value. */
  override async getSessionEnv(session: string, key: string): Promise<string | undefined> { return this.readMeta(session, "env", key); }
  /** Store a session-environment value (identity keys by value, others as presence only). */
  override async setSessionEnv(session: string, key: string, value: string): Promise<void> {
    const s = session.replace(/^=/, "");
    if (READ_BACK_ENV.has(key)) this.writeMeta(s, "env", key, value);
    else this.writeMeta(s, "env_present", key, value.trim() ? "1" : "0");
  }
  /** Forget a session-environment value. */
  override async unsetSessionEnv(session: string, key: string): Promise<void> {
    this.deps.db.prepare("DELETE FROM herdr_session_meta WHERE session_name = ? AND kind IN ('env', 'env_present') AND key = ?").run(session.replace(/^=/, ""), key);
  }
  /** Whether a session-environment name has a non-blank value (by value or by presence). */
  override async hasSessionEnv(sessionName: string, varName: string): Promise<boolean | null> {
    const value = this.readMeta(sessionName, "env", varName);
    if (value !== undefined) return value.trim().length > 0;
    const present = this.readMeta(sessionName, "env_present", varName);
    return present === "1";
  }
  /** hasSessionEnv for several names. */
  override async hasSessionEnvBatch(sessionName: string, varNames: readonly string[]): Promise<Record<string, boolean | null>> {
    return Object.fromEntries(await Promise.all(varNames.map(async n => [n, await this.hasSessionEnv(sessionName, n)] as const)));
  }
  /** Store a session option (Herdr has no tmux options; kept in the DB). */
  override async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    this.writeMeta(sessionName.replace(/^=/, ""), "option", key, value);
    return { ok: true };
  }
  /** A stored session option, or null. */
  override async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    return this.readMeta(sessionName, "option", key) ?? null;
  }

  // --- Transcripts ---------------------------------------------------------------------------------
  // Seat transcripts on current main are bounded-trail rotation (transcript-rotation.ts), which reads the pane
  // through capturePaneContent and so works for Herdr seats through the router. pipe-pane is only the web terminal's
  // live stream (TerminalSessionBroker), a view outside the MVP: refused, so it never waits on a stream that won't come.
  override async startPipePane(): Promise<TmuxResult> { return this.unsupported("pipe-pane (the web terminal live view; open the seat in Herdr)"); }
  /** No-op: pipe-pane is never started on a Herdr seat. */
  override async stopPipePane(): Promise<TmuxResult> { return { ok: true }; }

  // --- Verbs Herdr has no counterpart for (explicit refusals, R1) ---------------------------------

  private unsupported(what: string): TmuxResult {
    return { ok: false, code: "herdr_unsupported", message: `This seat runs on Herdr, which has no ${what}; nothing was done.` };
  }
  /** Refused: Herdr has no respawn-pane, so restart-in-place isn't available. */
  override async respawnPane(): Promise<TmuxResult> { return this.unsupported("respawn-pane (restart in place)"); }
  /** Refused: Herdr has no remain-on-exit. */
  override async setRemainOnExit(): Promise<TmuxResult> { return this.unsupported("remain-on-exit"); }
  /** Refused: no pane signal through Herdr. */
  override async signalPaneProcess(): Promise<TmuxResult> { return this.unsupported("pane signal"); }
  /** Refused: runtime switch isn't supported on Herdr seats. */
  override async swapRuntimeSwitchPanes(): Promise<TmuxResult> { return this.unsupported("pane swap for a runtime switch"); }
  /** Refused: runtime switch isn't supported on Herdr seats. */
  override async adoptRuntimeSwitchStaging(): Promise<TmuxResult> { return this.unsupported("staging adoption for a runtime switch"); }
  /** Refused: runtime switch isn't supported on Herdr seats. */
  override async setRuntimeSwitchEnvironment(): Promise<TmuxResult> { return this.unsupported("runtime-switch environment"); }
  /** Refused: probe sessions stay on tmux. */
  override async createProbeSession(): Promise<TmuxResult> { return this.unsupported("probe session"); }
  /** Refused: Herdr has no tmux clients to switch. */
  override async switchClient(): Promise<TmuxResult> { return this.unsupported("switch-client"); }
  /** Refused: Herdr has no tmux window options. */
  override async setWindowOption(): Promise<TmuxResult> { return this.unsupported("window option"); }
  /** Refused: Herdr has no tmux window options. */
  override async restoreWindowOption(): Promise<TmuxResult> { return this.unsupported("window option"); }
  /** Refused: Herdr has no tmux pane options. */
  override async restorePaneOption(): Promise<TmuxResult> { return this.unsupported("pane option"); }
  /** Undefined: Herdr has no tmux window options. */
  override async getWindowLocalOption(): Promise<string | null | undefined> { return undefined; }
  /** Undefined: Herdr has no tmux pane options. */
  override async getPaneLocalOption(): Promise<string | null | undefined> { return undefined; }
  /** Null: Herdr has no tmux window user options. */
  override async readWindow(): Promise<{ id: string; userOption: string } | null> { return null; }
  /** Empty: Herdr has no tmux clients. */
  override async listClients(): Promise<[]> { return []; }
}
