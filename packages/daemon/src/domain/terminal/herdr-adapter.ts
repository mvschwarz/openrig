// OPR.0.4.6.02 C2+FB4 — the herdr TerminalProvider (the proof-gated primary
// provider). Arm's-length AGPL: it drives the installed herdr's local control
// SOCKET through the injected `HerdrTransport` (see herdr-transport.ts) and
// never links herdr.
//
// FB4 (the VM-RED correction): herdr 0.7.1 has NO `layout` CLI command — the
// prior CLI shape (`herdr layout apply …`) could never tile (proven RED in the
// VM at e373f741). herdr's real layout mechanism is the socket `layout.apply`,
// validated verbatim in research/herdr-socket-captures/herdr-phase3-*.json:
//   request  {id, method:"layout.apply",
//             params:{workspace_id, tab_label, focus, root}}
//   root     = {type:"split", direction:"right"|"down", ratio, first, second}
//              | {type:"pane", label, command:[argv…]}
//   response {id, result:{type:"layout_apply", layout:{workspace_id, tab_id,…}}}
//
// Behavior contract (unchanged from the guard-cleared shape):
//  - ONE atomic `layout.apply` per grid page — the whole page's panes land in
//    a single request so a page is never half-tiled.
//  - FRESH tab/workspace on every relaunch (BR-5, not-replace-idempotent):
//    each open creates its own workspace (`workspace.create`) and the tab
//    label embeds a per-launch token — and `layout.apply` itself is
//    empirically non-idempotent (the four-reapply capture shows a re-apply
//    minting tab t3, never replacing t2), so a re-open can never clobber a
//    previous view.
//  - Pane labels ride the layout.apply pane nodes' `label` field (AC-7
//    `<agent> · <slice>`) — the captures show the label echoed per pane, so
//    no separate `pane rename` pass is needed (there is no `pane rename` CLI
//    to shell anyway).
//  - The composer's `paneCommand` is a SHELL string (`tmux attach -r -t 's'`,
//    `ssh 'dest' tmux attach …`); the pane node's `command` is an ARGV array —
//    so it is carried as `["sh", "-c", paneCommand]`, preserving the composed
//    quoting byte-for-byte without the adapter re-parsing shell.
//  - Liveness/availability = the socket `ping` (is the multiplexer's OWN
//    control socket answering — NOT a daemon server ping; HERDR-FINDINGS #3's
//    intent, carried to the socket transport). No "layout command" probe: the
//    CLI help surface is irrelevant to the socket API.
//  - SAME-SIZE panes only. The BSP tree below splits 0.5/0.5 alternating
//    right/down; asymmetric pane layouts are a DOCUMENTED limitation, not
//    faked here (the inherent tmux multi-client resize limit).
//
// The `workspace.create` response envelope was NOT captured verbatim (only
// layout.apply/ping were); the workspace id is therefore extracted
// DEFENSIVELY (see extractWorkspaceId) — to be confirmed by the fresh VM
// re-proof (unproven until that proof artifact lands).

import type {
  AbsentSeat,
  ComposedPane,
  ComposedView,
  DegradedSeat,
  OpenViewResult,
  ProviderLiveness,
  ProviderStatus,
  TerminalProvider,
} from "./terminal-provider.js";
import type {
  HerdrResult,
  HerdrTransport,
  HerdrTransportFactory,
} from "./herdr-transport.js";

/** Sentinel host for herdr-surface degrades (a pane herdr itself failed to render). */
const HERDR_SURFACE_HOST = "herdr";

/** A herdr layout-tree pane leaf — `command` is an ARGV array (capture-verified). */
export interface HerdrPaneNode {
  type: "pane";
  label: string;
  command: string[];
}

/** A herdr layout-tree binary split (capture-verified shape). */
export interface HerdrSplitNode {
  type: "split";
  direction: "right" | "down";
  ratio: number;
  first: HerdrLayoutNode;
  second: HerdrLayoutNode;
}

export type HerdrLayoutNode = HerdrPaneNode | HerdrSplitNode;

/**
 * Build the balanced BSP layout tree for one page of panes. PURE. Splits
 * alternate right/down by depth at ratio 0.5 → same-size tiles (the documented
 * v1 layout; asymmetric layouts are out of scope). Each leaf runs the
 * composer's shell `paneCommand` via `["sh","-c",…]` so the composed quoting
 * (read-only `-r`, ssh-wrap) is preserved untouched.
 */
