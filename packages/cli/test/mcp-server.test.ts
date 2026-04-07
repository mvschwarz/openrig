import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, type DaemonResponse } from "../src/client.js";

function mockClient(overrides?: {
  get?: (path: string) => Promise<DaemonResponse>;
  post?: (path: string, body?: unknown) => Promise<DaemonResponse>;
  postText?: (path: string, text: string, contentType?: string, extraHeaders?: Record<string, string>) => Promise<DaemonResponse>;
}): DaemonClient {
  const client = new DaemonClient("http://127.0.0.1:9999");
  client.get = overrides?.get ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  client.post = overrides?.post ?? vi.fn(async () => ({ status: 200, data: { status: "ok" } }));
  client.postText = overrides?.postText ?? vi.fn(async () => ({ status: 200, data: { valid: true, errors: [] } }));
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

  // T1: MCP server lists all 17 tools
  it("lists all 17 tools", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "rig_agent_validate",
      "rig_bundle_inspect",
      "rig_capture",
      "rig_chatroom_send",
      "rig_chatroom_watch",
      "rig_claim",
      "rig_discover",
      "rig_down",
      "rig_ps",
      "rig_restore",
      "rig_rig_nodes",
      "rig_rig_validate",
      "rig_send",
      "rig_snapshot_create",
      "rig_snapshot_list",
      "rig_status",
      "rig_up",
    ]);
    await cleanup();
  });

  // T2: rig_up calls POST /api/up
  it("rig_up calls POST /api/up with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { runId: "run-1", status: "completed", rigId: "rig-1", stages: [], errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_up",
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

  // T3: rig_down calls POST /api/down
  it("rig_down calls POST /api/down with correct params", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { rigId: "rig-1", sessionsKilled: 2, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [] },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_down",
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

  // T4: rig_ps calls GET /api/ps
  it("rig_ps calls GET /api/ps and returns entries", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [{ rigId: "rig-1", name: "test", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }],
    }));
    await setup({ get: getFn });

    const result = await mcpClient.callTool({ name: "rig_ps", arguments: {} });

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

    const upTool = result.tools.find((t) => t.name === "rig_up")!;
    expect(upTool.inputSchema.required).toContain("sourceRef");
    expect(upTool.inputSchema.properties).toHaveProperty("plan");
    expect(upTool.inputSchema.properties).toHaveProperty("autoApprove");

    const downTool = result.tools.find((t) => t.name === "rig_down")!;
    expect(downTool.inputSchema.required).toContain("rigId");

    const restoreTool = result.tools.find((t) => t.name === "rig_restore")!;
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
      name: "rig_down",
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
      name: "rig_down",
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
    expect(result.tools.length).toBe(17);

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
    expect(result2.tools.length).toBe(17);

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
      name: "rig_bundle_inspect",
      arguments: { bundlePath: "/tmp/test.rigbundle" },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.integrityResult.passed).toBe(false);
    await cleanup();
  });

  // T10: MCP server lists rig_agent_validate + rig_rig_validate tools
  it("rig_agent_validate and rig_rig_validate tools are registered", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("rig_agent_validate");
    expect(names).toContain("rig_rig_validate");

    // Verify schema: both have required "yaml" input
    const agentTool = result.tools.find((t) => t.name === "rig_agent_validate")!;
    expect(agentTool.inputSchema.required).toContain("yaml");
    const rigTool = result.tools.find((t) => t.name === "rig_rig_validate")!;
    expect(rigTool.inputSchema.required).toContain("yaml");

    await cleanup();
  });

  // T10b: rig_agent_validate calls postText with correct path
  it("rig_agent_validate calls postText on /api/agents/validate", async () => {
    const postTextFn = vi.fn(async () => ({
      status: 200,
      data: { valid: true, errors: [] },
    }));
    await setup({ postText: postTextFn });

    const result = await mcpClient.callTool({
      name: "rig_agent_validate",
      arguments: { yaml: "name: my-agent\nversion: 1.0.0\n" },
    });

    expect(postTextFn).toHaveBeenCalledWith("/api/agents/validate", "name: my-agent\nversion: 1.0.0\n");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T11: MCP tools URL-encode path parameters
  it("snapshot_create URL-encodes rigId in path", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { id: "snap-1", rigId: "rig/with/slashes", kind: "manual", status: "complete" },
    }));
    await setup({ post: postFn });

    await mcpClient.callTool({
      name: "rig_snapshot_create",
      arguments: { rigId: "rig/with/slashes" },
    });

    const calledPath = postFn.mock.calls[0][0] as string;
    expect(calledPath).toBe(`/api/rigs/${encodeURIComponent("rig/with/slashes")}/snapshots`);
    expect(calledPath).toContain("rig%2Fwith%2Fslashes");
    await cleanup();
  });

  // NS-T09: rig_rig_nodes calls GET /api/rigs/:rigId/nodes
  it("rig_rig_nodes returns node inventory", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path.includes("/nodes")) {
        return {
          status: 200,
          data: [
            { rigId: "rig-1", rigName: "test", logicalId: "dev.impl", nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", tmuxAttachCommand: "tmux attach -t dev-impl@test" },
          ],
        };
      }
      return { status: 200, data: {} };
    });
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "rig_rig_nodes",
      arguments: { rigId: "rig-1" },
    });

    expect(getFn).toHaveBeenCalled();
    const calledPath = getFn.mock.calls.find((c) => (c[0] as string).includes("/nodes"))?.[0] as string;
    expect(calledPath).toBe("/api/rigs/rig-1/nodes");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].nodeKind).toBe("agent");
    await cleanup();
  });

  // T14: rig_send returns structured result
  it("rig_send returns structured result", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_send",
      arguments: { session: "dev-impl@my-rig", text: "hello" },
    });

    expect(postFn).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
    await cleanup();
  });

  // T-chatroom-send: rig_chatroom_send returns result
  it("rig_chatroom_send returns result", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [{ id: "rig-1", name: "my-rig", nodeCount: 2 }],
    }));
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { id: "msg-1", rigId: "rig-1", sender: "mcp", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
    }));
    await setup({ get: getFn, post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_chatroom_send",
      arguments: { rigName: "my-rig", body: "hello" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.sender).toBe("mcp");
    expect(parsed.body).toBe("hello");
    await cleanup();
  });

  // T-chatroom-watch: rig_chatroom_watch returns recent history
  it("rig_chatroom_watch returns recent history", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path === "/api/rigs/summary") {
        return {
          status: 200,
          data: [{ id: "rig-1", name: "my-rig", nodeCount: 2 }],
        };
      }
      if (path.includes("/chat/history")) {
        return {
          status: 200,
          data: [
            { id: "msg-1", rigId: "rig-1", sender: "alice", kind: "message", body: "hello", topic: null, createdAt: "2026-03-31T10:00:00Z" },
          ],
        };
      }
      return { status: 200, data: {} };
    });
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "rig_chatroom_watch",
      arguments: { rigName: "my-rig" },
    });

    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].sender).toBe("alice");
    await cleanup();
  });

  // T-chatroom-ambiguous: MCP rig_chatroom_send with ambiguous rig name -> error
  it("rig_chatroom_send with ambiguous rig name returns error", async () => {
    const getFn = vi.fn(async () => ({
      status: 200,
      data: [
        { id: "rig-1", name: "my-rig", nodeCount: 2 },
        { id: "rig-2", name: "my-rig", nodeCount: 1 },
      ],
    }));
    await setup({ get: getFn });

    const result = await mcpClient.callTool({
      name: "rig_chatroom_send",
      arguments: { rigName: "my-rig", body: "hello" },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.error).toContain("ambiguous");
    await cleanup();
  });

  // T15: rig_capture returns structured result
  it("rig_capture returns structured result", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig", content: "pane output", lines: 20 },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_capture",
      arguments: { session: "dev-impl@my-rig" },
    });

    expect(postFn).toHaveBeenCalled();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("pane output");
    await cleanup();
  });
});
