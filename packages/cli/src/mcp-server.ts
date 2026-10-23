import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import nodePath from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { DaemonConnectionError, DaemonTimeoutError, terminalAuthHeaders, type DaemonClient, type DaemonResponse } from "./client.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { resolveRigHandle } from "./rig-handle.js";
import { CLI_VERSION } from "./version.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;

type TextResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
  structuredContent?: Record<string, unknown>;
};

/** The one error shape every error a tool returns carries in structuredContent; its text stays as it always was. ok is
 *  false, code is stable (the daemon's own when it sends one), message is readable, and status is the HTTP status when
 *  there was one. Arguments a tool's input schema refuses never reach the tool: the MCP SDK answers those itself, with
 *  its own text-only error. */
function errorResult(text: string, code: string, message: string, extra: Record<string, unknown> = {}): TextResult {
  return { content: [{ type: "text", text }], isError: true, structuredContent: { ok: false, code, message, ...extra } };
}

/** A request that threw (the daemon unreachable, a timeout): its message as the text, as before, with a code. */
function caught(err: unknown): TextResult {
  const message = (err as Error).message;
  const code = err instanceof DaemonTimeoutError ? "daemon_timeout"
    : err instanceof DaemonConnectionError ? "daemon_unreachable"
      : typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code
        : "request_failed";
  return errorResult(message, code, message);
}

function rigNotFound(handle: string): TextResult {
  const message = `Rig '${handle}' not found: no rig has that name or id`;
  return errorResult(JSON.stringify({ error: message }), "rig_not_found", message);
}

/** structuredContent is an object, so a list comes back as { items }. */
function structured(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
  return Array.isArray(data) ? { items: data } : { value: data };
}

/**
 * The rig id for a tool's rig argument, resolved as the rig CLI commands resolve it: an id, or a name one
 * active rig has, gives that rig's id; a name two active rigs share is an error result with their ids;
 * anything else (no match, or the rig list can't be read) goes to the daemon as given. `known` is false
 * only when the rig list was read and nothing matched.
 */
async function rigIdFor(client: DaemonClient, handle: string): Promise<{ id: string; known: boolean; resolved: boolean } | TextResult> {
  const resolution = await resolveRigHandle(client, handle);
  if (resolution.kind === "ambiguous") {
    const message = `'${handle}' matches ${resolution.ids.length} rigs. Nothing was done; pass one of these ids instead.`;
    return errorResult(JSON.stringify({ ok: false, code: "rig_ambiguous", message, candidates: resolution.ids }), "rig_ambiguous", message, { candidates: resolution.ids });
  }
  if (resolution.kind === "resolved") return { id: resolution.id, known: true, resolved: true };
  return { id: handle, known: resolution.kind === "passthrough", resolved: false };
}

/** The rig id for a chatroom tool: only a handle the rig list resolves. History answers [] for an unknown id, so a
 *  handle no rig has, or one the list couldn't be read to check, would otherwise read as an empty room. */
async function chatRigId(client: DaemonClient, handle: string): Promise<{ id: string } | TextResult> {
  const rig = await rigIdFor(client, handle);
  if ("content" in rig) return rig;
  if (!rig.resolved) {
    const error = rig.known ? `Rig '${handle}' could not be checked: the rig list couldn't be read` : `Rig '${handle}' not found: no rig has that name or id`;
    return errorResult(JSON.stringify({ error }), rig.known ? "rig_list_unavailable" : "rig_not_found", error);
  }
  return rig;
}

/** Options for the transport routes: the wait-for-idle timeout, plus the daemon's terminal bearer token when one is
 *  configured (the daemon checks it on /api/transport/* only), sent the way the CLI's send and capture send it. */
function transportRequestOptions(timeout?: { timeoutMs: number }): { timeoutMs?: number; headers?: Record<string, string> } | undefined {
  const headers = terminalAuthHeaders();
  const hasHeaders = Object.keys(headers).length > 0;
  if (!timeout && !hasHeaders) return undefined;
  return { ...(timeout ?? {}), ...(hasHeaders ? { headers } : {}) };
}