export function buildBspRoot(panes: ComposedPane[], depth = 0): HerdrLayoutNode {
  if (panes.length === 1) {
    const pane = panes[0]!;
    return { type: "pane", label: pane.label, command: ["sh", "-c", pane.paneCommand] };
  }
  const mid = Math.ceil(panes.length / 2);
  return {
    type: "split",
    direction: depth % 2 === 0 ? "right" : "down",
    ratio: 0.5,
    first: buildBspRoot(panes.slice(0, mid), depth + 1),
    second: buildBspRoot(panes.slice(mid), depth + 1),
  };
}

/** The per-page socket request plan — pure, so it is asserted directly in tests. */
export interface HerdrPagePlan {
  /** Fresh tab label for this page (embeds the launch token → fresh-on-relaunch). */
  tabLabel: string;
  /** The whole page's layout tree — ONE atomic layout.apply request body. */
  root: HerdrLayoutNode;
}

export interface HerdrLayoutPlan {
  /** The label for the fresh per-open workspace (same token discipline as tabs). */
  workspaceLabel: string;
  pages: HerdrPagePlan[];
}

/**
 * Build the herdr socket plan for a composed view. PURE — no I/O. Each page
 * gets a fresh tab labeled `${tabPrefix}:${view.id}#${launchToken}/<pageIndex>`;
 * two calls with different `launchToken`s produce DIFFERENT labels, which is
 * exactly the fresh-tab-on-relaunch (not-replace) invariant.
 */
export function planHerdrLayout(
  view: ComposedView,
  launchToken: string,
  tabPrefix: string = "openrig",
): HerdrLayoutPlan {
  const base = `${tabPrefix}:${view.id}#${launchToken}`;
  const pages: HerdrPagePlan[] = view.pages.map((page, pageIndex) => ({
    tabLabel: view.pages.length > 1 ? `${base}/${pageIndex + 1}` : base,
    root: buildBspRoot(page),
  }));
  return { workspaceLabel: base, pages };
}

/**
 * Extract the created workspace's id from a `workspace.create` result body.
 * DEFENSIVE — this envelope was not captured verbatim, so the known plausible
 * homes are tried in order: a top-level `workspace_id`, then a nested
 * `workspace`/`layout` object's `workspace_id`/`id`, then a top-level string
 * `id`. Returns null when nothing string-shaped is found (the caller degrades
 * honestly rather than guessing).
 */
export function extractWorkspaceId(result: HerdrResult): string | null {
  const direct = result["workspace_id"];
  if (typeof direct === "string" && direct) return direct;
  for (const key of ["workspace", "layout"]) {
    const nested = result[key];
    if (nested && typeof nested === "object") {
      const obj = nested as Record<string, unknown>;
      const id = obj["workspace_id"] ?? obj["id"];
      if (typeof id === "string" && id) return id;
    }
  }
  const bare = result["id"];
  if (typeof bare === "string" && bare) return bare;
  return null;
}

export interface HerdrAdapterDeps {
  transportFactory: HerdrTransportFactory;
  /**
   * Mint a fresh launch token per `openView` so a relaunch creates a new tab
   * (BR-5). Injectable for deterministic tests. Default: a per-instance
   * monotonic counter (unique within a daemon lifetime).
   */
  newLaunchToken?: () => string;
  /** Tab-name prefix (default `openrig`). */
  tabPrefix?: string;
}

export class HerdrAdapter implements TerminalProvider {
  readonly name = "herdr";
  private readonly transport: HerdrTransport;
  private readonly newLaunchToken: () => string;
  private readonly tabPrefix: string;
  private launchCounter = 0;

  constructor(private readonly deps: HerdrAdapterDeps) {
    this.transport = deps.transportFactory();
    this.tabPrefix = deps.tabPrefix ?? "openrig";
    this.newLaunchToken =
      deps.newLaunchToken ?? (() => `l${(this.launchCounter += 1)}`);
  }

