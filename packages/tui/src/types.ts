// Core types for the mission-control TUI. The TUI is a renderer + navigation
// shell over the daemon's EXISTING projections (two-renderers-over-one-
// projection); FleetSnapshot is the render-side shape those reads hydrate —
// it introduces no new data model.

export interface AgentRow {
  name: string;
  runtime: string;
  spec: string;
  /** null = the projection has no value → renders honest-unknown, never fabricated (PIN 2) */
  context: number | null;
  tokens: string | null;
  status: string;
  /** lifecycle truth, separate from the displayed activity status */
  live: boolean;
  /** whether the lifecycle restore action is valid */
  canRun?: boolean;
  /** canonicalSessionName where served — joins Needs-You targets to topology */
  session?: string | null;
  /** served tmuxAttachCommand, displayed verbatim in the detail view (web parity) */
  attach?: string | null;
  /** served working directory (S19 MR4 §D9 — full absolute path, verbatim) */
  cwd?: string | null;
  /** served terminalActive VERBATIM (S19 round-5): tmux #{window_activity}
   * within the daemon's silence window — the substrate whose false→true
   * transition means real new pane output; null = no signal */
  paneActive?: boolean | null;
}

export interface PodNode {
  name: string;
  agents: AgentRow[];
}

export interface RigNode {
  /** daemon rig id; absent only in static demo fixtures */
  id?: string;
  name: string;
  pods: PodNode[];
  /** the rig's served graph projection (§4.A topology row 1 — a DECLARED
   * existing read via daemon-client.rigGraph; slice-17 view consumes it, R7-clean) */
  graph?: import("./topology/graph-types.js").RigGraph;
  /** served rig lifecycleState verbatim (summary read); non-"running" states surface */
  lifecycleState?: string;
}

export interface HostNode {
  name: string;
  reachable: boolean;
  rigs: RigNode[];
}

export type SpecKind = "rig" | "agent" | "workflow";

export interface RigSpecMember {
  id: string;
  agentRef: string;
  runtime: string;
  profile?: string;
}

export interface RigSpecEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RigSpecPod {
  id: string;
  namespace?: string;
  label?: string;
  members: RigSpecMember[];
  edges: RigSpecEdge[];
}

export interface AgentSpecResources {
  skills: string[];
  guidance: string[];
  plugins: string[];
  subagents: string[];
}

export interface SpecGraphData {
  nodes: Array<{ id: string; label: string; pod?: string; runtime: string; kind: "agent" | "infrastructure" }>;
  edges: Array<{ source: string; target: string; kind: string }>;
}

export interface SpecEntry {
  name: string;
  kind: SpecKind;
  /** rig specs: member agent-refs, each clickable → that agent spec */
  agentRefs?: string[];
  runtime?: string;
  usedByRigs?: string[];
  /** structured detail from existing reads (library list + /:id/review), verbatim */
  version?: string;
  sourceState?: "draft" | "file_preview" | "library_item";
  sourceType?: "builtin" | "user_file";
  sourcePath?: string;
  relativePath?: string;
  /** Agent library folder grouping, e.g. review/ or orchestration/. */
  namespace?: string;
  description?: string;
  skills?: string[];
  hasGuidance?: boolean;
  startupFiles?: Array<{ path: string; required: boolean }>;
  profiles?: string[];
  resources?: AgentSpecResources;
  format?: "pod_aware" | "legacy";
  pods?: RigSpecPod[];
  edges?: RigSpecEdge[];
  graph?: SpecGraphData;
  raw?: string;
  legacyNodes?: Array<{ id: string; runtime: string; role?: string; model?: string }>;
  /** workflow library entries (served on the library list read) */
  rolesCount?: number;
  stepsCount?: number;
  workflowStatus?: string;
}

export interface NeedsItem {
  /** Preserve the daemon's ordered union while retaining presentation semantics. */
  source: "agent" | "derived";
  kind: string;
  target: string;
  detail: string;
  /** fleet provenance; required to prevent a remote row opening a local twin */
  hostId?: string;
}

/** Host/rig-down rows — composed BESIDE the Needs-You items at render, never
 * projected into the item shape (§4.A: composeNeedsYou supplies no host rows). */
export interface HostDown {
  hostId: string;
  status: string;
  error?: string;
}

/** TUI-local read shape for the PULSE exception joins — the subset of the
 * daemon QueueItem (queue-repository.ts) the two LIVE joins consume. Carried
 * VERBATIM from the shipped queue-list reads (attention → NEEDS YOU;
 * state=blocked → BLOCKED ON AGENTS; the client wrappers own the routes). The
 * daemon applies both filters, so the TUI only maps + presents (no threshold,
 * no synthesis). `body` is present for the NEEDS-YOU subject fallback
 * (summary → body head). */
