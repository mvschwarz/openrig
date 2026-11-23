import type { ScopeViewError } from "./scope-task-terminal-view.js";
import { pinnedTileAttachArgv, tileAttachArgv } from "./tile-attach.js";
import { shellQuote } from "../../adapters/shell-quote.js";
import { parseTmuxViewerProof, TMUX_VIEWER_PROOF_OPTION, tmuxViewerCloseArgs, TMUX_VIEWER_OPTION_SNAPSHOT, TMUX_VIEWER_KEPT } from "./tmux-viewer-guard.js";
import type { ViewerKey, ViewerResult } from "./herdr-viewer.js";
import { TerminalFollowing, type FollowingSelector } from "./terminal-following.js";
import type { FollowControls } from "./terminal-follow-policy.js";
import type { EventBus } from "../event-bus.js";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
// OPR.0.4.6.02 C3 — the TerminalService orchestrator.
//
// ONE daemon-side composer for EVERY view kind (arch R1 / guard b1): the
// canonical route and the CLI both call this, so there is never a second
// composition path. It resolves a view ARGUMENT into composer-ready members,
// composes them into a provider-neutral `ComposedView` (the pure `composeView`
// owns the local/ssh/http/read-only partition rules), and hands that to the
// chosen `TerminalProvider`. It adds no pixel logic and no provider-specific
// branching — the provider paints, the composer partitions, this service only
// RESOLVES + ROUTES.
//
// View argument resolution (precedence):
//   1. `mission:<id>` / `slice:<id>`  → current active obligation owners;
//      READ-ONLY by construction (a cross-rig observational grouping —
//      AC-3 "another rig's agents ... read-only"). Never persisted (A3).
//   2. a rig NAME                      → per-rig derived, LIVE from the node
//      inventory; INTERACTIVE (you asked for that rig, you drive it — AC-1c).
//   3. a saved-view id                 → from `terminal-views.yaml`; per-member
//      read-only as the operator saved it.
//   Anything else → a named `view_not_found` (never a silent empty open).
//
// The read-only policy above is a v1 build decision grounded in AC-1c/AC-3
// (interactive rig view vs read-only cross-rig/derived view); it is NAMED here
// for the guard/QA gates, not silently absorbed. Saved views carry their own
// per-member read-only, so an operator can save an interactive multi-rig view
// deliberately.
//
// The one shared result shape is `OpenViewResult { opened, absent, degraded }`
// (arch Q3): this service returns it for resolution failures too (view/provider
// not found), so the route JSON and the CLI JSON carry ONE contract for every
// outcome.

import type { TaskTerminalView, TaskMembership } from "./task-terminal-view.js";
import { composeView, type ViewMemberInput } from "./view-composer.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { buildGridRoot, HerdrAdapter } from "./herdr-adapter.js";
import { daemonTmuxServerArgs, daemonTmuxServerInfo } from "../../adapters/tmux-server.js";
import { execArgvCommand } from "../../adapters/tmux-exec.js";
import {
  RigViewerLedger,
  rigViewerRecordKey,
  tmuxEndpointKey,
  type HerdrRigViewerRecord,
  type RigViewerEndpointTx,
  type RigViewerRecord,
  CorruptRigViewerLedgerError,
  sameIdSet,
} from "./rig-viewer-records.js";
import type { TmuxServerSelection } from "../tmux-server-selection.js";
// deriveViewMembers is a VALUE exported by the views store (not the composer).
import { deriveViewMembers } from "./terminal-views-store.js";
import type {
  LiveSeatRow,
  SavedView,
  SavedViewMember,
  TerminalViewsStore,
} from "./terminal-views-store.js";
import type { HostEntry } from "../hosts/hosts-registry-reader.js";
import type {
  AbsentSeat,
  DegradedSeat,
  OpenViewResult,
  ComposedView,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
  ViewDescriptor,
} from "./terminal-provider.js";

/** The provider name set (herdr = proof-gated primary; cmux = best-effort; rex = by name or from a Rex caller;
 *  herdr-app = Rig-layout views in a herdr-app client, by name only). */
export type TerminalProviderName = "herdr" | "cmux" | "rex" | "herdr-app";
export const DEFAULT_PROVIDER: TerminalProviderName = "herdr";
/** The order an omitted provider is chosen in: herdr if it's there, otherwise cmux. Rex is never chosen here. */
const DEFAULT_PROVIDER_ORDER: readonly TerminalProviderName[] = ["herdr", "cmux"];

export interface OpenViewRequest {
  /** Provider name. With no session, omission selects the first available, live provider: herdr, then cmux. */
  provider?: string;
  /** An explicit provider session; omission retains the daemon's configured endpoint. */
  session?: string;
  /** A rig, mission:<id>, slice:<id>, qitem:<id> local episode, or saved view. */
  view: string;
  /** Preview fingerprint. A changed membership/layout must be previewed again. */
  expectedPlan?: string;
  /** Measured width of the viewing terminal; unknown widths keep the narrow default. */
  viewportColumns?: number;
  /** Reuse a workspace that still shows this view live instead of opening a copy (herdr). */
  reuseLive?: boolean;
  /** The herdr-app client (its app home) for provider herdr-app. */
  herdrApp?: HerdrAppTarget;
  /** True only when previewing a rig for bulk `--all` open (partitions stopped/unbound/remote). */
  bulk?: boolean;
}

export interface HerdrAppTarget { appHome?: string }

export interface TerminalPreview {
  provider: string;
  session?: string;
  tmux?: TmuxServerSelection;
  view: string;
  planId: string;
  rigViewer?: boolean;
  composed: ComposedView;
  /** Seats skipped in bulk rig preview (e.g. non-local host). */
  skipped?: SkippedSeat[];
  /** The same pure grid roots consumed by the Herder adapter. */
  grids: ReturnType<typeof buildGridRoot>[];
  status: ProviderStatus;
  task?: TaskMembership;
  capabilities: { ensureViewer: boolean };
  viewDescriptor?: ViewDescriptor;
  /** The composed view's remote tiles with their hosts; complete, so empty means every opened seat is local. */
  remote: Array<{ seat: string; host: string }>;
}

/** The `rig terminal views` payload: saved views + the live rig names you can open. */
export interface ListViewsResult {
  following?: ReturnType<TerminalFollowing["list"]>;
  saved: SavedView[];
  /** Rig names openable as per-rig derived views (live from the inventory). */
  rigs: string[];
  /** Stable local identities. Names remain above for existing clients. */
  rigIdentities: Array<{ id: string; name: string }>;
  catalog?: Array<{ view: string; name: string; kind: "saved" | "derived"; members: string[]; ready: number; absent: number; degraded: number; pages: number }>;
}

/** One provider's doctor line for `rig terminal status`. */
export interface ProviderStatusReport {
  name: string;
  status: ProviderStatus;
  liveness: ProviderLiveness;
}

export interface TerminalStatusResult {
  following?: ReturnType<TerminalFollowing["list"]>;
  providers: ProviderStatusReport[];
  tmux?: TmuxServerSelection;
  session?: string;
  error?: string;
  code?: string;
}

export interface OpenAllRequest {
  provider?: string;
  session?: string;
  viewportColumns?: number;
  /** Focus a workspace that still shows a rig's view live instead of opening a copy. On by default: open all opens
   *  what's absent and focuses what's there, so a repeat adds no views and no tmux clients. `false` opens copies. */
  reuseLive?: boolean;
  herdrApp?: HerdrAppTarget;
}

export interface SkippedSeat {
  seat: string;
  reason: string;
}

export interface OpenAllRigResult {
  rig: string;
  rigId?: string;
  view: string;
  outcome: "opened" | "reused" | "absent" | "skipped" | "failed";
  opened: string[];
  absent: AbsentSeat[];
  degraded: DegradedSeat[];
  skipped: SkippedSeat[];
  workspaceId?: string;
  code?: string;
  error?: string;
  notes?: string[];
  cleanup?: "closed" | "already_gone" | "unknown";
}

export interface OpenAllResult {
  ok: boolean;
  provider: string;
  session?: string;
  rigs: OpenAllRigResult[];
  code?: string;
  error?: string;
  notes?: string[];
}

export interface CloseAllRequest {
  provider?: string;
  session?: string;
}

export interface CloseAllViewerResult {
  view: string;
  provider: "herdr" | "tmux";
  target: string;
  outcome: "closed" | "already_gone" | "kept" | "failed";
  reason?: string;
  code?: string;
}

export interface CloseAllResult {
  ok: boolean;
  viewers: CloseAllViewerResult[];
  code?: string;
  error?: string;
  notes?: string[];
}

export type BulkSeatRow = LiveSeatRow & { host?: string | null };

