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
import { SECTION_REGISTRY } from "./sections.js";
import { GRAPH_STYLE_NAMES } from "./topology/render-graph.js";

export function defaultSections(): SectionDef[] {
  return SECTION_REGISTRY.map((section) => ({ ...section }));
}

export function emptySnapshot(): FleetSnapshot {
  return { hosts: [], specs: [], needs: [], humanQueueProbed: false, hostsDown: [], stream: [], readErrors: [] };
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
    viewTab: "table",
    // Phase-2 DECISION RULE EXECUTED (founder pre-ratified): the clean-box
    // braille attempt SOLVED → braille = primary, hatchet one command away
    // (`style hatchet`). Residual: braille is TIER-2 (font-dependent) — the
    // decision record carries that caveat to the founder via pm.
    graphStyle: "braille",
    contentOffset: 0,
    contentMaxOffset: 0,
    contentTargetCount: 0,
    contentSelection: 0,
    focusedPane: "explorer",
    footerOn: true,
    expanded: [],
    notice: null,
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
  const next: ViewState = { ...state, lastError: null, notice: action.type === "notice" || action.type === "act" ? state.notice : null };
  switch (action.type) {
    case "noop":
      return next;
    case "error":
      return { ...next, lastError: action.message };
    case "jump": {
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `unknown section "${action.section}"` };
      return syncSelection(
        resetContent({ ...next, section: action.section, drill: [], filter: "", runningOf: null, viewTab: "table" }),
        snap,
      );
    }
    case "style": {
      // slice-17: validated against the graph-style registry — the ONE
      // failure surface for every input adapter (same rule as sections)
      if (!(GRAPH_STYLE_NAMES as readonly string[]).includes(action.name))
        return { ...next, lastError: `unknown style "${action.name}" — known: ${GRAPH_STYLE_NAMES.join(", ")}` };
      return { ...next, graphStyle: action.name };
    }
    case "toggle-expand": {
      const expanded = state.expanded.includes(action.key)
        ? state.expanded.filter((key) => key !== action.key)
        : [...state.expanded, action.key];
      return { ...next, expanded };
    }
    case "tab": {
      const rigSpec = state.section === "specs" && state.drill.at(-1)?.kind === "spec" && findSpec(snap, state.drill.at(-1)!.name)?.kind === "rig";
      const allowed = rigSpec ? ["topology", "configuration", "yaml"] : state.section === "topology" ? ["table", "overview", "graph"] : [];
      if (!allowed.includes(action.tab)) return { ...next, lastError: `tab ${action.tab} is not available in this content context` };
      return resetContent({ ...next, viewTab: action.tab });
    }
    case "content-scroll":
      return { ...next, contentOffset: Math.min(Math.max(0, state.contentOffset + action.delta), state.contentMaxOffset) };
    case "focus":
      return { ...next, focusedPane: action.pane };
    case "content-select": {
      const count = Math.max(state.contentTargetCount, 1);
      const target = action.index ?? state.contentSelection + (action.delta ?? 0);
      return { ...next, contentSelection: Math.min(Math.max(target, 0), count - 1) };
    }
    case "layout":
      return {
        ...next,
        contentMaxOffset: Math.max(action.contentMaxOffset, 0),
        contentTargetCount: Math.max(action.contentTargetCount, 0),
        contentOffset: Math.min(state.contentOffset, Math.max(action.contentMaxOffset, 0)),
        contentSelection: Math.min(state.contentSelection, Math.max(action.contentTargetCount - 1, 0)),
      };
    case "footer":
      return { ...next, footerOn: action.on ?? !state.footerOn };
    case "act":
      // Acts are daemon writes executed by the driver loop, never view-state
      // mutations — the view is untouched; the loop reports via 'notice'.
      return next;
    case "notice":
      return { ...next, notice: action.message };
    case "filter":
      return resetContent({ ...next, filter: action.text, selection: 0 });
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
    case "drill": {
      const drilled = drillTo(next, action.resource, action.name, snap, action.target);
      if (drilled.lastError) return drilled;
      const spec = action.resource === "spec" ? findSpec(snap, action.name) : null;
      // filters are VIEW-scoped: a drill that crosses sections clears the old
      // section's filter (founder direct-drive catch — a specs filter leaked
      // into the topology table and blanked it)
      const filter = drilled.section === state.section ? drilled.filter : "";
      return syncSelection(resetContent({ ...drilled, filter, viewTab: spec?.kind === "rig" ? "configuration" : "table" }), snap);
    }
    case "cross": {
      const crossed = crossNav(next, action.kind, action.name, snap, action.target);
      if (crossed.lastError) return crossed;
      const filter = crossed.section === state.section ? crossed.filter : "";
      return syncSelection({ ...crossed, filter }, snap);
    }
    default:
      return { ...next, lastError: "unknown action" };
  }
}

