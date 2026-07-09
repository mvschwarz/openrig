// OPR.0.4.6.02 C2 — the TerminalProvider abstraction (the CORE seam of the
// terminal-provider ride).
//
// A provider renders an ALREADY-COMPOSED view into its own surface model
// (herdr workspace/tab/pane; cmux workspace/surface). It NEVER composes the
// pane command itself — pane-command composition lives entirely in
// `view-composer.ts`, which emits provider-neutral `ComposedPane.paneCommand`
// strings. The provider's only job is placement + labeling + liveness. This
// split keeps the composition rules (local vs ssh vs http honest-degrade,
// read-only `-r`, paging) in one pure, testable place regardless of which
// provider paints the tiles.
//
// The one shared result shape is `{ opened, absent, degraded }` (BR-6
// honest-partial): a view that can only partially render says so explicitly —
// never a silent omission.

/**
 * A single provider-neutral pane, fully composed. `paneCommand` is the exact
 * shell command the provider runs inside the pane (e.g. `tmux attach -t 's'`
 * or `ssh host tmux attach -r -t 's'`); the provider does not modify it.
 */
export interface ComposedPane {
  /** Canonical session name of the seat this pane attaches to. */
  seat: string;
  /** Human pane label — `<agent> · <slice>` per AC-7. */
  label: string;
  /** The provider-neutral shell command the pane runs. Composed upstream. */
  paneCommand: string;
  /** True when the attach is view-only (`tmux attach -r`) — cross-rig / saved read-only. */
  readOnly: boolean;
}

/** A seat that could not be tiled because it has no live/attachable session. Named, never dropped. */
export interface AbsentSeat {
  seat: string;
  /** Structured host id when the seat is remote; null for a local seat. */
  host: string | null;
  reason: string;
}

/** A seat that is honestly degraded (e.g. an http-registered host that tiles cannot reach over ssh). */
export interface DegradedSeat {
  seat: string;
  /** Structured host id (degrade is always host-driven). */
  host: string;
  reason: string;
}

/**
 * A fully-composed view: the provider-neutral output of `composeView`.
 * `opened` is the flat tiled set; `pages` is that same set chunked into
 * fixed-size grids (one provider tab/workspace per page).
 */
export interface ComposedView {
  id: string;
  opened: ComposedPane[];
  absent: AbsentSeat[];
  degraded: DegradedSeat[];
  /** `opened` chunked into ≤ PANES_PER_PAGE grids; a provider renders one tab per page. */
  pages: ComposedPane[][];
}

/** Provider availability + version + capability map (from a version-adaptive probe). */
export interface ProviderStatus {
  provider: string;
  available: boolean;
  /** Provider version when the probe could determine it; omitted when unknown. */
  version?: string;
  capabilities: Record<string, boolean>;
}

/** Liveness of the provider surface itself (herdr: `herdr status`; NOT a daemon ping). */
export interface ProviderLiveness {
  alive: boolean;
  /** Optional honest detail (why not alive / probe note). */
  detail?: string;
}

/**
 * The result of rendering a composed view. `opened` lists the seats that were
 * actually placed into panes; `absent`/`degraded` carry forward the composer's
 * honest-partial classification (a provider may add its own degrades, e.g. a
 * pane that failed to render). `pages` is the number of grid pages painted.
 */
export interface OpenViewResult {
  provider: string;
  ok: boolean;
  opened: string[];
  absent: AbsentSeat[];
  degraded: DegradedSeat[];
  pages: number;
  /** Present only on a hard provider failure (surface unreachable, layout apply refused). */
  error?: string;
  code?: string;
}

/**
 * The provider contract. Three methods only:
 *  - `status()`   — availability + version + capabilities (version-adaptive probe).
 *  - `liveness()` — is the provider surface itself up right now.
 *  - `openView()` — render an already-composed view into the provider surface.
 *
 * Pane-command composition is deliberately NOT part of this interface.
 */
export interface TerminalProvider {
  readonly name: string;
  status(): Promise<ProviderStatus>;
  liveness(): Promise<ProviderLiveness>;
  openView(view: ComposedView): Promise<OpenViewResult>;
}
