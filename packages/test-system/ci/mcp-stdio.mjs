import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const seat = 'dev-impl@dev-pair-stub';
const destination = 'dev-qa@dev-pair-stub';
const qitemId = 'qitem-installed-mcp';

export function verifyMcpStdio(proof) {
  assert.ok(proof, 'missing installed MCP stdio proof');
  assert.notEqual(proof.identity.isError, true);
  assert.equal(proof.identity.structuredContent.identity.sessionName, seat);
  assert.equal(proof.identity.structuredContent.identity.rigName, 'dev-pair-stub');
  assert.notEqual(proof.unseated.isError, true);
  assert.equal(proof.unseated.structuredContent.ok, true);
  assert.equal(proof.unseated.structuredContent.seat, null);
  assert.match(proof.unseated.structuredContent.message, /no seat/);
  assert.notEqual(proof.created.isError, true);
  assert.equal(proof.created.structuredContent.qitemId, qitemId);
  assert.notEqual(proof.shown.isError, true);
  const item = proof.shown.structuredContent.item;
  assert.equal(item.qitemId, qitemId);
  assert.equal(item.destinationSession, destination);
  assert.ok(item.sourceSession === seat || item.sourceSession.startsWith(`${seat}@`));
  assert.equal(item.body, 'Read the installed MCP result.');
  assert.equal(proof.missing.isError, true);
  assert.deepEqual(proof.daemonError, { status: 404, body: { error: 'qitem_not_found' } });
  assert.deepEqual(proof.missing.structuredContent, {
    ok: false, code: proof.daemonError.body.error, message: 'qitem_not_found', status: 404,
  });
  for (const result of [proof.identity, proof.unseated, proof.created, proof.shown]) {
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  }
  assert.deepEqual(JSON.parse(proof.missing.content[0].text), proof.daemonError.body);
  verifyInstructions(proof.instructions);
}

/** The server's instructions, one marker per line, in order. */
export const INSTRUCTION_MARKERS = ['OPENRIG_SESSION_NAME', 'rig_queue_create', 'not idle', 'reserved for a person', 'rig_queue_claim'];

export function verifyInstructions(instructions) {
  const lines = instructions.split('\n');
  assert.equal(lines.length, INSTRUCTION_MARKERS.length);
  for (const [index, text] of INSTRUCTION_MARKERS.entries()) {
    assert.ok(lines[index].includes(text), text);
  }
}

// The installed CLI's own MCP server, not a source-only one, driven by a 2025-era client. The CLI no longer ships that
// client's SDK (it serves through the 2.x server packages), so the client is bundled into the runner with this helper.
export async function checkMcpStdio(rigBin, readEnv) {
  const started = performance.now();
  const proof = {};
  for (const configuredSeat of [seat, '']) {
    const client = new Client({ name: 'installed-scenario', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [rigBin, 'mcp', 'serve', '--port', new URL(readEnv.OPENRIG_URL).port],
      env: Object.fromEntries(Object.entries({ ...readEnv,
        OPENRIG_SESSION_NAME: configuredSeat, RIGGED_SESSION_NAME: '',
      }).filter(([, value]) => value !== undefined)),
    });
    try {
      await client.connect(transport, { timeout: 5000 });
      const call = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 5000 });
      const identity = await call('rig_whoami');
      if (!configuredSeat) { proof.unseated = identity; continue; }
      proof.instructions = client.getInstructions();
      proof.identity = identity;
      proof.created = await call('rig_queue_create', { qitemId, destination, body: 'Read the installed MCP result.' });
      proof.shown = await call('rig_queue_show', { qitemId });
      proof.missing = await call('rig_queue_show', { qitemId: 'qitem-installed-mcp-missing' });
      const response = await fetch(`${readEnv.OPENRIG_URL}/api/queue/qitem-installed-mcp-missing`,
        { signal: AbortSignal.timeout(5000) });
      proof.daemonError = { status: response.status, body: await response.json() };
    } finally {
      await client.close();
    }
  }
  verifyMcpStdio(proof);
  proof.durationMs = Math.round(performance.now() - started);
  return proof;
}
