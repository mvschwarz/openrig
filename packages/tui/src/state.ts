import { fileTargetForPath } from "./reading.js";
import { terminalExplorerRows } from "./terminals/terminal-model.js";
import { CONFIG_CATEGORIES } from "./config/config-model.js";
import { availableTabs } from "./commands/registry.js";
import { DEFAULT_TIME_ZONE, resolveTimeZone } from "./time.js";
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
  NavigationFrame,
} from "./types.js";
import { SECTION_REGISTRY, SYSTEM_SECTIONS } from "./sections.js";
import { scopesExplorerRows } from "./scopes/scopes-model.js";
import { GRAPH_STYLE_NAMES } from "./topology/render-graph.js";
import { rowStatusGlyph } from "./topology/glyphs.js";

export function defaultSections(): SectionDef[] {
  return SECTION_REGISTRY.map((section) => ({ ...section }));
}

export function emptySnapshot(): FleetSnapshot {
  return { health: { availability: "unavailable", evaluatedAt: null, total: 0, truncated: false, records: [] }, hosts: [], specs: [], needs: [], humanQueueProbed: false, execution: null, executionMission: null, attention: [], blocked: [], inProgress: [], seatActivity: [], pending: [], recentlyFinished: [], hostsDown: [], stream: [], readErrors: [] };
}

export interface CreateViewStateOptions {
  instanceId: string;
  timeZone?: string;
  timeZoneWarning?: string | null;
  sections?: SectionDef[];
  getSnapshot?: GetSnapshot;
}

