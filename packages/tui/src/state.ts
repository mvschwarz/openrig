// ONE instance-scoped view-state with ONE mutation path (dispatch) — PIN 1.
// No module-level state anywhere in this file (FR-13). The section set is a
// data registry, not a switch (FR-12). Ported from the Phase-0 spike verbatim
// in shape: the parity-by-construction property lives in the reducer resolving
// 'activate' against the SAME row model the renderer draws.
import type {
  Action,
  DrillSegment,
  ExplorerRow,
  FleetSnapshot,
  GetSnapshot,
  SectionDef,
  ViewState,
  ViewStateStore,
} from "./types.js";

export function defaultSections(): SectionDef[] {
  return [
    {
      name: "topology",
      sourceRead: "GET /api/rigs/:id/graph + /api/ps + /api/rigs/summary (existing)",
      drillShape: "host>rig>pod>agent",
    },
    {
      name: "specs",
      sourceRead: "GET /api/specs/library + /api/rigs/:rigId/spec (existing)",
      drillShape: "kind>spec",
    },
    {
      name: "needs",
      sourceRead: "GET /api/review/rig|fleet + /api/queue/list?attention=1 (existing)",
      drillShape: "flat",
    },
  ];
}

export function emptySnapshot(): FleetSnapshot {
  return { hosts: [], specs: [], needs: [], humanQueueProbed: false, humanQueue: [], hostsDown: [], readErrors: [] };
}

export interface CreateViewStateOptions {
  instanceId: string;
  sections?: SectionDef[];
  getSnapshot?: GetSnapshot;
}

export function createViewState(options: CreateViewStateOptions): ViewStateStore {
  const { instanceId, sections = defaultSections(), getSnapshot = emptySnapshot } = options;
  if (!instanceId) throw new Error("createViewState requires an instanceId (A2: instances are addressable)");

  let state: ViewState = {
    instanceId,
    sections,
    section: sections[0]?.name ?? "topology",
    drill: [],
    filter: "",
    selection: 0,
    runningOf: null,
    lastError: null,
  };
  const listeners = new Set<(s: ViewState) => void>();

  function dispatch(action: Action): ViewState {
    state = reduce(state, action, getSnapshot());
    for (const fn of listeners) fn(state);
    return state;
  }

  return {
    instanceId,
    get: () => state,
    dispatch,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function reduce(state: ViewState, action: Action, snap: FleetSnapshot): ViewState {
  const next: ViewState = { ...state, lastError: null };
  switch (action.type) {
    case "noop":
      return next;
    case "error":
      return { ...next, lastError: action.message };
    case "jump": {
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `unknown section "${action.section}"` };
      return { ...next, section: action.section, drill: [], filter: "", selection: 0, runningOf: null };
    }
    case "filter":
      return { ...next, filter: action.text, selection: 0 };
    case "select": {
      const count = Math.max(action.rowCount ?? Number.MAX_SAFE_INTEGER, 1);
      const target = action.index ?? state.selection + (action.delta ?? 0);
      return { ...next, selection: Math.min(Math.max(target, 0), count - 1) };
    }
    case "activate": {
      // Enter activates the selected explorer row — resolved against the SAME
      // row model the renderer draws, so keyboard and mouse cannot diverge.
      const row = computeExplorerRows(state, snap)[state.selection];
      if (!row) return { ...next, lastError: "nothing selected" };
      return reduce(next, row.action, snap);
    }
    case "drill":
      return drillTo(next, action.resource, action.name, snap);
    case "cross":
      return crossNav(next, action.kind, action.name, snap);
    default:
      return { ...next, lastError: "unknown action" };
  }
}

// --- snapshot lookups (pure; no daemon calls here) ---

export function findAgent(snap: FleetSnapshot, name: string) {
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.name === name) return { host, rig, pod, agent };
  return null;
}

export function findSpec(snap: FleetSnapshot, name: string) {
  return snap.specs.find((s) => s.name === name) ?? null;
}

export function findRig(snap: FleetSnapshot, name: string) {
  for (const host of snap.hosts) for (const rig of host.rigs) if (rig.name === name) return { host, rig };
  return null;
}

export function agentsRunningSpec(snap: FleetSnapshot, specName: string): string[] {
  const out: string[] = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.spec === specName) out.push(agent.name);
  return out;
}

