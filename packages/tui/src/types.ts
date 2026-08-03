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

export interface FleetSnapshot {
  hosts: HostNode[];
  specs: SpecEntry[];
  /** grounded composeNeedsYou union in daemon priority order, VERBATIM (PIN 3) */
  needs: NeedsItem[];
  /** false until the human-queue read has answered — honest-unknown vs proven-empty */
  humanQueueProbed: boolean;
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

export type ViewTab = "table" | "overview" | "graph" | "topology" | "configuration" | "yaml";

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

export interface Screen {
  lines: string[];
  hitMap: HitTarget[];
  contentTargets: HitTarget[];
  contentMaxOffset: number;
  explorerRows: Array<ExplorerRow & { y: number }>;
  /** slice-17: token segments for canvas-rendered content rows (keyed by
   * 1-based terminal row) — the paint layer renders them with its own Style;
   * plain(segs) === the row's content text BY CONSTRUCTION (strip-invariant) */
  segRows?: Record<number, Array<{ text: string; token?: import("./theme.js").Token; bold?: boolean }>>;
}

export type InputEvent =
  | { type: "char"; ch: string }
  | { type: "key"; key: "up" | "down" | "left" | "right" | "pageup" | "pagedown"; action: Action }
  | { type: "key"; key: "enter"; action: Action }
  | { type: "key"; key: "backspace" | "escape" }
  | { type: "mouse"; button: number; x: number; y: number };
