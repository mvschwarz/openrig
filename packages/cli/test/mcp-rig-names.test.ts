// The MCP tools that take a rig resolve a rig name as well as an id, as the rig CLI commands do. The daemon
// answers these routes by exact rig id, and lists [] for an id it has no snapshots under, so an agent passing a
// name used to get "not found", or an empty snapshot list for a rig that has snapshots.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type McpAccess, createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";

const RIG_ID = "01M5F0YZQXETQ4YVH3MJVQPQXQ";
const OTHER_ID = "01M5F0OTHERRIGIDXXXXXXXXXX";
const REMOVED_ID = "01M5F0REMOVEDRIGIDXXXXXXXX";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function connect(rigs: Array<{ id: string; name: string }>, access?: McpAccess) {
  const requests: string[] = [];
  const snapshots: Record<string, unknown[]> = { [RIG_ID]: [{ id: "snap-1" }], [REMOVED_ID]: [{ id: "snap-old" }] };
  const known = new Set(rigs.map((r) => r.id));
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = vi.fn(async (path: string): Promise<DaemonResponse> => {
    requests.push(`GET ${path}`);
    if (path.startsWith("/api/rigs/summary")) return { status: 200, data: rigs.map((r) => ({ ...r, archivedAt: null })) };
    const snaps = /^\/api\/rigs\/([^/]+)\/snapshots$/.exec(path);
    if (snaps) return { status: 200, data: snapshots[snaps[1]!] ?? [] };
    const detail = /^\/api\/rigs\/([^/]+)$/.exec(path);
    if (detail && known.has(detail[1]!)) return { status: 200, data: { rig: rigs.find(r => r.id === detail[1]), representative: null } };
    const nodes = /^\/api\/rigs\/([^/]+)\/nodes$/.exec(path);
    if (nodes && known.has(nodes[1]!)) return { status: 200, data: [{ logicalId: "work.worker" }] };
    return { status: 404, data: { error: "Rig not found" } };
  }) as DaemonClient["get"];
  client.post = vi.fn(async (path: string, body?: unknown): Promise<DaemonResponse> => {
    requests.push(`POST ${path} ${JSON.stringify(body ?? {})}`);
    if (path === "/api/down" && known.has((body as { rigId: string }).rigId)) return { status: 200, data: { ok: true } };
    if (path === `/api/rigs/${RIG_ID}/snapshots`) return { status: 201, data: { id: "snap-new" } };
    return { status: 404, data: { error: "Rig not found" } };
  }) as DaemonClient["post"];

  const server = createMcpServer(client, { access });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  close = async () => { await mcp.close(); await server.close(); };
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0]!.text, isError: result.isError === true };
  };
  return { call, requests, instructions: mcp.getInstructions(), tools: (await mcp.listTools()).tools };
}

describe("MCP rig tools accept a rig name", () => {
  it("rig_snapshot_list lists the named rig's snapshots", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }]);
    const result = await call("rig_snapshot_list", { rigId: "solo" });
    expect(requests).toContain(`GET /api/rigs/${RIG_ID}/snapshots`);
    expect(result).toEqual({ text: JSON.stringify([{ id: "snap-1" }]), isError: false });
  });

  it("rig_snapshot_list reports a handle that matches no rig as an error, not an empty list", async () => {
    const { call } = await connect([{ id: RIG_ID, name: "solo" }]);
    const result = await call("rig_snapshot_list", { rigId: "no-such-rig" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Rig 'no-such-rig' not found");

    // Snapshots kept under a removed rig's id still list by that id.
    const removed = await (await connect([{ id: RIG_ID, name: "solo" }])).call("rig_snapshot_list", { rigId: REMOVED_ID });
    expect(removed).toEqual({ text: JSON.stringify([{ id: "snap-old" }]), isError: false });
  });

  it("rig_rig_nodes, rig_snapshot_create and rig_down act on the named rig's id", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }]);
    expect((await call("rig_rig_nodes", { rigId: "solo" })).isError).toBe(false);
    expect((await call("rig_snapshot_create", { rigId: "solo" })).isError).toBe(false);
    expect((await call("rig_down", { rigId: "solo" })).isError).toBe(false);
    expect(requests).toEqual(expect.arrayContaining([
      `GET /api/rigs/${RIG_ID}/nodes`,
      `POST /api/rigs/${RIG_ID}/snapshots {}`,
      expect.stringContaining(`POST /api/down {"rigId":"${RIG_ID}"`),
    ]));
  });

  it("a name two active rigs share is rig_ambiguous, before any request that changes a rig", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "twin" }, { id: OTHER_ID, name: "twin" }]);
    const result = await call("rig_down", { rigId: "twin" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.text)).toMatchObject({ ok: false, code: "rig_ambiguous", candidates: [RIG_ID, OTHER_ID] });
    expect(requests.filter((r) => r.startsWith("POST"))).toEqual([]);
  });

  it("an id still goes to that id", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }]);
    await call("rig_rig_nodes", { rigId: RIG_ID });
    expect(requests).toContain(`GET /api/rigs/${RIG_ID}/nodes`);
  });
});

const external = (rigs: string[]): McpAccess => ({ principal: "fixture-caller@solo", owner: false, rigs, roots: [], workspace: false, external: { objects: { team: ["list"] } } });

describe("external team discovery within the grant", () => {
  it.each([["solo"], ["solo", "solo"]])("uses a sole granted rig without a name (scope %j)", async (...rigs) => {
    const { call, instructions, tools } = await connect([{ id: RIG_ID, name: "solo" }, { id: OTHER_ID, name: "outside" }], external(rigs));
    const result = await call("rig_team", {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).rig).toEqual({ id: RIG_ID, name: "solo" });
    expect(result.text).not.toContain("outside");
    expect(instructions?.slice(0, 512)).toContain("rig_team without rigId");
    expect(tools.map(t => t.name)).toEqual(["rig_team"]);
  });

  it("offers only the granted names when a choice is needed, without looking up other rigs", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }, { id: OTHER_ID, name: "outside" }], external(["solo", "second"]));
    const result = await call("rig_team", {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).rigs).toEqual(["solo", "second"]);
    expect(result.text).not.toContain("outside");
    expect(requests).toEqual([]);
  });

  it("names an empty grant scope without guessing another rig", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "outside" }], external([]));
    const result = await call("rig_team", {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ rigs: [], message: expect.stringContaining("no rigs") });
    expect(result.text).not.toContain("outside");
    expect(requests).toEqual([]);
  });

  it("names an unresolved sole grant and does not read a different rig", async () => {
    const { call, requests } = await connect([{ id: OTHER_ID, name: "outside" }], external(["missing"]));
    const result = await call("rig_team", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("missing");
    expect(result.text).not.toContain("outside");
    expect(requests).not.toContain(`GET /api/rigs/${OTHER_ID}`);
  });

  it("still asks an unscoped owner for a rig rather than guessing one", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }]);
    const result = await call("rig_team", {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Pass a rig name or identifier");
    expect(requests).toEqual([]);
  });

  it("keeps explicit granted reads and out-of-scope refusal unchanged", async () => {
    const { call, requests } = await connect([{ id: RIG_ID, name: "solo" }, { id: OTHER_ID, name: "outside" }], external(["solo"]));
    expect((await call("rig_team", { rigId: "solo" })).isError).toBe(false);
    expect((await call("rig_team", { rigId: "outside" })).isError).toBe(true);
    expect(requests).not.toContain(`GET /api/rigs/${OTHER_ID}`);
  });
});
