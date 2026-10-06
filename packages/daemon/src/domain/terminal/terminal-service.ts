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
//   1. `mission:<id>` / `slice:<id>`  → derived, LIVE from the review agents
//      band; READ-ONLY by construction (a cross-rig observational grouping —
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

import { composeView, type ViewMemberInput } from "./view-composer.js";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { buildGridRoot } from "./herdr-adapter.js";
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
} from "./terminal-provider.js";

/** The v1 provider name set (herdr = proof-gated primary; cmux = best-effort). */
export type TerminalProviderName = "herdr" | "cmux";
export const DEFAULT_PROVIDER: TerminalProviderName = "herdr";

export interface OpenViewRequest {
  /** Provider name; defaults to herdr when omitted. */
  provider?: string;
  /** The view argument: a rig name | `mission:<id>` | `slice:<id>` | a saved-view id. */
  view: string;
  /** Preview fingerprint. A changed membership/layout must be previewed again. */
  expectedPlan?: string;
}

export interface TerminalPreview {
  provider: string;
  view: string;
  planId: string;
  composed: ComposedView;
  /** The same pure grid roots consumed by the Herder adapter. */
  grids: ReturnType<typeof buildGridRoot>[];
  status: ProviderStatus;
}

/** The `rig terminal views` payload: saved views + the live rig names you can open. */
export interface ListViewsResult {
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
  providers: ProviderStatusReport[];
}