function drillTo(state: ViewState, resource: string, name: string, snap: FleetSnapshot): ViewState {
  switch (resource) {
    case "host": {
      if (!snap.hosts.some((h) => h.name === name)) return { ...state, lastError: `no such host "${name}"` };
      return { ...state, section: "topology", drill: [{ kind: "host", name }], selection: 0, runningOf: null };
    }
    case "rig": {
      const found = findRig(snap, name);
      if (!found) return { ...state, lastError: `no such rig "${name}"` };
      return {
        ...state,
        section: "topology",
        drill: [
          { kind: "host", name: found.host.name },
          { kind: "rig", name },
        ],
        selection: 0,
        runningOf: null,
      };
    }
    case "pod": {
      for (const host of snap.hosts)
        for (const rig of host.rigs)
          if (rig.pods.some((p) => p.name === name))
            return {
              ...state,
              section: "topology",
              drill: [
                { kind: "host", name: host.name },
                { kind: "rig", name: rig.name },
                { kind: "pod", name },
              ],
              selection: 0,
              runningOf: null,
            };
      return { ...state, lastError: `no such pod "${name}"` };
    }
    case "agent": {
      const found = findAgent(snap, name);
      if (!found) return { ...state, lastError: `no such agent "${name}"` };
      const drill: DrillSegment[] = [
        { kind: "host", name: found.host.name },
        { kind: "rig", name: found.rig.name },
        { kind: "pod", name: found.pod.name },
        { kind: "agent", name },
      ];
      return { ...state, section: "topology", drill, selection: 0, runningOf: null };
    }
    case "spec": {
      if (!findSpec(snap, name)) return { ...state, lastError: `no such spec "${name}"` };
      return { ...state, section: "specs", drill: [{ kind: "spec", name }], selection: 0, runningOf: null };
    }
    default:
      return { ...state, lastError: `unknown resource "${resource}"` };
  }
}

function crossNav(state: ViewState, kind: "spec-of" | "running", name: string, snap: FleetSnapshot): ViewState {
  if (kind === "spec-of") {
    const found = findAgent(snap, name);
    if (!found) return { ...state, lastError: `no such agent "${name}"` };
    return {
      ...state,
      section: "specs",
      drill: [{ kind: "spec", name: found.agent.spec }],
      selection: 0,
      runningOf: null,
    };
  }
  if (!findSpec(snap, name)) return { ...state, lastError: `no such spec "${name}"` };
  return { ...state, section: "topology", drill: [], runningOf: name, filter: "", selection: 0 };
}

// The explorer row model — pure function of (state, snapshot), shared by the
// reducer ('activate') and the renderer (drawing + hit-map). One source of truth.
export function computeExplorerRows(state: ViewState, snap: FleetSnapshot): ExplorerRow[] {
  const rows: ExplorerRow[] = [];
  for (const section of state.sections) {
    const active = section.name === state.section;
    const label =
      section.name === "topology"
        ? "TOPOLOGY"
        : section.name === "specs"
          ? "SPECS"
          : section.name === "needs"
            ? "NEEDS-YOU"
            : section.name.toUpperCase();
    rows.push({ label: `${active ? "▾" : "▸"} ${label}`, action: { type: "jump", section: section.name } });
    if (!active) continue;
    if (section.name === "topology") {
      for (const host of snap.hosts) {
        rows.push({
          label: `  ▾ ${host.name}${host.reachable ? "" : " (unreachable)"}`,
          action: { type: "drill", resource: "host", name: host.name },
        });
        for (const rig of host.rigs) {
          rows.push({ label: `    ▾ ${rig.name}`, action: { type: "drill", resource: "rig", name: rig.name } });
          for (const pod of rig.pods) {
            rows.push({
              label: `      ▾ ${pod.name} (${pod.agents.length})`,
              action: { type: "drill", resource: "pod", name: pod.name },
            });
            for (const agent of pod.agents)
              rows.push({
                label: `        ● ${agent.name}`,
                action: { type: "drill", resource: "agent", name: agent.name },
              });
          }
        }
      }
    } else if (section.name === "specs") {
      const kinds = ["rig", "agent", "workflow"] as const;
      for (const kind of kinds) {
        const list = snap.specs.filter((s) => s.kind === kind);
        if (list.length === 0) continue;
        rows.push({ label: `  ${kind.toUpperCase()} SPECS (${list.length})`, action: { type: "jump", section: "specs" } });
        for (const spec of list)
          rows.push({ label: `    ▪ ${spec.name}`, action: { type: "drill", resource: "spec", name: spec.name } });
      }
    } else if (section.name === "needs") {
      for (const item of snap.needs)
        rows.push({ label: `  ⚑ ${item.kind}: ${item.target}`, action: { type: "jump", section: "needs" } });
    }
  }
  return rows;
}
