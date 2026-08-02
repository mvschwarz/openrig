import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from './grammar.mjs'

test(':section jump parses for the three launch sections', () => {
  assert.deepEqual(parseCommand(':topology'), { type: 'jump', section: 'topology' })
  assert.deepEqual(parseCommand(':specs'), { type: 'jump', section: 'specs' })
  assert.deepEqual(parseCommand(':needs'), { type: 'jump', section: 'needs' })
})

test('unknown :section is a named error, never a silent no-op', () => {
  const r = parseCommand(':bogus')
  assert.equal(r.type, 'error')
  assert.match(r.message, /unknown section/)
  assert.match(r.message, /bogus/)
})

test('/text filters the current view; bare / clears', () => {
  assert.deepEqual(parseCommand('/driver'), { type: 'filter', text: 'driver' })
  assert.deepEqual(parseCommand('/'), { type: 'filter', text: '' })
})

test('<resource> <name> drill parses for known resource kinds', () => {
  assert.deepEqual(parseCommand('rig openrig-build'), { type: 'drill', resource: 'rig', name: 'openrig-build' })
  assert.deepEqual(parseCommand('agent dev50.driver'), { type: 'drill', resource: 'agent', name: 'dev50.driver' })
  assert.deepEqual(parseCommand('host vm-host'), { type: 'drill', resource: 'host', name: 'vm-host' })
  assert.deepEqual(parseCommand('spec driver-agent'), { type: 'drill', resource: 'spec', name: 'driver-agent' })
})

test('cross-nav verbs parse', () => {
  assert.deepEqual(parseCommand('spec-of dev50.driver'), { type: 'cross', kind: 'spec-of', name: 'dev50.driver' })
  assert.deepEqual(parseCommand('running driver-agent'), { type: 'cross', kind: 'running', name: 'driver-agent' })
})

test('unknown command is a named error carrying the offending token', () => {
  const r = parseCommand('frobnicate xyz')
  assert.equal(r.type, 'error')
  assert.match(r.message, /unknown command/)
  assert.match(r.message, /frobnicate/)
})

test('drill with missing name is a named error', () => {
  const r = parseCommand('agent')
  assert.equal(r.type, 'error')
  assert.match(r.message, /agent/)
})

test('empty input is a no-op action (explicitly typed, not silent)', () => {
  assert.deepEqual(parseCommand(''), { type: 'noop' })
  assert.deepEqual(parseCommand('   '), { type: 'noop' })
})
