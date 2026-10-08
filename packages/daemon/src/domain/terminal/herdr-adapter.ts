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
//    it is carried through `sh -c` with Herdr's fixed Claude/Codex detection
//    hint when the live runtime is known, without re-parsing shell quoting.
//  - Liveness/availability = the socket `ping` (is the multiplexer's OWN
//    control socket answering — NOT a daemon server ping; HERDR-FINDINGS #3's
//    intent, carried to the socket transport). No "layout command" probe: the
//    CLI help surface is irrelevant to the socket API.
//  - EQUAL auto-grid cells (OPR.0.4.7.1). The layout tree matches the UI
//    TerminalLauncher suggestLayout shape exactly — cols=ceil(sqrt(N)),
//    rows=ceil(N/cols): N=2 → 2×1, N=5 → 3×2, N=7 → 3×3 (cols×rows) — built
//    as equal right-strips per row combined by equal down-strips, using
//    first-vs-rest ratios (1/N, then 1/(N-1), …; VM pane.layout-verified).
//    The prior alternating-0.5 BSP is retired: it rendered N=7 as 4×2 with
//    one double-width cell. Incomplete rectangles are padded with inert
//    blank panes (cmux's blank-surface precedent); blanks are never
//    reported as opened seats.
//
// The `workspace.create` response envelope is VM-confirmed (OPR.0.4.7.1):
// `result.workspace.workspace_id` + `result.tab.tab_id` + `result.root_pane`.
// Extraction stays null-safe/defensive for older builds (extractWorkspaceId).
// OPR.0.6.0.8: issue #26 is the live evidence the earlier ruling waited for — users
// landed on the create's blank default tab. After layout the adapter focuses the
// first populated tab it knows (tab.focus) and then closes the starting tab (tab.close)
// only when it is known blank: every page applied and reported a tab id, and none is
// the starting tab. Otherwise the starting tab is kept and the result says so. Both methods are in
// herdr 0.7.1's socket API (`herdr tab focus|close <tab_id>`); a refusal of either
// is reported as a note, never as a failed seat.

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
import { autoGridCols } from "../cmux-layout-service.js";

/** Sentinel host for herdr-surface degrades (a pane herdr itself failed to render). */
const HERDR_SURFACE_HOST = "herdr";

/** The degrade reason for a seat whose pane was already gone right after its page applied (#707). */
export const HERDR_PANE_EXITED_REASON = "the pane had already exited when OpenRig checked right after herdr opened it";

/** The note when the pane listing can't confirm a page's panes; its seats stay listed as opened. */
export const HERDR_PANES_UNCONFIRMED_NOTE = "herdr's pane list couldn't confirm the panes after layout, so those seats are listed as opened without that check.";

const normalLabel = (label: string): string => label.trim().replace(/\s+/g, " ");

/** A listed label matches a composed one exactly, or as a prefix (a truncated label, with or without a trailing ellipsis). */
function labelMatches(listed: string, composed: string): boolean {
  const shown = normalLabel(listed).replace(/(…|\.\.\.)$/, "").trimEnd();
  const full = normalLabel(composed);
  return shown.length > 0 && (shown === full || full.startsWith(shown));
}

/**
 * #707 — `layout.apply` acknowledges the tab, not that each pane's command stayed alive. One read of
 * the workspace's panes right after a page applies finds seats whose pane is already gone. There is
 * no wait, so only a pane that exited before this read is seen.
 *
 * It fails safe: a seat is degraded only when the listing positively shows the page's tab, and
 * either another seat's label from the same apply is matched there (so labels compare) or the tab
 * holds nothing but blank filler panes. A missing tab, an empty or unreadable listing, or labels
 * that match nothing keep today's `opened`, with a note.
 */
