import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/mcp-server.js";
import { DaemonClient, DaemonConnectionError, type DaemonResponse } from "../src/client.js";

function mockClient(overrides?: {
  get?: (path: string) => Promise<DaemonResponse>;
  post?: (path: string, body?: unknown, options?: { timeoutMs?: number }) => Promise<DaemonResponse>;
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

  // T1: MCP server lists all 26 tools: the original 18, the five queue tools, the telemetry events read, restore status and whoami
  it("lists all 26 tools", async () => {
    await setup();
    const result = await mcpClient.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "rig_add",
      "rig_agent_validate",
      "rig_bind",
      "rig_bundle_inspect",
      "rig_capture",
      "rig_chatroom_send",
      "rig_chatroom_watch",
      "rig_discover",
      "rig_down",
      "rig_ps",
      "rig_queue_claim",
      "rig_queue_create",
      "rig_queue_list",
      "rig_queue_show",
      "rig_queue_update",
      "rig_restore",
      "rig_restore_status",
      "rig_rig_nodes",
      "rig_rig_validate",
      "rig_send",
      "rig_snapshot_create",
      "rig_snapshot_list",
      "rig_status",
      "rig_telemetry_events",
      "rig_up",
      "rig_whoami",
    ]);
    await cleanup();
  });

  // rig_add: posts the member fragment to the pod-members route.
  it("rig_add posts to the pod-members route and returns the added node", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: {
        ok: true,
        result: {
          podId: "pod-1",
          podNamespace: "infra",
          node: { logicalId: "infra.server2", nodeId: "n2", status: "launched", sessionName: "infra-server2@r" },
          warnings: [],
        },
      },
    }));
    await setup({ post: postFn });

    const member = { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
    const result = await mcpClient.callTool({
      name: "rig_add",
      arguments: { rigId: "rig-1", podNamespace: "infra", member },
    });

    expect(postFn).toHaveBeenCalledWith("/api/rigs/rig-1/pods/infra/members", { member });
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result.node.logicalId).toBe("infra.server2");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  it("rig_add forwards optional pod-local edges in the request body", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: { ok: true, result: { podId: "pod-1", podNamespace: "infra", node: { logicalId: "infra.server2", nodeId: "n2", status: "launched" }, edges: [{ from: "infra.server2", to: "infra.server", kind: "delegates_to" }] } },
    }));
    await setup({ post: postFn });

    const member = { id: "server2", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: "/tmp" };
    const edges = [{ from: "server2", to: "server", kind: "delegates_to" }];
    await mcpClient.callTool({ name: "rig_add", arguments: { rigId: "rig-1", podNamespace: "infra", member, edges } });

    expect(postFn).toHaveBeenCalledWith("/api/rigs/rig-1/pods/infra/members", { member, edges });
    await cleanup();
  });

  it("rig_add surfaces a member_conflict (HTTP 409) as isError", async () => {
    const postFn = vi.fn(async () => ({
      status: 409,
      data: { ok: false, code: "member_conflict", message: 'Member "infra.server" already exists' },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_add",
      arguments: { rigId: "rig-1", podNamespace: "infra", member: { id: "server" } },
    });

    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text: string }>;
    expect(JSON.parse(content[0].text).code).toBe("member_conflict");
    await cleanup();
  });

  it("rig_add flags a persisted-but-not-launched node as isError", async () => {
    const postFn = vi.fn(async () => ({
      status: 201,
      data: {
        ok: true,
        result: {
          podId: "pod-1",
          podNamespace: "infra",
          node: { logicalId: "infra.server2", nodeId: "n2", status: "failed", error: "harness launch failed" },
        },
      },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_add",
      arguments: { rigId: "rig-1", podNamespace: "infra", member: { id: "server2" } },
    });

    expect(result.isError).toBe(true);
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

    expect(postFn).toHaveBeenCalledWith(
      "/api/up",
      {
        sourceRef: "/tmp/rig.yaml",
        plan: false,
        autoApprove: true,
        targetRoot: undefined,
      },
      { timeoutMs: 120_000 },
    );
    const content = result.content as Array<{ type: string; text: string }>;
    const parsed = JSON.parse(content[0].text);
    expect(parsed.status).toBe("completed");
    expect(result.isError).toBeFalsy();
    await cleanup();
  });

  // T3: rig_down calls POST /api/down
  it("rig_up passes cwd, env, a rig name and fresh seats, and refuses an env the daemon would drop", async () => {
    const postFn = vi.fn(async () => ({ status: 201, data: { status: "completed" } }));
    await setup({ post: postFn });

    const ok = await mcpClient.callTool({
      name: "rig_up",
      arguments: { sourceRef: "/work/rig.yaml", cwd: "/work/app", env: { API_MODE: "test" }, rigName: "app-team", fresh: ["dev.impl"] },
    });
    expect(ok.isError).toBeFalsy();
    expect(postFn).toHaveBeenCalledWith("/api/up", expect.objectContaining({
      sourceRef: "/work/rig.yaml", cwdOverride: "/work/app", envOverride: { API_MODE: "test" }, rigName: "app-team", freshLogicalIds: ["dev.impl"],
    }), { timeoutMs: 120_000 });

    // The daemon ignores an env block with any invalid entry, so the launch would run without it; refuse it before sending.
    for (const env of [{ "lower-case": "x" }, { OPENRIG_HOME: "/tmp" }, { EMPTY: "" }]) {
      const refused = await mcpClient.callTool({ name: "rig_up", arguments: { sourceRef: "/work/rig.yaml", env } });
      expect(refused.isError).toBe(true);
    }
    const relative = await mcpClient.callTool({ name: "rig_up", arguments: { sourceRef: "/work/rig.yaml", cwd: "app" } });
    expect(relative.isError).toBe(true);
    expect(postFn).toHaveBeenCalledTimes(1);
    await cleanup();
  });

  it("declares read and change hints on every tool, so a client can let the reads through once", async () => {
    await setup();
    const { tools } = await mcpClient.listTools();
    const reads = ["rig_agent_validate", "rig_bundle_inspect", "rig_capture", "rig_chatroom_watch", "rig_ps", "rig_queue_list", "rig_queue_show",
      "rig_restore_status", "rig_rig_nodes", "rig_rig_validate", "rig_snapshot_list", "rig_status", "rig_telemetry_events", "rig_whoami"];
    const additive = ["rig_add", "rig_chatroom_send", "rig_queue_create", "rig_snapshot_create"];
    // Discover refreshes and retires discovered facts; claim ends a blocked row's wait. Both change existing state.
    const destructive = ["rig_bind", "rig_discover", "rig_down", "rig_queue_claim", "rig_queue_update", "rig_restore", "rig_send", "rig_up"];
    const hints = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    expect(Object.keys(hints).sort()).toEqual([...reads, ...additive, ...destructive].sort());
    for (const name of reads) expect(hints[name], name).toEqual({ readOnlyHint: true });
    for (const name of additive) expect(hints[name], name).toEqual({ readOnlyHint: false, destructiveHint: false });
    for (const name of destructive) expect(hints[name], name).toEqual({ readOnlyHint: false, destructiveHint: true });
    await cleanup();
  });

  it("rig_send and rig_capture send the daemon's terminal token when one is configured, as the CLI does", async () => {
    vi.stubEnv("OPENRIG_TERMINAL_BEARER_TOKEN", "terminal-secret");
    try {
      const postFn = vi.fn(async () => ({ status: 200, data: { ok: true } }));
      await setup({ post: postFn });
      await mcpClient.callTool({ name: "rig_send", arguments: { session: "dev-impl@my-rig", text: "hello" } });
      await mcpClient.callTool({ name: "rig_send", arguments: { session: "dev-impl@my-rig", text: "hello", waitForIdleSeconds: 30 } });
      await mcpClient.callTool({ name: "rig_capture", arguments: { session: "dev-impl@my-rig" } });
      const auth = { headers: { Authorization: "Bearer terminal-secret" } };
      expect(postFn.mock.calls.map((call) => (call as unknown[])[2])).toEqual([auth, { timeoutMs: 35000, ...auth }, auth]);
      await cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rig_restore says it only starts the restore, and rig_restore_status follows the attempt", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "rig-1", name: "my-rig" }] };
      if (path === "/api/rigs/rig-1/restore/status/7") return { status: 409, data: { error: "Restore attempt 7 has no terminal completion event", code: "attempt_incomplete" } };
      if (path === "/api/rigs/rig-1/restore/status/8") return { status: 200, data: { ok: true, attemptId: 8, rigResult: "fully_restored" } };
      return { status: 404, data: { error: "unexpected" } };
    });
    await setup({ get: getFn });
    const { tools } = await mcpClient.listTools();
    expect(tools.find((tool) => tool.name === "rig_restore")?.description).toContain("rig_restore_status");
    // No completion event can also mean the attempt stopped, so the description doesn't promise it's still running.
    expect(tools.find((tool) => tool.name === "rig_restore_status")?.description).toContain("stopped before it finished");

    const incomplete = await mcpClient.callTool({ name: "rig_restore_status", arguments: { rigId: "my-rig", attemptId: 7 } });
    expect(incomplete.isError).toBe(true);
    expect(incomplete.structuredContent).toEqual({ ok: false, code: "attempt_incomplete", message: "Restore attempt 7 has no terminal completion event", status: 409 });

    const done = await mcpClient.callTool({ name: "rig_restore_status", arguments: { rigId: "my-rig", attemptId: 8 } });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toEqual({ ok: true, attemptId: 8, rigResult: "fully_restored" });

    // Arguments the input schema refuses never reach the tool: the SDK answers with its own text-only error.
    const invalid = await mcpClient.callTool({ name: "rig_restore_status", arguments: { rigId: "my-rig", attemptId: 0 } });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect((invalid.content as Array<{ text: string }>)[0]!.text).toContain("Invalid arguments for tool rig_restore_status");
    await cleanup();
  });

  it("rig_whoami reads the seat this server is configured as, and says plainly when there is none", async () => {
    try {
      vi.stubEnv("OPENRIG_SESSION_NAME", "dev-impl@my-rig");
      vi.stubEnv("RIGGED_SESSION_NAME", "");
      vi.stubEnv("OPENRIG_TARGET_REPO", "");
      vi.stubEnv("RIGGED_TARGET_REPO", "");
      const identity = { identity: { sessionName: "dev-impl@my-rig", rigName: "my-rig" }, peers: [] };
      const getFn = vi.fn(async () => ({ status: 200, data: identity }));
      await setup({ get: getFn });
      const seated = await mcpClient.callTool({ name: "rig_whoami", arguments: {} });
      expect(getFn).toHaveBeenCalledWith("/api/whoami?sessionName=dev-impl%40my-rig&compact=1");
      expect(seated.structuredContent).toEqual(identity);
      await cleanup();

      vi.stubEnv("OPENRIG_SESSION_NAME", "");
      const quietGet = vi.fn(async () => ({ status: 200, data: {} }));
      await setup({ get: quietGet });
      const unseated = await mcpClient.callTool({ name: "rig_whoami", arguments: {} });
      expect(unseated.isError).toBeFalsy();
      expect(unseated.structuredContent).toMatchObject({ ok: true, seat: null });
      expect(quietGet).not.toHaveBeenCalled();
      await cleanup();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the queue tools return structured content; every error a tool returns carries one shape and keeps its old text", async () => {
    // The queue's missing-item read answers with its code alone, as GET /api/queue/:qitemId does.
    const missing = { error: "qitem_not_found" };
    const getFn = vi.fn(async (path: string) => {
      if (path === "/api/queue/qitem-1") return { status: 200, data: { qitemId: "qitem-1", state: "done" } };
      if (path === "/api/queue/qitem-1/transitions") return { status: 200, data: [{ state: "done" }] };
      if (path === "/api/queue/qitem-x") return { status: 404, data: missing };
      if (path === "/api/queue/qitem-y") return { status: 409, data: { error: "not-found", message: "No pending decision has that id." } };
      if (path.startsWith("/api/queue/list")) return { status: 200, data: [{ qitemId: "qitem-1" }] };
      return { status: 404, data: {} };
    });
    const postFn = vi.fn(async () => { throw new DaemonConnectionError("Cannot reach the OpenRig daemon at http://127.0.0.1:9999"); });
    await setup({ get: getFn, post: postFn });

    const shown = await mcpClient.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-1" } });
    expect(shown.structuredContent).toEqual({ item: { qitemId: "qitem-1", state: "done" }, transitions: [{ state: "done" }] });
    const listed = await mcpClient.callTool({ name: "rig_queue_list", arguments: { destination: "dev-impl@my-rig" } });
    expect(listed.structuredContent).toEqual({ items: [{ qitemId: "qitem-1" }] });

    const notFound = await mcpClient.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-x" } });
    expect(notFound.isError).toBe(true);
    expect((notFound.content as Array<{ text: string }>)[0]!.text).toBe(JSON.stringify(missing));
    expect(notFound.structuredContent).toEqual({ ok: false, code: "qitem_not_found", message: "qitem_not_found", status: 404 });
    // An error beside a message is the route's code, whatever its spelling, and the message stays readable.
    const paired = await mcpClient.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-y" } });
    expect(paired.structuredContent).toEqual({ ok: false, code: "not-found", message: "No pending decision has that id.", status: 409 });

    const unreachable = await mcpClient.callTool({ name: "rig_queue_claim", arguments: { qitemId: "qitem-1" } });
    expect((unreachable.content as Array<{ text: string }>)[0]!.text).toBe("Cannot reach the OpenRig daemon at http://127.0.0.1:9999");
    expect(unreachable.structuredContent).toEqual({ ok: false, code: "daemon_unreachable", message: "Cannot reach the OpenRig daemon at http://127.0.0.1:9999" });
    await cleanup();
  });

  it("gives the client short instructions on the seat, durable delegation and reserved questions", async () => {
    await setup();
    const instructions = mcpClient.getInstructions() ?? "";
    expect(instructions).toContain("OPENRIG_SESSION_NAME");
    expect(instructions).toContain("rig_queue_create");
    expect(instructions).toContain("not idle");
    expect(instructions).toContain("reserved for a person");
    await cleanup();
  });

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
    expect(result.tools.length).toBe(26);

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
    expect(result2.tools.length).toBe(26);

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
    expect(postFn.mock.calls[0]?.[2]).toBeUndefined();
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.sessionName).toBe("dev-impl@my-rig");
    await cleanup();
  });

  it("rig_send with waitForIdleSeconds extends request timeout", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true, sessionName: "dev-impl@my-rig" },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_send",
      arguments: { session: "dev-impl@my-rig", text: "hello", waitForIdleSeconds: 30 },
    });

    expect(postFn).toHaveBeenCalledWith(
      "/api/transport/send",
      expect.objectContaining({
        session: "dev-impl@my-rig",
        text: "hello",
        waitForIdleMs: 30000,
      }),
      { timeoutMs: 35000 },
    );
    expect(result.isError).toBeUndefined();
    await cleanup();
  });

  it("rig_send rejects waitForIdleSeconds with force before daemon contact", async () => {
    const postFn = vi.fn(async () => ({
      status: 200,
      data: { ok: true },
    }));
    await setup({ post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_send",
      arguments: { session: "dev-impl@my-rig", text: "hello", waitForIdleSeconds: 30, force: true },
    });

    expect(result.isError).toBe(true);
    expect(postFn).not.toHaveBeenCalled();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.error).toContain("cannot be combined");
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
      if (path.startsWith("/api/rigs/summary")) {
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
    expect(getFn).toHaveBeenCalledWith("/api/rigs/rig-1/chat/history?limit=20");
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
    const postFn = vi.fn(async () => ({ status: 201, data: {} }));
    await setup({ get: getFn, post: postFn });

    const result = await mcpClient.callTool({
      name: "rig_chatroom_send",
      arguments: { rigName: "my-rig", body: "hello" },
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed).toMatchObject({ code: "rig_ambiguous", candidates: ["rig-1", "rig-2"] });
    expect(postFn).not.toHaveBeenCalled();
    await cleanup();
  });

  it("the chatroom tools take a rig id as well as a name; watch reads one topic, sender and page size; send ignores an old sender argument", async () => {
    const getFn = vi.fn(async (path: string) => {
      if (path.startsWith("/api/rigs/summary")) return { status: 200, data: [{ id: "01RIG", name: "my-rig", nodeCount: 2 }] };
      return { status: 200, data: [] };
    });
    const postFn = vi.fn(async () => ({ status: 201, data: { id: "msg-1", body: "hello" } }));
    await setup({ get: getFn, post: postFn });

    const sent = await mcpClient.callTool({ name: "rig_chatroom_send", arguments: { rigName: "01RIG", body: "hello", sender: "someone-else" } });
    expect(sent.isError).toBeFalsy();
    expect(postFn).toHaveBeenCalledWith("/api/rigs/01RIG/chat/send", { body: "hello" });

    const read = await mcpClient.callTool({ name: "rig_chatroom_watch", arguments: { rigName: "my-rig", topic: "release", sender: "dev-impl@my-rig", limit: 5 } });
    expect(read.isError).toBeFalsy();
    expect(getFn).toHaveBeenCalledWith("/api/rigs/01RIG/chat/history?limit=5&topic=release&sender=dev-impl%40my-rig");

    // A handle no rig has is an error, not an empty room.
    const missing = await mcpClient.callTool({ name: "rig_chatroom_watch", arguments: { rigName: "no-such-rig" } });
    expect(missing.isError).toBe(true);
    expect((missing.content as Array<{ text: string }>)[0]!.text).toContain("not found");
    await cleanup();
  });

  it("the chatroom tools report a rig list they can't read, instead of an empty room", async () => {
    const getFn = vi.fn(async (path: string) => (path.startsWith("/api/rigs/summary")
      ? { status: 500, data: { error: "unavailable" } }
      : { status: 200, data: [] }));
    await setup({ get: getFn });
    const read = await mcpClient.callTool({ name: "rig_chatroom_watch", arguments: { rigName: "my-rig" } });
    expect(read.isError).toBe(true);
    expect((read.content as Array<{ text: string }>)[0]!.text).toContain("could not be checked");
    expect(getFn.mock.calls.some(([path]) => String(path).includes("/chat/history"))).toBe(false);
    await cleanup();
  });

  // T15: rig_capture asks for the input box and returns structured result
  it("rig_capture asks for the input box and returns structured result", async () => {
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
    const [path, body] = postFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/api/transport/capture");
    expect(body).toEqual({ session: "dev-impl@my-rig", inputBox: true });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("pane output");
    await cleanup();
  });
  describe("queue tools", () => {
    const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0]!.text;

    it("rig_queue_create posts the task with a minted request id and no body sender", async () => {
      const postFn = vi.fn(async () => ({ status: 201, data: { qitemId: "qitem-1" } }));
      await setup({ post: postFn });
      const result = await mcpClient.callTool({ name: "rig_queue_create", arguments: { destination: "impl@team", body: "Do X", summary: "X", tags: ["mission:m"] } });
      expect(result.isError).toBeUndefined();
      const [path, body] = postFn.mock.calls[0] as unknown as [string, Record<string, unknown>];
      expect(path).toBe("/api/queue/create");
      expect(body).toMatchObject({ destinationSession: "impl@team", body: "Do X", summary: "X", tags: ["mission:m"] });
      expect(body.qitemId).toMatch(/^qitem-\d{14}-[0-9a-f]{16}$/);
      expect(body).not.toHaveProperty("sourceSession");
      await cleanup();
    });

    it("rig_queue_create reuses a given request id and names it when the outcome is unknown", async () => {
      const postFn = vi.fn(async () => { throw new Error("timed out after 5000ms"); });
      await setup({ post: postFn });
      const result = await mcpClient.callTool({ name: "rig_queue_create", arguments: { destination: "impl@team", body: "Do X", qitemId: "qitem-retry" } });
      expect((postFn.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].qitemId).toBe("qitem-retry");
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("unknown");
      expect(text(result)).toContain("qitem-retry");
      await cleanup();
    });

    it("rig_queue_show returns the item and its transitions together", async () => {
      const getFn = vi.fn(async (path: string) => path.endsWith("/transitions")
        ? { status: 200, data: [{ state: "done", transitionNote: "the answer" }] }
        : { status: 200, data: { qitemId: "qitem 1", state: "done" } });
      await setup({ get: getFn });
      const result = await mcpClient.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem 1" } });
      expect(getFn.mock.calls.map(c => c[0])).toEqual(["/api/queue/qitem%201", "/api/queue/qitem%201/transitions"]);
      expect(JSON.parse(text(result))).toEqual({ item: { qitemId: "qitem 1", state: "done" }, transitions: [{ state: "done", transitionNote: "the answer" }] });
      await cleanup();
    });

    it("rig_queue_show surfaces a missing item as an error without reading transitions", async () => {
      const getFn = vi.fn(async () => ({ status: 404, data: { error: "not found" } }));
      await setup({ get: getFn });
      const result = await mcpClient.callTool({ name: "rig_queue_show", arguments: { qitemId: "qitem-x" } });
      expect(result.isError).toBe(true);
      expect(getFn).toHaveBeenCalledTimes(1);
      await cleanup();
    });

    it("rig_queue_list scopes owned and mine to this server's seat", async () => {
      const getFn = vi.fn(async () => ({ status: 200, data: [] }));
      const prior = process.env.OPENRIG_SESSION_NAME;
      process.env.OPENRIG_SESSION_NAME = "desk@team";
      try {
        await setup({ get: getFn });
        await mcpClient.callTool({ name: "rig_queue_list", arguments: { owned: true } });
        await mcpClient.callTool({ name: "rig_queue_list", arguments: { mine: true, all: true } });
        await mcpClient.callTool({ name: "rig_queue_list", arguments: {} });
        await mcpClient.callTool({ name: "rig_queue_list", arguments: { owned: true, destination: "other@team" } });
        const queries = getFn.mock.calls.map(c => new URLSearchParams(String(c[0]).split("?")[1]));
        expect(queries[3]!.getAll("destinationSession")).toEqual(["desk@team"]);
        expect(queries[0]!.get("destinationSession")).toBe("desk@team");
        expect(queries[0]!.get("activeOnly")).toBe("1");
        expect(queries[1]!.get("as")).toBe("desk@team");
        expect(queries[1]!.has("activeOnly")).toBe(false);
        expect(queries[2]!.get("rig")).toBe("team");
        await cleanup();
      } finally {
        if (prior === undefined) delete process.env.OPENRIG_SESSION_NAME; else process.env.OPENRIG_SESSION_NAME = prior;
      }
    });

    it("rig_queue_list asks for a seat instead of guessing one", async () => {
      const getFn = vi.fn(async () => ({ status: 200, data: [] }));
      const prior = process.env.OPENRIG_SESSION_NAME;
      const priorLegacy = process.env.RIGGED_SESSION_NAME;
      delete process.env.OPENRIG_SESSION_NAME;
      delete process.env.RIGGED_SESSION_NAME;
      try {
        await setup({ get: getFn });
        const result = await mcpClient.callTool({ name: "rig_queue_list", arguments: { owned: true } });
        expect(result.isError).toBe(true);
        expect(getFn).not.toHaveBeenCalled();
        await cleanup();
      } finally {
        if (prior !== undefined) process.env.OPENRIG_SESSION_NAME = prior;
        if (priorLegacy !== undefined) process.env.RIGGED_SESSION_NAME = priorLegacy;
      }
    });

    it("rig_queue_claim and rig_queue_update post to the item's routes", async () => {
      const postFn = vi.fn(async () => ({ status: 200, data: { ok: true } }));
      await setup({ post: postFn });
      await mcpClient.callTool({ name: "rig_queue_claim", arguments: { qitemId: "qitem-1" } });
      await mcpClient.callTool({ name: "rig_queue_update", arguments: { qitemId: "qitem-1", state: "done", closureReason: "no-follow-on", note: "the answer" } });
      expect(postFn.mock.calls[0]?.[0]).toBe("/api/queue/qitem-1/claim");
      expect(postFn.mock.calls[1]?.[0]).toBe("/api/queue/qitem-1/update");
      expect(postFn.mock.calls[1]?.[1]).toMatchObject({ state: "done", closureReason: "no-follow-on", transitionNote: "the answer" });
      await cleanup();
    });
    it("rig_queue_update passes the outcome as resolution and a deliberate reopen", async () => {
      const postFn = vi.fn(async () => ({ status: 200, data: { ok: true } }));
      await setup({ post: postFn });
      await mcpClient.callTool({ name: "rig_queue_update", arguments: { qitemId: "qitem-1", state: "done", closureReason: "no-follow-on", resolution: "the answer" } });
      await mcpClient.callTool({ name: "rig_queue_update", arguments: { qitemId: "qitem-1", state: "pending", reopen: true, note: "one more detail" } });
      expect(postFn.mock.calls[0]?.[1]).toMatchObject({ state: "done", resolution: "the answer" });
      expect(postFn.mock.calls[1]?.[1]).toMatchObject({ state: "pending", reopen: true, transitionNote: "one more detail" });
      await cleanup();
    });
  });
});
