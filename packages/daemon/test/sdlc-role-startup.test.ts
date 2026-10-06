import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAgentRef } from '../src/domain/agent-resolver.js';
import { resolveNodeConfig } from '../src/domain/profile-resolver.js';
import { RigSpecSchema } from '../src/domain/rigspec-schema.js';

const agents = resolve(import.meta.dirname, '../specs/agents');
const roles = ['development/implementer', 'development/qa', 'review/independent-reviewer', 'orchestration/orchestrator'];
const fs = { readFile: (p: string) => readFileSync(p, 'utf8'), exists: existsSync };

describe('packaged SDLC entry', () => {
  it.each(roles)('%s delivers its authority pointer without eager process actions', role => {
    const result = resolveAgentRef(`local:${role}`, agents, fs);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const rig = RigSpecSchema.normalize({ version: '0.2', name: 'entry-fixture', pods: [{ id: 'work', members: [{ id: 'seat', agent_ref: `local:${role}`, profile: 'default', runtime: 'codex', cwd: '/isolated-sdlc-fixture' }] }] });
    const pod = rig.pods[0]!;
    const config = resolveNodeConfig({ baseSpec: result.resolved, importedSpecs: result.imports, collisions: result.collisions, profileName: 'default', member: pod.members[0]!, pod, rig, homedir: '/isolated-sdlc-fixture-home', skillsRoot: '/isolated-sdlc-fixture-catalog' });
    expect(config.ok).toBe(true);
    if (!config.ok) throw new Error(config.errors.join('\n'));
    const startup = config.config.startup;
    expect(startup.actions).toEqual([]);
    expect(startup.files).toHaveLength(1);
    const file = startup.files[0]!;
    // Role-specific bytes must stay on the seat's wire: a shared cwd overlay
    // would let one role replace another's instructions on the next launch.
    expect(file.deliveryHint).toBe('send_text');
    expect(file.appliesOn).toEqual(['fresh_start', 'restore']);
    const text = readFileSync(resolve(agents, role, file.path), 'utf8');
    expect(text).toContain('#resolve-the-selected-path');
    expect(text).toContain('project.yaml -> mission.yaml');
    expect(text).not.toMatch(/gate every edit|gates every edit|Skip no gates|Load these packaged skills now|first meaningful milestone/);
  });
});

it('generic starter overlays cannot reintroduce universal edit gates', () => {
  const rigs = resolve(agents, '../rigs');
  for (const file of ['launch/factory/CULTURE.md']) {
    const text = readFileSync(resolve(rigs, file), 'utf8');
    expect(text).not.toMatch(/gates every edit|reviews every edit|strict gated loop|Reviewers do not wait to be asked|Wait for QA approval/);
    expect(text).toContain('Part A');
  }
});