export async function exitedSeats(
  transport: HerdrTransport,
  workspaceId: string,
  tabId: string,
  pagePanes: ComposedPane[],
  blanks: number,
  notes: string[],
): Promise<Set<string>> {
  const gone = new Set<string>();
  const unconfirmed = (): Set<string> => {
    if (!notes.includes(HERDR_PANES_UNCONFIRMED_NOTE)) notes.push(HERDR_PANES_UNCONFIRMED_NOTE);
    return gone;
  };
  let listed: unknown;
  try {
    listed = (await transport.request("pane.list", { workspace_id: workspaceId }))["panes"];
  } catch {
    return unconfirmed();
  }
  if (!Array.isArray(listed)) return unconfirmed();
  const live = listed.filter((p): p is Record<string, unknown> =>
    p !== null && typeof p === "object" && (p as Record<string, unknown>)["tab_id"] === tabId);
  if (live.length === 0) return unconfirmed();
  if (!live.every((p) => typeof p["label"] === "string")) {
    // Panes without labels can't be told apart, so a loss is only counted.
    const missing = pagePanes.length + blanks - live.length;
    if (missing > 0) notes.push(`${missing} pane(s) exited right after opening. herdr's pane list doesn't say which, so those seats stay listed as opened.`);
    return gone;
  }
  const liveLabels = live.map((p) => p["label"] as string);
  // A seat whose label is blank can't be matched, and can't be told apart from a filler pane.
  const blankSeats = pagePanes.filter((pane) => normalLabel(pane.label) === "");
  // Blank filler panes run `sh` and stay. A tab holding exactly the fillers, all blank-labelled, has
  // lost every seat pane. Labels are read first: a seat label anywhere means this rule doesn't apply,
  // and neither does a blank-labelled seat, which would look like a filler.
  if (blankSeats.length === 0 && live.length === blanks && liveLabels.every((l) => normalLabel(l) === "")) {
    for (const pane of pagePanes) gone.add(pane.seat);
    return gone;
  }
  if (blankSeats.length > 0) unconfirmed();
  if (!pagePanes.some((pane) => liveLabels.some((l) => labelMatches(l, pane.label)))) return unconfirmed();
  const perLabel = new Map<string, ComposedPane[]>();
  for (const pane of pagePanes) {
    const key = normalLabel(pane.label);
    if (key === "") continue; // never attributed; the note above says so
    perLabel.set(key, [...(perLabel.get(key) ?? []), pane]);
  }
  const shared: string[] = [];
  for (const [label, seats] of perLabel) {
    const alive = liveLabels.filter((l) => labelMatches(l, label)).length;
    if (seats.length === 1) {
      if (alive === 0) gone.add(seats[0]!.seat);
    } else if (alive < seats.length) {
      shared.push(label);
    }
  }
  if (shared.length > 0) {
    notes.push(`A pane labelled ${shared.map((l) => `"${l}"`).join(", ")} exited right after opening. Several seats share that label, so they stay listed as opened.`);
  }
  return gone;
}

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
 * Combine N nodes into an equal N-way strip along one direction. PURE.
 * Equal N-way BSP is first-vs-rest at ratio 1/N, recursively 1/(N-1) —
 * NOT midpoint 0.5 (the VM-reproduced defect: alternating 0.5 splits gave
 * N=7 a 4×2 layout with one double-width cell instead of the promised 3×3).
 */
export function equalStrip(nodes: HerdrLayoutNode[], direction: "right" | "down"): HerdrLayoutNode {
  if (nodes.length === 1) return nodes[0]!;
  return {
    type: "split",
    direction,
    ratio: 1 / nodes.length,
    first: nodes[0]!,
    second: equalStrip(nodes.slice(1), direction),
  };
}

/** An inert blank pane — pads an incomplete grid rectangle (cmux's blank-surface precedent). */
function blankPane(): HerdrPaneNode {
  return { type: "pane", label: "", command: ["sh"] };
}

function herdrPaneCommand(pane: ComposedPane): string {
  const agent = pane.runtime === "claude-code" ? "claude" : pane.runtime === "codex" ? "codex" : null;
  return agent ? `env HERDR_AGENT=${agent} ${pane.paneCommand}` : pane.paneCommand;
}

/**
 * Build an equal grid for one page. Explicit columns are capped to its pane
 * count, as in cmux; otherwise use the UI TerminalLauncher `suggestLayout` —
 * cols = ceil(sqrt(N)), rows = ceil(N/cols): N=2 → 2×1, N=5 → 3×2, N=7 → 3×3
 * (cols×rows). An incomplete rectangle is padded with inert blank panes so
 * every cell is the same size; blanks are layout filler only — they are never
 * reported as opened seats. Each real leaf runs the composer's shell
 * `paneCommand` via `["sh","-c",…]` so the composed quoting (read-only `-r`,
 * ssh-wrap) is preserved; a known Claude/Codex runtime adds Herdr's detection
 * hint. Rows are built as equal `right` strips,
 * then combined with equal `down` strips.
 */
export function buildGridRoot(panes: ComposedPane[], columns?: number): { root: HerdrLayoutNode; blanks: number; columns: number; rows: number } {
  const cols = Math.min(columns ?? autoGridCols(panes.length), panes.length || 1);
  const rows = Math.ceil(panes.length / cols);
  const blanks = rows * cols - panes.length;
  const leaves: HerdrLayoutNode[] = panes.map((pane) => ({
    type: "pane",
    label: pane.label,
    command: ["sh", "-c", herdrPaneCommand(pane)],
  }));
  for (let i = 0; i < blanks; i++) leaves.push(blankPane());
  const rowStrips: HerdrLayoutNode[] = [];
  for (let r = 0; r < rows; r++) {
    rowStrips.push(equalStrip(leaves.slice(r * cols, (r + 1) * cols), "right"));
  }
  return { root: equalStrip(rowStrips, "down"), blanks, columns: cols, rows };
}