export interface QueueRead {
  qitemId: string;
  state: string;
  destinationSession: string;
  blockedOn: string | null;
  handedOffTo: string | null;
  tier: string | null;
  tags: string[] | null;
  summary: string | null;
  body: string;
  claimedAt: string | null;
  tsUpdated: string;
  /** BLOCKED ON AGENTS label==referent: blockedOn is a qitem id for agent-blocks
   * (a session only for human-park), so the blocking AGENT is that qitem's owner.
   * hydrate resolves it via the shipped single-qitem daemon read (a bounded
   * per-row lookup) and stamps the owner session here; null when unresolved (gate
   * name / lookup miss) — the render falls back to the raw blockedOn, never fabricates. */
  blockerSession?: string | null;
}

/** One seat's ps/activity summary — the PULSE ◌ PARKED WITH BATON join's right
 * side, carried VERBATIM from the shipped nodes read (attachTerminalActivityAndWork).
 * `terminalActive`: the shipped idle boolean (false = silent past the window = the
 * "idle owner" gate; null = NO signal → honest-unknown, NEVER treated as idle).
 * `lastActivityAt`: the RAW window_activity fact (arch 3a947fb1) — owner idle-age
 * is a VIEW derived at the renderer from this + the reader clock, never here. */
export interface SeatActivitySummary {
  session: string;
  /** the seat's COMPACT canonical id (podNamespace.memberId, e.g. "dev50.driver")
   * — served VERBATIM as node.logicalId on the SAME nodes read (it is the agent
   * NAME the TABLE view already renders, hydrate.ts toAgentRow). The PULSE lane
   * form (r1 mock-authority ruling) shows this short id; the full `session` is
   * recovered on drill-in. Carried, never reconstructed from the session string
   * (namespaces/members may contain hyphens → a split would be lossy). */
  logicalId: string;
  terminalActive: boolean | null;
  lastActivityAt: string | null;
}

export interface FleetSnapshot {
  hosts: HostNode[];
  specs: SpecEntry[];
  /** grounded composeNeedsYou union in daemon priority order, VERBATIM (PIN 3) */
  needs: NeedsItem[];
  /** false until the human-queue read has answered — honest-unknown vs proven-empty */
  humanQueueProbed: boolean;
  /** PULSE ▲ NEEDS YOU source — the shipped attention read (already the exact
   * human-facing set); empty array = the join ran and yielded zero (silence). */
  attention: QueueRead[];
  /** PULSE ⧗ BLOCKED ON AGENTS source — the shipped state=blocked read (ALL
   * blocked qitems); the render filters to NON-human blockedOn. */
  blocked: QueueRead[];
  /** PULSE ◌ PARKED WITH BATON source — the shipped state=in-progress read (ALL
   * in-progress qitems); the render joins each to its owner's seatActivity and
   * keeps only IDLE (terminalActive===false), NOT-handed-off owners. */
  inProgress: QueueRead[];
  /** Per-seat ps/activity (the PARKED join's right side), one entry per running
   * agent seat with a canonical session, from the shipped nodes read. */
  seatActivity: SeatActivitySummary[];
  /** PULSE UP NEXT source (increment 3) — the shipped state=pending read
   * (unclaimed backlog). Carried in the daemon's served order (ts_created DESC);
   * the render keeps only unclaimed (claimedAt null) and caps for display. */
  pending: QueueRead[];
  /** PULSE JUST FINISHED source (increment 3) — the shipped
   * state=done,handed-off read (a bounded recent WINDOW; no fleet-wide
   * finish-time-ordered transitions endpoint exists — the served order is
   * ts_created, so the render re-sorts by tsUpdated DESC for newest-finished-first). */
  recentlyFinished: QueueRead[];
  /** When THIS snapshot finished hydrating (TUI render-time fact, not a daemon
   * read) — the PULSE footer "updated Ns ago" freshness. Absent before the first
   * hydration (emptySnapshot) → the footer renders an honest "—", never a fake age. */
  hydratedAt?: string;
  hostsDown: HostDown[];
  /** latest ambient stream items for the footer ticker (FR-10), newest last */
  stream: Array<{ tsEmitted: string; sourceSession: string; body: string }>;
  /** named per-read failures (honest partial hydration, never silent) */
  readErrors: string[];
}

export type GetSnapshot = () => FleetSnapshot;

export type ResourceKind = "host" | "rig" | "pod" | "agent" | "spec";

export interface ResourceTarget {
  host: string;
  rig?: string;
  pod?: string;
}

export interface DrillSegment {
  kind: ResourceKind;
  name: string;
}

export type ViewTab = "table" | "overview" | "graph" | "topology" | "configuration" | "yaml" | "pulse";