  async status(): Promise<ProviderStatus> {
    try {
      const probe = await this.transport.probe();
      return {
        provider: this.name,
        available: probe.alive,
        ...(probe.version ? { version: probe.version } : {}),
        // The socket answering ping IS the capability surface: layout.apply is
        // the protocol's layout verb (there is no per-command discovery on
        // 0.7.1 — `api schema` is absent; HERDR-FINDINGS §3).
        capabilities: { socket: probe.alive, "layout.apply": probe.alive },
      };
    } catch {
      // An unreachable socket (herdr not running) = honestly unavailable.
      return { provider: this.name, available: false, capabilities: {} };
    }
  }

  async liveness(): Promise<ProviderLiveness> {
    // Liveness is the multiplexer's OWN control socket answering ping.
    try {
      const probe = await this.transport.probe();
      return probe.alive
        ? { alive: true }
        : { alive: false, detail: "herdr control socket is not answering ping" };
    } catch (err) {
      return { alive: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  async openView(view: ComposedView): Promise<OpenViewResult> {
    const absent: AbsentSeat[] = [...view.absent];
    const degraded: DegradedSeat[] = [...view.degraded];
    const opened: string[] = [];

    // Gate on the socket being alive — the honest "herdr isn't running" refuse.
    // (No CLI-help "layout command" probe: the socket API is the layout surface.)
    const probe = await this.transport.probe();
    if (!probe.alive) {
      return {
        provider: this.name,
        ok: false,
        opened,
        absent,
        degraded,
        pages: 0,
        error: "herdr control socket is not answering ping; is herdr running?",
        code: "herdr_unavailable",
      };
    }

    const launchToken = this.newLaunchToken();
    const plan = planHerdrLayout(view, launchToken, this.tabPrefix);

    // Nothing to tile (an all-absent/degraded view) → no workspace side effect.
    if (plan.pages.length === 0) {
      return {
        provider: this.name,
        ok: view.opened.length === 0,
        opened,
        absent,
        degraded,
        pages: 0,
      };
    }

    // A fresh workspace per open (BR-5 fresh-on-relaunch, strongest form).
    // The labeled create is tried first; because the label param is an
    // uncaptured assumption, a failure falls back ONCE to a bare create
    // before degrading (defensive; to be confirmed by the fresh VM re-proof).
    let workspaceId: string | null = null;
    let createErr: unknown = null;
    try {
      workspaceId = extractWorkspaceId(
        await this.transport.request("workspace.create", {
          focus: false,
          label: plan.workspaceLabel,
        }),
      );
    } catch (err) {
      createErr = err;
    }
    if (workspaceId == null) {
      try {
        workspaceId = extractWorkspaceId(
          await this.transport.request("workspace.create", { focus: false }),
        );
        createErr = null;
      } catch (err) {
        createErr = createErr ?? err;
      }
    }
    if (workspaceId == null) {
      // No workspace → nothing can tile. Degrade every pane honestly.
      const reason = `herdr workspace.create failed: ${
        createErr instanceof Error
          ? createErr.message
          : createErr != null
            ? String(createErr)
            : "no workspace id in the response"
      }`;
      for (const page of view.pages) {
        for (const pane of page) {
          degraded.push({ seat: pane.seat, host: HERDR_SURFACE_HOST, reason });
        }
      }
      return {
        provider: this.name,
        ok: view.opened.length === 0,
        opened,
        absent,
        degraded,
        pages: 0,
        error: reason,
        code: "herdr_workspace_failed",
      };
    }

    for (let pageIndex = 0; pageIndex < plan.pages.length; pageIndex++) {
      const pagePlan = plan.pages[pageIndex]!;
      const pagePanes = view.pages[pageIndex]!;
      try {
        // ONE atomic layout.apply for the whole page (capture-verified shape).
        await this.transport.request("layout.apply", {
          workspace_id: workspaceId,
          tab_label: pagePlan.tabLabel,
          focus: true,
          root: pagePlan.root,
        });
        for (const pane of pagePanes) opened.push(pane.seat);
      } catch (err) {
        // The whole page failed to apply — degrade its seats honestly.
        for (const pane of pagePanes) {
          degraded.push({
            seat: pane.seat,
            host: HERDR_SURFACE_HOST,
            reason: `herdr layout.apply failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
    }

    return {
      provider: this.name,
      ok: opened.length > 0 || view.opened.length === 0,
      opened,
      absent,
      degraded,
      pages: plan.pages.length,
    };
  }
}