function resetContent(state: ViewState): ViewState {
  return { ...state, contentOffset: 0, contentMaxOffset: 0, contentTargetCount: 0, contentSelection: 0, focusedPane: "explorer" };
}

/** The explorer key for the state's current location (drill leaf or section). */
export function locationKey(state: ViewState): string {
  const names = new Map(state.drill.map((seg) => [seg.kind, seg.name]));
  const leaf = state.drill.at(-1);
  if (!leaf || state.runningOf) return `section:${state.section}`;
  switch (leaf.kind) {
    case "host":
      return `host:${leaf.name}`;
    case "rig":
      return `rig:${names.get("host")}/${leaf.name}`;
    case "pod":
      return `pod:${names.get("host")}/${names.get("rig")}/${leaf.name}`;
    case "agent":
      return `agent:${names.get("host")}/${names.get("rig")}/${names.get("pod")}/${leaf.name}`;
    case "spec":
      return `spec:${leaf.name}`;
    default:
      return `section:${state.section}`;
  }
}

/** ROUND-4 items 2-4: after navigation the explorer highlight lands ON the
 * opened item and STAYS there — auto-expanding whatever level hides it. */
function syncSelection(state: ViewState, snap: FleetSnapshot): ViewState {
  const expanded = new Set(state.expanded);
  const names = new Map(state.drill.map((seg) => [seg.kind, seg.name]));
  if (names.has("pod")) expanded.add(`pod:${names.get("host")}/${names.get("rig")}/${names.get("pod")}`);
  const leaf = state.drill.at(-1);
  if (leaf?.kind === "spec") {
    const spec = findSpec(snap, leaf.name);
    if (spec?.kind === "agent" && spec.namespace) expanded.add(`folder:${spec.namespace}`);
  }
  const withExpansion = { ...state, expanded: [...expanded] };
  const key = locationKey(withExpansion);
  const index = computeExplorerRows(withExpansion, snap).findIndex((row) => row.key === key);
  return index >= 0 ? { ...withExpansion, selection: index } : withExpansion;
}

// --- snapshot lookups (pure; no daemon calls here) ---

function agentMatches(snap: FleetSnapshot, name: string, target?: { host: string; rig?: string; pod?: string }) {
  const matches = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if (agent.name === name && (!target || (host.name === target.host && (!target.rig || rig.name === target.rig) && (!target.pod || pod.name === target.pod))))
            matches.push({ host, rig, pod, agent });
  return matches;
}

export function findAgent(snap: FleetSnapshot, name: string, target?: { host: string; rig?: string; pod?: string }) {
  const matches = agentMatches(snap, name, target);
  return matches.length === 1 ? matches[0]! : null;
}

export function findSpec(snap: FleetSnapshot, name: string) {
  return snap.specs.find((s) => s.name === name) ?? null;
}

/** Joins a Needs-You target (a session name) back to the topology agent. */
export function findAgentBySession(snap: FleetSnapshot, session: string, hostId?: string) {
  const matches = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents)
          if (agent.session === session && (!hostId || host.name === hostId)) matches.push({ host, rig, pod, agent });
  return matches.length === 1 ? matches[0]! : null;
}

function rigMatches(snap: FleetSnapshot, name: string, hostName?: string) {
  return snap.hosts.flatMap((host) => host.rigs
    .filter((rig) => rig.name === name && (!hostName || host.name === hostName))
    .map((rig) => ({ host, rig })));
}

export function findRig(snap: FleetSnapshot, name: string, hostName?: string) {
  const matches = rigMatches(snap, name, hostName);
  return matches.length === 1 ? matches[0]! : null;
}

export function agentsRunningSpec(snap: FleetSnapshot, specName: string): string[] {
  return agentsRunningSpecTargets(snap, specName).map(({ agent }) => agent.name);
}

