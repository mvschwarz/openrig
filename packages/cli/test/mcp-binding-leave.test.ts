import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { RigRepository } from "../../daemon/src/domain/rig-repository.js";
import { NetworkBindingStore } from "../../daemon/src/domain/network/network-bindings.js";
import { runNetworkProviderRemovalPass } from "../../daemon/src/domain/network/network-provider-removal.js";
import type { NetworkConnectorDeps } from "../../daemon/src/domain/network/network-connector.js";
import { startMcpHttpServer, type BindingLeaveRequest, type McpHttpOptions } from "../src/mcp-http.js";

const context = { bindingId: "netb-aaaaaaaaaaaaaaaaaaaa", hubSeat: "alex@team", provider: { id: "example", installation: "local", participant: "alex", remoteInstallation: "original" }, removalRevision: "epoch-one" };
describe("the provider-owned binding leave endpoint", () => {
  let home: string;
  let daemon: http.Server;
  let daemonUrl: string;
  const closers: Array<() => Promise<void>> = [];
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "mcp-leave-"));
    daemon = http.createServer((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ selfHostId: "test-host" })));
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    daemonUrl = `http://127.0.0.1:${(daemon.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
    await new Promise<void>((resolve) => { daemon.closeAllConnections(); daemon.close(() => resolve()); });
    rmSync(home, { recursive: true, force: true });
  });
  async function server(over: Partial<McpHttpOptions> = {}) {
    const srv = await startMcpHttpServer({ daemonUrl, host: "127.0.0.1", port: 0, tokenFile: join(home, "absent.json"), ...over });
    closers.push(srv.close); return srv;
  }
  const request = (url: string, body = context, token = "opaque-removal-capability") => fetch(url + "/bindings/leave", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("uses only the explicit removal hook, and echoes the original references without the token", async () => {
    let workCalls = 0; let received: BindingLeaveRequest | undefined;
    const srv = await server({ resolver: async () => { workCalls++; return { ok: false, refusal: "unknown" }; }, onBindingLeave: async (req) => {
      received = req; return { removalRevision: req.removalRevision, alreadyRemoved: true };
    } });
    const res = await request(srv.url); expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...context, alreadyRemoved: true });
    expect(received).toEqual({ ...context, token: "opaque-removal-capability" }); expect(workCalls).toBe(0);
    const work = await fetch(srv.url, { method: "POST", headers: { Authorization: "Bearer opaque-removal-capability", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }) });
    expect(work.status).toBe(401); expect(workCalls).toBe(1);
  });

  it("retries a lost provider result over real HTTP after local disconnect and store reconstruction", async () => {
    const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS);
    try {
      const rigs = new RigRepository(db); const rig = rigs.createRig("local"); const node = rigs.addNode(rig.id, "a", { runtime: "codex" });
      db.prepare("INSERT INTO sessions (id,node_id,session_name,status) VALUES ('local-session',?,'a@local','running')").run(node.id);
      const seen = new Set<string>(); let attempts = 0;
      const srv = await server({ onBindingLeave: async (req) => {
        expect(req.token).toBe("remove-only"); expect(req.provider).toEqual(context.provider); attempts++;
        if (seen.has(req.removalRevision)) return { removalRevision: req.removalRevision, alreadyRemoved: true };
        seen.add(req.removalRevision); throw new Error("provider applied removal but result was lost");
      } });
      let bindings = new NetworkBindingStore(db, home);
      const binding = bindings.create({ session: "a@local", hubUrl: srv.url, hubSeat: "alex@team", token: "work-only", allowHttp: true,
        provider: context.provider, removal: { revision: "epoch-one", token: "remove-only" } });
      bindings.disconnect(binding.id);
      await runNetworkProviderRemovalPass({ bindings, home } as NetworkConnectorDeps, bindings.pendingProviderRemovals()[0]!);
      expect(bindings.get(binding.id)!.providerRemoval).toBe("pending");
      bindings = new NetworkBindingStore(db, home); bindings.sweepCredentials();
      await runNetworkProviderRemovalPass({ bindings, home } as NetworkConnectorDeps, bindings.pendingProviderRemovals()[0]!);
      expect(bindings.get(binding.id)!.providerRemoval).toBe("confirmed"); expect(attempts).toBe(2);
      expect(bindings.pendingProviderRemovals()).toEqual([]);
    } finally { db.close(); }
  });

  it("keeps the old endpoint unchanged when no provider hook is configured", async () => {
    const srv = await server(); expect((await request(srv.url)).status).toBe(404);
  });

  it("returns superseded distinctly, never as removed", async () => {
    const srv = await server({ onBindingLeave: async () => ({ removalRevision: "epoch-one", superseded: true }) });
    const res = await request(srv.url); expect(await res.json()).toEqual({ ...context, superseded: true });
  });

  it("refusal and invalid receipts cannot confirm a different revision", async () => {
    const refused = await server({ onBindingLeave: async () => ({ refused: true, code: "wrong_epoch" }) });
    const res = await request(refused.url); expect(res.status).toBe(403); expect(await res.json()).toEqual({ ...context, refused: true, code: "wrong_epoch" });
    const invalid = await server({ onBindingLeave: async () => ({ removalRevision: "older", alreadyRemoved: true }) });
    expect((await request(invalid.url)).status).toBe(503);
  });

  it("bounds even an uncooperative provider hook and does not return its thrown diagnostic", async () => {
    const srv = await server({ resolverTimeoutMs: 20, onBindingLeave: async () => new Promise(() => {}) });
    expect((await request(srv.url)).status).toBe(503);
    const failed = await server({ onBindingLeave: async () => { throw new Error("private-provider-diagnostic"); } });
    const res = await request(failed.url); expect(res.status).toBe(503); expect(await res.text()).not.toContain("private-provider-diagnostic");
  });
});