export type Action =
  | { type: "noop" }
  | { type: "error"; message: string }
  | { type: "jump"; section: string }
  | { type: "filter"; text: string }
  | { type: "select"; delta?: number; index?: number; rowCount?: number }
  | { type: "activate" }
  | { type: "drill"; resource: ResourceKind; name: string; target?: ResourceTarget }
  | { type: "cross"; kind: "spec-of" | "running"; name: string; target?: ResourceTarget }
  | { type: "tab"; tab: ViewTab }
  | { type: "content-scroll"; delta: number }
  | { type: "focus"; pane: "explorer" | "content" }
  | { type: "content-select"; delta?: number; index?: number }
  | { type: "layout"; contentMaxOffset: number; contentTargetCount: number }
  | { type: "footer"; on?: boolean }
  | { type: "toggle-expand"; key: string }
  /** slice-17: the graph-render style dimension rides the command bar */
  | { type: "style"; name: string }
  /** drive-structure daemon writes (BR-8/BR-9): executed by the driver loop
   * against EXISTING write contracts; never a view-state mutation */
  | { type: "act"; act: "open-terminal"; view: string }
  | { type: "act"; act: "run"; rigId: string; agent: string }
  | { type: "notice"; message: string };

/** FR-12: the section set is ONE in-code registry — adding a section is a
 * localized edit to this data structure, never a scattered switch. */
export interface SectionDef {
  name: string;
  /** provenance note: which EXISTING daemon read feeds it (the R7 no-new-data trail) */
  sourceRead: string;
  drillShape: string;
}

export interface ViewState {
  instanceId: string;
  sections: SectionDef[];
  section: string;
  drill: DrillSegment[];
  filter: string;
  selection: number;
  runningOf: string | null;
  viewTab: ViewTab;
  contentOffset: number;
  contentMaxOffset: number;
  contentTargetCount: number;
  contentSelection: number;
  focusedPane: "explorer" | "content";
  /** slice-17 graph view render style (hatchet mainline per the founder verdict) */
  graphStyle: string;
  /** the rig-stream footer is ambient: toggleable, never a navigable view (FR-10) */
  footerOn: boolean;
  /** explorer expansion keys (pod:…, folder:…) — default-collapsed levels open on demand */
  expanded: string[];
  /** transient result line from an executed act (daemon reply, verbatim) */
  notice: string | null;
  lastError: string | null;
}

export interface ViewStateStore {
  instanceId: string;
  get(): ViewState;
  dispatch(action: Action): ViewState;
  subscribe(fn: (state: ViewState) => void): () => void;
}

export interface ExplorerRow {
  label: string;
  action: Action;
  /** stable identity — selection sync finds the row for the current location */
  key?: string;
}

export interface HitTarget {
  y: number;
  x1: number;
  x2: number;
  action: Action;
}

/** S19 round-5 (guard): the refresh owner's honest load lifecycle — the ONLY
 * state the loading spinner may ride (data absence is not a lifecycle fact) */
export interface LoadState {
  /** a hydrate refresh is running right now */
  inFlight: boolean;
  /** at least one refresh has completed (success or failure) */
  settled: boolean;
}

/** S19 round-5 (guard): one seat's fresh pane-output event — key matches the
 * agent's stable explorer-row key; at = owner clock ms when observed */
export interface RowFlash {
  key: string;
  at: number;
}

export interface Screen {
  lines: string[];
  hitMap: HitTarget[];
  contentTargets: HitTarget[];
  contentMaxOffset: number;
  explorerRows: Array<ExplorerRow & { y: number }>;
  /** slice-17: token segments for canvas-rendered content rows (keyed by
   * 1-based terminal row) — the paint layer renders them with its own Style;
   * plain(segs) === the row's content text BY CONSTRUCTION (strip-invariant) */
  segRows?: Record<number, Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token; inverse?: boolean }>>;
  /** S19: explorer seg-run channel — a row's paint runs (round-4: status
   * badge + right meta) carry their own tokens through stylization (keyed by
   * 1-based row; start = column within the LEFT cell after the selection-
   * marker slot; runs are in ascending start order) */
  explorerMeta?: Record<number, Array<{ start: number; segs: Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean; bg?: import("./theme.js").Token; inverse?: boolean }> }>>;
  /** S19 round-5 (guard): 1-based terminal rows whose agent produced fresh
   * PANE OUTPUT inside the one-shot flash window — stylize inverts exactly
   * these rows (the tmux-style activity row flash) */
  flashRows?: number[];
  /** true when this frame contains time-driven motion (spinner frame or an
   * un-expired flash) — the entry loop keeps redrawing while set */
  motionActive?: boolean;
}

export type InputEvent =
  | { type: "char"; ch: string }
  | { type: "key"; key: "up" | "down" | "left" | "right" | "pageup" | "pagedown"; action: Action }
  | { type: "key"; key: "enter"; action: Action }
  | { type: "key"; key: "backspace" | "escape" }
  | { type: "mouse"; button: number; x: number; y: number };
