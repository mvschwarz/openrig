import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DaemonClient, DaemonResponse } from "./client.js";

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
    name: "rigged",
    version: "0.1.0",
  });

  // 1. rigged_up — bootstrap/bundle install
  server.tool(
    "rigged_up",
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

  // 2. rigged_down — rig teardown
  server.tool(
    "rigged_down",
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

  // 3. rigged_ps — list running rigs
  server.tool(
    "rigged_ps",
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

  // 4. rigged_status — daemon health
  server.tool(
    "rigged_status",
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

  // 5. rigged_snapshot_create — create snapshot
  server.tool(
    "rigged_snapshot_create",
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

  // 6. rigged_snapshot_list — list snapshots
  server.tool(
    "rigged_snapshot_list",
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

  // 7. rigged_restore — restore from snapshot
  server.tool(
    "rigged_restore",
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

  // 8. rigged_discover — scan for sessions
  server.tool(
    "rigged_discover",
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

  // 9. rigged_claim — claim discovered session
  server.tool(
    "rigged_claim",
    "Claim a discovered session into a rig",
    {
      discoveryId: z.string().describe("Discovery session identifier"),
      rigId: z.string().describe("Target rig identifier"),
      logicalId: z.string().optional().describe("Node name (default: tmux session name)"),
    },
    async ({ discoveryId, rigId, logicalId }) => {
      try {
        const res = await client.post(`/api/discovery/${encodeURIComponent(discoveryId)}/claim`, { rigId, logicalId });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 10. rigged_bundle_inspect — inspect a bundle
  server.tool(
    "rigged_bundle_inspect",
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

  // 11. rigged_agent_validate — validate an AgentSpec
  server.tool(
    "rigged_agent_validate",
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

  // 12. rigged_rig_validate — validate a RigSpec
  server.tool(
    "rigged_rig_validate",
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

  // 13. rigged_rig_nodes — node inventory for a rig
  server.tool(
    "rigged_rig_nodes",
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

  // 14. rigged_send — send message to agent session
  server.tool(
    "rigged_send",
    "Send a message to an agent's terminal using reliable two-step send",
    {
      session: z.string().describe("Target session name (e.g. dev-impl@my-rig)"),
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

  // 15. rigged_capture — capture terminal output from agent session
  server.tool(
    "rigged_capture",
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

  return server;
}