export function createViewState(options: CreateViewStateOptions): ViewStateStore {
  const { instanceId, sections = defaultSections(), getSnapshot = emptySnapshot } = options;
  if (!instanceId) throw new Error("createViewState requires an instanceId (A2: instances are addressable)");

  let state: ViewState = {
    instanceId,
    file: null,
    externalUrl: null,
    timeZone: resolveTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE).timeZone,
    timeZoneWarning: options.timeZoneWarning ?? resolveTimeZone(options.timeZone ?? DEFAULT_TIME_ZONE).warning,
    timeZoneHelp: false,
    recentOpen: null,
    sections,
    section: sections[0]?.name ?? "topology",
    drill: [],
    filter: "",
    selection: 0,
    runningOf: null,
    viewTab: "table",
    // FOUNDER FLIP (2026-08-04, amended spec a4ae4b24/0a989c0d): clean-box
    // WAS solved (record at 99433fde) but font-dependence = brittleness —
    // HATCHET is the default render; braille stays fully available behind
    // the style verb (`style braille`), test-pinned both directions.
    graphStyle: "hatchet",
    contentOffset: 0,
    contentMaxOffset: 0,
    contentTargetCount: 0,
    contentSelection: 0,
    focusedPane: "explorer",
    copyMode: false,
    footerOn: true,
    expanded: [],
    notice: null,
    lastError: null,
    palette: null,
    project: null,
    scopesMission: null,
    scopesSelected: null,
    scopesCollapseReqs: false,
    scopesNarrative: false,
    executionOpen: null,
    healthOpen: null,
    attentionOpen: null,
  };
  const listeners = new Set<(s: ViewState) => void>();

  function dispatch(action: Action): ViewState {
    const previous = state;
    if (["attention-category", "attention-open", "terminal-preview", "project-select", "jump", "drill", "cross", "tab", "scopes-mission-open", "scopes-open", "health-open", "execution-open", "recent-open", "timezone", "config-category", "config-setting"].includes(action.type)) state = { ...state, file: null, externalUrl: null, recentOpen: null, timeZoneHelp: false, attentionOpen: null };
    state = reduce(state, action, getSnapshot());
    // Connections is a side trip from work, including explorer/palette entry.
    if (action.type === "jump" && ![...SYSTEM_SECTIONS, "needs"].includes(action.section) && ![...SYSTEM_SECTIONS, "needs"].includes(previous.section)) state.history = [];
    // A filter changes the current view; clearing it must not add the detail
    // being left back onto history (Escape would then cycle forever).
    else if (!["back", "execution-close", "filter"].includes(action.type) && !state.lastError && location(previous) !== location(state)) {
      state.history = [...(previous.history ?? []), navigationFrame(previous)].slice(-50);
    }
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
  const readingNotice = state.notice?.includes("\n") && (["layout", "content-scroll", "content-select", "focus", "copy-mode"].includes(action.type) || (action.type === "select" && action.origin === "refresh"));
  const next: ViewState = { ...state, lastError: null, notice: action.type === "notice" || action.type === "act" || readingNotice ? state.notice : null };
  switch (action.type) {
    case "terminal-result":
      return { ...next, terminalResult: { view: action.view, message: action.message } };
    case "terminal-preview":
      return syncSelection(resetContent({ ...next, section: "terminals", terminalView: action.view, terminalPage: 0, drill: [], viewTab: "table", healthOpen: null }), snap);
    case "terminal-page":
      return resetContent({ ...next, terminalPage: Math.max(0, Math.min(action.page, (snap.terminals?.preview?.composed.pages.length ?? 1) - 1)) });
    case "attention-category":
      return syncSelection({ ...resetContent({ ...next, section: "needs", attentionCategory: action.category, attentionOpen: null }), focusedPane: "content" }, snap);
    case "attention-open":
      return syncSelection({ ...resetContent({ ...next, section: "needs", attentionOpen: action.id, file: null, externalUrl: null, healthOpen: null }), focusedPane: "content" }, snap);
    case "attention-source": {
      const detail = snap.attentionRead?.detail;
      if (!detail || detail.item.id !== next.attentionOpen || !detail.files.some(f => f.path === action.path)) return { ...next, lastError: "Source is no longer in the current Attention read" };
      const hash = action.path.indexOf("#");
      const target = fileTargetForPath(hash < 0 ? action.path : action.path.slice(0, hash), snap.fileRoots ?? []);
      if (target && hash >= 0) target.anchor = action.path.slice(hash + 1);
      const project = detail.item.project && action.path.startsWith(detail.item.project.root + "/") ? detail.item.project : null;
      return { ...resetContent({ ...next, project, file: target ?? { root: "", path: action.path } }), focusedPane: "content" };
    }
    case "file-open":
      return { ...resetContent({ ...next, file: action.target, externalUrl: null, healthOpen: null, recentOpen: null, timeZoneHelp: false }), focusedPane: "content" };
    case "print-for-copy":
      return state; // a terminal side effect run by main's perform; never a view-state change
    case "external-open":
      return { ...resetContent({ ...next, externalUrl: action.url, file: null, healthOpen: null, recentOpen: null, timeZoneHelp: false }), focusedPane: "content" };
    case "time-setting":
      return { ...state, timeZone: action.timeZone, timeZoneWarning: action.timeZoneWarning };
    case "timezone":
      return resetContent({ ...next, timeZoneHelp: true, viewTab: "table", healthOpen: null });
    case "recent-open": {
      const row = snap.recentTransitions?.find((r) => r.transitionId === action.transitionId);
      return row ? resetContent({ ...next, recentOpen: { ...row }, healthOpen: null }) : { ...next, lastError: "Event is outside the served Recent window" };
    }
    case "back": {
      const history = [...(state.history ?? [])];
      const frame = history.pop();
      return frame ? { ...next, ...frame, history } : { ...next, notice: "No previous view" };
    }
    case "noop":
      return next;
    case "error":
      return { ...next, lastError: action.message };
    case "config-category": {
      if (!CONFIG_CATEGORIES.some((c) => c.id === action.category)) return { ...next, lastError: "Unknown CONFIG category" };
      return syncSelection(resetContent({ ...next, section: "config", drill: [], viewTab: "table", configCategory: action.category, configKey: null, filter: "", healthOpen: null }), snap);
    }
    case "config-setting":
      return resetContent({ ...next, section: "config", drill: [], viewTab: "table", configKey: action.key, healthOpen: null });
    case "jump": {
      next.terminalView = null;
      next.terminalPage = 0;
      if (action.section === "needs") { next.attentionCategory = null; next.attentionOpen = null; next.file = null; next.externalUrl = null; next.recentOpen = null; next.timeZoneHelp = false; }
      // scopes: jumping anywhere (incl. back to :scopes) closes the opened slice.
      if (action.section === "scopes") next.project = null;
      next.scopesMission = null;
      next.scopesSelected = null;
      next.executionOpen = null;
      next.healthOpen = null;
      next.configCategory = null;
      next.configKey = null;
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `unknown section "${action.section}"` };
      return syncSelection(
        resetContent({ ...next, section: action.section, drill: [], filter: "", runningOf: null, viewTab: "table" }),
        snap,
      );
    }
    case "project-select": {
      const project = snap.projects?.projects.find(p => p.id === action.id);
      if (!project) return { ...next, lastError: `Project ${action.id} is not in the current catalog` };
      return syncSelection(resetContent({ ...next, section: "scopes", project: { id: project.id, root: project.root }, drill: [], scopesMission: null, scopesSelected: null, executionOpen: null, scopesNarrative: false, filter: "", expanded: [], viewTab: "table" }), snap);
    }
    case "project-source": {
      if (!state.project || snap.projectRead?.id !== state.project.id || snap.projectRead?.root !== state.project.root) return { ...next, lastError: "Selected project read is pending" };
      const entry = snap.projects?.projects.find(p => p.id === state.project!.id && p.root === state.project!.root);
      const missionSource = state.scopesMission ? snap.projectSources?.[state.scopesMission] : null;
      const sliceDir = state.scopesSelected?.slice ?? snap.sliceDetailName;
      const source = sliceDir && state.scopesMission ? snap.scopes?.find(m => m.mission === state.scopesMission)?.slices.find(s => s.dirName === sliceDir)?.sourcePath : missionSource ?? entry?.sourcePath;
      if (!source) return { ...next, lastError: "Selected source is unavailable" };
      return reduce(next, { type: "file-open", target: fileTargetForPath(source, snap.fileRoots ?? []) ?? { root: "", path: source } }, snap);
    }
    case "scopes-mission-open": {
      if (snap.projects !== undefined && !state.project) return { ...next, lastError: "Choose a project first" };
      const key = `scopes-mission:${action.mission}`;
      const expanded = state.expanded.includes(key) ? state.expanded : [...state.expanded, key];
      return syncSelection(resetContent({ ...next, section: "scopes", drill: [], runningOf: null, viewTab: "table", filter: "", scopesMission: action.mission, scopesSelected: null, executionOpen: null, healthOpen: null, expanded }), snap);
    }
    case "scopes-open":
      return syncSelection(resetContent({ ...next, section: "scopes", drill: [], runningOf: null, viewTab: "table", filter: "", scopesMission: action.mission, scopesSelected: { mission: action.mission, slice: action.slice }, scopesNarrative: false, executionOpen: null, healthOpen: null }), snap);
    case "scopes-reqs":
      return { ...next, scopesCollapseReqs: !next.scopesCollapseReqs };
    case "scopes-narrative":
      return { ...next, scopesNarrative: !next.scopesNarrative };
    case "execution-open":
      if (next.section !== "scopes" || !next.scopesMission) return { ...next, lastError: "Open a mission before following its workflow or work packet" };
      return resetContent({ ...next, executionOpen: action.key });
    case "execution-close":
      return state.history?.length ? reduce(next, { type: "back" }, snap) : resetContent({ ...next, executionOpen: null });
    case "health-open":
      return { ...resetContent(next), healthOpen: action.findingId };
    case "health-close":
      return { ...resetContent(next), healthOpen: null };
    case "palette-open":
      return { ...next, palette: { query: "", selection: 0 } };
    case "palette-close":
      return { ...next, palette: null };
    case "palette-query":
      return next.palette ? { ...next, palette: { query: action.query, selection: 0 } } : next;
    case "palette-move": {
      if (!next.palette) return next;
      const sel = Math.max(0, next.palette.selection + action.delta);
      return { ...next, palette: { ...next.palette, selection: sel } };
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
      // 5.2 Wave B — PULSE is a FLEET-WIDE top-level view (the mock's tab set),
      // reachable from ANY content context, unlike the section-scoped tabs.
      if (action.tab === "pulse") return resetContent({ ...next, viewTab: "pulse", healthOpen: null });
      const allowed = availableTabs(state, snap);
      if (!allowed.includes(action.tab)) return { ...next, lastError: `tab ${action.tab} is not available in this content context` };
      return { ...resetContent({ ...next, viewTab: action.tab }), healthOpen: null };
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
    case "copy-mode":
      return { ...next, copyMode: action.on ?? !state.copyMode };
    case "layout":
      // Do not clamp a restored bookmark against another page's in-flight snapshot.
      if (state.file && JSON.stringify(state.file) !== JSON.stringify(snap.fileRead?.target)) return next;
      if (!state.file && state.section === "specs" && !snap.specsLoaded && (snap.fileRead || snap.config)) return next;
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
    case "startup":
      // Acts are daemon writes executed by the driver loop, never view-state
      // mutations — the view is untouched; the loop reports via 'notice'.
      return next;
    case "notice":
      return action.message.includes("\n")
        ? { ...resetContent(next), notice: action.message, focusedPane: "content" }
        : { ...next, notice: action.message };
    case "filter":
      return state.section === "config"
        ? syncSelection({ ...resetContent({ ...next, filter: action.text, configKey: null, configCategory: "all" }), focusedPane: "content" }, snap)
        : resetContent({ ...next, filter: action.text, selection: 0 });
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
      const sectionState = clearScopeCoordinatesOnSectionChange(state, drilled);
      const spec = action.resource === "spec" ? findSpec(snap, action.name) : null;
      // filters are VIEW-scoped: a drill that crosses sections clears the old
      // section's filter (founder direct-drive catch — a specs filter leaked
      // into the topology table and blanked it)
      const filter = drilled.section === state.section ? drilled.filter : "";
      return syncSelection({ ...resetContent({ ...sectionState, filter, viewTab: spec?.kind === "rig" ? "configuration" : "table" }), healthOpen: null }, snap);
    }
    case "cross": {
      const crossed = crossNav(next, action.kind, action.name, snap, action.target);
      if (crossed.lastError) return crossed;
      const sectionState = clearScopeCoordinatesOnSectionChange(state, crossed);
      const filter = crossed.section === state.section ? crossed.filter : "";
      return syncSelection({ ...sectionState, filter, healthOpen: null }, snap);
    }
    default:
      return { ...next, lastError: "unknown action" };
  }
}