export interface TerminalServiceDeps {
  eventBus?: Pick<EventBus, "subscribe">;
  followingStatePath?: string;
  /** Resolve a provider name to its adapter, or null for an unknown name. */
  resolveProvider(name: string): TerminalProvider | null;
  /** Resolve an explicit session without altering the default provider instance. */
  resolveSessionProvider?(name: string, session: string): TerminalProvider | null;
  /** Daemon shutdown: stops herdr-app's own watcher and timers. */
  stopHerdrApp?(): void;
  /** The herdr-app provider for one client (app home); null when this daemon can't serve herdr-app. */
  resolveHerdrAppProvider?(target: HerdrAppTarget): (TerminalProvider & { closeView(viewId: string): Promise<OpenViewResult>; appHome: string }) | null;
  /** The saved-views store (read paths only from this service). */
  viewsStore: Pick<TerminalViewsStore, "get" | "list">;
  /** Resolve an exact rig ID first, then a legacy name; null means unknown. */
  listRigSeats(rigIdOrName: string): Promise<BulkSeatRow[] | null> | BulkSeatRow[] | null;
  /** One request-local inventory fold for the derived catalog entries. */
  listRigSeatsBatch?(rigNames: string[]): Promise<Map<string, BulkSeatRow[]>> | Map<string, BulkSeatRow[]>;
  /** Live seats of a pod within a rig (by rig name-or-id + pod namespace); null when the rig/pod is unknown. */
  listPodSeats(rigArg: string, podNamespace: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** Exact local queue episode; unavailable owners must remain in task.members. */
  resolveTaskView?(qitemId: string): Promise<TaskTerminalView | null> | TaskTerminalView | null;
  /** Authoritative scoped work in this daemon's configured index context. */
  resolveScopeView?(view: string): Promise<TaskTerminalView | ScopeViewError> | TaskTerminalView | ScopeViewError;
  /** Drop generation-cached scope identities on the same source event as following. */
  invalidateScopeView?(): void;
  /** Known rig names (for the `views` listing). */
  listRigNames(): Promise<string[]> | string[];
  listRigs?(): Promise<Array<{ id: string; name: string }>> | Array<{ id: string; name: string }>;
  /** Read-only host resolution for the composer (registry unavailable → null for every id). */
  resolveHost(id: string): HostEntry | null;
  /** Local liveness refine — has-session for a local tmux session; remote members are not probed here. */
  hasSession(tmuxSession: string): Promise<boolean> | boolean;
  /**
   * The tmux executable the daemon itself resolves, for local pane commands (#707). Only an
   * absolute path is used; anything else, or no resolver, keeps the bare `tmux` token.
   */
  resolveLocalTmux?(): Promise<string | null> | string | null;
  /** Directory storing `<sha256(endpoint)>.json` rig-viewer ownership ledgers. Omit for isolated memory in tests. */
  rigViewersDir?: string;
  /** Injectable tmux command runner on the daemon's tmux server (used for close --all and tests). */
  tmuxExec?(args: string[]): Promise<string>;
  /** Injectable daemon tmux server args (default: `daemonTmuxServerArgs()`). */
  tmuxServerArgs?(): readonly string[];
}

/** The opened seats on another host, from the composed tiles: the complete list, so empty means all local. */
function remoteOpened(composed: ComposedView, opened?: readonly string[]): Array<{ seat: string; host: string }> {
  return composed.opened.flatMap(pane => pane.host && (!opened || opened.includes(pane.seat)) ? [{ seat: pane.seat, host: pane.host }] : []);
}

/** Build the one shared result shape for a pre-provider failure (view/provider not found). */
function errorResult(provider: string, code: string, error: string): OpenViewResult {
  return { provider, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code };
}

/** Map a persisted saved-view member to a composer input (defaults filled; alive refined later). */
function savedMemberToInput(m: SavedViewMember): ViewMemberInput {
  return {
    seat: m.seat,
    label: m.label ?? m.seat,
    // A local saved member without an explicit tmuxSession falls back to the
    // seat's canonical name (the common local seat == session case); a wrong
    // guess simply lands the seat in absent[] at compose time (honest).
    tmuxSession: m.tmuxSession ?? m.seat,
    host: m.host ?? null,
    readOnly: m.readOnly === true,
    // Refined by refineLiveness for local members; remote members are routed by
    // the composer regardless (ssh reachability is not a has-session concern).
    alive: true,
  };
}

const BULK_UNSUPPORTED_PROVIDERS = new Set(["herdr-app", "cmux", "rex"]);

function normalizeTerminalSession(raw: unknown): { ok: true; session: string } | { ok: false; code: "invalid_terminal_session"; error: string } {
  const session = typeof raw === "string" ? raw.trim() : "";
  if (!session || session === "." || session === ".." || /[\\/\x00-\x1f\x7f]/.test(session)) {
    return { ok: false, code: "invalid_terminal_session", error: "session must be one non-empty session name, not a socket path." };
  }
  return { ok: true, session };
}

function bulkSeatName(row: BulkSeatRow): string {
  if (row.canonicalSessionName && row.canonicalSessionName.trim()) return row.canonicalSessionName.trim();
  if (row.logicalId && row.rigName) {
    return `${row.logicalId}@${row.rigName}`;
  }
  return row.logicalId || "unknown";
}

function manualHerdrViewerClose(endpoint: string, workspaceId: string): string {
  const socket = endpoint.startsWith("herdr:") ? endpoint.slice(6) : "";
  if (!isAbsolute(socket) || /[\x00-\x1f\x7f]/.test(socket)
    || !workspaceId || workspaceId.startsWith("-") || /[\x00-\x1f\x7f]/.test(workspaceId)) {
    return "The exact endpoint or workspace identity cannot be qualified for a manual command. Inspect the workspace in its original endpoint.";
  }
  return `After inspecting the workspace, close it manually: env -u HERDR_SESSION -u HERDR_ENV -u HERDR_SOCKET_PATH -u OPENRIG_HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)} herdr workspace close ${shellQuote(workspaceId)}`;
}

function partitionRigRowsForBulk(rows: BulkSeatRow[]): {
  tmuxRows: LiveSeatRow[];
  absent: AbsentSeat[];
  skipped: SkippedSeat[];
} {
  const tmuxRows: LiveSeatRow[] = [];
  const absent: AbsentSeat[] = [];
  const skipped: SkippedSeat[] = [];
  for (const row of rows) {
    const seat = bulkSeatName(row);
    if (row.host != null) {
      skipped.push({ seat, reason: `remote host (${row.host})` });
      continue;
    }
    if (row.attachmentType !== "tmux" || !row.canonicalSessionName || !row.canonicalSessionName.trim()) {
      const reason = row.attachmentType === "external_cli"
        ? "external_cli attachment"
        : "no active tmux binding: stopped or unbound";
      absent.push({ seat, host: null, reason });
      continue;
    }
    tmuxRows.push(row);
  }
  return { tmuxRows, absent, skipped };
}

function isTmuxNoServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission denied|operation not permitted|eacces|eperm/i.test(msg)) return false;
  return /\bno server running\b|\bno current target\b|failed to connect to server: (?:no such file|connection refused)|error connecting to [^\r\n]+ \(No such file or directory\)/i.test(msg);
}

interface TmuxInventorySession { sessionId: string; sessionName: string; windowIds: string[]; paneIds: string[] }

async function readTmuxInventory(runTmux: (args: string[]) => Promise<string>): Promise<Map<string, TmuxInventorySession>> {
  const byId = new Map<string, TmuxInventorySession>();
  let sessOut = "";
  try {
    sessOut = await runTmux(["list-sessions", "-F", "#{session_id}|#{session_name}"]);
  } catch (err) {
    if (isTmuxNoServerError(err)) return byId;
    throw err;
  }
  for (const line of sessOut.trim().split("\n")) {
    if (!line.trim()) continue;
    const sep = line.indexOf("|");
    if (sep <= 0) continue;
    const sessionId = line.slice(0, sep);
    const sessionName = line.slice(sep + 1);
    byId.set(sessionId, { sessionId, sessionName, windowIds: [], paneIds: [] });
  }
  if (byId.size === 0) return byId;
  const winOut = await runTmux(["list-windows", "-a", "-F", "#{session_id}|#{window_id}"]);
  for (const line of winOut.trim().split("\n")) {
    if (!line.trim()) continue;
    const [sessionId = "", windowId = ""] = line.split("|");
    if (windowId) byId.get(sessionId)?.windowIds.push(windowId);
  }
  const paneOut = await runTmux(["list-panes", "-a", "-F", "#{session_id}|#{pane_id}"]);
  for (const line of paneOut.trim().split("\n")) {
    if (!line.trim()) continue;
    const [sessionId = "", paneId = ""] = line.split("|");
    if (paneId) byId.get(sessionId)?.paneIds.push(paneId);
  }
  return byId;
}

