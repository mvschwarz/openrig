import { serveOwnedHonoFixture } from "./helpers/owned-hono-fixture.js";
// rig_telemetry_events against the daemon's real telemetry route, over HTTP, through the real DaemonClient: the
// page `rig telemetry events` reads, with a rig name resolved to its id as the other MCP rig tools resolve it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowFetchTarget } from "./fetch-guard.js";
import type { AddressInfo } from "node:net";
import { type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { createDb } from "../../daemon/src/db/connection.js";
import { ALL_MIGRATIONS } from "../../daemon/src/db/all-migrations.js";
import { migrate } from "../../daemon/src/db/migrate.js";
import { createTestApp } from "../../daemon/test/helpers/test-app.js";
import { DaemonClient } from "../src/client.js";
import { createMcpServer } from "../src/mcp-server.js";

describe("rig_telemetry_events on the daemon's telemetry route", () => {
  let db: Database.Database;
  let fixture: ReturnType<typeof createTestApp>;
  let server: ServerType;
  let call: (args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;
  let close: () => Promise<void>;

  beforeEach(async () => {
    db = createDb(":memory:");
    migrate(db, ALL_MIGRATIONS);
    // The tool resolves a rig name to its id through the daemon's own rig list, so the fixture owns the rows.
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("alpha-id", "alpha");
    db.prepare("INSERT INTO rigs (id, name) VALUES (?, ?)").run("beta-id", "beta");
    fixture = createTestApp(db, { appDeps: { daemonBootEpoch: "fixture-boot" } });
    server = await serveOwnedHonoFixture(fixture.app.fetch);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    allowFetchTarget(url);
    const mcp = createMcpServer(new DaemonClient(url));
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
    const insert = db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)");
    insert.run("alpha-id", "chat.message", JSON.stringify({ body: "PRIVATE BODY" }));
    insert.run("beta-id", "rig.stopped", "{}");
    insert.run("alpha-id", "rig.stopped", "{}");

    const latest = await call({});
    expect(latest.isError).toBe(false);
    expect(JSON.parse(latest.text)).toMatchObject({ rows: [], coverage: { gaps: [{ code: "historical_events_not_read" }] } });

    const first = await call({ start: "retained", rigId: "alpha", limit: 2 });
    expect(first.isError).toBe(false);
    expect(first.text).not.toContain("PRIVATE BODY");
    const firstPage = JSON.parse(first.text);
    expect(firstPage.rows).toEqual([expect.objectContaining({ rigId: "alpha-id", type: "chat.message" })]);
    expect(firstPage.page).toMatchObject({ scanned: 2, hasMore: true });

    const next = JSON.parse((await call({ cursor: firstPage.page.nextCursor, rigId: "alpha" })).text);
    expect(next.rows).toEqual([expect.objectContaining({ rigId: "alpha-id", type: "rig.stopped" })]);
  });

  it("reports a rig no name or id matches, and a malformed cursor, as errors rather than an empty page", async () => {
    const unknown = await call({ rigId: "no-such-rig" });
    expect(unknown).toMatchObject({ isError: true, text: expect.stringContaining("Rig 'no-such-rig' not found") });

    const malformed = await call({ cursor: "not-a-cursor" });
    expect(malformed.isError).toBe(true);
    expect(JSON.parse(malformed.text)).toMatchObject({ code: "telemetry_invalid_request" });
  });

  it.each(["cursor", "nodeId", "rigId"])("ignores an empty %s and reports it alongside the page", async (name) => {
    db.prepare("INSERT INTO events (rig_id, type, payload) VALUES (?, ?, ?)").run("alpha-id", "rig.stopped", "{}");
    const baseline = await call({ start: "retained" });
    const result = await call({ start: "retained", [name]: "" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ rows: JSON.parse(baseline.text).rows, note: `Ignored empty optional argument(s): ${name}.` });
  });
});
