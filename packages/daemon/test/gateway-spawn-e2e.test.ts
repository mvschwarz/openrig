import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { spawnGatewayProcess } from "../src/domain/gateway/spawn-gateway.js";
import { encodeGatewayMessage, type CapabilityDescriptor } from "../src/domain/gateway/protocol.js";
import { mkdtempSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

// M1 A4a — REAL-SPAWN liveness proof. The lessons idle-process-needs-refd-handle +
// in-memory-test-path-hides-real-spawn-bugs are explicit: an in-process test CANNOT prove a
// spawned process stays alive (vitest's own event loop masks a missing ref'd handle). So we
// spawn the ACTUAL compiled gateway process and prove:
//   1. it out-dials the connector (stub sees a connection),
//   2. it SURVIVES a connector outage (the socket drops, yet the process does NOT exit — the
//      ref'd heartbeat keeps the event loop alive), and
//   3. it RE-DIALS when the connector returns (stub sees a fresh connection),
//   4. it shuts down cleanly on SIGTERM.
//
// The child runs from the built dist (tsc emit), so this suite requires `tsc` to have run.

const CAP: CapabilityDescriptor = {
  kind: "capability", connectorId: "slack-1", platform: "slack", protocolVersion: 1, ops: ["post_message"],
};

// dist entry, resolved relative to this test file: <pkg>/test/.. -> <pkg>/dist/...
const DIST_ENTRY = fileURLToPath(new URL("../dist/domain/gateway/gateway-process-main.js", import.meta.url));

interface Stub { server: Server; connections: number; sockets: Socket[]; }
function startStub(path: string): Promise<Stub> {
  const stub: Stub = { server: undefined as unknown as Server, connections: 0, sockets: [] };
  try { if (existsSync(path)) unlinkSync(path); } catch { /* fresh */ }
  const server = createServer((sock) => {
    stub.connections += 1;
    stub.sockets.push(sock);
    sock.on("error", () => { /* client teardown races */ });
    sock.write(encodeGatewayMessage(CAP)); // greet on connect
  });
  stub.server = server;
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(path, () => resolve(stub));
  });
}
const closeStub = (s: Stub): Promise<void> => new Promise((res) => {
  for (const sk of s.sockets) { try { sk.destroy(); } catch { /* best-effort */ } }
  s.server.close(() => res());
});
function waitFor(pred: () => boolean, ms = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error("waitFor timeout")); }
    }, 25);
  });
}
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("A4a gateway spawn wrapper e2e (real spawned process)", () => {
  let home: string;
  let child: ChildProcess | undefined;
  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed) { child.kill("SIGKILL"); }
    child = undefined;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it("dist entry is built (tsc emit ran)", () => {
    expect(existsSync(DIST_ENTRY)).toBe(true);
  });

  it("spawns, connects, SURVIVES a connector outage, then RE-DIALS + shuts down on SIGTERM", async () => {
    home = mkdtempSync(join(tmpdir(), "a4a-spawn-"));
    const sockPath = join(home, "g.sock");
    expect(sockPath.length).toBeLessThan(104); // sun_path guard

    // 1. connector up; spawn the real gateway process pointed at it (fast reconnect for the test).
    const stub1 = await startStub(sockPath);
    let exited = false;
    // entryPath = the built dist entry (under vitest the source module resolves ./*.js to a
    // non-existent sibling — prod resolves it correctly from dist via import.meta.url).
    child = spawnGatewayProcess({ socketPath: sockPath, home, entryPath: DIST_ENTRY, env: { ...process.env, OPENRIG_GATEWAY_RECONNECT_MS: "300" } });
    child.on("exit", () => { exited = true; });

    await waitFor(() => stub1.connections >= 1); // out-dialled the connector
    expect(exited).toBe(false);

    // 2. OUTAGE: tear the connector down. The socket drops — but the process must NOT exit.
    await closeStub(stub1);
    await delay(1200); // several reconnect ticks with NO connector to dial
    expect(exited).toBe(false); // <-- the liveness proof: ref'd heartbeat kept it alive
    expect(child.exitCode).toBeNull();

    // 3. connector returns on the SAME path; the heartbeat re-dials -> a fresh connection.
    const stub2 = await startStub(sockPath);
    await waitFor(() => stub2.connections >= 1); // re-dialled after the outage (no-loss recovery path)

    // 4. clean shutdown on SIGTERM.
    child.kill("SIGTERM");
    await waitFor(() => exited === true, 5000);
    expect(child.exitCode === 0 || child.signalCode === "SIGTERM").toBe(true);
    await closeStub(stub2);
  });
});