/** The default kernel view's space name in a terminal multiplexer such as Herdr. */
export const KERNEL_SPACE_LABEL = "openrig kernel";

type ResolvedView = { id: string; rigName?: string; rigViewer?: boolean; members: ViewMemberInput[]; kernelLayout?: string; columns?: number; panesPerPage?: number; task?: TaskMembership } | { code: string; error: string };
type ComposedTerminalView = ComposedView & { kernelLayout?: string };
type TileProvider = Pick<TerminalProvider, "panesPerPage" | "pinsWritableSeats">;

export class TerminalService {
  private localTmux?: Promise<string | undefined>;
  private following?: TerminalFollowing;
  private readonly rigViewers: RigViewerLedger;

  private unsubscribeScope?: () => void;
  constructor(private readonly deps: TerminalServiceDeps) {
    this.rigViewers = new RigViewerLedger(deps.rigViewersDir);
    if (deps.invalidateScopeView) this.unsubscribeScope = deps.eventBus?.subscribe(event => {
      if (event.type === "scope.sources_changed") deps.invalidateScopeView?.();
    });
    if (deps.eventBus) this.following = new TerminalFollowing(
      deps.followingStatePath ?? getDefaultOpenRigPath("private/terminal-following/selectors.json"), deps.eventBus,
      (selector, controls) => this.renderFollowing(selector, controls));
  }

  async stop(): Promise<void> { this.unsubscribeScope?.(); this.deps.stopHerdrApp?.(); await this.following?.stop(); }

  async followView(req: OpenViewRequest & FollowControls): Promise<OpenViewResult> {
    if (!this.following) return errorResult("herdr", "follow_unavailable", "This daemon has no event-driven terminal following service.");
    if (!/^(qitem|slice|mission):.+/.test(req.view)) return errorResult("herdr", "follow_view_required", "Follow requires an authoritative qitem:<id>, slice:<id-or-name> or mission:<id> view.");
    if (/^(slice|mission):/.test(req.view) && !this.deps.resolveScopeView) return errorResult("herdr", "scope_unsupported", "This daemon has no authoritative scoped membership resolver.");
    const selected = this.selectProvider({ ...req, provider: req.provider ?? "herdr" });
    if ("ok" in selected) return selected;
    if (selected.name !== "herdr" || !selected.provider.followView) return errorResult(selected.name, "follow_unsupported", "Follow is supported by the qualified Herdr provider only.");
    if (/^(slice|mission):/.test(req.view) || req.expectedPlan !== undefined) {
      const composed = await this.resolveComposed(req.view, selected.provider);
      if ("code" in composed) return errorResult(selected.name, composed.code, composed.error);
      if (req.expectedPlan !== undefined && req.expectedPlan !== this.planId(selected.name, composed, selected.session)) return errorResult(selected.name, "preview_changed", "Task membership changed since preview; refresh before enabling following.");
    }
    const { enabled, maxTiles, graceMs, focusRetentionMs, pin, unpin, suppress, unsuppress, suppressionMs } = req;
    const result = await this.following.open({ view: req.view, provider: "herdr", ...(selected.session !== undefined ? { session: selected.session } : {}) },
      { enabled, maxTiles, graceMs, focusRetentionMs, pin, unpin, suppress, unsuppress, suppressionMs });
    if (result.code !== "follow_unsupported" || result.following?.enabled !== false) return result;
    // The selector is durably retired BEFORE a one-shot snapshot is dispatched.
    // A lost reply or restart must not make Core events repeat the open.
    const composed = await this.resolveComposed(req.view, selected.provider);
    if ("code" in composed || !composed.task?.complete) return { ...result,
      error: `${result.error ?? "Live following is unsupported."} No snapshot opened: ${"code" in composed ? composed.error : "task membership is incomplete."}` };
    if (req.expectedPlan !== undefined && req.expectedPlan !== this.planId(selected.name, composed, selected.session)) return errorResult(selected.name, "preview_changed", "Task membership changed before the snapshot; refresh its preview.");
    const note = `Snapshot: this view will not track later owner changes. ${result.error ?? "Live following is unsupported."}`;
    const snapshot = await selected.provider.openView({ ...composed, opened: composed.opened.map(p => this.viewerPane(p, selected.provider)), spaceLabel: `Snapshot: ${composed.task.name}` });
    return { ...snapshot, following: result.following, task: composed.task, remote: remoteOpened(composed, snapshot.opened),
      ...(selected.session !== undefined ? { session: selected.session } : {}),
      viewDescriptor: { kind: "fixed", name: composed.task.name }, notes: [...(snapshot.notes ?? []), note] };
  }

  private async renderFollowing(selector: FollowingSelector, controls: FollowControls): Promise<OpenViewResult> {
    const selected = this.selectProvider(selector);
    if ("ok" in selected) return selected;
    if (!selected.provider.followView) return errorResult(selected.name, "follow_unsupported", "This provider cannot follow a task.");
    let composed: ComposedView | null = null;
    let membershipError: string | undefined;
    try {
      const current = await this.resolveComposed(selector.view, selected.provider);
      if (!("code" in current)) composed = { ...current, opened: current.opened.map(p => this.viewerPane(p, selected.provider)) };
      else membershipError = `${current.code}: ${current.error}${/^(slice|mission):/.test(selector.view) ? ` Refresh or reopen the ${selector.view.split(":")[0]} under its current unambiguous key.` : ""}`;
    } catch { /* Unreadable membership is supplied as unknown, never empty. */ }
    const plan = composed && this.planId(selected.name, composed, selected.session);
    const stillCurrent = async () => {
      if (!composed?.task?.complete || !plan) return false;
      const current = await this.resolveComposed(selector.view, selected.provider);
      return !("code" in current) && current.task?.complete === true && this.planId(selected.name,
        { ...current, opened: current.opened.map(p => this.viewerPane(p, selected.provider)) }, selected.session) === plan;
    };
    const result = await selected.provider.followView(selector.view, composed, controls, stillCurrent, membershipError);
    // Following resolves local task owners only, so its remote list is empty unless a composed tile says otherwise.
    return { ...result, remote: composed ? remoteOpened(composed, result.opened) : [], ...(selected.session !== undefined ? { session: selected.session } : {}),
      ...(composed?.task ? { task: composed.task } : {}), viewDescriptor: { kind: controls.enabled && result.following?.enabled !== false ? "following" : "fixed", name: composed?.task?.name ?? selector.view } };
  }

  private selectProvider(req: Pick<OpenViewRequest, "provider" | "session" | "herdrApp">): {
    name: string; provider: TerminalProvider; session?: string;
  } | OpenViewResult {
    const name = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    if (name === "herdr-app") {
      if (req.session !== undefined) return errorResult(name, "unsupported_terminal_session", "herdr-app selects its client by app home, not by session.");
      const provider = this.deps.resolveHerdrAppProvider?.(req.herdrApp ?? {});
      return provider ? { name, provider, session: provider.appHome }
        : errorResult(name, "herdr_app_unsupported", "This daemon has no herdr-app provider.");
    }
    const defaultProvider = this.deps.resolveProvider(name);
    if (!defaultProvider) return errorResult(name, "unknown_provider", `unknown provider '${name}' — expected herdr, herdr-app, cmux or rex`);
    if (req.session === undefined) return { name, provider: defaultProvider };
    const normalized = normalizeTerminalSession(req.session);
    if (!normalized.ok) return errorResult(name, normalized.code, normalized.error);
    const session = normalized.session;
    const provider = this.deps.resolveSessionProvider?.(name, session);
    return provider ? { name, provider, session }
      : errorResult(name, "unsupported_terminal_session", `Provider '${name}' does not support selecting a named session. Use herdr with --session <name>.`);
  }

  /** Resolved once, so a preview and the open that follows compose the same pane commands; resolved again once that
   *  file is gone (e.g. a removed version-manager shim), so a long-running daemon never hands out a dead tmux path. */
  private async resolveLocalTmux(): Promise<string | undefined> {
    const cached = await (this.localTmux ??= this.probeLocalTmux());
    if (cached === undefined || existsSync(cached)) return cached;
    return this.localTmux = this.probeLocalTmux();
  }

  private async probeLocalTmux(): Promise<string | undefined> {
    try {
      const path = await this.deps.resolveLocalTmux?.();
      return typeof path === "string" && isAbsolute(path) ? path : undefined;
    } catch {
      return undefined;
    }
  }

