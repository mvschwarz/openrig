import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import type { DaemonClient, DaemonResponse } from "./client.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { CLI_VERSION } from "./version.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

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
        const res = await client.post(
          "/api/up",
          { sourceRef, plan: plan ?? false, autoApprove: autoApprove ?? false, targetRoot },
          plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
        );
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
      session: z.string().describe("Target session name (e.g. dev-impl@my-rig)"),
      text: z.string().describe("Message text to send"),
      verify: z.boolean().optional().describe("Verify delivery by checking pane content"),
      force: z.boolean().optional().describe("Send even if target appears mid-task"),
      waitForIdleSeconds: z.number().positive().optional().describe("Wait until explicit idle evidence before sending"),
    },
    async ({ session, text, verify, force, waitForIdleSeconds }) => {
      try {
        if (force && waitForIdleSeconds !== undefined) {
          return {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: "waitForIdleSeconds cannot be combined with force" }) }],
            isError: true,
          };
        }
        const waitForIdleMs = waitForIdleSeconds === undefined ? undefined : Math.ceil(waitForIdleSeconds * 1000);
        const res = await client.post("/api/transport/send", {
          session,
          text,
          verify,
          force,
          waitForIdleMs,
        }, waitForIdleRequestOptions(waitForIdleMs));
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
        body.inputBox = true; // what the live input box holds, in the result's inputBox
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
      sender: z.string().optional().describe("(deprecated, ignored) the sender is derived from the seat env (X-OpenRig-Session, stamped by the MCP server's DaemonClient); the chat route derives it from the transport header"),
    },
    async ({ rigName, body }) => {
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
        // P21: no body sender — the daemon derives it from the transport header (X-OpenRig-Session,
        // stamped by the MCP server's DaemonClient from its seat env). A hardcoded 'mcp' differing from the
        // header would be SUPERSEDED by it (transport:v1), not persisted (P18: the 409 mismatch is retired).
        const res = await client.post(`/api/rigs/${encodeURIComponent(rigId)}/chat/send`, {
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

  // 18. rig_add — add a single member to an existing pod (the add_member
  // converge op). Agent parity for `rig add`: the ergonomics live ON the
  // converge interface, so every future reshape verb inherits this surface.
  server.tool(
    "rig_add",
    "Add a single member to an existing pod in a running rig (the add_member converge op). Identity-migration-free: mints a fresh seat, nothing existing re-keys.",
    {
      rigId: z.string().describe("Target rig identifier"),
      podNamespace: z.string().describe("Namespace of the existing pod to add the member to"),
      member: z.record(z.string(), z.unknown()).describe("Member fragment with spec snake_case fields: id, runtime, agent_ref, profile, cwd (and optional model, codex_config_profile, restore_policy, label)"),
      edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).optional().describe("Optional pod-local edges (from/to are member ids within the pod; resolved against the new member + existing pod-mates)"),
      rigRoot: z.string().optional().describe("Root directory for agent resolution"),
    },
    async ({ rigId, podNamespace, member, edges, rigRoot }) => {
      try {
        const body: Record<string, unknown> = { member };
        if (edges) body["edges"] = edges;
        if (rigRoot) body["rigRoot"] = rigRoot;
        const res = await client.post(
          `/api/rigs/${encodeURIComponent(rigId)}/pods/${encodeURIComponent(podNamespace)}/members`,
          body,
        );
        // Structural failure: the add persisted (201) but the new node did not
        // fully launch (failed / attention_required) — surface it as an error so
        // the agent knows the seat is not live, mirroring the CLI non-zero exit.
        return mapResult(res, (data) => {
          const result = data["result"] as { node?: { status?: string } } | undefined;
          return result?.node?.status !== undefined && result.node.status !== "launched";
        });
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 19-23. Queue tools: the same routes `rig queue` uses, for a client without a shell. The source
  // and actor are this server's seat (OPENRIG_SESSION_NAME in its env), stamped on every request by
  // DaemonClient, so the identity is configured once, where the server is set up.

  // 19. rig_queue_create — hand a task to a seat
  server.tool(
    "rig_queue_create",
    "Hand a task to another seat as a durable queue item. Returns its qitemId: read the answer later with rig_queue_show. If the call times out, check rig_queue_show with the same qitemId before retrying; never retry with a new id.",
    {
      destination: z.string().describe("Destination seat (e.g. dev-impl@my-rig)"),
      body: z.string().describe("The task: what to do and what to return"),
      summary: z.string().optional().describe("One-line summary"),
      tags: z.array(z.string()).optional().describe("Tags, e.g. mission:<name>"),
      priority: z.string().optional().describe("Priority (as rig queue create --priority)"),
      tier: z.string().optional().describe("Tier (as rig queue create --tier)"),
      qitemId: z.string().optional().describe("Request id to reuse when retrying the same create (default: a new id)"),
    },
    async ({ destination, body, summary, tags, priority, tier, qitemId }) => {
      const id = qitemId ?? `qitem-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
      try {
        const res = await client.post("/api/queue/create", {
          qitemId: id, destinationSession: destination, body, summary, tags, priority, tier,
        });
        return mapResult(res);
      } catch (err) {
        return { content: [{ type: "text" as const, text: `${(err as Error).message} The outcome is unknown: check rig_queue_show with qitemId ${id} before retrying, and retry only with that same qitemId.` }], isError: true as const };
      }
    },
  );

  // 20. rig_queue_show — one item with its transitions: a delegated task's answer is its own record
  server.tool(
    "rig_queue_show",
    "Read one queue item and its transitions. For a task you handed off, this is where its answer is: the state, the closure reason and target, and the notes the assignee recorded.",
    {
      qitemId: z.string().describe("The qitemId returned by rig_queue_create (or any queue item)"),
    },
    async ({ qitemId }) => {
      try {
        const id = encodeURIComponent(qitemId);
        const item = await client.get(`/api/queue/${id}`);
        if (item.status >= 400) return mapResult(item);
        const transitions = await client.get(`/api/queue/${id}/transitions`);
        if (transitions.status >= 400) return mapResult(transitions);
        return mapResult({ status: 200, data: { item: item.data, transitions: transitions.data } });
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 21. rig_queue_list — list queue items
  server.tool(
    "rig_queue_list",
    "List queue items. owned: assigned to this seat. mine: this seat is the source or the destination. Without a scope, this seat's rig. Without state, open items only (all adds closed ones); a state filter returns exactly those states, closed ones included.",
    {
      owned: z.boolean().optional().describe("Only items assigned to this seat (overrides destination)"),
      mine: z.boolean().optional().describe("Items this seat sent or owns"),
      destination: z.string().optional().describe("Filter by destination seat"),
      source: z.string().optional().describe("Filter by source seat"),
      state: z.string().optional().describe("Only these states, comma-separated; closed states included when named"),
      all: z.boolean().optional().describe("Without state: include closed items"),
      limit: z.number().int().positive().optional().describe("Result limit (default 100)"),
    },
    async ({ owned, mine, destination, source, state, all, limit }) => {
      try {
        const params = new URLSearchParams();
        const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
        if ((owned || mine) && !sessionName) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: "owned and mine need this server's seat: set OPENRIG_SESSION_NAME in its env, or filter by destination or source" }) }], isError: true as const };
        }
        if (owned) params.set("destinationSession", sessionName!);
        else if (mine) params.set("as", sessionName!);
        else if (!destination && !source && sessionName?.includes("@")) params.set("rig", sessionName.split("@")[1]!);
        if (!all) params.set("activeOnly", "1");
        params.set("compact", "1");
        // owned means assigned to this seat; another destination can't widen it to someone else's items.
        if (destination && !owned) params.set("destinationSession", destination);
        if (source) params.set("sourceSession", source);
        if (state) params.set("state", state);
        params.set("limit", String(limit ?? 100));
        return mapResult(await client.get(`/api/queue/list?${params.toString()}`));
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 22. rig_queue_claim — take an item assigned to this seat
  server.tool(
    "rig_queue_claim",
    "Claim a queue item assigned to this seat before working on it.",
    { qitemId: z.string().describe("The queue item to claim") },
    async ({ qitemId }) => {
      try {
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {}));
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  // 23. rig_queue_update — record progress, block, or close with the answer
  server.tool(
    "rig_queue_update",
    "Update a queue item: add a note, block it, or close it. To answer a task, close it with state done, a closure reason, and the answer in note.",
    {
      qitemId: z.string().describe("The queue item to update"),
      state: z.string().optional().describe("New state (e.g. in-progress, blocked, done)"),
      closureReason: z.string().optional().describe("Why it closed (as rig queue update --closure-reason)"),
      closureTarget: z.string().optional().describe("Closure target, when the reason needs one"),
      note: z.string().optional().describe("Transition note: progress, or the answer when closing"),
      summary: z.string().optional().describe("Replace the one-line summary"),
      evidenceRef: z.string().optional().describe("Where the evidence is"),
      blockedOn: z.string().optional().describe("What it waits on, when blocking"),
      wakeAfterSeconds: z.number().int().positive().optional().describe("Wake this seat after this many seconds, when blocking. Delivered only to a seat with a terminal: an attached app can't receive it today, so the item just waits until it is checked."),
    },
    async ({ qitemId, state, closureReason, closureTarget, note, summary, evidenceRef, blockedOn, wakeAfterSeconds }) => {
      try {
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          state, closureReason, closureTarget, summary, evidenceRef, blockedOn, wakeAfterSeconds, transitionNote: note,
        }));
      } catch (err) {
        return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true as const };
      }
    },
  );

  return server;
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}
