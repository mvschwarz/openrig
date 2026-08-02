// Safe-core command grammar (§4.B / FR-1): :section jump · /text filter ·
// <resource> <name> drill · spec-of / running cross-nav. k9s-primary taxonomy.
// parseCommand is pure text -> action; target existence is validated by dispatch,
// so every input adapter shares one failure surface.

const SECTIONS = ['topology', 'specs', 'needs']
const RESOURCES = ['host', 'rig', 'pod', 'agent', 'spec']

export function parseCommand(raw) {
  const input = raw.trim()
  if (input === '') return { type: 'noop' }

  if (input.startsWith(':')) {
    const section = input.slice(1).trim()
    if (SECTIONS.includes(section)) return { type: 'jump', section }
    return { type: 'error', message: `unknown section ":${section}" — known: ${SECTIONS.map((s) => ':' + s).join(' ')}` }
  }

  if (input.startsWith('/')) {
    return { type: 'filter', text: input.slice(1).trim() }
  }

  const [verb, ...rest] = input.split(/\s+/)
  const name = rest.join(' ')

  if (verb === 'spec-of' || verb === 'running') {
    if (!name) return { type: 'error', message: `${verb} needs a target name (e.g. "${verb} ${verb === 'spec-of' ? 'dev50.driver' : 'driver-agent'}")` }
    return { type: 'cross', kind: verb, name }
  }

  if (RESOURCES.includes(verb)) {
    if (!name) return { type: 'error', message: `${verb} drill needs a name (e.g. "${verb} <name>")` }
    return { type: 'drill', resource: verb, name }
  }

  return { type: 'error', message: `unknown command "${verb}" — known: :<section> /<filter> ${RESOURCES.join('|')} <name>, spec-of <agent>, running <spec>` }
}