  /** An omitted provider takes the first in DEFAULT_PROVIDER_ORDER that is available and alive. With neither, it stays
   *  herdr, whose honest failure carries the direct attach commands. A named provider is used as named, errors and all.
   *  A named session stays on herdr without probing default-provider availability. */
  private async providerNameFor(req: OpenViewRequest): Promise<{ name: string; fellBack: boolean }> {
    const named = req.provider?.trim();
    if (named || req.session !== undefined) return { name: named || DEFAULT_PROVIDER, fellBack: false };
    for (const name of DEFAULT_PROVIDER_ORDER) {
      const candidate = this.deps.resolveProvider(name);
      if (!candidate) continue;
      try {
        if ((await candidate.status()).available && (await candidate.liveness()).alive) return { name, fellBack: name !== DEFAULT_PROVIDER };
      } catch {
        // A probe that throws is not an available provider; try the next.
      }
    }
    return { name: DEFAULT_PROVIDER, fellBack: false };
  }

  /** Open a view in the chosen provider. Always returns the one shared result shape. */
  async openView(req: OpenViewRequest): Promise<OpenViewResult> {
    const { name: providerName, fellBack } = await this.providerNameFor(req);
    const selected = this.selectProvider({ ...req, provider: providerName });
    if ("ok" in selected) return selected;
    const { provider, session } = selected;

    const composed = await this.resolveComposedWithMeta(req.view, provider, req.viewportColumns);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    const { composed: composedView, rigViewer } = composed;
    await this.viewerMappings(provider, composedView);
    const planId = this.planId(providerName, composedView, session);
    if (req.expectedPlan !== undefined && req.expectedPlan !== planId) {
      return errorResult(providerName, "preview_changed", "View membership, layout or provider session changed. Refresh the preview before Open; nothing was launched.");
    }
    const notes = composedView.task ? [...composedView.task.issues] : composedView.kernelLayout ? [`Default kernel view: ${composedView.kernelLayout}.`] : [];
    if (fellBack) notes.push(`Herdr isn't available here (not installed or not answering), so this view uses ${providerName}.`);
    if (composedView.kernelLayout && composedView.opened.length === 0) {
      return {
        ...errorResult(providerName, "kernel_seats_unavailable", `No kernel conversations are attachable: ${composedView.absent.map(member => `${member.seat} (${member.reason})`).join("; ")}`),
        ...(session !== undefined ? { session } : {}),
        absent: composedView.absent, degraded: composedView.degraded, notes,
      };
    }
    const tracked = await this.openTrackedHerdr(provider, composedView, planId, req.reuseLive, rigViewer, true);
    const result = tracked.result;
    notes.push(...tracked.extraNotes);
    // herdr-app opens in the client the request came from: its failure says why, never "attach by hand elsewhere".
    // A reused workspace already shows every tile.
    if (result.opened.length === 0 && composedView.opened.length > 0 && providerName !== "herdr-app" && !result.reusedWorkspace) {
      notes.push("In a new terminal on the daemon's host, attach directly using one of these commands:");
      for (const pane of composedView.opened) notes.push(`${pane.label}: env -u TMUX ${pane.recoveryCommand ?? pane.paneCommand}`);
      notes.push("Each labelled command above opens a different seat. When sharing how to join this team, include every command in full, unchanged, including env -u TMUX, paths and quoting.");
    }
    if (!composedView.kernelLayout && composedView.opened.some(pane => !pane.readOnly)) {
      notes.push("The shared dashboard is the overview; the team's lead pane is where you can talk about the work. Check the opened seats and any absent or degraded seats above. Can you see the team? A created workspace or a capture alone does not confirm what is visible on your screen.");
    }
    return { ...result, viewDescriptor: composedView.viewDescriptor, ...(composedView.task ? { task: composedView.task } : {}), ...(session !== undefined ? { session } : {}), remote: remoteOpened(composedView, result.opened), ...(notes.length ? { notes: [...notes, ...(result.notes ?? [])] } : {}) };
  }

  private async openTrackedHerdr(
    provider: TerminalProvider,
    composed: ComposedView,
    planId: string,
    reuseLive?: boolean,
    collectCreated = false,
    noteIncomplete = false,
  ): Promise<{ result: OpenViewResult; workspaceId?: string; extraNotes: string[] }> {
    const extraNotes: string[] = [];
    const openOpts = reuseLive ? { reuseLive: true } : undefined;
    if (collectCreated && provider instanceof HerdrAdapter) {
      const tracked = await provider.openViewTracked({ ...composed, planId }, openOpts, true);
      if (tracked.created && "workspaceId" in tracked.created && !tracked.result.reusedWorkspace) {
        try {
          await this.rigViewers.upsert({
            kind: "herdr",
            endpoint: tracked.created.endpoint,
            view: composed.id,
            workspaceId: tracked.created.workspaceId,
            tabIds: tracked.created.tabIds,
            tabLabels: tracked.created.tabLabels,
            paneIds: tracked.created.paneIds,
            planId,
            createdAt: new Date().toISOString(),
            phase: "created",
          });
          return { result: tracked.result, workspaceId: tracked.created.workspaceId, extraNotes };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          extraNotes.push(`Herdr workspace was opened, but its ownership could not be persisted in the journal and it was not recorded for close (${detail}).`);
          return { result: tracked.result, extraNotes };
        }
      }
      if (noteIncomplete && tracked.created && "incomplete" in tracked.created && !tracked.result.reusedWorkspace) {
        extraNotes.push("Herdr workspace identity could not be confirmed completely and was not recorded for close.");
      }
      return { result: tracked.result, extraNotes };
    }
    const result = await provider.openView({ ...composed, planId }, openOpts);
    return { result, extraNotes };
  }

  /** Composition for a provider: its page size, and whether its local writable tiles pin their seat. */
  private async composeRigBulk(rig: string, provider?: TileProvider, viewportColumns?: number): Promise<{ composed: ComposedTerminalView; bulkAbsent: AbsentSeat[]; skipped: SkippedSeat[] } | null> {
    const identity = await this.resolveRigIdentity(rig);
    if (!identity) return null;
    const rows = await this.deps.listRigSeats(identity.id);
    if (rows == null) return null;
    const { tmuxRows, absent: bulkAbsent, skipped } = partitionRigRowsForBulk(rows);
    const derived = deriveViewMembers(tmuxRows, { readOnly: false });
    const composed = composeView(`rig:${identity.id}`, await this.refineLiveness(derived), {
      resolveHost: (id) => this.deps.resolveHost(id),
      panesPerPage: provider?.panesPerPage,
      localTmux: await this.resolveLocalTmux(),
      localTmuxServer: this.getTmuxServerArgs(),
      localTmuxServerMode: daemonTmuxServerInfo()?.mode,
      ...(provider?.pinsWritableSeats ? { pinWritableSeats: true } : {}),
      ...(viewportColumns !== undefined ? { viewportColumns } : {}),
    });
    composed.rigName = identity.name;
    composed.viewDescriptor = { kind: "following", name: `rig:${identity.id}` };
    return { composed, bulkAbsent, skipped };
  }

  private async resolveComposed(viewArg: string, provider?: TileProvider, viewportColumns?: number): Promise<ComposedTerminalView | { code: string; error: string }> {
    const res = await this.resolveComposedWithMeta(viewArg, provider, viewportColumns);
    return "code" in res ? res : res.composed;
  }

  private async resolveComposedWithMeta(viewArg: string, provider?: TileProvider, viewportColumns?: number): Promise<{ composed: ComposedTerminalView; rigViewer: boolean } | { code: string; error: string }> {
    const view = (viewArg ?? "").trim();
    if (!view) return { code: "view_required", error: "a view argument is required" };
    const resolved = await this.resolveView(view);
    if ("code" in resolved) return resolved;
    const rigViewer = resolved.rigViewer === true;
    const composed = composeView(resolved.id, await this.refineLiveness(resolved.members), { resolveHost: (id) => this.deps.resolveHost(id), panesPerPage: resolved.panesPerPage ?? provider?.panesPerPage, localTmux: await this.resolveLocalTmux(), localTmuxServer: this.getTmuxServerArgs(), localTmuxServerMode: daemonTmuxServerInfo()?.mode, ...(provider?.pinsWritableSeats ? { pinWritableSeats: true } : {}) });
    if (resolved.rigName !== undefined) composed.rigName = resolved.rigName;
    const saved = view.startsWith("saved:") ? this.deps.viewsStore.get(view.slice(6))
      : !/^(qitem|mission|slice|pod|seat|rig):/.test(view) ? this.deps.viewsStore.get(view) : null;
    composed.viewDescriptor = { kind: saved && saved.id === resolved.id ? "fixed" : "following",
      name: resolved.task?.name ?? (saved?.id === resolved.id ? saved.name : resolved.id) };
    if (resolved.task) {
      for (const member of resolved.task.members) {
        const missing = composed.absent.find(item => item.seat === member.seat);
        if (missing && member.availability === "available") {
          member.availability = "missing"; member.reason = missing.reason;
        } else if (member.availability !== "available") {
          composed.absent.push({ seat: member.seat, host: member.key.hostId, reason: member.reason ?? member.availability });
        }
      }
      return { composed: { ...composed, task: resolved.task }, rigViewer };
    }
    if (resolved.kernelLayout && Number.isSafeInteger(viewportColumns) && viewportColumns! >= 120) {
      // The default's members are operator, dashboard, advisor. Keep the advisor separate
      // even when one of the other roles is unavailable; chunking two at a time would not.
      const page = (indexes: number[]) => indexes.flatMap(index => composed.opened.filter(pane => pane.seat === resolved.members[index]?.seat));
      const pages = [page([1, 0]), page([2])].filter(panes => panes.length > 0);
      return { composed: { ...composed, opened: pages.flat(), pages, kernelLayout: resolved.kernelLayout, columns: 2, spaceLabel: KERNEL_SPACE_LABEL }, rigViewer };
    }
    return { composed: resolved.kernelLayout ? { ...composed, kernelLayout: resolved.kernelLayout, columns: resolved.columns, spaceLabel: KERNEL_SPACE_LABEL } : composed, rigViewer };
  }