// Hints for a client deciding what to ask the person (MCP tool annotations), not enforcement. A read-only tool changes
// nothing through OpenRig. An additive one only adds a record, a message or a seat. A destructive one can also change or
// remove existing state (stop, replace, discard, refresh discovered facts, or end a row's wait), or, for rig_send, types
// into an agent that may act on it.
const READ_ONLY: ToolAnnotations = { readOnlyHint: true };
const ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/** What each tool calls and what it does, kept beside the registrations. The MCP contract tests check that it names every
 *  registered tool, that each tool's annotations match its effect, and that each route is mounted in the daemon. Tools that
 *  take a rig name also read GET /api/rigs/summary to resolve it. */
export const MCP_OPERATIONS: ReadonlyArray<{ tool: string; routes: readonly string[]; effect: "read" | "additive" | "destructive" }> = [
  { tool: "rig_up", routes: ["POST /api/up"], effect: "destructive" },
  { tool: "rig_down", routes: ["POST /api/down"], effect: "destructive" },
  { tool: "rig_ps", routes: ["GET /api/ps"], effect: "read" },
  { tool: "rig_status", routes: ["GET /healthz"], effect: "read" },
  { tool: "rig_snapshot_create", routes: ["POST /api/rigs/:rigId/snapshots"], effect: "additive" },
  { tool: "rig_snapshot_list", routes: ["GET /api/rigs/:rigId/snapshots"], effect: "read" },
  { tool: "rig_restore", routes: ["POST /api/rigs/:rigId/restore/:snapshotId"], effect: "destructive" },
  { tool: "rig_restore_status", routes: ["GET /api/rigs/:rigId/restore/status/:attemptId"], effect: "read" },
  { tool: "rig_discover", routes: ["POST /api/discovery/scan"], effect: "destructive" },
  { tool: "rig_bind", routes: ["POST /api/discovery/:id/bind"], effect: "destructive" },
  { tool: "rig_bundle_inspect", routes: ["POST /api/bundles/inspect"], effect: "read" },
  { tool: "rig_agent_validate", routes: ["POST /api/agents/validate"], effect: "read" },
  { tool: "rig_rig_validate", routes: ["POST /api/rigs/import/validate"], effect: "read" },
  { tool: "rig_rig_nodes", routes: ["GET /api/rigs/:rigId/nodes"], effect: "read" },
  { tool: "rig_send", routes: ["POST /api/transport/send"], effect: "destructive" },
  { tool: "rig_capture", routes: ["POST /api/transport/capture"], effect: "read" },
  { tool: "rig_chatroom_send", routes: ["POST /api/rigs/:rigId/chat/send"], effect: "additive" },
  { tool: "rig_chatroom_watch", routes: ["GET /api/rigs/:rigId/chat/history"], effect: "read" },
  { tool: "rig_add", routes: ["POST /api/rigs/:rigId/pods/:podNamespace/members"], effect: "additive" },
  { tool: "rig_queue_create", routes: ["POST /api/queue/create"], effect: "additive" },
  { tool: "rig_queue_show", routes: ["GET /api/queue/:qitemId", "GET /api/queue/:qitemId/transitions"], effect: "read" },
  { tool: "rig_queue_list", routes: ["GET /api/queue/list"], effect: "read" },
  { tool: "rig_queue_claim", routes: ["POST /api/queue/:qitemId/claim"], effect: "destructive" },
  { tool: "rig_queue_update", routes: ["POST /api/queue/:qitemId/update"], effect: "destructive" },
  { tool: "rig_telemetry_events", routes: ["GET /api/telemetry/v1/events"], effect: "read" },
  { tool: "rig_whoami", routes: ["GET /api/whoami"], effect: "read" },
];

