import type { ScopeViewError } from "./scope-task-terminal-view.js";
import { tileAttachArgv } from "./tile-attach.js";
import { shellQuote } from "../../adapters/shell-quote.js";
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
import { isAbsolute } from "node:path";
import { buildGridRoot } from "./herdr-adapter.js";
import { daemonTmuxServerArgs } from "../../adapters/tmux-server.js";
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
  OpenViewResult,
  ComposedView,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
  ViewDescriptor,
} from "./terminal-provider.js";

/** The provider name set (herdr = proof-gated primary; cmux = best-effort; rex = by name or from a Rex caller). */
export type TerminalProviderName = "herdr" | "cmux" | "rex";
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
}

export interface TerminalPreview {
  provider: string;
  session?: string;
  view: string;
  planId: string;
  composed: ComposedView;
  /** The same pure grid roots consumed by the Herder adapter. */
  grids: ReturnType<typeof buildGridRoot>[];
  status: ProviderStatus;
  task?: TaskMembership;
  capabilities: { ensureViewer: boolean };
  viewDescriptor?: ViewDescriptor;
}

/** The `rig terminal views` payload: saved views + the live rig names you can open. */
export interface ListViewsResult {
  following?: ReturnType<TerminalFollowing["list"]>;
  saved: SavedView[];
  /** Rig names openable as per-rig derived views (live from the inventory). */
  rigs: string[];
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
  session?: string;
  error?: string;
  code?: string;
}