  private planId(provider: string, composed: ComposedView, session?: string): string {
    return createHash("sha256").update(JSON.stringify({ provider, ...(session !== undefined ? { session } : {}), composed: { ...composed, ...(composed.task ? { task: { ...composed.task, members: composed.task.members.map(({ viewer, viewerStatus, ...member }) => member) } } : {}) }, grids: composed.pages.map(page => buildGridRoot(page, composed.columns)) })).digest("hex");
  }

  /** Passive: inventory, local has-session and provider probe only. Never openView. */
  async previewView(req: OpenViewRequest): Promise<TerminalPreview | OpenViewResult> {
    const { name: providerName } = await this.providerNameFor(req);
    const selected = this.selectProvider({ ...req, provider: providerName });
    if ("ok" in selected) return selected;
    const { provider, session } = selected;
    if (req.bulk && req.view.startsWith("rig:")) {
      const rigName = req.view.slice("rig:".length);
      const bulk = await this.composeRigBulk(rigName, provider, req.viewportColumns);
      if (!bulk) return errorResult(providerName, "view_not_found", `unknown rig '${rigName}'`);
      const tmux = daemonTmuxServerInfo();
      const planId = this.planId(providerName, bulk.composed, session);
      const composed = { ...bulk.composed, absent: [...bulk.bulkAbsent, ...bulk.composed.absent] };
      return {
        provider: providerName, ...(session !== undefined ? { session } : {}), ...(tmux ? { tmux } : {}),
        view: req.view, rigViewer: true, composed, skipped: bulk.skipped, remote: remoteOpened(composed),
        viewDescriptor: composed.viewDescriptor, capabilities: { ensureViewer: false },
        grids: composed.pages.map(page => buildGridRoot(page, composed.columns)),
        planId, status: await provider.status(),
      };
    }
    const resolved = await this.resolveComposedWithMeta(req.view, provider, req.viewportColumns);
    if ("code" in resolved) return errorResult(providerName, resolved.code, resolved.error);
    const { composed, rigViewer } = resolved;
    await this.viewerMappings(provider, composed);
    const tmux = daemonTmuxServerInfo();
    return { provider: providerName, ...(session !== undefined ? { session } : {}), ...(tmux ? { tmux } : {}), view: req.view, rigViewer, composed, remote: remoteOpened(composed), viewDescriptor: composed.viewDescriptor, ...(composed.task ? { task: composed.task } : {}),
      capabilities: { ensureViewer: !!composed.task && !!provider.ensureViewer },
      grids: composed.pages.map(page => buildGridRoot(page, composed.columns)), planId: this.planId(providerName, composed, session), status: await provider.status() };
  }

  private getTmuxServerArgs(): readonly string[] {
    return this.deps.tmuxServerArgs ? this.deps.tmuxServerArgs() : daemonTmuxServerArgs();
  }

  private async runDaemonTmux(args: string[], serverArgs: readonly string[] = this.getTmuxServerArgs()): Promise<string> {
    if (this.deps.tmuxExec) return this.deps.tmuxExec(args);
    const bin = (await this.resolveLocalTmux()) ?? "tmux";
    return execArgvCommand([bin, ...serverArgs, ...args]);
  }

