// Hand-rolled ANSI renderer (substrate candidate under trial). Layout:
// row 1 command bar · row 2 rule · left Explorer (fixed width) · right Content
// pane · last row status line. Returns plain lines + a hit-map so mouse clicks
// resolve to the SAME semantic actions commands produce.
import { computeExplorerRows } from './state.mjs'
import { STUB, findAgent, findSpec, agentsRunningSpec } from './data.mjs'

const EXPL_W = 30

function pad(text, width) {
  const t = String(text ?? '')
  return t.length >= width ? t.slice(0, width) : t + ' '.repeat(width - t.length)
}

function padLeft(text, width) {
  const t = String(text ?? '')
  return t.length >= width ? t.slice(0, width) : ' '.repeat(width - t.length) + t
}

const AGENT_COLS = [
  ['POD', 8, 'left'],
  ['AGENT', 16, 'left'],
  ['RUNTIME', 13, 'left'],
  ['CTX%', 4, 'right'],
  ['TOKENS', 7, 'right'],
  ['STATUS', 17, 'left'],
  ['ACTIONS', 14, 'left'],
]

function tableRow(cells) {
  return AGENT_COLS.map(([, w, align], i) => (align === 'right' ? padLeft(cells[i], w) : pad(cells[i], w))).join(' ')
}

function contentLines(state) {
  const lines = []
  if (state.section === 'topology') {
    if (state.runningOf) {
      lines.push(`seats running spec "${state.runningOf}":`)
      for (const seat of agentsRunningSpec(state.runningOf)) lines.push(`  ● ${seat}  (open: agent ${seat})`)
      return lines
    }
    const leaf = state.drill.at(-1)
    if (leaf?.kind === 'agent') {
      const { agent, rig, pod } = findAgent(leaf.name)
      lines.push(`agent ${agent.name}`)
      lines.push(`  rig ${rig.name} · pod ${pod.name} · runtime ${agent.runtime}`)
      lines.push(`  spec ${agent.spec}  (open: spec-of ${agent.name})`)
      lines.push(`  state ${agent.status}`)
      return lines
    }
    const rigName = state.drill.find((d) => d.kind === 'rig')?.name ?? STUB.hosts[0]?.rigs[0]?.name
    const podFilter = leaf?.kind === 'pod' ? leaf.name : null
    const rig = STUB.hosts.flatMap((h) => h.rigs).find((r) => r.name === rigName)
    if (!rig) return ['no rig in view']
    const all = rig.pods.flatMap((p) => p.agents.map((a) => ({ pod: p.name, ...a })))
    const rows = all
      .filter((a) => !podFilter || a.pod === podFilter)
      .filter((a) => !state.filter || a.name.includes(state.filter) || a.pod.includes(state.filter))
    lines.push(`[ TABLE ] OVERVIEW      rig ${rig.name}${podFilter ? ` · pod ${podFilter}` : ''}${state.filter ? ` · filter "${state.filter}"` : ''}`)
    lines.push(tableRow(AGENT_COLS.map(([name]) => name)))
    lines.push('─'.repeat(AGENT_COLS.reduce((n, [, w]) => n + w + 1, -1)))
    for (const a of rows)
      lines.push(
        tableRow([
          a.pod,
          a.name,
          a.runtime,
          a.context == null ? '—' : `${a.context}%`,
          a.tokens ?? '—',
          a.status,
          'run ▸ · term',
        ]),
      )
    lines.push('')
    lines.push(`${rows.length} of ${all.length} agents shown`)
    return lines
  }
  if (state.section === 'specs') {
    const leaf = state.drill.at(-1)
    if (leaf?.kind === 'spec') {
      const spec = findSpec(leaf.name)
      if (spec?.agentRefs) {
        lines.push(`rig spec ${spec.name}   tabs: topology [ CONFIGURATION ] yaml`)
        lines.push('  members:')
        for (const ref of spec.agentRefs) lines.push(`    ▪ ${ref}  (open: spec ${ref})`)
      } else if (spec) {
        lines.push(`agent spec ${spec.name}`)
        lines.push(`  runtime ${spec.runtime}`)
        lines.push(`  used by rigs: ${spec.usedByRigs.join(', ')}`)
        lines.push(`  seats now: ${agentsRunningSpec(spec.name).join(', ') || '(none)'}  (open: running ${spec.name})`)
      }
      return lines
    }
    lines.push('SPEC LIBRARY')
    for (const [kind, list] of Object.entries(STUB.specs)) {
      const shown = list.filter((s) => !state.filter || s.name.includes(state.filter))
      lines.push(`  ${kind.toUpperCase()} (${shown.length})`)
      for (const s of shown) lines.push(`    ▪ ${s.name}`)
    }
    return lines
  }
  if (state.section === 'needs') {
    lines.push('NEEDS-YOU')
    for (const item of STUB.needs) lines.push(`  ⚑ ${item.kind}  ${item.target}  — ${item.detail}  (open ▸)`)
    lines.push('')
    lines.push('  human-queue: no items yet (proven empty — surfacing adoption pending)')
    return lines
  }
  return [`(${state.section})`]
}

export function renderScreen(state, { cols = 120, rows = 32 } = {}, inputLine = '') {
  const lines = []
  const hitMap = []
  lines.push(pad(`cmd ▸ ${inputLine}`, cols))
  lines.push('─'.repeat(cols))

  const explorer = computeExplorerRows(state)
  const content = contentLines(state)
  const bodyRows = Math.max(explorer.length, content.length)
  const explorerRows = []
  for (let i = 0; i < bodyRows; i++) {
    const y = lines.length + 1 // 1-based terminal row this line will occupy
    const row = explorer[i]
    const marker = i === state.selection && row ? '›' : ' '
    const left = pad(row ? `${marker}${row.label}` : '', EXPL_W)
    const right = content[i] ?? ''
    lines.push(`${left}│ ${right}`)
    if (row) {
      hitMap.push({ y, x1: 1, x2: EXPL_W, action: row.action })
      explorerRows.push({ ...row, y })
    }
  }

  const drillPath = state.drill.map((d) => d.name).join(' → ')
  lines.push('─'.repeat(cols))
  lines.push(
    pad(
      `[${state.instanceId}] ${state.section}${drillPath ? ' · ' + drillPath : ''}${state.lastError ? '  ✗ ' + state.lastError : ''}`,
      cols,
    ),
  )
  while (lines.length < rows) lines.push('')
  return { lines: lines.slice(0, rows), hitMap, explorerRows }
}
