// rig_telemetry_events against the daemon's real telemetry route, over HTTP, through the real DaemonClient: the
// page `rig telemetry events` reads, with a rig name resolved to its id as the other MCP rig tools resolve it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { createDb } from "../../daemon/src/db/connection.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

describe("rig_telemetry_events on the daemon's telemetry route", () => {
  let db: Database.Database;
  let server: ServerType;
  let fixture: ReturnType<typeof createTestApp>;
  let call: (args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    fixture = createTestApp(db, { appDeps: { daemonBootEpoch: "fixture-boot" } });
    server = await new Promise<ServerType>((resolve) => {
      const s = serve({ fetch: fixture.app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s));
    });
    const mcp = createMcpServer(new DaemonClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "collector", version: "1.0.0" });
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    close = async () => { await client.close(); await mcp.close(); };
    call = async (args) => {
      const result = await client.callTool({ name: "rig_telemetry_events", arguments: args });
      return { isError: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    };
  });

  afterEach(async () => {
    await close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  it("pages one rig's event metadata by its name, never payloads, continuing from the cursor", async () => {
    const alpha = fixture.rigRepo.createRig("alpha");
    const beta = fixture.rigRepo.createRig("beta");
    fixture.eventBus.emit({ type: "chat.message", rigId: alpha.id, messageId: "m1", sender: "desk", kind: "message", body: "PRIVATE BODY" });
    fixture.eventBus.emit({ type: "rig.stopped", rigId: beta.id });
    fixture.eventBus.emit({ type: "rig.stopped", rigId: alpha.id });

    const latest = await call({});
    expect(latest.isError).toBe(false);
    expect(JSON.parse(latest.text)).toMatchObject({ rows: [], coverage: { gaps: [{ code: "historical_events_not_read" }] } });

    const first = await call({ start: "retained", rigId: "alpha", limit: 2 });
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain("PRIVATE BODY");
    const firstPage = JSON.parse(first.text);
    expect(firstPage.rows).toEqual([expect.objectContaining({ rigId: alpha.id, type: "chat.message" })]);
    expect(firstPage.page).toMatchObject({ scanned: 2, hasMore: true });

    const next = JSON.parse((await call({ cursor: firstPage.page.nextCursor, rigId: "alpha" })).text);
    expect(next.rows).toEqual([expect.objectContaining({ rigId: alpha.id, type: "rig.stopped" })]);
  });

  it("reports a rig no name or id matches, and a malformed cursor, as errors rather than an empty page", async () => {
    const unknown = await call({ rigId: "no-such-rig" });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining("Rig 'no-such-rig' not found") });

    const malformed = await call({ cursor: "not-a-cursor" });
    expect(malformed.isError).toBe(true);
    expect(JSON.parse(malformed.text)).toMatchObject({ code: "telemetry_invalid_request" });
  });
});