  private async rigIdentities(): Promise<Array<{ id: string; name: string }>> {
    const rows = this.deps.listRigs ? await this.deps.listRigs() : (await this.deps.listRigNames()).map(name => ({ id: name, name }));
    return [...new Map(rows.map(row => [row.id, row])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  private async resolveRigIdentity(arg: string): Promise<{ id: string; name: string } | null> {
    // Older injected compositions have only name lookup. Production supplies IDs.
    if (!this.deps.listRigs) return { id: arg, name: arg };
    const rigs = await this.deps.listRigs();
    return rigs.find(rig => rig.id === arg) ?? rigs.find(rig => rig.name === arg) ?? null;
  }

  async openAll(req: OpenAllRequest): Promise<OpenAllResult> {
    const named = req.provider?.trim();
    if (req.herdrApp || (named && BULK_UNSUPPORTED_PROVIDERS.has(named))) {
      const p = named || "herdr-app";
      return { ok: false, provider: p, rigs: [], code: "unsupported_provider", error: `--all supports herdr or tmux --window; ${p} is unsupported.` };
    }
    if (named && named !== "herdr") {
      return { ok: false, provider: named, rigs: [], code: "unknown_provider", error: `unknown provider '${named}' — expected herdr` };
    }
    const selected = this.selectProvider({ provider: "herdr", session: req.session });
    if ("ok" in selected) {
      return { ok: false, provider: "herdr", ...(req.session ? { session: req.session } : {}), rigs: [], code: selected.code, error: selected.error };
    }
    const { provider, session } = selected;
    try {
      const [status, live] = await Promise.all([provider.status(), provider.liveness()]);
      if (!status.available || !live.alive) {
        return {
          ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [],
          code: "herdr_unavailable", error: live.detail ?? "herdr is unavailable",
        };
      }
    } catch (err) {
      return {
        ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [],
        code: "herdr_unavailable", error: err instanceof Error ? err.message : String(err),
      };
    }

    const identities = await this.rigIdentities();
    const rigs: OpenAllRigResult[] = [];
    const reuseLive = req.reuseLive !== false;
    for (const rig of identities) {
      try {
        rigs.push(await this.openSingleRigBulk(rig.id, provider, session, req.viewportColumns, reuseLive, rig.name));
      } catch (err) {
        rigs.push({ rig: rig.name, rigId: rig.id, view: `rig:${rig.id}`, outcome: "failed",
          opened: [], absent: [], degraded: [], skipped: [], error: err instanceof Error ? err.message : String(err) });
      }
    }
    return {
      ok: rigs.some(r => r.outcome === "opened" || r.outcome === "reused"),
      provider: "herdr",
      ...(session !== undefined ? { session } : {}),
      rigs,
    };
  }

  private async openSingleRigBulk(
    rig: string,
    provider: TerminalProvider,
    session?: string,
    viewportColumns?: number,
    reuseLive?: boolean,
    displayName = rig,
  ): Promise<OpenAllRigResult> {
    const view = `rig:${rig}`;
    let bulk: Awaited<ReturnType<TerminalService["composeRigBulk"]>>;
    try {
      bulk = await this.composeRigBulk(rig, provider, viewportColumns);
    } catch (err) {
      // No composed view exists yet, so absent/degraded/skipped details are unknown.
      return {
        rig: displayName, rigId: rig, view, outcome: "failed", opened: [], absent: [], degraded: [], skipped: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    if (!bulk) {
      return { rig: displayName, rigId: rig, view, outcome: "failed", opened: [], absent: [], degraded: [], skipped: [], code: "view_not_found", error: `unknown rig '${displayName}'` };
    }
    const { composed, bulkAbsent, skipped } = bulk;
    if (composed.opened.length === 0) {
      const mergedAbsent = [...bulkAbsent, ...composed.absent];
      const outcome = skipped.length > 0 && mergedAbsent.length === 0 ? "skipped" : "absent";
      return { rig: displayName, rigId: rig, view, outcome, opened: [], absent: mergedAbsent, degraded: composed.degraded, skipped };
    }
    const planId = this.planId("herdr", composed, session);
    try {
      const { result, workspaceId, extraNotes } = await this.openTrackedHerdr(provider, composed, planId, reuseLive, true, true);
      const mergedAbsent = [...bulkAbsent, ...result.absent];
      const notes = [...(result.notes ?? []), ...extraNotes];
      if (result.reusedWorkspace) {
        return {
          rig: displayName, rigId: rig, view, outcome: "reused", opened: [], absent: mergedAbsent, degraded: result.degraded, skipped,
          workspaceId: result.reusedWorkspace.id, ...(notes.length ? { notes } : {}),
        };
      }
      if (result.opened.length > 0) {
        return {
          rig: displayName, rigId: rig, view, outcome: "opened", opened: result.opened, absent: mergedAbsent, degraded: result.degraded, skipped,
          ...(workspaceId ? { workspaceId } : {}), ...(notes.length ? { notes } : {}),
        };
      }
      return {
        rig: displayName, rigId: rig, view, outcome: "failed", opened: [], absent: mergedAbsent, degraded: result.degraded, skipped,
        ...(result.code ? { code: result.code } : {}), error: result.error ?? "no seats opened",
        ...(notes.length ? { notes } : {}),
      };
    } catch (err) {
      return {
        rig: displayName, rigId: rig, view, outcome: "failed", opened: [], absent: [...bulkAbsent, ...composed.absent], degraded: composed.degraded, skipped,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async closeAll(req: CloseAllRequest): Promise<CloseAllResult> {
    const named = req.provider?.trim();
    if (named && BULK_UNSUPPORTED_PROVIDERS.has(named)) {
      return { ok: false, viewers: [], code: "unsupported_provider", error: `--all close supports herdr or tmux; ${named} is unsupported.` };
    }
    if (named && named !== "herdr" && named !== "tmux") {
      return { ok: false, viewers: [], code: "unknown_provider", error: `unknown provider '${named}' — expected herdr or tmux` };
    }
    let session: string | undefined;
    if (req.session !== undefined) {
      if (named === "tmux") {
        return {
          ok: false,
          viewers: [],
          code: "unsupported_terminal_session",
          error: "--session selects a Herdr session; use herdr without --provider tmux.",
        };
      }
      const normalized = normalizeTerminalSession(req.session);
      if (!normalized.ok) {
        return { ok: false, viewers: [], code: normalized.code, error: normalized.error };
      }
      session = normalized.session;
    }
    let allEntries: Array<{ endpoint: string; key: string; record: RigViewerRecord }>;
    try {
      allEntries = named === "tmux" ? [] : await this.rigViewers.listAll();
    } catch (err) {
      if (err instanceof CorruptRigViewerLedgerError || (err as { code?: string })?.code === "corrupt_ledger") {
        return { ok: false, viewers: [], code: "corrupt_ledger", error: err instanceof Error ? err.message : String(err) };
      }
      throw err;
    }
    const effectiveProvider = named || (session !== undefined ? "herdr" : undefined);
    const filtered = allEntries.filter(({ record }) => !effectiveProvider || record.kind === effectiveProvider);
    const viewers: CloseAllViewerResult[] = [];
    const byEndpoint = new Map<string, Array<{ key: string; record: RigViewerRecord }>>();
    for (const item of filtered) {
      const bucket = byEndpoint.get(item.endpoint) ?? [];
      bucket.push({ key: item.key, record: item.record });
      byEndpoint.set(item.endpoint, bucket);
    }

    for (const [endpoint, entries] of byEndpoint) {
      const endpointResults: CloseAllViewerResult[] = [];
      const completed = new Set<string>();
      try {
        await this.rigViewers.runExclusive(endpoint, async (tx) => {
          await this.closeHerdrEndpoint(endpoint, entries, session, tx, endpointResults, completed);
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        let unresolved = 0;
        for (const { key, record } of entries) {
          if (completed.has(key)) continue;
          unresolved++;
          endpointResults.push({ view: record.view, provider: "herdr", target: record.workspaceId,
            outcome: "failed", code: "bookkeeping_failed",
            reason: `Endpoint bookkeeping failed; journal removal and close were not confirmed (${detail}).` });
        }
        if (!unresolved) endpointResults.push({ view: "rig:*", provider: "herdr", target: endpoint,
          outcome: "failed", code: "bookkeeping_failed", reason: `Endpoint bookkeeping failed after gathered results (${detail}).` });
      }
      viewers.push(...endpointResults);
    }
    if (!effectiveProvider || effectiveProvider === "tmux") await this.closeTmuxEndpoint(viewers);
    return { ok: viewers.every(v => v.outcome !== "failed"), viewers, ...(!viewers.length ? { notes: ["no OpenRig rig viewers recorded"] } : {}) };
  }

  private resolveHerdrAdapterStatus(
    endpoint: string,
    session?: string,
  ): { status: "matched"; adapter: HerdrAdapter } | { status: "different_endpoint"; activeEndpoint: string } | { status: "missing" } {
    const candidate = session !== undefined
      ? this.deps.resolveSessionProvider?.("herdr", session)
      : this.deps.resolveProvider("herdr");
    if (!(candidate instanceof HerdrAdapter)) return { status: "missing" };
    const activeEndpoint = candidate.endpointKey();
    if (activeEndpoint === endpoint) return { status: "matched", adapter: candidate };
    return { status: "different_endpoint", activeEndpoint };
  }

  private async closeHerdrEndpoint(
    endpoint: string,
    entries: Array<{ key: string; record: HerdrRigViewerRecord }>,
    session: string | undefined,
    tx: RigViewerEndpointTx,
    viewers: CloseAllViewerResult[],
    completed: Set<string>,
  ): Promise<void> {
    const resolved = this.resolveHerdrAdapterStatus(endpoint, session);
    if (resolved.status === "different_endpoint") {
      for (const { key, record } of entries) {
        viewers.push({
          view: record.view, provider: "herdr", target: record.workspaceId,
          outcome: "kept", code: "different_endpoint",
          reason: `Viewer belongs to a different Herdr endpoint (${endpoint}) than active endpoint (${resolved.activeEndpoint}).`,
        });
        completed.add(key);
      }
      return;
    }
    if (resolved.status === "missing") {
      for (const { key, record } of entries) {
        viewers.push({ view: record.view, provider: "herdr", target: record.workspaceId, outcome: "failed", code: "provider_unreachable", reason: "No matching Herdr endpoint configured." });
        completed.add(key);
      }
      return;
    }
    const { adapter } = resolved;

    for (const { key, record } of entries) {
      let inv: Awaited<ReturnType<HerdrAdapter["readInventory"]>>;
      try {
        inv = await adapter.readInventory();
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        viewers.push({ view: record.view, provider: "herdr", target: record.workspaceId, outcome: "failed", code: "provider_unreachable", reason });
        completed.add(key);
        continue;
      }

      const ws = inv.workspaces.find(w => w.workspace_id === record.workspaceId);
      const wsTabs = inv.tabsByWorkspace.get(record.workspaceId) ?? [];
      const wsPanes = inv.panesByWorkspace.get(record.workspaceId) ?? [];
      const anyRecordedTab = wsTabs.some(t => record.tabIds.includes(t.tab_id));
      const anyRecordedPane = wsPanes.some(p => record.paneIds.includes(p.pane_id));

      if (!ws || (!anyRecordedTab && !anyRecordedPane)) {
        try {
          tx.remove(key);
          viewers.push({ view: record.view, provider: "herdr", target: record.workspaceId, outcome: "already_gone" });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          viewers.push({ view: record.view, provider: "herdr", target: record.workspaceId,
            outcome: "failed", code: "bookkeeping_failed", reason: `Journal removal was not confirmed (${detail}).` });
        }
        completed.add(key);
        continue;
      }

      const labelsMatch = !record.tabLabels
        || (record.tabLabels.length === record.tabIds.length && record.tabIds.every((id, idx) => {
          const tab = wsTabs.find(t => t.tab_id === id);
          return tab?.label === record.tabLabels![idx];
        }));
      const intact = labelsMatch
        && sameIdSet(wsTabs.map(t => t.tab_id), record.tabIds)
        && sameIdSet(wsPanes.map(p => p.pane_id), record.paneIds)
        && wsPanes.every(p => record.tabIds.includes(p.tab_id));
      if (!intact) {
        viewers.push({
          view: record.view, provider: "herdr", target: record.workspaceId,
          outcome: "kept", code: labelsMatch ? "not_separable" : "ownership_unconfirmed",
          reason: `${labelsMatch ? "Workspace has foreign or modified tabs/panes." : "Workspace tab labels do not match the recorded rig viewer."} ${manualHerdrViewerClose(endpoint, record.workspaceId)}`,
        });
        completed.add(key);
        continue;
      }

      viewers.push({
        view: record.view, provider: "herdr", target: record.workspaceId,
        outcome: "kept", code: "conditional_close_unavailable",
        reason: `Automatic Herdr close has no qualified compare-and-close operation. ${manualHerdrViewerClose(endpoint, record.workspaceId)}`,
      });
      completed.add(key);
    }
  }

  private async closeTmuxEndpoint(viewers: CloseAllViewerResult[]): Promise<void> {
    const serverArgs = [...this.getTmuxServerArgs()];
    const endpoint = tmuxEndpointKey(serverArgs);
    const run = (args: string[]) => this.runDaemonTmux(args, serverArgs);
    let candidates: string;
    try {
      candidates = await run(["list-sessions", "-F", `#{session_id}|#{session_name}|#{${TMUX_VIEWER_PROOF_OPTION}}`]);
    } catch (err) {
      if (!isTmuxNoServerError(err)) viewers.push({ view: "rig:*", provider: "tmux", target: endpoint,
        outcome: "failed", code: "provider_unreachable", reason: err instanceof Error ? err.message : String(err) });
      return;
    }
    for (const line of candidates.trim().split("\n")) {
      const [sessionId, sessionName, encoded] = line.split("|");
      if (!encoded) continue; // Unqualified and legacy viewers need manual inspection.
      const proof = parseTmuxViewerProof(encoded);
      const result = { view: proof?.view ?? "rig:*", provider: "tmux" as const, target: sessionName ?? endpoint };
      if (!proof || proof.sessionId !== sessionId || proof.sessionName !== sessionName) {
        viewers.push({ ...result, outcome: "kept", code: "ownership_unconfirmed", reason: "Tmux session ownership options are incomplete or invalid." });
        continue;
      }
      if (proof.endpoint !== endpoint) {
        viewers.push({ ...result, outcome: "kept", code: "different_endpoint", reason: "Tmux ownership options belong to a different endpoint." });
        continue;
      }
      let attemptedClose = false;
      try {
        const inventory = await readTmuxInventory(run);
        if (!inventory.has(proof.sessionId)) {
          viewers.push({ ...result, outcome: "already_gone" });
          continue;
        }
        const snapshot = await run(["display-message", "-p", "-t", proof.sessionId, TMUX_VIEWER_OPTION_SNAPSHOT]);
        const args = tmuxViewerCloseArgs(proof, snapshot);
        if (!args) {
          viewers.push({ ...result, outcome: "kept", code: "ownership_unconfirmed", reason: "Tmux session nonce, identity or original inventory no longer matches." });
          continue;
        }
        attemptedClose = true;
        if ((await run(args)).trim() === TMUX_VIEWER_KEPT) {
          viewers.push({ ...result, outcome: "kept", code: "ownership_unconfirmed", reason: "Tmux viewer identity or contents changed before conditional close." });
          continue;
        }
        if ((await readTmuxInventory(run)).has(proof.sessionId)) {
          viewers.push({ ...result, outcome: "failed", code: "close_pending", reason: "Tmux session still present after conditional close." });
        } else viewers.push({ ...result, outcome: "closed" });
      } catch (err) {
        viewers.push({ ...result, outcome: "failed", code: attemptedClose ? "close_pending" : "provider_unreachable",
          reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private viewerPane(pane: import("./terminal-provider.js").ComposedPane, provider: TileProvider) {
    const original = pane.attachArgv;
    if (!original) return pane;
    const attachArgv = provider.pinsWritableSeats ? pinnedTileAttachArgv(original[5]!, original.slice(6), original[4]!)
      : tileAttachArgv(original[5]!, original.slice(6), original[4]!, false);
    return { ...pane, readOnly: false, attachArgv, paneCommand: attachArgv.map(shellQuote).join(" ") };
  }

  private async viewerMappings(provider: TerminalProvider, composed: ComposedView): Promise<void> {
    if (!composed.task || !provider.lookupViewer) return;
    for (const member of composed.task.members) {
      const pane = composed.opened.find(p => p.seat === member.seat);
      if (!pane || !member.key.hostId || !member.key.nodeId) continue;
      const result = await provider.lookupViewer({ hostId: member.key.hostId, nodeId: member.key.nodeId }, this.viewerPane(pane, provider));
      if (result.ok) { member.viewerStatus = "verified"; member.viewer = result.viewer; }
      else if (result.code !== "viewer_not_provisioned") member.viewerStatus = "unconfirmed";
    }
  }

  /** Explicit owner operation: membership never grants input authority. The
   * HTTP route supplies the existing owner bearer/browser boundary. */
  async ensureViewer(req: OpenViewRequest & { member: ViewerKey; expectedPlan: string }): Promise<ViewerResult> {
    if (!/^(qitem|slice|mission):.+/.test(req.view)) return { ok: false, code: "view_required", error: "Ensure-viewer requires an authoritative qitem, slice or mission view." };
    const selected = this.selectProvider({ ...req, provider: req.provider ?? "herdr" });
    if ("ok" in selected) return { ok: false, code: selected.code ?? "unknown_provider", error: selected.error ?? "Provider unavailable." };
    if (!selected.provider.ensureViewer) return { ok: false, code: "viewer_unsupported", error: "This provider has no qualified ensure-viewer operation." };
    const composed = await this.resolveComposed(req.view, selected.provider, req.viewportColumns);
    if ("code" in composed) return { ok: false, code: composed.code, error: composed.error };
    if (req.expectedPlan !== this.planId(selected.name, composed, selected.session)) return { ok: false, code: "preview_changed", error: "Task membership or attachment changed; refresh the preview before ensuring a viewer." };
    if (!composed.task?.complete) return { ok: false, code: "viewer_unconfirmed", error: "Task membership is incomplete; no viewer was provisioned." };
    const member = composed.task.members.find(m => m.key.hostId === req.member.hostId && m.key.nodeId === req.member.nodeId);
    const pane = member?.availability === "available" && composed.opened.find(p => p.seat === member.seat);
    if (!pane) return { ok: false, code: "viewer_unavailable", error: "This current task member has no verified local terminal attachment." };
    return selected.provider.ensureViewer(req.member, this.viewerPane(pane, selected.provider), async () => {
      const current = await this.resolveComposed(req.view, selected.provider, req.viewportColumns);
      return !("code" in current) && current.task?.complete === true
        && this.planId(selected.name, current, selected.session) === req.expectedPlan;
    });
  }

  /** Close one herdr-app Rig view: its cells leave the client's layout first, then only its own verified viewers end.
   *  Seats are never touched. Other providers have no close. */
  async closeView(req: { provider?: string; view: string; session?: string; herdrApp?: HerdrAppTarget }): Promise<OpenViewResult> {
    const name = req.provider?.trim() ?? "herdr-app";
    if (name !== "herdr-app") return errorResult(name || "herdr-app", "close_unsupported", "Only herdr-app Rig views are closed by OpenRig; close other provider tabs in that provider.");
    if (req.session !== undefined) return errorResult(name, "unsupported_terminal_session", "herdr-app selects its client by app home, not by session.");
    const provider = this.deps.resolveHerdrAppProvider?.(req.herdrApp ?? {});
    if (!provider) return errorResult(name, "herdr_app_unsupported", "This daemon has no herdr-app provider.");
    if (!req.view.trim()) return errorResult(name, "view_required", "Name the Rig view to close (rv-…).");
    return provider.closeView(req.view.trim());
  }

  /** List saved views + the rig names openable as derived views. */
  async listViews(detail = false): Promise<ListViewsResult> {
    const result: ListViewsResult = {
      following: this.following?.list() ?? [],
      saved: this.deps.viewsStore.list(),
      rigs: await this.deps.listRigNames(),
      rigIdentities: await this.rigIdentities(),
    };
    if (!result.saved.some(view => view.id === "kernel") && result.rigs.includes("kernel")) {
      const kernel = await this.defaultKernelView();
      if (kernel) result.saved = [...result.saved, {
        id: "kernel", name: `Kernel conversations · ${kernel.kernelLayout}`,
        members: kernel.members.map(({ seat, label, tmuxSession }) => ({ seat, label, tmuxSession: tmuxSession ?? undefined })),
      }];
    }
    if (detail) {
      result.catalog = [];
      const entries = [
        ...result.saved.map((s) => ({ view: `saved:${s.id}`, name: s.name, kind: "saved" as const })),
        ...result.rigIdentities.map(({ id, name }) => ({ view: `rig:${id}`, name, kind: "derived" as const })),
      ];
      const inventory = await this.deps.listRigSeatsBatch?.(result.rigIdentities.map(rig => rig.id));
      for (const entry of entries) {
        const rows = entry.kind === "derived" ? inventory?.get(entry.view.slice(4)) : undefined;
        const plan = rows ? composeView(entry.view, await this.refineLiveness(deriveViewMembers(rows, { readOnly: false })), { resolveHost: id => this.deps.resolveHost(id), panesPerPage: this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage, localTmux: await this.resolveLocalTmux(), localTmuxServer: this.getTmuxServerArgs(), localTmuxServerMode: daemonTmuxServerInfo()?.mode })
          : await this.resolveComposed(entry.view, this.deps.resolveProvider(DEFAULT_PROVIDER) ?? undefined);
        if ("code" in plan) continue;
        result.catalog.push({ ...entry, members: [...plan.opened, ...plan.absent, ...plan.degraded].map((m) => m.seat), ready: plan.opened.length, absent: plan.absent.length, degraded: plan.degraded.length, pages: plan.pages.length });
      }
    }
    return result;
  }

  /** Provider availability + liveness (doctor). Unknown named provider → empty report for it. */
  async status(providerName?: string, session?: string, herdrApp?: HerdrAppTarget): Promise<TerminalStatusResult> {
    const tmux = daemonTmuxServerInfo();
    if (providerName === "herdr-app") {
      const selected = this.selectProvider({ provider: "herdr-app", ...(herdrApp ? { herdrApp } : {}) });
      if ("ok" in selected) return { providers: [], error: selected.error, code: selected.code };
      return { ...(tmux ? { tmux } : {}), session: selected.session, providers: [{ name: selected.name,
        status: await selected.provider.status(), liveness: await selected.provider.liveness() }] };
    }
    if (session !== undefined) {
      const selected = this.selectProvider({ provider: providerName, session });
      if ("ok" in selected) return { providers: [], error: selected.error, code: selected.code };
      return { following: this.following?.list() ?? [], session: selected.session, ...(tmux ? { tmux } : {}), providers: [{ name: selected.name,
        status: await selected.provider.status(), liveness: await selected.provider.liveness() }] };
    }
    const names: string[] = providerName ? [providerName] : ["herdr", "cmux", "rex"];
    // Checked side by side, so a slow provider never delays the others.
    const providers = await Promise.all(names.map(async (name): Promise<ProviderStatusReport> => {
      const p = this.deps.resolveProvider(name);
      if (!p) {
        return {
          name,
          status: { provider: name, available: false, capabilities: {} },
          liveness: { alive: false, detail: `unknown provider '${name}'` },
        };
      }
      return { name, status: await p.status(), liveness: await p.liveness() };
    }));
    return { providers, following: this.following?.list() ?? [], ...(tmux ? { tmux } : {}) };
  }

  /** Resolve a view argument into composer-ready members (precedence in the file header). */
  private async resolveView(view: string): Promise<ResolvedView> {
    if (view.startsWith("qitem:")) {
      const task = await this.deps.resolveTaskView?.(view.slice(6));
      return task ? { id: view, members: task.members, task: task.task }
        : { code: "view_not_found", error: `unknown local queue episode '${view.slice(6)}'` };
    }
    if (/^(slice|mission):/.test(view)) {
      if (!this.deps.resolveScopeView) return { code: "scope_unsupported", error: "This daemon has no authoritative scoped membership resolver." };
      const scope = await this.deps.resolveScopeView(view);
      return "code" in scope ? scope : { id: view, members: scope.members, task: scope.task };
    }
    if (view.startsWith("saved:")) {
      const saved = this.deps.viewsStore.get(view.slice(6));
      if (saved) return { id: saved.id, rigViewer: false, members: saved.members.map(savedMemberToInput) };
      if (view === "saved:kernel") {
        const kernel = await this.defaultKernelView();
        if (kernel) return { ...kernel, rigViewer: false };
        return { code: "view_not_found", error: "No kernel rig is installed; saved:kernel has no installed bindings" };
      }
      return { code: "view_not_found", error: `unknown saved view '${view.slice(6)}'` };
    }
    // 2. a pod within a rig — `pod:<rig-id-or-name>/<podNamespace>` (AC-5 launcher
    //    target). Interactive (a subset of your own rig).
    if (view.startsWith("pod:")) {
      const rest = view.slice("pod:".length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0 || slash === rest.length - 1) {
        return { code: "view_not_found", error: `malformed pod view '${view}' — expected pod:<rig>/<pod>` };
      }
      const rows = await this.deps.listPodSeats(rest.slice(0, slash), rest.slice(slash + 1));
      if (rows == null) {
        return { code: "view_not_found", error: `unknown pod '${rest.slice(slash + 1)}' in rig '${rest.slice(0, slash)}'` };
      }
      return { id: view, members: deriveViewMembers(rows, { readOnly: false }) };
    }

    // 2b. one seat within a rig — `seat:<rig-id-or-name>/<logicalId>` (the TUI's agent page opens just that agent).
    //     Interactive, like its rig. A logical id has no `/`, so the last `/` splits it from the rig.
    if (view.startsWith("seat:")) {
      const rest = view.slice("seat:".length);
      const slash = rest.lastIndexOf("/");
      if (slash <= 0 || slash === rest.length - 1) {
        return { code: "view_not_found", error: `malformed seat view '${view}' — expected seat:<rig>/<logical-id>` };
      }
      const rigArg = rest.slice(0, slash);
      const logicalId = rest.slice(slash + 1);
      const rows = ((await this.deps.listRigSeats(rigArg)) ?? []).filter((row) => row.logicalId === logicalId);
      if (rows.length === 0) {
        return { code: "view_not_found", error: `unknown seat '${logicalId}' in rig '${rigArg}'` };
      }
      return { id: view, members: deriveViewMembers(rows, { readOnly: false }) };
    }

    // 3. a rig — either the bare name (the common case: `rig terminal open acme`)
    //    or the explicit `rig:<id-or-name>` form the rig-scoped route alias
    //    composes (arch R1: the alias just prefixes `rig:<rigId>` and delegates,
    //    zero composition logic of its own). `listRigSeats` resolves the arg as
    //    an exact rig ID first, then a legacy name.
    const explicitRig = view.startsWith("rig:");
    const rigArg = explicitRig ? view.slice("rig:".length) : view;
    const identity = await this.resolveRigIdentity(rigArg);
    const rigRows = identity ? await this.deps.listRigSeats(identity.id) : null;
    if (rigRows != null) {
      return { id: `rig:${identity!.id}`, rigName: identity!.name, rigViewer: true, members: deriveViewMembers(rigRows, { readOnly: false }) };
    }
    // An explicit `rig:<x>` that resolves to no rig is a named not-found — it must
    // NOT fall through to the saved-view lookup (the caller asked for a rig).
    if (explicitRig) {
      return { code: "view_not_found", error: `unknown rig '${rigArg}'` };
    }

    // 4. a saved-view id.
    const saved = this.deps.viewsStore.get(view);
    if (saved) {
      return { id: saved.id, rigViewer: false, members: saved.members.map(savedMemberToInput) };
    }

    return {
      code: "view_not_found",
      error: `unknown view '${view}' — not a known rig, a mission:/slice: scope, or a saved-view id`,
    };
  }

  /** An in-memory default; a user's saved kernel view always takes precedence. */
  private async defaultKernelView(): Promise<{ id: string; members: ViewMemberInput[]; kernelLayout: string; columns: number; panesPerPage: number } | null> {
    const rows = await this.deps.listRigSeats("kernel");
    if (rows == null) return null;
    const advisor = rows.find(row => row.logicalId === "advisor.lead");
    const operator = rows.find(row => row.logicalId === "operator.agent");
    const runtimesKnown = !!advisor?.runtime && !!operator?.runtime;
    const singleRuntime = runtimesKnown && advisor!.runtime === operator!.runtime;
    const kernelLayout = runtimesKnown ? (singleRuntime ? "single-runtime" : "dual-runtime") : "runtime layout unverified; TUI, advisor and operator";
    // One full-width conversation per page; the operator is the first populated page when ready.
    // Panes and tabs are named for what the person sees there, not by logical id.
    const roles: Array<[string, string]> = [["operator.agent", "operator"], ["operator.human", "dashboard"], ["advisor.lead", "advisor"]];
    const members = roles.map(([logicalId, label]) => {
      const row = rows.find(row => row.logicalId === logicalId);
      const bound = row && deriveViewMembers([row])[0];
      // An expected role is still visible when there is no attachable binding.
      // Its logical ID names the absence; it is never used as a tmux target.
      return bound ? { ...bound, label } : { seat: logicalId, label, tmuxSession: null, host: null, readOnly: false, alive: false };
    });
    return { id: "kernel", members, kernelLayout, columns: 1, panesPerPage: 1 };
  }

  /** Refine local members' liveness with a real has-session probe (a dead seat → absent, honest-partial). */
  private async refineLiveness(members: ViewMemberInput[]): Promise<ViewMemberInput[]> {
    const out: ViewMemberInput[] = [];
    for (const m of members) {
      if (m.host === null && m.tmuxSession) {
        out.push({ ...m, alive: await this.deps.hasSession(m.tmuxSession) });
      } else {
        out.push(m);
      }
    }
    return out;
  }
}