/** The per-page socket request plan — pure, so it is asserted directly in tests. */
export interface HerdrPagePlan {
  /** Fresh tab label for this page (embeds the launch token → fresh-on-relaunch). */
  tabLabel: string;
  /** The whole page's layout tree — ONE atomic layout.apply request body. */
  root: HerdrLayoutNode;
  /** Inert blank leaves padding the grid rectangle (never reported as opened). */
  blanks: number;
}

export interface HerdrLayoutPlan {
  /** The label for the fresh per-open workspace (same token discipline as tabs). */
  workspaceLabel: string;
  pages: HerdrPagePlan[];
}

/** A named view's tab: its panes' names in reading order, such as "dashboard · operator". */
export function namedTabLabel(page: ComposedPane[]): string {
  return page.map((pane) => pane.label).join(" · ");
}

/**
 * Build the herdr socket plan for a composed view. PURE — no I/O. Each page
 * gets a fresh tab labeled `${tabPrefix}:${view.id}#<plan>#${launchToken}/<pageIndex>`;
 * two calls with different `launchToken`s produce DIFFERENT labels, which is
 * exactly the fresh-tab-on-relaunch (not-replace) invariant.
 */
export function planHerdrLayout(
  view: ComposedView,
  launchToken: string,
  tabPrefix: string = "openrig",
): HerdrLayoutPlan {
  // Older callers without a preview fingerprint still get fresh, non-reusable tabs.
  const base = `${tabPrefix}:${view.id}${view.planId ? `#${view.planId.slice(0, 16)}` : ""}#${launchToken}`;
  // The workspace is named for people: a named view's own label, the rig name for a rig view, else the view id.
  // Tab labels keep the launch token, so every open is still a fresh, distinct space. A named view's
  // tabs carry their panes' names instead; the CLI confirms reuse by live attachments, not labels.
  const workspaceLabel = view.spaceLabel ?? (view.id.startsWith("rig:") ? view.id.slice("rig:".length) : view.id);
  const pages: HerdrPagePlan[] = view.pages.map((page, pageIndex) => {
    const grid = buildGridRoot(page, view.columns);
    return {
      tabLabel: view.spaceLabel ? namedTabLabel(page) : view.pages.length > 1 ? `${base}/${pageIndex + 1}` : base,
      root: grid.root,
      blanks: grid.blanks,
    };
  });
  return { workspaceLabel, pages };
}

/**
 * Extract the created workspace's id from a `workspace.create` result body.
 * The live envelope is VM-confirmed (OPR.0.4.7.1): `result.workspace.
 * workspace_id` + `result.tab.tab_id` + `result.root_pane` — covered by the
 * nested-`workspace` home below. The other defensive homes are retained
 * (top-level `workspace_id`, nested `layout`, bare `id`) for older builds.
 * Returns null when nothing string-shaped is found (the caller degrades
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
  launch?: ProviderStatus["launch"];
  /**
   * Mint a fresh launch token per `openView` so a relaunch creates a new tab
   * (BR-5). Injectable for deterministic tests. Default: a per-instance
   * monotonic counter (unique within a daemon lifetime).
   */
  newLaunchToken?: () => string;
  /** Tab-name prefix (default `openrig`). */
  tabPrefix?: string;
}

/** Herdr lays out 4×4 per tab (OPR.0.6.0.8); cmux keeps the composer default. */
export const HERDR_PANES_PER_PAGE = 16;

/** A `tab_id` from a herdr result body (`result.tab.tab_id`, `result.layout.tab_id`, or top-level). */
export function extractTabId(result: HerdrResult | null | undefined): string | null {
  if (!result) return null;
  if (typeof result["tab_id"] === "string" && result["tab_id"]) return result["tab_id"] as string;
  for (const key of ["tab", "layout"]) {
    const nested = result[key];
    if (nested && typeof nested === "object") {
      const id = (nested as Record<string, unknown>)["tab_id"];
      if (typeof id === "string" && id) return id;
    }
  }
  return null;
}

/** Workspace labels from a `workspace.list` result body; [] when the shape is unknown. */
export function extractWorkspaceLabels(result: HerdrResult | null | undefined): string[] {
  const list = result?.["workspaces"];
  if (!Array.isArray(list)) return [];
  return list.map((w) => (w && typeof w === "object" ? (w as Record<string, unknown>)["label"] : null))
    .filter((l): l is string => typeof l === "string");
}

