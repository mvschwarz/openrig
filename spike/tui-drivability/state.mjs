// ONE instance-scoped view-state with ONE mutation path (dispatch) — PIN 1.
// No module-level state anywhere in this file (FR-13). The section set is a
// data registry, not a switch (FR-12): each entry = {name, sourceRead, drillShape}.
import { STUB, findAgent, findSpec, findRig, findHost, agentsRunningSpec } from './data.mjs'

export function defaultSections() {
  return [
    { name: 'topology', sourceRead: 'GET /api/rigs/:id/graph + /api/ps + /api/rigs/summary (existing)', drillShape: 'host>rig>pod>agent' },
    { name: 'specs', sourceRead: 'GET /api/specs/library + /api/rigs/:rigId/spec (existing)', drillShape: 'kind>spec' },
    { name: 'needs', sourceRead: 'GET /api/review/rig|fleet + /api/queue/list?attention=1 (existing)', drillShape: 'flat' },
  ]
}

export function createViewState({ instanceId, sections = defaultSections() } = {}) {
  if (!instanceId) throw new Error('createViewState requires an instanceId (A2: instances are addressable)')

  let state = {
    instanceId,
    sections,
    section: sections[0]?.name ?? 'topology',
    drill: [],
    filter: '',
    selection: 0,
    runningOf: null,
    lastError: null,
  }
  const listeners = new Set()

  function get() {
    return state
  }

  function subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  // The single mutation path. Every adapter (command bar, mouse, keyboard,
  // control socket) funnels here; nothing else writes state.
  function dispatch(action) {
    state = reduce(state, action)
    for (const fn of listeners) fn(state)
    return state
  }

  return { instanceId, get, dispatch, subscribe }
}

function reduce(state, action) {
  const next = { ...state, lastError: null }
  switch (action.type) {
    case 'noop':
      return next
    case 'error':
      return { ...next, lastError: action.message }
    case 'jump': {
      if (!state.sections.some((s) => s.name === action.section))
        return { ...next, lastError: `unknown section "${action.section}"` }
      return { ...next, section: action.section, drill: [], filter: '', selection: 0, runningOf: null }
    }
    case 'filter':
      return { ...next, filter: action.text, selection: 0 }
    case 'select': {
      const count = Math.max(action.rowCount ?? Number.MAX_SAFE_INTEGER, 1)
      const target = action.index ?? state.selection + (action.delta ?? 0)
      return { ...next, selection: Math.min(Math.max(target, 0), count - 1) }
    }
    case 'activate': {
      // Enter activates the selected explorer row — resolved against the SAME
      // row model the renderer draws, so keyboard and mouse cannot diverge.
      const rows = computeExplorerRows(state)
      const row = rows[state.selection]
      if (!row) return { ...next, lastError: 'nothing selected' }
      return reduce(next, row.action)
    }
    case 'drill':
      return drillTo(next, action)
    case 'cross':
      return crossNav(next, action)
    default:
      return { ...next, lastError: `unknown action "${action.type}"` }
  }
}

function drillTo(state, { resource, name }) {
  switch (resource) {
    case 'host': {
      const found = findHost(name)
      if (!found) return { ...state, lastError: `no such host "${name}"` }
      return { ...state, section: 'topology', drill: [{ kind: 'host', name }], selection: 0, runningOf: null }
    }
    case 'rig': {
      const found = findRig(name)
      if (!found) return { ...state, lastError: `no such rig "${name}"` }
      return { ...state, section: 'topology', drill: [{ kind: 'host', name: found.host.name }, { kind: 'rig', name }], selection: 0, runningOf: null }
    }
    case 'pod': {
      for (const host of STUB.hosts)
        for (const rig of host.rigs)
          if (rig.pods.some((p) => p.name === name))
            return { ...state, section: 'topology', drill: [{ kind: 'host', name: host.name }, { kind: 'rig', name: rig.name }, { kind: 'pod', name }], selection: 0, runningOf: null }
      return { ...state, lastError: `no such pod "${name}"` }
    }
    case 'agent': {
      const found = findAgent(name)
      if (!found) return { ...state, lastError: `no such agent "${name}"` }
      return {
        ...state,
        section: 'topology',
        drill: [
          { kind: 'host', name: found.host.name },
          { kind: 'rig', name: found.rig.name },
          { kind: 'pod', name: found.pod.name },
          { kind: 'agent', name },
        ],
        selection: 0,
        runningOf: null,
      }
    }
    case 'spec': {
      const found = findSpec(name)
      if (!found) return { ...state, lastError: `no such spec "${name}"` }
      return { ...state, section: 'specs', drill: [{ kind: 'spec', name }], selection: 0, runningOf: null }
    }
    default:
      return { ...state, lastError: `unknown resource "${resource}"` }
  }
}

// The explorer row model — pure function of state, shared by the reducer
// ('activate') and the renderer (drawing + hit-map). One source of truth.
export function computeExplorerRows(state) {
  const rows = []
  for (const section of state.sections) {
    const active = section.name === state.section
    const label = { topology: 'TOPOLOGY', specs: 'SPECS', needs: 'NEEDS-YOU' }[section.name] ?? section.name.toUpperCase()
    rows.push({ label: `${active ? '▾' : '▸'} ${label}`, action: { type: 'jump', section: section.name } })
    if (!active) continue
    if (section.name === 'topology') {
      for (const host of STUB.hosts) {
        rows.push({ label: `  ▾ ${host.name}${host.reachable ? '' : ' (unreachable)'}`, action: { type: 'drill', resource: 'host', name: host.name } })
        for (const rig of host.rigs) {
          rows.push({ label: `    ▾ ${rig.name}`, action: { type: 'drill', resource: 'rig', name: rig.name } })
          for (const pod of rig.pods) {
            rows.push({ label: `      ▾ ${pod.name} (${pod.agents.length})`, action: { type: 'drill', resource: 'pod', name: pod.name } })
            for (const agent of pod.agents)
              rows.push({ label: `        ● ${agent.name}`, action: { type: 'drill', resource: 'agent', name: agent.name } })
          }
        }
      }
    } else if (section.name === 'specs') {
      for (const [kind, list] of Object.entries(STUB.specs)) {
        rows.push({ label: `  ${kind.toUpperCase()} SPECS (${list.length})`, action: { type: 'jump', section: 'specs' } })
        for (const spec of list) rows.push({ label: `    ▪ ${spec.name}`, action: { type: 'drill', resource: 'spec', name: spec.name } })
      }
    } else if (section.name === 'needs') {
      for (const item of STUB.needs) rows.push({ label: `  ⚑ ${item.kind}: ${item.target}`, action: { type: 'jump', section: 'needs' } })
    }
  }
  return rows
}

function crossNav(state, { kind, name }) {
  if (kind === 'spec-of') {
    const found = findAgent(name)
    if (!found) return { ...state, lastError: `no such agent "${name}"` }
    return { ...state, section: 'specs', drill: [{ kind: 'spec', name: found.agent.spec }], selection: 0, runningOf: null }
  }
  if (kind === 'running') {
    const spec = findSpec(name)
    if (!spec) return { ...state, lastError: `no such spec "${name}"` }
    const seats = agentsRunningSpec(name)
    return { ...state, section: 'topology', drill: [], runningOf: name, filter: '', selection: 0, seats }
  }
  return { ...state, lastError: `unknown cross-nav "${kind}"` }
}
