import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createViewState, defaultSections } from './state.mjs'
import { STUB } from './data.mjs'

test('view-state is instance-scoped: two instances never share state (FR-13 negative AC)', () => {
  const a = createViewState({ instanceId: 'tui-a' })
  const b = createViewState({ instanceId: 'tui-b' })
  a.dispatch({ type: 'jump', section: 'specs' })
  assert.equal(a.get().section, 'specs')
  assert.equal(b.get().section, 'topology', 'instance b must be untouched by instance a mutations')
  assert.equal(a.get().instanceId, 'tui-a')
  assert.equal(b.get().instanceId, 'tui-b')
})

test('section set is ONE in-code registry: adding a section is a localized edit (FR-12 negative AC)', () => {
  const sections = [...defaultSections(), { name: 'extra', sourceRead: 'GET /api/ps (existing read)', drillShape: 'flat', rows: () => STUB.needs }]
  const s = createViewState({ instanceId: 't', sections })
  const r = s.dispatch({ type: 'jump', section: 'extra' })
  assert.equal(r.section, 'extra', 'a section added to the registry array is reachable with zero other edits')
})

test('every registered view is reachable by a command (R1.2 drivability by construction)', () => {
  const s = createViewState({ instanceId: 't' })
  for (const sec of s.get().sections) {
    s.dispatch({ type: 'jump', section: sec.name })
    assert.equal(s.get().section, sec.name)
  }
})

test('drill to a known agent lands topology on that agent; unknown target is a named error in state', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'drill', resource: 'agent', name: 'dev50.driver' })
  assert.equal(s.get().section, 'topology')
  assert.deepEqual(s.get().drill.at(-1), { kind: 'agent', name: 'dev50.driver' })
  assert.equal(s.get().lastError, null)

  s.dispatch({ type: 'drill', resource: 'agent', name: 'nobody.here' })
  assert.match(s.get().lastError, /no such agent/)
  assert.match(s.get().lastError, /nobody\.here/)
})

test('cross-nav spec-of: running agent -> its agent spec (Specs section)', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'cross', kind: 'spec-of', name: 'dev50.driver' })
  assert.equal(s.get().section, 'specs')
  assert.deepEqual(s.get().drill.at(-1), { kind: 'spec', name: 'driver-agent' })
})

test('cross-nav running: spec -> topology filtered to seats running it', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'cross', kind: 'running', name: 'driver-agent' })
  assert.equal(s.get().section, 'topology')
  assert.ok(s.get().runningOf === 'driver-agent')
})

test('filter mutates the current view only and clears with empty text', () => {
  const s = createViewState({ instanceId: 't' })
  s.dispatch({ type: 'filter', text: 'dev50' })
  assert.equal(s.get().filter, 'dev50')
  s.dispatch({ type: 'filter', text: '' })
  assert.equal(s.get().filter, '')
})
