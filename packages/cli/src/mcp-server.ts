import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient, DaemonResponse } from "./client.js";
import { CLI_VERSION } from "./version.js";

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
};

/**
 * Maps a DaemonResponse to MCP tool result.
 * Three error levels: HTTP status, in-body errors, and structural failure fields.
 * @param res - DaemonResponse from DaemonClient
 * @param structuralCheck - optional extra check for tool-specific structural failures
 * @returns MCP tool result
 */
function mapResult(
  res: DaemonResponse<unknown>,
  structuralCheck?: (data: Record<string, unknown>) => boolean,
): TextResult {
  const text = JSON.stringify(res.data);

  // Level 1: HTTP error
  if (res.status >= 400) {
    return { content: [{ type: "text", text }], isError: true };
  }

  const data = res.data as Record<string, unknown>;

  // Level 2: In-body error/errors fields
  if (data.error || (Array.isArray(data.errors) && data.errors.length > 0)) {
    return { content: [{ type: "text", text }], isError: true };
  }

  // Level 3: Tool-specific structural failure
  if (structuralCheck && structuralCheck(data)) {
    return { content: [{ type: "text", text }], isError: true };
  }

  return { content: [{ type: "text", text }] };
}

/**
 * Creates an MCP server wrapping the daemon HTTP API.
 * @param client - DaemonClient connected to the daemon
 * @returns McpServer instance (not yet connected to a transport)
 */