function location(s: ViewState): string {
  return JSON.stringify([s.attentionCategory, s.attentionOpen, s.project, s.terminalView, s.section, s.drill, s.runningOf, s.scopesMission, s.scopesSelected, s.executionOpen, s.recentOpen?.transitionId, s.timeZoneHelp, s.configCategory, s.configKey, s.file, s.externalUrl]);
}

function navigationFrame(s: ViewState): NavigationFrame {
  const { attentionCategory, attentionOpen, project, terminalView, terminalPage, file, externalUrl, section, drill, filter, selection, runningOf, viewTab, contentOffset, contentMaxOffset, contentTargetCount, contentSelection, focusedPane, scopesMission, scopesSelected, scopesCollapseReqs, scopesNarrative, executionOpen, expanded, recentOpen, timeZoneHelp, configCategory, configKey } = s;
  return { attentionCategory, attentionOpen, project, terminalView, terminalPage, file, externalUrl, section, drill, filter, selection, runningOf, viewTab, contentOffset, contentMaxOffset, contentTargetCount, contentSelection, focusedPane, scopesMission, scopesSelected, scopesCollapseReqs, scopesNarrative, executionOpen, expanded, recentOpen, timeZoneHelp, configCategory, configKey };
}

function clearScopeCoordinatesOnSectionChange(previous: ViewState, next: ViewState): ViewState {
  return next.section === previous.section
    ? next
    : { ...next, scopesMission: null, scopesSelected: null, executionOpen: null };
}