export class HerdrAdapter implements TerminalProvider {
  readonly name = "herdr";
  readonly panesPerPage = HERDR_PANES_PER_PAGE;
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
        ...(this.deps.launch ? { launch: this.deps.launch } : {}),
        available: probe.alive,
        ...(probe.version ? { version: probe.version } : {}),
        // The socket answering ping IS the capability surface: layout.apply is
        // the protocol's layout verb (there is no per-command discovery on
        // 0.7.1 — `api schema` is absent; HERDR-FINDINGS §3).
        capabilities: { socket: probe.alive, "layout.apply": probe.alive },
      };
    } catch {
      // An unreachable socket (herdr not running) = honestly unavailable.
      return { provider: this.name, available: false, capabilities: {}, ...(this.deps.launch ? { launch: this.deps.launch } : {}) };
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
    // The labeled create is tried first. If herdr refuses it and a workspace with
    // that label already exists, retry once with a numbered suffix and say so;
    // otherwise fall back ONCE to a bare create before degrading.
    const notes: string[] = [];
    let workspaceId: string | null = null;
    let defaultTabId: string | null = null;
    let createErr: unknown = null;
    try {
      const created = await this.transport.request("workspace.create", { focus: false, label: plan.workspaceLabel });
      workspaceId = extractWorkspaceId(created);
      defaultTabId = extractTabId(created);
    } catch (err) {
      createErr = err;
    }
    if (workspaceId == null) {
      let existing: string[] = [];
      try { existing = extractWorkspaceLabels(await this.transport.request("workspace.list", {})); } catch { /* unknown → bare fallback */ }
      if (existing.includes(plan.workspaceLabel)) {
        let n = 2;
        while (existing.includes(`${plan.workspaceLabel} (${n})`)) n++;
        const suffixed = `${plan.workspaceLabel} (${n})`;
        try {
          const created = await this.transport.request("workspace.create", { focus: false, label: suffixed });
          workspaceId = extractWorkspaceId(created);
          defaultTabId = extractTabId(created);
          if (workspaceId != null) {
            createErr = null;
            notes.push(`A workspace named "${plan.workspaceLabel}" already exists, so this one is "${suffixed}".`);
          }
        } catch (err) {
          createErr = createErr ?? err;
        }
      }
    }
    if (workspaceId == null) {
      try {
        const created = await this.transport.request("workspace.create", { focus: false });
        workspaceId = extractWorkspaceId(created);
        defaultTabId = extractTabId(created);
        if (workspaceId != null) notes.push(`herdr refused the workspace name "${plan.workspaceLabel}"; the workspace is unnamed.`);
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

    const appliedTabIds: string[] = [];
    let firstPopulatedTabId: string | null = null;
    // The starting tab is known blank only if every page applied AND reported its tab id:
    // an id-less reply or a failed (possibly still effective) apply may have used it.
    let everyPageKnown = true;
    for (let pageIndex = 0; pageIndex < plan.pages.length; pageIndex++) {
      const pagePlan = plan.pages[pageIndex]!;
      const pagePanes = view.pages[pageIndex]!;
      try {
        // ONE atomic layout.apply for the whole page (capture-verified shape).
        const applied = await this.transport.request("layout.apply", {
          workspace_id: workspaceId,
          tab_label: pagePlan.tabLabel,
          focus: true,
          root: pagePlan.root,
        });
        const tabId = extractTabId(applied);
        // Without a tab id the page's panes can't be told apart from other tabs, so no check runs.
        const gone = tabId
          ? await exitedSeats(this.transport, workspaceId, tabId, pagePanes, pagePlan.blanks, notes)
          : new Set<string>();
        if (tabId) {
          appliedTabIds.push(tabId);
          if (pagePanes.some((pane) => !gone.has(pane.seat))) firstPopulatedTabId ??= tabId;
        } else everyPageKnown = false;
        for (const pane of pagePanes) {
          if (gone.has(pane.seat)) degraded.push({ seat: pane.seat, host: HERDR_SURFACE_HOST, reason: HERDR_PANE_EXITED_REASON });
          else opened.push(pane.seat);
        }
      } catch (err) {
        everyPageKnown = false;
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

    // Land on a known populated tab, then remove the create's starting tab (#26) only when it is
    // known to be blank. When that is uncertain the tab is kept: closing it could remove seats.
    if (opened.length > 0) {
      if (firstPopulatedTabId) {
        try { await this.transport.request("tab.focus", { tab_id: firstPopulatedTabId }); }
        catch (err) { notes.push(`herdr did not focus the first tab: ${err instanceof Error ? err.message : String(err)}`); }
      } else {
        notes.push("herdr returned no tab id for any page, so no tab was focused explicitly.");
      }
      if (defaultTabId) {
        if (!everyPageKnown) {
          notes.push("The starting tab was kept because it could not be confirmed empty.");
        } else if (!appliedTabIds.includes(defaultTabId)) {
          try { await this.transport.request("tab.close", { tab_id: defaultTabId }); }
          catch (err) { notes.push(`herdr kept the blank starting tab: ${err instanceof Error ? err.message : String(err)}`); }
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
      ...(notes.length ? { notes } : {}),
    };
  }
}
