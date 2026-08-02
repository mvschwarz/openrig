import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewState } from './state.mjs'
import { parseCommand } from './grammar.mjs'
import { decodeInput, sgrClick } from './input.mjs'
import { renderScreen } from './render.mjs'

// PIN 1: command / mouse / keyboard are three ADAPTERS over ONE dispatch.
// Parity is proven by reaching the IDENTICAL state through each input kind.

function freshPair() {
  return [createViewState({ instanceId: 'cmd' }), createViewState({ instanceId: 'ui' })]
}

function comparable(state) {
  const { instanceId, sections, ...rest } = state
  return rest
}

test('command vs mouse click on the explorer reach identical state', () => {
  const [byCommand, byMouse] = freshPair()

  byCommand.dispatch(parseCommand(':specs'))

  // Render byMouse's screen, find the explorer hit-target for "specs", click its coordinates.
  const screen = renderScreen(byMouse.get(), { cols: 100, rows: 30 })
  const target = screen.hitMap.find((h) => h.action.type === 'jump' && h.action.section === 'specs')
  assert.ok(target, 'explorer must expose a clickable hit-target for the specs section')
  const events = decodeInput(sgrClick(target.x1, target.y))
  const click = events.find((e) => e.type === 'mouse')
  assert.ok(click, 'SGR mouse bytes must decode to a mouse event')
  const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2)
  byMouse.dispatch(hit.action)

  assert.deepEqual(comparable(byMouse.get()), comparable(byCommand.get()))
})

test('command vs keyboard (arrows + enter) reach identical state', () => {
  const [byCommand, byKeys] = freshPair()

  byCommand.dispatch(parseCommand('rig openrig-build'))

  // Keyboard path: explorer starts on topology/host; ArrowDown to the rig row, Enter drills it.
  const screen = renderScreen(byKeys.get(), { cols: 100, rows: 30 })
  const rigIndex = screen.explorerRows.findIndex((r) => r.action.type === 'drill' && r.action.resource === 'rig')
  assert.ok(rigIndex >= 0, 'explorer must list the rig row')
  for (let i = 0; i < rigIndex; i++) {
    for (const e of decodeInput('[B')) byKeys.dispatch(e.action ?? e) // ArrowDown
  }
  const enter = decodeInput('\r')[0]
  byKeys.dispatch(enter.action ?? enter)

  assert.deepEqual(comparable(byKeys.get()), comparable(byCommand.get()))
})

test('the aligned table renders fixed-width columns with right-aligned numerics', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch(parseCommand('rig openrig-build'))
  const screen = renderScreen(s.get(), { cols: 100, rows: 30 })
  const header = screen.lines.find((l) => l.includes('AGENT') && l.includes('STATUS'))
  assert.ok(header, 'agents table header renders')
  const ctxCol = header.indexOf('CTX%')
  const rows = screen.lines.filter((l) => /\b(running|idle|needs-attention|unknown)\b/.test(l))
  assert.ok(rows.length >= 2, 'agent rows render')
  for (const row of rows) {
    // right-aligned numeric: the digits end where the CTX% header ends
    const cell = row.slice(ctxCol, ctxCol + 4)
    assert.match(cell, /^\s*(\d+%|—)$/, `CTX% cell right-aligned, got "${cell}" in "${row}"`)
  }
})