export function agentsRunningSpecTargets(snap: FleetSnapshot, specName: string) {
  const out = [];
  for (const host of snap.hosts)
    for (const rig of host.rigs)
      for (const pod of rig.pods)
        for (const agent of pod.agents) if (agent.live && agent.spec === specName) out.push({ host, rig, pod, agent });
  return out;
}

function drillTo(state: ViewState, resource: string, name: string, snap: FleetSnapshot, target?: { host: string; rig?: string; pod?: string }): ViewState {
  switch (resource) {
    case "host": {
      if (!snap.hosts.some((h) => h.name === name)) return { ...state, lastError: `no such host "${name}"` };
      return { ...state, section: "topology", drill: [{ kind: "host", name }], selection: 0, runningOf: null };
    }
    case "rig": {
      const qualified = !target ? parseQualified(name, 2) : null;
      const rigName = qualified?.at(-1) ?? name;
      const hostName = qualified?.[0] ?? target?.host;
      const matches = rigMatches(snap, rigName, hostName);
      if (matches.length > 1) return { ...state, lastError: `ambiguous rig "${name}" — use rig <host>/<rig>` };
      const found = matches[0];
      if (!found) return { ...state, lastError: `no such rig "${name}"` };
      return {
        ...state,
        section: "topology",
        drill: [
          { kind: "host", name: found.host.name },
          { kind: "rig", name: rigName },
        ],
        selection: 0,
        runningOf: null,
      };
    }
    case "pod": {
      const qualified = !target ? parseQualified(name, 3) : null;
      const podName = qualified?.at(-1) ?? name;
      const hostName = qualified?.[0] ?? target?.host;
      const rigName = qualified?.[1] ?? target?.rig;
      const matches = [];
      for (const host of snap.hosts)
        for (const rig of host.rigs)
          for (const pod of rig.pods)
            if (pod.name === podName && (!hostName || host.name === hostName) && (!rigName || rig.name === rigName)) matches.push({ host, rig, pod });
      if (matches.length > 1) return { ...state, lastError: `ambiguous pod "${name}" — use pod <host>/<rig>/<pod>` };
      const found = matches[0];
      if (found) return {
        ...state,
        section: "topology",
        drill: [
          { kind: "host", name: found.host.name },
          { kind: "rig", name: found.rig.name },
          { kind: "pod", name: podName },
        ],
        selection: 0,
        runningOf: null,
      };
      return { ...state, lastError: `no such pod "${name}"` };
    }
    case "agent": {
      const qualified = !target ? parseQualifiedAgent(name) : null;
      const agentName = qualified?.name ?? name;
      const exactTarget = qualified?.target ?? target;
      const matches = agentMatches(snap, agentName, exactTarget);
      if (matches.length > 1) return { ...state, lastError: `ambiguous agent "${name}" — use agent <host>/<rig>/<pod>/<agent>` };
      const found = matches[0];
      if (!found) return { ...state, lastError: `no such agent "${name}"` };
      const drill: DrillSegment[] = [
        { kind: "host", name: found.host.name },
        { kind: "rig", name: found.rig.name },
        { kind: "pod", name: found.pod.name },
        { kind: "agent", name: agentName },
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

function parseQualifiedAgent(value: string): { name: string; target: { host: string; rig: string; pod: string } } | null {
  const [host, rig, pod, ...agentParts] = value.split("/");
  if (!host || !rig || !pod || agentParts.length === 0) return null;
  return { name: agentParts.join("/"), target: { host, rig, pod } };
}

function parseQualified(value: string, count: number): string[] | null {
  const parts = value.split("/");
  return parts.length === count && parts.every(Boolean) ? parts : null;
}

function crossNav(state: ViewState, kind: "spec-of" | "running", name: string, snap: FleetSnapshot, target?: { host: string; rig?: string; pod?: string }): ViewState {
  if (kind === "spec-of") {
    const qualified = !target ? parseQualifiedAgent(name) : null;
    const agentName = qualified?.name ?? name;
    const matches = agentMatches(snap, agentName, qualified?.target ?? target);
    if (matches.length > 1) return { ...state, lastError: `ambiguous agent "${name}" — use spec-of <host>/<rig>/<pod>/<agent>` };
    const found = matches[0];
    if (!found) return { ...state, lastError: `no such agent "${name}"` };
    if (!findSpec(snap, found.agent.spec)) return { ...state, lastError: `spec "${found.agent.spec}" not in the library` };
    return resetContent({
      ...state,
      section: "specs",
      drill: [{ kind: "spec", name: found.agent.spec }],
      selection: 0,
      runningOf: null,
      viewTab: "table",
    });
  }
  if (!findSpec(snap, name)) return { ...state, lastError: `no such spec "${name}"` };
  return resetContent({ ...state, section: "topology", drill: [], runningOf: name, filter: "", selection: 0, viewTab: "table" });
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
    rows.push({ label: `${active ? "▾" : "▸"} ${label}`, action: { type: "jump", section: section.name }, key: `section:${section.name}` });
    if (!active) continue;
    if (section.name === "topology") {
      // ROUND-4 item 4: rigs + pods by default; agents appear when a pod is
      // expanded (drilling a pod expands it) — "tighter visually".
      const expanded = new Set(state.expanded);
      for (const host of snap.hosts) {
        rows.push({
          label: `  ▾ ${host.name}${host.reachable ? "" : " (unreachable)"}`,
          action: { type: "drill", resource: "host", name: host.name },
          key: `host:${host.name}`,
        });
        for (const rig of host.rigs) {
          const stateSuffix = rig.lifecycleState && rig.lifecycleState !== "running" ? ` (${rig.lifecycleState})` : "";
          rows.push({
            label: `    ▾ ${rig.name}${stateSuffix}`,
            action: { type: "drill", resource: "rig", name: rig.name, target: { host: host.name } },
            key: `rig:${host.name}/${rig.name}`,
          });
          for (const pod of rig.pods) {
            const podKey = `pod:${host.name}/${rig.name}/${pod.name}`;
            const open = expanded.has(podKey);
            rows.push({
              label: `      ${open ? "▾" : "▸"} ${pod.name} (${pod.agents.length})`,
              action: { type: "drill", resource: "pod", name: pod.name, target: { host: host.name, rig: rig.name } },
              key: podKey,
            });
            if (!open) continue;
            for (const agent of pod.agents)
              rows.push({
                label: `        ● ${agent.name}`,
                action: { type: "drill", resource: "agent", name: agent.name, target: { host: host.name, rig: rig.name, pod: pod.name } },
                key: `agent:${host.name}/${rig.name}/${pod.name}/${agent.name}`,
              });
          }
        }
      }
    } else if (section.name === "specs") {
      const kinds = ["rig", "agent", "workflow"] as const;
      rows.push({
        label: state.filter ? `/ filter: ${state.filter}` : "/ filter specs…",
        action: { type: "filter", text: state.filter },
      });
      // ROUND-4 item 3: RIG SPECS fully expanded; AGENT SPECS collapsed to the
      // folder level by default ("there's too many, it fills it up").
      const expanded = new Set(state.expanded);
      for (const kind of kinds) {
        const list = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
        if (list.length === 0) continue;
        rows.push({ label: `  ${kind.toUpperCase()} SPECS (${list.length})`, action: { type: "jump", section: "specs" }, key: `specs-kind:${kind}` });
        if (kind !== "agent") {
          for (const spec of list)
            rows.push({ label: `    ▪ ${spec.name}`, action: { type: "drill", resource: "spec", name: spec.name }, key: `spec:${spec.name}` });
          continue;
        }
        const groups = new Map<string, typeof list>();
        for (const spec of list) {
          const namespace = spec.namespace ?? "(root)";
          const group = groups.get(namespace) ?? [];
          group.push(spec);
          groups.set(namespace, group);
        }
        for (const [namespace, specs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          // a filter search overrides collapse — matches must be visible
          const open = namespace === "(root)" || expanded.has(`folder:${namespace}`) || !!state.filter;
          if (namespace !== "(root)")
            rows.push({
              label: `    ${open ? "▾" : "▸"} ${namespace}/ (${specs.length})`,
              action: { type: "toggle-expand", key: `folder:${namespace}` },
              key: `folder:${namespace}`,
            });
          if (!open) continue;
          for (const spec of specs)
            rows.push({
              label: `${namespace === "(root)" ? "    " : "      "}▪ ${spec.name}`,
              action: { type: "drill", resource: "spec", name: spec.name },
              key: `spec:${spec.name}`,
            });
        }
      }
    } else if (section.name === "needs") {
      for (const item of snap.needs)
        rows.push({ label: `  ${item.source === "agent" ? "☐" : "⚑"} ${item.kind}: ${item.target}`, action: { type: "jump", section: "needs" } });
    }
  }
  return rows;
}