export function createMcpServer(client: DaemonClient): McpServer {
  const server = new McpServer({
    name: "openrig",
    version: CLI_VERSION,
  });

  // 1. rig_up — bootstrap/bundle install
  server.tool(
    "rig_up",
    "Bootstrap a rig from a spec or bundle",
    {
      sourceRef: z.string().describe("Path to .yaml rig spec or .rigbundle"),
      plan: z.boolean().optional().describe("Plan mode — preview without executing"),
      autoApprove: z.boolean().optional().describe("Auto-approve trusted actions"),
      targetRoot: z.string().optional().describe("Target root directory for package installation"),
    },
    async ({ sourceRef, plan, autoApprove, targetRoot }) => {
      try {
        const res = await client.post("/api/up", { sourceRef, plan: plan ?? false, autoApprove: autoApprove ?? false, targetRoot });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 2. rig_down — rig teardown
  server.tool(
    "rig_down",
    "Tear down a rig",
    {
      rigId: z.string().describe("Rig identifier to tear down"),
      delete: z.boolean().optional().describe("Delete rig record after stopping"),
      force: z.boolean().optional().describe("Kill sessions immediately"),
      snapshot: z.boolean().optional().describe("Take snapshot before teardown"),
    },
    async (params) => {
      try {
        const res = await client.post("/api/down", {
          rigId: params.rigId,
          delete: params.delete ?? false,
          force: params.force ?? false,
          snapshot: params.snapshot ?? false,
        });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 3. rig_ps — list running rigs
  server.tool(
    "rig_ps",
    "List rigs and their status",
    {},
    async () => {
      try {
        const res = await client.get("/api/ps");
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 4. rig_status — daemon health
  server.tool(
    "rig_status",
    "Check daemon health",
    {},
    async () => {
      try {
        const res = await client.get("/healthz");
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 5. rig_snapshot_create — create snapshot
  server.tool(
    "rig_snapshot_create",
    "Create a snapshot for a rig",
    {
      rigId: z.string().describe("Rig identifier"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`, {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 6. rig_snapshot_list — list snapshots
  server.tool(
    "rig_snapshot_list",
    "List snapshots for a rig",
    {
      rigId: z.string().describe("Rig identifier"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/snapshots`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 7. rig_restore — restore from snapshot
  server.tool(
    "rig_restore",
    "Restore a rig from a snapshot",
    {
      rigId: z.string().describe("Rig identifier"),
      snapshotId: z.string().describe("Snapshot identifier"),
    },
    async ({ rigId, snapshotId }) => {
      try {
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/restore/${encodeURIComponent(snapshotId)}`, {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 8. rig_discover — scan for sessions
  server.tool(
    "rig_discover",
    "Scan for tmux sessions to discover",
    {},
    async () => {
      try {
        const res = await client.post("/api/discovery/scan", {});
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 9. rig_bind — bind discovered session to a rig node (existing or new in pod)
  server.tool(
    "rig_bind",
    "Bind a discovered session to an existing node or create a new node in a pod",
    {
      discoveryId: z.string().describe("Discovery session identifier"),
      rigId: z.string().describe("Target rig identifier"),
      logicalId: z.string().optional().describe("Existing node logical ID (mode: bind to existing)"),
      podNamespace: z.string().optional().describe("Pod namespace to create node in (mode: create in pod)"),
      memberName: z.string().optional().describe("Member name for new node (required with podNamespace)"),
    },
    async ({ discoveryId, rigId, logicalId, podNamespace, memberName }) => {
      try {
        const body: Record<string, unknown> = { rigId };
        if (logicalId) body["logicalId"] = logicalId;
        if (podNamespace) body["podNamespace"] = podNamespace;
        if (memberName) body["memberName"] = memberName;
        const res = await client.post(`/api/discovery/${encodeURIComponent(discoveryId)}/bind`, body);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 10. rig_bundle_inspect — inspect a bundle
  server.tool(
    "rig_bundle_inspect",
    "Inspect a .rigbundle file",
    {
      bundlePath: z.string().describe("Path to .rigbundle file"),
    },
    async ({ bundlePath }) => {
      try {
        const res = await client.post("/api/bundles/inspect", { bundlePath });
        return mapResult(res, (data) => {
          // Structural failure: digest invalid or integrity check failed
          if (data.digestValid === false) return true;
          const integrity = data.integrityResult as { passed?: boolean } | undefined;
          if (integrity && integrity.passed === false) return true;
          return false;
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 11. rig_agent_validate — validate an AgentSpec
  server.tool(
    "rig_agent_validate",
    "Validate an AgentSpec (agent.yaml) from YAML text",
    {
      yaml: z.string().describe("YAML text of the agent spec"),
    },
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/agents/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 12. rig_rig_validate — validate a RigSpec
  server.tool(
    "rig_rig_validate",
    "Validate a RigSpec (rig.yaml) from YAML text",
    {
      yaml: z.string().describe("YAML text of the rig spec"),
    },
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/rigs/import/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 13. rig_rig_nodes — node inventory for a rig
  server.tool(
    "rig_rig_nodes",
    "Get node inventory for a rig — session names, status, attach commands, resume commands",
    {
      rigId: z.string().describe("Rig identifier"),
    },
    async ({ rigId }) => {
      try {
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/nodes`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 14. rig_send — send message to agent session
  server.tool(
    "rig_send",
    "Send a message to an agent's terminal using reliable two-step send",
    {
      session: z.string().describe("Target session name (e.g. dev.impl@my-rig)"),
      text: z.string().describe("Message text to send"),
      verify: z.boolean().optional().describe("Verify delivery by checking pane content"),
      force: z.boolean().optional().describe("Send even if target appears mid-task"),
    },
    async ({ session, text, verify, force }) => {
      try {
        const res = await client.post("/api/transport/send", { session, text, verify, force });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 15. rig_capture — capture terminal output from agent session
  server.tool(
    "rig_capture",
    "Capture terminal output from an agent session",
    {
      session: z.string().optional().describe("Session name (omit for multi-target with rig/pod)"),
      rig: z.string().optional().describe("Capture all sessions in a rig"),
      pod: z.string().optional().describe("Capture all sessions in a pod"),
      lines: z.number().optional().describe("Number of lines to capture (default: 20)"),
    },
    async ({ session, rig, pod, lines }) => {
      try {
        const body: Record<string, unknown> = {};
        if (session) body.session = session;
        if (rig) body.rig = rig;
        if (pod) body.pod = pod;
        if (lines) body.lines = lines;
        const res = await client.post("/api/transport/capture", body);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 16. rig_chatroom_send — send message to rig chatroom
  server.tool(
    "rig_chatroom_send",
    "Send a message to a rig's chatroom",
    {
      rigName: z.string().describe("Rig name to send message to"),
      body: z.string().describe("Message body"),
      sender: z.string().optional().describe("Sender name (default: mcp)"),
    },
    async ({ rigName, body, sender }) => {
      try {
        // Resolve rig name → ID
        const summaryRes = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
        const matches = (summaryRes.data ?? []).filter((r) => r.name === rigName);

        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Rig '${rigName}' not found` }) }], isError: true as const };
        }
        if (matches.length > 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Rig '${rigName}' is ambiguous — ${matches.length} rigs share that name` }) }], isError: true as const };
        }

        const rigId = matches[0]!.id;
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/chat/send`, {
          sender: sender ?? "mcp",
          body,
        });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 17. rig_chatroom_watch — get recent chatroom history for a rig
  server.tool(
    "rig_chatroom_watch",
    "Get recent chatroom messages for a rig (MCP returns history, not streaming)",
    {
      rigName: z.string().describe("Rig name"),
    },
    async ({ rigName }) => {
      try {
        // Resolve rig name → ID
        const summaryRes = await client.get<Array<{ id: string; name: string }>>("/api/rigs/summary");
        const matches = (summaryRes.data ?? []).filter((r) => r.name === rigName);

        if (matches.length === 0) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Rig '${rigName}' not found` }) }], isError: true as const };
        }
        if (matches.length > 1) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Rig '${rigName}' is ambiguous — ${matches.length} rigs share that name` }) }], isError: true as const };
        }

        const rigId = matches[0]!.id;
        const res = await client.get(`/api/rigs/${encodeURIComponent(rigId)}/chat/history?limit=20`);
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  return server;
}