export interface TerminalServiceDeps {
  /** Resolve a provider name to its adapter, or null for an unknown name. */
  resolveProvider(name: string): TerminalProvider | null;
  /** The saved-views store (read paths only from this service). */
  viewsStore: Pick<TerminalViewsStore, "get" | "list">;
  /** Live seats of a rig BY NAME; null when no such rig is known (vs [] = a known-but-empty rig). */
  listRigSeats(rigName: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** One request-local inventory fold for the derived catalog entries. */
  listRigSeatsBatch?(rigNames: string[]): Promise<Map<string, LiveSeatRow[]>> | Map<string, LiveSeatRow[]>;
  /** Live seats of a pod within a rig (by rig name-or-id + pod namespace); null when the rig/pod is unknown. */
  listPodSeats(rigArg: string, podNamespace: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
  /** Live seats for a derived scope (`mission:<id>` | `slice:<id>`); null when the scope is unknown/invalid. */
  listScopeSeats(scope: string): Promise<LiveSeatRow[] | null> | LiveSeatRow[] | null;
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

type ResolvedView = { id: string; members: ViewMemberInput[]; kernelLayout?: string } | { code: string; error: string };
type ComposedTerminalView = ComposedView & { kernelLayout?: string };

export class TerminalService {
  private localTmux?: Promise<string | undefined>;

  constructor(private readonly deps: TerminalServiceDeps) {}

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

  /** Open a view in the chosen provider. Always returns the one shared result shape. */
  async openView(req: OpenViewRequest): Promise<OpenViewResult> {
    const providerName = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const provider = this.deps.resolveProvider(providerName);
    if (!provider) {
      return errorResult(
        providerName,
        "unknown_provider",
        `unknown provider '${providerName}' — expected herdr or cmux`,
      );
    }

    const composed = await this.resolveComposed(req.view, provider.panesPerPage);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    if (req.expectedPlan !== undefined && req.expectedPlan !== this.planId(providerName, composed)) {
      return errorResult(providerName, "preview_changed", "View membership or layout changed. Refresh the preview before Open; nothing was launched.");
    }
    const notes = composed.kernelLayout ? [`Default kernel view: ${composed.kernelLayout}.`] : [];
    if (composed.kernelLayout && composed.opened.length === 0) {
      return {
        ...errorResult(providerName, "kernel_seats_unavailable", `No kernel conversations are attachable: ${composed.absent.map(member => `${member.seat} (${member.reason})`).join("; ")}`),
        absent: composed.absent, degraded: composed.degraded, notes,
      };
    }
    const result = await provider.openView(composed);
    return notes.length ? { ...result, notes: [...notes, ...(result.notes ?? [])] } : result;
  }

  private async resolveComposed(viewArg: string, panesPerPage?: number): Promise<ComposedTerminalView | { code: string; error: string }> {
    const view = (viewArg ?? "").trim();
    if (!view) return { code: "view_required", error: "a view argument is required" };
    const resolved = await this.resolveView(view);
    if ("code" in resolved) return resolved;
    const composed = composeView(resolved.id, await this.refineLiveness(resolved.members), { resolveHost: (id) => this.deps.resolveHost(id), panesPerPage, localTmux: await this.resolveLocalTmux() });
    return resolved.kernelLayout ? { ...composed, kernelLayout: resolved.kernelLayout } : composed;
  }

  private planId(provider: string, composed: ComposedView): string {
    return createHash("sha256").update(JSON.stringify({ provider, composed, grids: composed.pages.map(buildGridRoot) })).digest("hex");
  }

  /** Passive: inventory, local has-session and provider probe only. Never openView. */
  async previewView(req: OpenViewRequest): Promise<TerminalPreview | OpenViewResult> {
    const providerName = (req.provider ?? DEFAULT_PROVIDER).trim() || DEFAULT_PROVIDER;
    const provider = this.deps.resolveProvider(providerName);
    if (!provider) return errorResult(providerName, "unknown_provider", `unknown provider '${providerName}'`);
    const composed = await this.resolveComposed(req.view, provider.panesPerPage);
    if ("code" in composed) return errorResult(providerName, composed.code, composed.error);
    return { provider: providerName, view: req.view, composed, grids: composed.pages.map(buildGridRoot), planId: this.planId(providerName, composed), status: await provider.status() };
  }

  /** List saved views + the rig names openable as derived views. */
  async listViews(detail = false): Promise<ListViewsResult> {
    const result: ListViewsResult = {
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
        const plan = rows ? composeView(entry.view, await this.refineLiveness(deriveViewMembers(rows, { readOnly: false })), { resolveHost: id => this.deps.resolveHost(id), panesPerPage: this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage, localTmux: await this.resolveLocalTmux() })
          : await this.resolveComposed(entry.view, this.deps.resolveProvider(DEFAULT_PROVIDER)?.panesPerPage);
        if ("code" in plan) continue;
        result.catalog.push({ ...entry, members: [...plan.opened, ...plan.absent, ...plan.degraded].map((m) => m.seat), ready: plan.opened.length, absent: plan.absent.length, degraded: plan.degraded.length, pages: plan.pages.length });
      }
    }
    return result;
  }

  /** Provider availability + liveness (doctor). Unknown named provider → empty report for it. */
  async status(providerName?: string): Promise<TerminalStatusResult> {
    const names: string[] = providerName ? [providerName] : ["herdr", "cmux"];
    const providers: ProviderStatusReport[] = [];
    for (const name of names) {
      const p = this.deps.resolveProvider(name);
      if (!p) {
        providers.push({
          name,
          status: { provider: name, available: false, capabilities: {} },
          liveness: { alive: false, detail: `unknown provider '${name}'` },
        });
        continue;
      }
      providers.push({ name, status: await p.status(), liveness: await p.liveness() });
    }
    return { providers };
  }

  /** Resolve a view argument into composer-ready members (precedence in the file header). */
  private async resolveView(view: string): Promise<ResolvedView> {
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
    // 1. derived scope prefixes → live, read-only, never persisted.
    if (view.startsWith("mission:") || view.startsWith("slice:")) {
      const rows = await this.deps.listScopeSeats(view);
      if (rows == null) {
        return { code: "view_not_found", error: `unknown or invalid scope '${view}'` };
      }
      return {
        id: view,
        members: deriveViewMembers(rows, { readOnly: true, labelSuffix: view }),
      };
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
  private async defaultKernelView(): Promise<{ id: string; members: ViewMemberInput[]; kernelLayout: string } | null> {
    const rows = await this.deps.listRigSeats("kernel");
    if (rows == null) return null;
    const advisor = rows.find(row => row.logicalId === "advisor.lead");
    const operator = rows.find(row => row.logicalId === "operator.agent");
    const runtimesKnown = !!advisor?.runtime && !!operator?.runtime;
    const singleRuntime = runtimesKnown && advisor!.runtime === operator!.runtime;
    const kernelLayout = runtimesKnown ? (singleRuntime ? "single-runtime" : "dual-runtime") : "runtime layout unverified; advisor, operator and TUI";
    const roles = ["advisor.lead", ...(!singleRuntime ? ["operator.agent"] : []), "operator.human"];
    const members = roles.map(logicalId => {
      const row = rows.find(row => row.logicalId === logicalId);
      const bound = row && deriveViewMembers([row])[0];
      // An expected role is still visible when there is no attachable binding.
      // Its logical ID names the absence; it is never used as a tmux target.
      return bound ?? { seat: logicalId, label: logicalId, tmuxSession: null, host: null, readOnly: false, alive: false };
    });
    return { id: "kernel", members, kernelLayout };
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