function resetContent(state: ViewState): ViewState {
  return { ...state, contentOffset: 0, contentMaxOffset: 0, contentTargetCount: 0, contentSelection: 0, focusedPane: "explorer" };
}

/** The founder scroll fix (class-(b) focus-model defect): on a SCROLLABLE spec
 *  detail the body IS the meaningful surface, so reflexive ↑↓ scroll it —
 *  while the explorer holds focus (focus resets to explorer on every
 *  drill, which is why the reflexive keys used to drive the hidden tree). Gated
 *  on real scrollability (contentMaxOffset), so a non-overflowing spec detail
 *  keeps its link-hop / explorer behavior. The key ROUTING (input.ts) and the
 *  footer/indicator affordances (render.ts) both read this ONE predicate, so
 *  the hint can never again promise a gesture the keys don't perform. */
export function specDetailArrowsScroll(state: ViewState): boolean {
  return (!!state.file || !!state.externalUrl || (state.section === "specs" && state.drill.length > 0) || (state.section === "config" && !!state.configKey)) && state.contentMaxOffset > 0 && state.focusedPane !== "content";
}

/** The explorer key for the state's current location (drill leaf or section). */
export function locationKey(state: ViewState): string {
  if (state.section === "system") return "system:health";
  if (state.section === "terminals" && state.terminalView) return `terminal:${state.terminalView}`;
  if (state.section === "needs" && state.attentionCategory) return `attention-category:${state.attentionCategory}`;
  if (state.section === "config" && state.configCategory) return `config:${state.configCategory}`;
  if (state.section === "scopes" && state.scopesSelected) return `scopes-slice:${state.scopesSelected.mission}/${state.scopesSelected.slice}`;
  if (state.section === "scopes" && state.scopesMission) return `scopes-mission:${state.scopesMission}`;
  if (state.section === "scopes" && state.project) return `project:${state.project.id}`;
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
    if (spec) expanded.add(`specs-kind:${spec.kind}`);
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
          if ((agent.name === name || agent.session === name) && (!target || (host.name === target.host && (!target.rig || rig.name === target.rig) && (!target.pod || pod.name === target.pod))))
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
          if (agent.session === session && (!hostId || (host.id ?? host.name) === hostId)) matches.push({ host, rig, pod, agent });
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
        { kind: "agent", name: found.agent.name },
      ];
      return { ...state, section: "topology", drill, selection: 0, runningOf: null };
    }
    case "spec": {
      // Another section may intentionally omit Specs. Its absence there is not
      // evidence that this source is missing; judge after the catalog read.
      if (snap.specsLoaded && !findSpec(snap, name)) return { ...state, lastError: `no such spec "${name}"` };
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
    const active = section.name === state.section || section.name === "system" && SYSTEM_SECTIONS.includes(state.section);
    if (section.name === "config" || section.name === "connections") continue;
    const label =
      section.name === "topology"
        ? "TOPOLOGY"
        : section.name === "specs"
          ? "SPECS"
          : section.name === "needs"
            ? "FEED"
            : section.name === "scopes" ? "PROJECTS" : section.name.toUpperCase();
    // A section changes view but has no independent collapse state. Do not draw
    // a disclosure glyph that cannot be toggled.
    rows.push({ label, action: { type: "jump", section: section.name }, key: `section:${section.name}` });
    if (!active) continue;
    if (section.name === "terminals") {
      rows.push(...terminalExplorerRows(state, snap));
      continue;
    }
    if (section.name === "system") {
      rows.push({ label: "  Health", key: "system:health", action: { type: "jump", section: "system" } },
        { label: "  Configuration", key: "section:config", action: { type: "jump", section: "config" } });
      if (state.section === "config") rows.push(...CONFIG_CATEGORIES.map((c) => ({ label: "    " + c.label, key: `config:${c.id}`, action: { type: "config-category" as const, category: c.id } })));
      rows.push({ label: "  Connections", key: "section:connections", action: { type: "jump", section: "connections" } });
      if (state.history?.length) rows.push({ label: "  Back", key: "system:back", action: { type: "back" } });
      continue;
    }
    if (section.name === "scopes") {
      if (snap.projects === undefined) rows.push(...scopesExplorerRows(snap.scopes, new Set(state.expanded), "  "));
      for (const project of snap.projects?.projects ?? []) {
        rows.push({ label: `  ${state.project?.id === project.id ? "●" : "○"} ${project.id}${project.error ? " !" : ""}`, key: `project:${project.id}`, action: { type: "project-select", id: project.id } });
        if (state.project?.id === project.id && state.project.root === project.root && snap.projectRead?.id === project.id && snap.projectRead.root === project.root)
          rows.push(...scopesExplorerRows(snap.scopes, new Set(state.expanded), "    "));
      }
      if (state.history?.length) rows.push({ label: "  Back", key: "project:back", action: { type: "back" } });
      continue;
    }
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
              disclosureAction: { type: "toggle-expand", key: podKey },
              key: podKey,
            });
            if (!open) continue;
            // S19 round-4 (guard finding 4): the glyph derives from the SERVED
            // status — active/idle/attention/unknown are visibly distinct and
            // an offline seat is never dressed as a live ●
            for (const agent of pod.agents)
              rows.push({
                label: `        ${rowStatusGlyph(agent).glyph} ${agent.name}`,
                action: { type: "drill", resource: "agent", name: agent.name, target: { host: host.name, rig: rig.name, pod: pod.name } },
                key: `agent:${host.name}/${rig.name}/${pod.name}/${agent.name}`,
              });
          }
        }
      }
    } else if (section.name === "specs") {
      const kinds = ["rig", "agent", "workflow"] as const;
      rows.push({
        label: state.filter ? `/ filter: ${state.filter} · / replace · esc clear` : "/ filter specs…",
        action: { type: "filter", text: state.filter },
      });
      // ROUND-4 item 3: RIG SPECS fully expanded; AGENT SPECS collapsed to the
      // folder level by default ("there's too many, it fills it up").
      const expanded = new Set(state.expanded);
      for (const kind of kinds) {
        const list = snap.specs.filter((s) => s.kind === kind).filter((s) => !state.filter || s.name.includes(state.filter));
        if (list.length === 0) continue;
        const key = `specs-kind:${kind}`;
        const openKind = expanded.has(key) || !!state.filter;
        rows.push({ label: `  ${openKind ? "▾" : "▸"} ${kind.toUpperCase()} SPECS (${list.length})`, action: { type: "toggle-expand", key }, disclosureAction: { type: "toggle-expand", key }, key });
        if (!openKind) continue;
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
              disclosureAction: { type: "toggle-expand", key: `folder:${namespace}` },
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
      rows.push({ label: "  Human requests", key: "attention-category:action", action: { type: "attention-category", category: "action" } },
        { label: "  Updates", key: "attention-category:update", action: { type: "attention-category", category: "update" } });
      if (state.history?.length) rows.push({ label: "  Back", key: "attention:back", action: { type: "back" } });
    }
  }
  return rows;
}
