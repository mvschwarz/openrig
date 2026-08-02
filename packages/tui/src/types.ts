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
}

export interface PodNode {
  name: string;
  agents: AgentRow[];
}

export interface RigNode {
  name: string;
  pods: PodNode[];
}

export interface HostNode {
  name: string;
  reachable: boolean;
  rigs: RigNode[];
}

export type SpecKind = "rig" | "agent" | "workflow";

export interface SpecEntry {
  name: string;
  kind: SpecKind;
  /** rig specs: member agent-refs, each clickable → that agent spec */
  agentRefs?: string[];
  runtime?: string;
  usedByRigs?: string[];
}

export interface NeedsItem {
  kind: string;
  target: string;
  detail: string;
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
  /** grounded composeNeedsYou derived exceptions, VERBATIM (PIN 3) */
  needs: NeedsItem[];
  /** false until the human-queue read has answered — honest-unknown vs proven-empty */
  humanQueueProbed: boolean;
  humanQueue: NeedsItem[];
  hostsDown: HostDown[];
  /** named per-read failures (honest partial hydration, never silent) */
  readErrors: string[];
}

export type GetSnapshot = () => FleetSnapshot;

export type ResourceKind = "host" | "rig" | "pod" | "agent" | "spec";

export interface DrillSegment {
  kind: ResourceKind;
  name: string;
}

export type Action =
  | { type: "noop" }
  | { type: "error"; message: string }
  | { type: "jump"; section: string }
  | { type: "filter"; text: string }
  | { type: "select"; delta?: number; index?: number; rowCount?: number }
  | { type: "activate" }
  | { type: "drill"; resource: ResourceKind; name: string }
  | { type: "cross"; kind: "spec-of" | "running"; name: string };

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
  explorerRows: Array<ExplorerRow & { y: number }>;
}

export type InputEvent =
  | { type: "char"; ch: string }
  | { type: "key"; key: "up" | "down" | "left" | "right"; action: Action }
  | { type: "key"; key: "enter"; action: Action }
  | { type: "key"; key: "backspace" | "escape" }
  | { type: "mouse"; button: number; x: number; y: number };