// Short guidance a client may show the model (the server's MCP instructions).
const INSTRUCTIONS = [
  "This server reaches an OpenRig team as one seat: the one named by OPENRIG_SESSION_NAME where the server was configured (rig_whoami shows it). The daemon attributes this server's writes to that seat.",
  "To hand work to a seat, use rig_queue_create and keep its qitemId; read the answer later with rig_queue_show. Queue items are durable: they outlive this conversation and this server.",
  "Tools marked read-only change nothing. A seat whose activity is unknown is not idle, and an accepted request (a restore's attemptId) is not a finished one.",
  "A question reserved for a person is theirs to answer: don't answer it on their behalf.",
].join("\n");

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
  opts: { structured?: boolean; structuralCode?: string } = {},
): TextResult {
  const text = JSON.stringify(res.data);
  const data = (res.data ?? {}) as Record<string, unknown>;
  // The daemon answers errors two ways: { error: <prose>, code } (restore, up), and the queue's { error: <code>,
  // message: <prose> }, whose missing-item reads send the code alone. So an error beside a message is the code, and so
  // is a snake_case error on its own.
  const error = typeof data.error === "string" ? data.error : undefined;
  const prose = typeof data.message === "string" ? data.message : undefined;
  const errorIsCode = error !== undefined && (prose !== undefined || /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(error));
  const daemonCode = typeof data.code === "string" ? data.code : errorIsCode ? error : undefined;
  const said = (fallback: string): string => (errorIsCode ? prose ?? error : error ?? prose) ?? fallback;

  // Level 1: HTTP error
  if (res.status >= 400) {
    return errorResult(text, daemonCode ?? `http_${res.status}`, said(`the daemon answered ${res.status}`), { status: res.status });
  }

  // Level 2: In-body error/errors fields
  if (data.error || (Array.isArray(data.errors) && data.errors.length > 0)) {
    const first = Array.isArray(data.errors) ? data.errors[0] : undefined;
    return errorResult(text, daemonCode ?? "request_failed", said(typeof first === "string" ? first : JSON.stringify(first ?? "the request reported an error")));
  }

  // Level 3: Tool-specific structural failure
  if (structuralCheck && structuralCheck(data)) {
    return errorResult(text, daemonCode ?? opts.structuralCode ?? "operation_incomplete", said("the operation did not complete"));
  }

  return opts.structured ? { content: [{ type: "text", text }], structuredContent: structured(res.data) } : { content: [{ type: "text", text }] };
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
  }, { instructions: INSTRUCTIONS });

  // 1. rig_up — launch from a spec, bundle or topology, or restore an existing rig by name
  server.tool(
    "rig_up",
    "Launch a rig from a rig spec (.yaml), a .rigbundle or a .rigtopology, or restore an existing rig by its name from its latest snapshot",
    {
      sourceRef: z.string().describe("An absolute path to a rig spec (.yaml), .rigbundle or .rigtopology, or the name of an existing rig to restore. The daemon reads the path, so a relative one resolves against the daemon's directory."),
      plan: z.boolean().optional().describe("Plan mode — preview without executing"),
      autoApprove: z.boolean().optional().describe("Auto-approve trusted actions"),
      targetRoot: z.string().optional().describe("Target root directory for package installation"),
      cwd: z.string().refine((dir) => nodePath.isAbsolute(dir), "cwd must be an absolute path").optional().describe("Working directory for a new launch's agents. It must be absolute: this server has no caller directory to resolve a relative one against."),
      // The daemon drops the whole env block when any entry is invalid, so check it here the way rig up --env does.
      env: z.record(
        z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env names match ^[A-Z_][A-Z0-9_]*$").refine((name) => !name.startsWith("OPENRIG_"), "OPENRIG_* env names belong to OpenRig"),
        z.string().min(1, "env values must not be empty").refine((value) => !value.includes("\0"), "env values must not contain a NUL byte"),
      ).optional().describe("Environment variables for a new launch from one rig spec or bundle, not saved with the rig (as rig up --env NAME=value). A .rigtopology or a restore by name doesn't use them."),
      rigName: z.string().min(1).optional().describe("A new launch's rig name instead of the spec's (as rig up --name)"),
      fresh: z.array(z.string()).optional().describe("When restoring an existing rig: the seats (logical ids, e.g. dev.impl) to start fresh instead of resuming (as rig up --fresh)"),
    },
    DESTRUCTIVE,
    async ({ sourceRef, plan, autoApprove, targetRoot, cwd, env, rigName, fresh }) => {
      try {
        const res = await client.post(
          "/api/up",
          { sourceRef, plan: plan ?? false, autoApprove: autoApprove ?? false, targetRoot, cwdOverride: cwd, envOverride: env, rigName, freshLogicalIds: fresh },
          plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS },
        );
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 2. rig_down — rig teardown
  server.tool(
    "rig_down",
    "Tear down a rig",
    {
      rigId: z.string().describe("Rig name or identifier to tear down"),
      delete: z.boolean().optional().describe("Delete rig record after stopping"),
      force: z.boolean().optional().describe("Kill sessions immediately"),
      snapshot: z.boolean().optional().describe("Take snapshot before teardown"),
    },
    DESTRUCTIVE,
    async (params) => {
      try {
        const rig = await rigIdFor(client, params.rigId);
        if ("content" in rig) return rig;
        const res = await client.post("/api/down", {
          rigId: rig.id,
          delete: params.delete ?? false,
          force: params.force ?? false,
          snapshot: params.snapshot ?? false,
        });
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 3. rig_ps — list running rigs
  server.tool(
    "rig_ps",
    "List rigs and their status",
    {},
    READ_ONLY,
    async () => {
      try {
        const res = await client.get("/api/ps");
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 4. rig_status — daemon health
  server.tool(
    "rig_status",
    "Check daemon health",
    {},
    READ_ONLY,
    async () => {
      try {
        const res = await client.get("/healthz");
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 5. rig_snapshot_create — create snapshot
  server.tool(
    "rig_snapshot_create",
    "Create a snapshot for a rig",
    {
      rigId: z.string().describe("Rig name or identifier"),
    },
    ADDITIVE,
    async ({ rigId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const res = await client.post(`/api/rigs/${encodeURIComponent(rig.id)}/snapshots`, {});
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 6. rig_snapshot_list — list snapshots
  server.tool(
    "rig_snapshot_list",
    "List snapshots for a rig",
    {
      rigId: z.string().describe("Rig name or identifier"),
    },
    READ_ONLY,
    async ({ rigId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const res = await client.get(`/api/rigs/${encodeURIComponent(rig.id)}/snapshots`);
        // The list answers [] for an id it has nothing under, so a handle no rig matches would read as a rig
        // with no snapshots. Snapshots kept under a removed rig's id still list.
        if (!rig.known && Array.isArray(res.data) && res.data.length === 0) {
          return rigNotFound(rigId);
        }
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 7. rig_restore — restore from snapshot
  server.tool(
    "rig_restore",
    "Start restoring a rig from a snapshot. It answers at once with an attemptId while the restore runs in the background; follow the attempt with rig_restore_status.",
    {
      rigId: z.string().describe("Rig name or identifier"),
      snapshotId: z.string().describe("Snapshot identifier"),
    },
    DESTRUCTIVE,
    async ({ rigId, snapshotId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const res = await client.post(`/api/rigs/${encodeURIComponent(rig.id)}/restore/${encodeURIComponent(snapshotId)}`, {});
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 7b. rig_restore_status — follow a restore attempt rig_restore started
  server.tool(
    "rig_restore_status",
    "Read where a restore attempt stands: the receipt for the attemptId rig_restore returned. An attempt with no completion yet (still running, or stopped before it finished) answers attempt_incomplete; it isn't a receipt.",
    {
      rigId: z.string().describe("Rig name or identifier"),
      attemptId: z.number().int().positive().describe("The attemptId rig_restore returned"),
    },
    READ_ONLY,
    async ({ rigId, attemptId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        return mapResult(await client.get(`/api/rigs/${encodeURIComponent(rig.id)}/restore/status/${attemptId}`), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 8. rig_discover — scan for sessions
  server.tool(
    "rig_discover",
    "Scan for tmux sessions to discover",
    {},
    DESTRUCTIVE,
    async () => {
      try {
        const res = await client.post("/api/discovery/scan", {});
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 9. rig_bind — bind discovered session to a rig node (existing or new in pod)
  server.tool(
    "rig_bind",
    "Bind a discovered session to an existing node or create a new node in a pod",
    {
      discoveryId: z.string().describe("Discovery session identifier"),
      rigId: z.string().describe("Target rig name or identifier"),
      logicalId: z.string().optional().describe("Existing node logical ID (mode: bind to existing)"),
      podNamespace: z.string().optional().describe("Pod namespace to create node in (mode: create in pod)"),
      memberName: z.string().optional().describe("Member name for new node (required with podNamespace)"),
    },
    DESTRUCTIVE,
    async ({ discoveryId, rigId, logicalId, podNamespace, memberName }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const body: Record<string, unknown> = { rigId: rig.id };
        if (logicalId) body["logicalId"] = logicalId;
        if (podNamespace) body["podNamespace"] = podNamespace;
        if (memberName) body["memberName"] = memberName;
        const res = await client.post(`/api/discovery/${encodeURIComponent(discoveryId)}/bind`, body);
        return mapResult(res);
      } catch (err) {
        return caught(err);
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
    READ_ONLY,
    async ({ bundlePath }) => {
      try {
        const res = await client.post("/api/bundles/inspect", { bundlePath });
        return mapResult(res, (data) => {
          // Structural failure: digest invalid or integrity check failed
          if (data.digestValid === false) return true;
          const integrity = data.integrityResult as { passed?: boolean } | undefined;
          if (integrity && integrity.passed === false) return true;
          return false;
        }, { structuralCode: "bundle_integrity_failed" });
      } catch (err) {
        return caught(err);
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
    READ_ONLY,
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/agents/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return caught(err);
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
    READ_ONLY,
    async ({ yaml }) => {
      try {
        const res = await client.postText("/api/rigs/import/validate", yaml);
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 13. rig_rig_nodes — node inventory for a rig
  server.tool(
    "rig_rig_nodes",
    "Get node inventory for a rig — session names, status, attach commands, resume commands",
    {
      rigId: z.string().describe("Rig name or identifier"),
    },
    READ_ONLY,
    async ({ rigId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const res = await client.get(`/api/rigs/${encodeURIComponent(rig.id)}/nodes`);
        return mapResult(res);
      } catch (err) {
        return caught(err);
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
    DESTRUCTIVE,
    async ({ session, text, verify, force, waitForIdleSeconds }) => {
      try {
        if (force && waitForIdleSeconds !== undefined) {
          const message = "waitForIdleSeconds cannot be combined with force";
          return errorResult(JSON.stringify({ ok: false, error: message }), "invalid_arguments", message);
        }
        const waitForIdleMs = waitForIdleSeconds === undefined ? undefined : Math.ceil(waitForIdleSeconds * 1000);
        const res = await client.post("/api/transport/send", {
          session,
          text,
          verify,
          force,
          waitForIdleMs,
        }, transportRequestOptions(waitForIdleRequestOptions(waitForIdleMs)));
        return mapResult(res);
      } catch (err) {
        return caught(err);
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
    READ_ONLY,
    async ({ session, rig, pod, lines }) => {
      try {
        const body: Record<string, unknown> = {};
        if (session) body.session = session;
        if (rig) body.rig = rig;
        if (pod) body.pod = pod;
        if (lines) body.lines = lines;
        body.inputBox = true; // what the live input box holds, in the result's inputBox
        const res = await client.post("/api/transport/capture", body, transportRequestOptions());
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 16. rig_chatroom_send — send message to rig chatroom
  server.tool(
    "rig_chatroom_send",
    "Send a message to a rig's chatroom as this server's seat",
    {
      rigName: z.string().describe("Rig name or identifier"),
      body: z.string().describe("Message body"),
    },
    ADDITIVE,
    async ({ rigName, body }) => {
      try {
        const rig = await chatRigId(client, rigName);
        if ("content" in rig) return rig;
        // P21: no body sender — the daemon derives it from the transport header (X-OpenRig-Session,
        // stamped by the MCP server's DaemonClient from its seat env).
        const res = await client.post(`/api/rigs/${encodeURIComponent(rig.id)}/chat/send`, {
          body,
        });
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 17. rig_chatroom_watch — a rig's recent chatroom history (the name is kept; it reads history, it doesn't stream)
  server.tool(
    "rig_chatroom_watch",
    "Read a rig's recent chatroom messages: the most recent ones (default 20), oldest first, optionally one topic's or one sender's. It returns what is there now and doesn't wait for new messages.",
    {
      rigName: z.string().describe("Rig name or identifier"),
      topic: z.string().optional().describe("Only messages in this topic"),
      sender: z.string().optional().describe("Only messages from this seat"),
      limit: z.number().int().positive().optional().describe("How many recent messages (default 20)"),
    },
    READ_ONLY,
    async ({ rigName, topic, sender, limit }) => {
      try {
        const rig = await chatRigId(client, rigName);
        if ("content" in rig) return rig;
        const params = new URLSearchParams({ limit: String(limit ?? 20) });
        if (topic) params.set("topic", topic);
        if (sender) params.set("sender", sender);
        const res = await client.get(`/api/rigs/${encodeURIComponent(rig.id)}/chat/history?${params.toString()}`);
        return mapResult(res);
      } catch (err) {
        return caught(err);
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
      rigId: z.string().describe("Target rig name or identifier"),
      podNamespace: z.string().describe("Namespace of the existing pod to add the member to"),
      member: z.record(z.string(), z.unknown()).describe("Member fragment with spec snake_case fields: id, runtime, agent_ref, profile, cwd (and optional model, codex_config_profile, restore_policy, label)"),
      edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).optional().describe("Optional pod-local edges (from/to are member ids within the pod; resolved against the new member + existing pod-mates)"),
      rigRoot: z.string().optional().describe("Root directory for agent resolution"),
    },
    ADDITIVE,
    async ({ rigId, podNamespace, member, edges, rigRoot }) => {
      try {
        const body: Record<string, unknown> = { member };
        if (edges) body["edges"] = edges;
        if (rigRoot) body["rigRoot"] = rigRoot;
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const res = await client.post(
          `/api/rigs/${encodeURIComponent(rig.id)}/pods/${encodeURIComponent(podNamespace)}/members`,
          body,
        );
        // Structural failure: the add persisted (201) but the new node did not
        // fully launch (failed / attention_required) — surface it as an error so
        // the agent knows the seat is not live, mirroring the CLI non-zero exit.
        return mapResult(res, (data) => {
          const result = data["result"] as { node?: { status?: string } } | undefined;
          return result?.node?.status !== undefined && result.node.status !== "launched";
        }, { structuralCode: "member_not_launched" });
      } catch (err) {
        return caught(err);
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
    ADDITIVE,
    async ({ destination, body, summary, tags, priority, tier, qitemId }) => {
      const id = qitemId ?? `qitem-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
      try {
        const res = await client.post("/api/queue/create", {
          qitemId: id, destinationSession: destination, body, summary, tags, priority, tier,
        });
        return mapResult(res, undefined, { structured: true });
      } catch (err) {
        const failure = caught(err);
        const text = `${(err as Error).message} The outcome is unknown: check rig_queue_show with qitemId ${id} before retrying, and retry only with that same qitemId.`;
        return { ...failure, content: [{ type: "text", text }], structuredContent: { ...failure.structuredContent, qitemId: id, outcome: "unknown" } };
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
    READ_ONLY,
    async ({ qitemId }) => {
      try {
        const id = encodeURIComponent(qitemId);
        const item = await client.get(`/api/queue/${id}`);
        if (item.status >= 400) return mapResult(item);
        const transitions = await client.get(`/api/queue/${id}/transitions`);
        if (transitions.status >= 400) return mapResult(transitions);
        return mapResult({ status: 200, data: { item: item.data, transitions: transitions.data } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
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
    READ_ONLY,
    async ({ owned, mine, destination, source, state, all, limit }) => {
      try {
        const params = new URLSearchParams();
        const sessionName = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
        if ((owned || mine) && !sessionName) {
          const message = "owned and mine need this server's seat: set OPENRIG_SESSION_NAME in its env, or filter by destination or source";
          return errorResult(JSON.stringify({ ok: false, error: message }), "seat_required", message);
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
        return mapResult(await client.get(`/api/queue/list?${params.toString()}`), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 22. rig_queue_claim — take an item assigned to this seat
  server.tool(
    "rig_queue_claim",
    "Claim a queue item assigned to this seat before working on it.",
    { qitemId: z.string().describe("The queue item to claim") },
    DESTRUCTIVE,
    async ({ qitemId }) => {
      try {
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {}), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 23. rig_queue_update — record progress, block, or close with the answer
  server.tool(
    "rig_queue_update",
    "Update a queue item: add a note, block it, close it, or reopen a closed one. To answer a task, close it with state done, a closure reason and the answer in resolution, which the item keeps; note records why this transition happened.",
    {
      qitemId: z.string().describe("The queue item to update"),
      state: z.string().optional().describe("New state (e.g. in-progress, blocked, done)"),
      closureReason: z.string().optional().describe("Why it closed (as rig queue update --closure-reason)"),
      closureTarget: z.string().optional().describe("Closure target, when the reason needs one"),
      note: z.string().optional().describe("Transition note: progress, or why this transition happened (required to reopen)"),
      resolution: z.string().optional().describe("The outcome the item keeps, stored only by the update that closes an open item (as rig queue update --resolution)"),
      reopen: z.boolean().optional().describe("Reopen a closed item: give an active state (pending, in-progress or blocked) and a note (as rig queue update --reopen)"),
      summary: z.string().optional().describe("Replace the one-line summary"),
      evidenceRef: z.string().optional().describe("Pointer to the durable artifact, stored on the item when closing with state done or parking on a human seat; other updates refuse it"),
      blockedOn: z.string().optional().describe("What it waits on, when blocking"),
      wakeAfterSeconds: z.number().int().positive().optional().describe("Wake this seat after this many seconds, when blocking. Delivered only to a seat with a terminal: an attached app can't receive it today, so the item just waits until it is checked."),
    },
    DESTRUCTIVE,
    async ({ qitemId, state, closureReason, closureTarget, note, resolution, reopen, summary, evidenceRef, blockedOn, wakeAfterSeconds }) => {
      try {
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          state, closureReason, closureTarget, summary, evidenceRef, blockedOn, wakeAfterSeconds, transitionNote: note, resolution, reopen,
        }), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 24. rig_telemetry_events — one bounded page of event metadata, the page `rig telemetry events` reads
  server.tool(
    "rig_telemetry_events",
    "Read one bounded page of event metadata: seq, rig, node, type and time, never payloads. Without a cursor it starts at the newest event and returns no rows; start retained reads the retained past instead. Continue with page.nextCursor and the same filters. coverage.gaps names any history it could not read, including a daemon restart, after which the old cursor can't continue.",
    {
      cursor: z.string().optional().describe("page.nextCursor from the previous page; not with start"),
      start: z.enum(["latest", "retained"]).optional().describe("Without a cursor: latest (default) or retained"),
      rigId: z.string().optional().describe("Rig name or identifier; events with no rig are left out"),
      nodeId: z.string().optional().describe("Node identifier"),
      limit: z.number().int().min(1).max(128).optional().describe("Source rows to scan (default and maximum 128); a filter can return fewer"),
    },
    READ_ONLY,
    async ({ cursor, start, rigId, nodeId, limit }) => {
      try {
        const params = new URLSearchParams();
        if (rigId) {
          const rig = await rigIdFor(client, rigId);
          if ("content" in rig) return rig;
          // The daemon filters by exact id and matches nothing for an unknown one, which would read as a quiet rig.
          if (!rig.known) {
            return rigNotFound(rigId);
          }
          params.set("rigId", rig.id);
        }
        if (cursor) params.set("cursor", cursor);
        if (start) params.set("start", start);
        if (nodeId) params.set("nodeId", nodeId);
        if (limit !== undefined) params.set("limit", String(limit));
        return mapResult(await client.get(`/api/telemetry/v1/events?${params.toString()}`));
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 26. rig_whoami — which seat this server acts as
  server.tool(
    "rig_whoami",
    "Show which OpenRig seat this server acts as (OPENRIG_SESSION_NAME where it was configured): its rig, pod, peers and edges. This is the configured seat, not a verified caller.",
    {},
    READ_ONLY,
    async () => {
      try {
        const seat = readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
        if (!seat) {
          const none = { ok: true, seat: null, message: "This server has no seat: OPENRIG_SESSION_NAME isn't set where it was configured, so its writes aren't attributed to a seat." };
          return { content: [{ type: "text" as const, text: JSON.stringify(none) }], structuredContent: none };
        }
        const params = new URLSearchParams({ sessionName: seat, compact: "1" });
        const targetRepo = readOpenRigEnv("OPENRIG_TARGET_REPO", "RIGGED_TARGET_REPO")?.trim();
        if (targetRepo) params.set("targetRepo", targetRepo);
        return mapResult(await client.get(`/api/whoami?${params.toString()}`), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  return server;
}

function waitForIdleRequestOptions(waitForIdleMs: number | undefined): { timeoutMs: number } | undefined {
  if (waitForIdleMs === undefined) return undefined;
  return { timeoutMs: waitForIdleMs + WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS };
}
