import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";

function mockClient(overrides?: {
  get?: (path: string) => Promise<DaemonResponse>;
  post?: (path: string, body?: unknown) => Promise<DaemonResponse>;
}): DaemonClient {
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = overrides?.get ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  client.post = overrides?.post ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  return client;
}

describe("MCP Server", () => {
  let mcpClient: Client;
  let daemonClient: DaemonClient;
  let cleanup: () => Promise<void>;

  async function setup(clientOverrides?: Parameters<typeof mockClient>[0]) {
    daemonClient = mockClient(clientOverrides);
    const server = createMcpServer(daemonClient);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    mcpClient = new Client({ name: "test-client", version: "1.0.0" });

    await server.connect(serverTransport);
    await mcpClient.connect(clientTransport);

    cleanup = async () => {
      await mcpClient.close();
      await server.close();
    };
  }

  afterAll(async () => {
    if (cleanup) await cleanup();
  });

  // T1: MCP server lists all 10 tools
  it("lists all 10 tools", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "rigged_bundle_inspect",
      "rigged_claim",
      "rigged_discover",
      "rigged_down",
      "rigged_ps",
      "rigged_restore",
      "rigged_snapshot_create",
      "rigged_snapshot_list",
      "rigged_status",
      "rigged_up",
    ]);
    await cleanup();
  });

  // T2: rigged_up calls POST /api/up
  it("rigged_up calls POST /api/up with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { runId: "run-1", status: "completed", rigId: "rig-1", stages: [], errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rigged_up",
      arguments: { sourceRef: "/tmp/rig.yaml", plan: false, autoApprove: true },
    });

    expect(postFn).toHaveBeenCalledWith("/api/up", {
      sourceRef: "/tmp/rig.yaml",
      plan: false,
      autoApprove: true,
      targetRoot: undefined,
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("completed");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T3: rigged_down calls POST /api/down
  it("rigged_down calls POST /api/down with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { rigId: "rig-1", sessionsKilled: 2, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rigged_down",
      arguments: { rigId: "rig-1", delete: true, force: false, snapshot: false },
    });

    expect(postFn).toHaveBeenCalledWith("/api/down", {
      rigId: "rig-1",
      delete: true,
      force: false,
      snapshot: false,
    });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.sessionsKilled).toBe(2);
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T4: rigged_ps calls GET /api/ps
  it("rigged_ps calls GET /api/ps and returns entries", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [{ rigId: "rig-1", name: "test", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }],
    }));
    await setup({ get: getFn });

    const result = await mcpClient.callTool({ name: "rigged_ps", arguments: {} });

    expect(getFn).toHaveBeenCalledWith("/api/ps");
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].rigId).toBe("rig-1");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T5: Tool schemas have required properties
  it("tool schemas have correct required properties", async () => {
    await setup();
    const result = await mcpClient.listTools();

    const upTool = result.tools.find((t) => t.name === "rigged_up")!;
    expect(upTool.inputSchema.required).toContain("sourceRef");
    expect(upTool.inputSchema.properties).toHaveProperty("plan");
    expect(upTool.inputSchema.properties).toHaveProperty("autoApprove");

    const downTool = result.tools.find((t) => t.name === "rigged_down")!;
    expect(downTool.inputSchema.required).toContain("rigId");

    const restoreTool = result.tools.find((t) => t.name === "rigged_restore")!;
    expect(restoreTool.inputSchema.required).toContain("rigId");
    expect(restoreTool.inputSchema.required).toContain("snapshotId");

    await cleanup();
  });

  // T6: HTTP 404 -> isError:true
  it("HTTP error maps to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 404,
      data: { error: "Rig not found" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rigged_down",
      arguments: { rigId: "missing" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.error).toBe("Rig not found");
    await cleanup();
  });

  // T7: In-body errors -> isError:true
  it("in-body errors map to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { rigId: "rig-1", sessionsKilled: 1, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: ["Kill failed"] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rigged_down",
      arguments: { rigId: "rig-1" },
    });

    expect(result.isError).toBe(true);
    await cleanup();
  });

  // T8: Transport connect/disconnect lifecycle
  it("transport connects and disconnects cleanly", async () => {
    await setup();

    // Verify server is responsive
    const result = await mcpClient.listTools();
    expect(result.tools.length).toBe(10);

    // Clean disconnect
    await cleanup();

    // Create a fresh pair to verify we can reconnect
    daemonClient = mockClient();
    const server2 = createMcpServer(daemonClient);
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client-2", version: "1.0.0" });
    await server2.connect(st2);
    await client2.connect(ct2);

    const result2 = await client2.listTools();
    expect(result2.tools.length).toBe(10);

    await client2.close();
    await server2.close();
  });

  // T9: bundle inspect integrityResult.passed=false -> isError:true
  it("bundle inspect integrity failure maps to isError:true", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: {
        manifest: { name: "test", version: "1.0.0", packages: [] },
        digestValid: true,
        integrityResult: { passed: false, mismatches: ["pkg-a"], missing: [], extra: [], errors: [] },
      },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rigged_bundle_inspect",
      arguments: { bundlePath: "/tmp/test.rigbundle" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.integrityResult.passed).toBe(false);
    await cleanup();
  });

  // T10: MCP tools URL-encode path parameters
  it("snapshot_create URL-encodes rigId in path", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { id: "snap-1", rigId: "rig/with/slashes", kind: "manual", status: "complete" },
    }));
    await setup({ post: postFn });

    await mcpClient.callTool({
      name: "rigged_snapshot_create",
      arguments: { rigId: "rig/with/slashes" },
    });

    const calledPath = postFn.mock.calls[0][0] as string;
    expect(calledPath).toBe(`/api/rigs/${encodeURIComponent("rig/with/slashes")}/snapshots`);
    expect(calledPath).toContain("rig%2Fwith%2Fslashes");
    await cleanup();
  });
});