export interface TerminalServiceDeps {
  eventBus?: Pick<EventBus, "subscribe">;
  followingStatePath?: string;
  /** Resolve a provider name to its adapter, or null for an unknown name. */
  resolveProvider(name: string): TerminalProvider | null;
  /** Resolve an explicit session without altering the default provider instance. */
  resolveSessionProvider?(name: string, session: string): TerminalProvider | null;
  /** The saved-views store (read paths only from this service). */
  viewsStore: Pick<TerminalViewsStore, "get" | "list">;
  /** Live seats of a rig BY NAME; null when no such rig is known (vs [] = a known-but-empty rig). */
  listRigSeats(rigName: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** One request-local inventory fold for the derived catalog entries. */
  listRigSeatsBatch?(rigNames: string[]): Promise<Map<string, LiveSeatRow[]>> | Map<string, LiveSeatRow[]>;
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
  /** Read-only host resolution for the composer (registry unavailable → null for every id). */
  resolveHost(id: string): HostEntry | null;
  /** Local liveness refine — has-session for a local tmux session; remote members are not probed here. */
  hasSession(tmuxSession: string): Promise<boolean> | boolean;
  /**
   * The tmux executable the daemon itself resolves, for local pane commands (#707). Only an
   * absolute path is used; anything else, or no resolver, keeps the bare `tmux` token.
   */
  resolveLocalTmux?(): Promise<string | null> | string | null;
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

/** The default kernel view's space name in a terminal multiplexer such as Herdr. */
export const KERNEL_SPACE_LABEL = "openrig kernel";

type ResolvedView = { id: string; members: ViewMemberInput[]; kernelLayout?: string; columns?: number; panesPerPage?: number; task?: TaskMembership } | { code: string; error: string };
type ComposedTerminalView = ComposedView & { kernelLayout?: string };

export class TerminalService {
  private localTmux?: Promise<string | undefined>;
  private following?: TerminalFollowing;

  private unsubscribeScope?: () => void;
  constructor(private readonly deps: TerminalServiceDeps) {
    if (deps.invalidateScopeView) this.unsubscribeScope = deps.eventBus?.subscribe(event => {
      if (event.type === "scope.sources_changed") deps.invalidateScopeView?.();
    });
    if (deps.eventBus) this.following = new TerminalFollowing(
      deps.followingStatePath ?? getDefaultOpenRigPath("private/terminal-following/selectors.json"), deps.eventBus,
      (selector, controls) => this.renderFollowing(selector, controls));
  }

  async stop(): Promise<void> { this.unsubscribeScope?.(); await this.following?.stop(); }

  async followView(req: OpenViewRequest & FollowControls): Promise<OpenViewResult> {
    if (!this.following) return errorResult("herdr", "follow_unavailable", "This daemon has no event-driven terminal following service.");
    if (!/^(qitem|slice|mission):.+/.test(req.view)) return errorResult("herdr", "follow_view_required", "Follow requires an authoritative qitem:<id>, slice:<id-or-name> or mission:<id> view.");
    if (/^(slice|mission):/.test(req.view) && !this.deps.resolveScopeView) return errorResult("herdr", "scope_unsupported", "This daemon has no authoritative scoped membership resolver.");
    const selected = this.selectProvider({ ...req, provider: req.provider ?? "herdr" });
    if ("ok" in selected) return selected;
    if (selected.name !== "herdr" || !selected.provider.followView) return errorResult(selected.name, "follow_unsupported", "Follow is supported by the qualified Herdr provider only.");
    if (/^(slice|mission):/.test(req.view) || req.expectedPlan !== undefined) {
      const composed = await this.resolveComposed(req.view, selected.provider.panesPerPage);
      if ("code" in composed) return errorResult(selected.name, composed.code, composed.error);
      if (req.expectedPlan !== undefined && req.expectedPlan !== this.planId(selected.name, composed, selected.session)) return errorResult(selected.name, "preview_changed", "Task membership changed since preview; refresh before enabling following.");
    }
    const { enabled, maxTiles, graceMs, focusRetentionMs, pin, unpin, suppress, unsuppress, suppressionMs } = req;
    return this.following.open({ view: req.view, provider: "herdr", ...(selected.session !== undefined ? { session: selected.session } : {}) },
      { enabled, maxTiles, graceMs, focusRetentionMs, pin, unpin, suppress, unsuppress, suppressionMs });
  }

  private async renderFollowing(selector: FollowingSelector, controls: FollowControls): Promise<OpenViewResult> {
    const selected = this.selectProvider(selector);
    if ("ok" in selected) return selected;
    if (!selected.provider.followView) return errorResult(selected.name, "follow_unsupported", "This provider cannot follow a task.");
    let composed: ComposedView | null = null;
    let membershipError: string | undefined;
    try {
      const current = await this.resolveComposed(selector.view, selected.provider.panesPerPage);
      if (!("code" in current)) composed = { ...current, opened: current.opened.map(p => this.viewerPane(p)) };
      else membershipError = `${current.code}: ${current.error}${/^(slice|mission):/.test(selector.view) ? ` Refresh or reopen the ${selector.view.split(":")[0]} under its current unambiguous key.` : ""}`;
    } catch { /* Unreadable membership is supplied as unknown, never empty. */ }
    const plan = composed && this.planId(selected.name, composed, selected.session);
    const stillCurrent = async () => {
      if (!composed?.task?.complete || !plan) return false;
      const current = await this.resolveComposed(selector.view, selected.provider.panesPerPage);
      return !("code" in current) && current.task?.complete === true && this.planId(selected.name,
        { ...current, opened: current.opened.map(p => this.viewerPane(p)) }, selected.session) === plan;
    };
    const result = await selected.provider.followView(selector.view, composed, controls, stillCurrent, membershipError);
    return { ...result, ...(selected.session !== undefined ? { session: selected.session } : {}),
      ...(composed?.task ? { task: composed.task } : {}), viewDescriptor: { kind: controls.enabled && result.following?.enabled !== false ? "following" : "fixed", name: composed?.task?.name ?? selector.view } };
  }

  private selectProvider(req: Pick<OpenViewRequest, "provider" | "session">): {
    name: string; provider: TerminalProvider; session?: string;
  } | OpenViewResult {
    const name = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const defaultProvider = this.deps.resolveProvider(name);
    if (!defaultProvider) return errorResult(name, "unknown_provider", `unknown provider '${name}' — expected herdr, cmux or rex`);
    if (req.session === undefined) return { name, provider: defaultProvider };
    const session = typeof req.session === "string" ? req.session.trim() : "";
    if (!session || session === "." || session === ".." || /[\\/\x00-\x1f\x7f]/.test(session)) {
      return errorResult(name, "invalid_terminal_session", "session must be one non-empty session name, not a socket path.");
    }
    const provider = this.deps.resolveSessionProvider?.(name, session);
    return provider ? { name, provider, session }
      : errorResult(name, "unsupported_terminal_session", `Provider '${name}' does not support selecting a named session. Use herdr with --session <name>.`);
  }

  /** Resolved once, so a preview and the open that follows compose the same pane commands. */
  private resolveLocalTmux(): Promise<string | undefined> {
    this.localTmux ??= (async () => {
      try {
        const path = await this.deps.resolveLocalTmux?.();
        return typeof path === "string" && isAbsolute(path) ? path : undefined;
      } catch {
        return undefined;
      }
    })();
    return this.localTmux;
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

    const composed = await this.resolveComposed(req.view, provider.panesPerPage, req.viewportColumns);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    await this.viewerMappings(provider, composed);
    const planId = this.planId(providerName, composed, session);
    if (req.expectedPlan !== undefined && req.expectedPlan !== planId) {
      return errorResult(providerName, "preview_changed", "View membership, layout or provider session changed. Refresh the preview before Open; nothing was launched.");
    }
    const notes = composed.task ? [...composed.task.issues] : composed.kernelLayout ? [`Default kernel view: ${composed.kernelLayout}.`] : [];
    if (fellBack) notes.push(`Herdr isn't available here (not installed or not answering), so this view uses ${providerName}.`);
    if (composed.kernelLayout && composed.opened.length === 0) {
      return {
        ...errorResult(providerName, "kernel_seats_unavailable", `No kernel conversations are attachable: ${composed.absent.map(member => `${member.seat} (${member.reason})`).join("; ")}`),
        ...(session !== undefined ? { session } : {}),
        absent: composed.absent, degraded: composed.degraded, notes,
      };
    }
    const result = await provider.openView({ ...composed, planId });
    if (result.opened.length === 0 && composed.opened.length > 0) {
      notes.push("In a new terminal on the daemon's host, attach directly using one of these commands:");
      for (const pane of composed.opened) notes.push(`${pane.label}: env -u TMUX ${pane.recoveryCommand ?? pane.paneCommand}`);
      notes.push("Each labelled command above opens a different seat. When sharing how to join this team, include every command in full, unchanged, including env -u TMUX, paths and quoting.");
    }
    if (!composed.kernelLayout && composed.opened.some(pane => !pane.readOnly)) {
      notes.push("The shared dashboard is the overview; the team's lead pane is where you can talk about the work. Check the opened seats and any absent or degraded seats above. Can you see the team? A created workspace or a capture alone does not confirm what is visible on your screen.");
    }
    return { ...result, viewDescriptor: composed.viewDescriptor, ...(composed.task ? { task: composed.task } : {}), ...(session !== undefined ? { session } : {}), ...(notes.length ? { notes: [...notes, ...(result.notes ?? [])] } : {}) };
  }

  private async resolveComposed(viewArg: string, panesPerPage?: number, viewportColumns?: number): Promise<ComposedTerminalView | { code: string; error: string }> {
    const view = (viewArg ?? "").trim();
    if (!view) return { code: "view_required", error: "a view argument is required" };
    const resolved = await this.resolveView(view);
    if ("code" in resolved) return resolved;
    const composed = composeView(resolved.id, await this.refineLiveness(resolved.members), { resolveHost: (id) => this.deps.resolveHost(id), panesPerPage: resolved.panesPerPage ?? panesPerPage, localTmux: await this.resolveLocalTmux(), localTmuxServer: daemonTmuxServerArgs() });
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
      return { ...composed, task: resolved.task };
    }
    if (resolved.kernelLayout && Number.isSafeInteger(viewportColumns) && viewportColumns! >= 120) {
      // The default's members are operator, dashboard, advisor. Keep the advisor separate
      // even when one of the other roles is unavailable; chunking two at a time would not.
      const page = (indexes: number[]) => indexes.flatMap(index => composed.opened.filter(pane => pane.seat === resolved.members[index]?.seat));
      const pages = [page([1, 0]), page([2])].filter(panes => panes.length > 0);
      return { ...composed, opened: pages.flat(), pages, kernelLayout: resolved.kernelLayout, columns: 2, spaceLabel: KERNEL_SPACE_LABEL };
    }
    return resolved.kernelLayout ? { ...composed, kernelLayout: resolved.kernelLayout, columns: resolved.columns, spaceLabel: KERNEL_SPACE_LABEL } : composed;
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
    const composed = await this.resolveComposed(req.view, provider.panesPerPage, req.viewportColumns);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    await this.viewerMappings(provider, composed);
    return { provider: providerName, ...(session !== undefined ? { session } : {}), view: req.view, composed, viewDescriptor: composed.viewDescriptor, ...(composed.task ? { task: composed.task } : {}),
      capabilities: { ensureViewer: !!composed.task && !!provider.ensureViewer },
      grids: composed.pages.map(page => buildGridRoot(page, composed.columns)), planId: this.planId(providerName, composed, session), status: await provider.status() };
  }

  private viewerPane(pane: import("./terminal-provider.js").ComposedPane) {
    const original = pane.attachArgv;
    if (!original) return pane;
    const attachArgv = tileAttachArgv(original[5]!, original.slice(6), original[4]!, false);
    return { ...pane, readOnly: false, attachArgv, paneCommand: attachArgv.map(shellQuote).join(" ") };
  }

  private async viewerMappings(provider: TerminalProvider, composed: ComposedView): Promise<void> {
    if (!composed.task || !provider.lookupViewer) return;
    for (const member of composed.task.members) {
      const pane = composed.opened.find(p => p.seat === member.seat);
      if (!pane || !member.key.hostId || !member.key.nodeId) continue;
      const result = await provider.lookupViewer({ hostId: member.key.hostId, nodeId: member.key.nodeId }, this.viewerPane(pane));
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
    const composed = await this.resolveComposed(req.view, selected.provider.panesPerPage, req.viewportColumns);
    if ("code" in composed) return { ok: false, code: composed.code, error: composed.error };
    if (req.expectedPlan !== this.planId(selected.name, composed, selected.session)) return { ok: false, code: "preview_changed", error: "Task membership or attachment changed; refresh the preview before ensuring a viewer." };
    if (!composed.task?.complete) return { ok: false, code: "viewer_unconfirmed", error: "Task membership is incomplete; no viewer was provisioned." };
    const member = composed.task.members.find(m => m.key.hostId === req.member.hostId && m.key.nodeId === req.member.nodeId);
    const pane = member?.availability === "available" && composed.opened.find(p => p.seat === member.seat);
    if (!pane) return { ok: false, code: "viewer_unavailable", error: "This current task member has no verified local terminal attachment." };
    return selected.provider.ensureViewer(req.member, this.viewerPane(pane), async () => {
      const current = await this.resolveComposed(req.view, selected.provider.panesPerPage, req.viewportColumns);
      return !("code" in current) && current.task?.complete === true
        && this.planId(selected.name, current, selected.session) === req.expectedPlan;
    });
  }

  /** List saved views + the rig names openable as derived views. */
  async listViews(detail = false): Promise<ListViewsResult> {
    const result: ListViewsResult = {
      following: this.following?.list() ?? [],
      saved: this.deps.viewsStore.list(),
      rigs: await this.deps.listRigNames(),
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
        ...result.rigs.map((name) => ({ view: `rig:${name}`, name, kind: "derived" as const })),
      ];
      const inventory = await this.deps.listRigSeatsBatch?.(result.rigs);
      for (const entry of entries) {
        const rows = entry.kind === "derived" ? inventory?.get(entry.name) : undefined;
        const plan = rows ? composeView(entry.view, await this.refineLiveness(deriveViewMembers(rows, { readOnly: false })), { resolveHost: id => this.deps.resolveHost(id), panesPerPage: this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage, localTmux: await this.resolveLocalTmux(), localTmuxServer: daemonTmuxServerArgs() })
          : await this.resolveComposed(entry.view, this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage);
        if ("code" in plan) continue;
        result.catalog.push({ ...entry, members: [...plan.opened, ...plan.absent, ...plan.degraded].map((m) => m.seat), ready: plan.opened.length, absent: plan.absent.length, degraded: plan.degraded.length, pages: plan.pages.length });
      }
    }
    return result;
  }

  /** Provider availability + liveness (doctor). Unknown named provider → empty report for it. */
  async status(providerName?: string, session?: string): Promise<TerminalStatusResult> {
    if (session !== undefined) {
      const selected = this.selectProvider({ provider: providerName, session });
      if ("ok" in selected) return { providers: [], error: selected.error, code: selected.code };
      return { following: this.following?.list() ?? [], session: selected.session, providers: [{ name: selected.name,
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
    return { providers, following: this.following?.list() ?? [] };
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
      if (saved) return { id: saved.id, members: saved.members.map(savedMemberToInput) };
      if (view === "saved:kernel") {
        const kernel = await this.defaultKernelView();
        if (kernel) return kernel;
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
    //    a rig name first, then as a rig id.
    const explicitRig = view.startsWith("rig:");
    const rigArg = explicitRig ? view.slice("rig:".length) : view;
    const rigRows = await this.deps.listRigSeats(rigArg);
    if (rigRows != null) {
      return { id: `rig:${rigArg}`, members: deriveViewMembers(rigRows, { readOnly: false }) };
    }
    // An explicit `rig:<x>` that resolves to no rig is a named not-found — it must
    // NOT fall through to the saved-view lookup (the caller asked for a rig).
    if (explicitRig) {
      return { code: "view_not_found", error: `unknown rig '${rigArg}'` };
    }

    // 4. a saved-view id.
    const saved = this.deps.viewsStore.get(view);
    if (saved) {
      return { id: saved.id, members: saved.members.map(savedMemberToInput) };
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
