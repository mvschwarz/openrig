import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import nodePath from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { DaemonConnectionError, DaemonTimeoutError, terminalAuthHeaders, type DaemonClient, type DaemonResponse } from "./client.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { resolveRigHandle } from "./rig-handle.js";
import { formatSeatActivity, type SeatActivityFields } from "./lib/seat-activity.js";
import { CLI_VERSION } from "./version.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;
const WAIT_FOR_IDLE_REQUEST_OVERHEAD_MS = 5_000;
/** The most text rig_context_get and rig_artifact_read return in one call; a longer file or section is cut, and says so. */
const CONTEXT_TEXT_LIMIT = 48_000;

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

/** Where a handed-on item went. A cross-host handoff records the remote item as qitem-…@<host> in closureTarget (named, not
 *  fetched); a local successor is the item whose handedOffFrom is this one, the newest when there are several. null when
 *  none is found; { unknown: true, code } when the lookup failed or the daemon can't filter by handedOffFrom. */
async function successorOf(client: DaemonClient, qitemId: string, closureTarget: unknown): Promise<Record<string, unknown> | null> {
  const remote = typeof closureTarget === "string" ? /^(qitem-[^@]+)@([^@]+)$/.exec(closureTarget) : null;
  if (remote) return { qitemId: remote[1], host: remote[2] };
  try {
    const res = await client.get(`/api/queue/list?${new URLSearchParams({ handedOffFrom: qitemId, compact: "1", limit: "5" }).toString()}`);
    if (res.status >= 400) return { unknown: true, code: (mapResult(res).structuredContent as { code: string }).code };
    if (!Array.isArray(res.data)) return { unknown: true, code: "unexpected_response" };
    if (ignoredFilter(res.data, { handedOffFrom: qitemId })) return { unknown: true, code: "filter_unsupported" };
    const [next, ...others] = res.data as Array<{ qitemId?: string; destinationSession?: string; state?: string }>;
    if (!next) return null;
    return { qitemId: next.qitemId, destinationSession: next.destinationSession, state: next.state, ...(others.length > 0 ? { otherSuccessors: others.map((o) => o.qitemId) } : {}) };
  } catch (err) {
    return { unknown: true, code: (caught(err).structuredContent as { code: string }).code };
  }
}

/** The list filter a daemon ignored, if its rows show one: a daemon older than the filter answers the unfiltered list. */
function ignoredFilter(data: unknown, filters: { since?: string; handedOffFrom?: string }): string | null {
  if (!Array.isArray(data)) return null;
  const rows = data as Array<{ handedOffFrom?: unknown; tsUpdated?: unknown }>;
  if (filters.handedOffFrom && rows.some((row) => row.handedOffFrom !== filters.handedOffFrom)) return "handedOffFrom";
  const sinceMs = filters.since ? Date.parse(filters.since) : Number.NaN;
  if (!Number.isNaN(sinceMs) && rows.some((row) => typeof row.tsUpdated === "string" && Date.parse(row.tsUpdated) < sinceMs)) return "since";
  return null;
}

type RigDetail = {
  rig?: { id?: string; name?: string };
  nodes?: Array<{ id: string; logicalId: string }>;
  edges?: Array<{ sourceId: string; targetId: string; kind: string }>;
  representative?: string | null;
};
type InventorySeat = SeatActivityFields & {
  logicalId: string;
  canonicalSessionName?: string | null;
  podNamespace?: string | null;
  role?: string | null;
  runtime?: string | null;
  nodeKind?: string;
  sessionStatus?: string | null;
};

/** A rig's team from its detail (authored delegates_to edges and the daemon's representative) and its node inventory
 *  (sessions and activity, passed on as the daemon reports them). */
function teamView(detail: RigDetail, inventory: unknown): Record<string, unknown> {
  const logicalIds = new Map((detail.nodes ?? []).map((node) => [node.id, node.logicalId]));
  const delegation = (detail.edges ?? []).filter((edge) => edge.kind === "delegates_to")
    .map((edge) => ({ from: logicalIds.get(edge.sourceId), to: logicalIds.get(edge.targetId) }));
  const seats = (Array.isArray(inventory) ? inventory as InventorySeat[] : []).map((seat) => ({
    logicalId: seat.logicalId,
    session: seat.canonicalSessionName ?? null,
    pod: seat.podNamespace ?? null,
    role: seat.role ?? null,
    runtime: seat.runtime ?? null,
    kind: seat.nodeKind ?? null,
    sessionStatus: seat.sessionStatus ?? "unknown",
    activity: formatSeatActivity(seat),
    reportsTo: delegation.filter((edge) => edge.to === seat.logicalId).map((edge) => edge.from),
    delegatesTo: delegation.filter((edge) => edge.from === seat.logicalId).map((edge) => edge.to),
  }));
  const rig = { id: detail.rig?.id ?? null, name: detail.rig?.name ?? null };
  if (!("representative" in detail)) {
    return { rig, lead: null, leadNote: "This daemon doesn't report a rig's lead; it needs a newer daemon.", seats };
  }
  const session = detail.representative ?? null;
  if (!session) {
    return { rig, lead: null, leadNote: "No single lead: the rig has no one seat that delegates to others and that nothing delegates to, or that seat has no session.", seats };
  }
  return { rig, lead: { session, logicalId: seats.find((seat) => seat.session === session)?.logicalId ?? null }, seats };
}

type SliceEntry = { name?: string; missionId?: string | null; displayName?: string; status?: string; description?: string | null; qitemCount?: number; lastActivityAt?: string | null };

/** A slice's summary fields, without its paths and readiness detail. */
function sliceSummary(slice: SliceEntry): Record<string, unknown> {
  return {
    name: slice.name, missionId: slice.missionId ?? null, displayName: slice.displayName, status: slice.status,
    description: slice.description ?? null, qitemCount: slice.qitemCount, lastActivityAt: slice.lastActivityAt ?? null,
  };
}

type Scope = { session(value: unknown): boolean; item(row: unknown): boolean; owner(row: unknown): boolean; rig(name: unknown): boolean; root(name: unknown): boolean };

/** What an authenticated non-owner caller may reach: its own seat, its rigs' seats, the items they send or own (to read),
 *  the items they own (to change), and its shared roots. A person (<entityId>@external) is never in a non-owner's scope. */
function scopeFor(access: McpAccess, seatOf: () => string | undefined): Scope {
  const rigs = new Set(access.rigs);
  const session = (value: unknown): boolean => {
    if (typeof value !== "string" || !value) return false;
    const seat = seatOf();
    if (seat && (value === seat || value.startsWith(`${seat}@`))) return true;
    const rig = value.split("@")[1];
    return rig !== undefined && rig !== "external" && rigs.has(rig);
  };
  return {
    session,
    item: (row) => {
      const item = (row ?? {}) as { sourceSession?: unknown; destinationSession?: unknown };
      return session(item.sourceSession) || session(item.destinationSession);
    },
    // The daemon's update has no owner check, so changing a row needs its owner in scope: a row a team seat handed to
    // another team, or a person's pending ask, stays readable and isn't the sender's to close or settle.
    owner: (row) => session(((row ?? {}) as { destinationSession?: unknown }).destinationSession),
    rig: (name) => typeof name === "string" && rigs.has(name),
    root: (name) => typeof name === "string" && access.roots.includes(name),
  };
}

/** A target outside an authenticated caller's scope. It names the kind of target only, never the record. */
function outOfScope(what: string): TextResult {
  const message = `${what} is outside what this connection may reach.`;
  return errorResult(JSON.stringify({ ok: false, error: "out_of_scope", message }), "out_of_scope", message);
}

type SharedRoot = { name: string; path: string };
type FileRead = { root?: string; path?: string; content?: string; binary?: boolean; size?: number; mtime?: string; truncated?: boolean; truncatedAtBytes?: number | null; totalBytes?: number };

/** The shared root an absolute path falls under as written, and its path inside that root. The reference names a file
 *  where the daemon runs, which may be another machine, so it's never resolved through this machine's filesystem; the
 *  daemon still checks containment itself when the file is read. */
function underSharedRoot(roots: SharedRoot[], absolute: string): { root: string; path: string } | null {
  for (const root of roots) {
    const inside = nodePath.relative(root.path, absolute);
    if (inside && inside !== ".." && !inside.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(inside)) return { root: root.name, path: inside };
  }
  return null;
}

/** A file the daemon read through a shared root, as text from offset: at most CONTEXT_TEXT_LIMIT characters, with
 *  nextOffset when more of what the daemon read remains, and its byte cut when the file was longer than the daemon reads. */
function artifactView(source: string, read: FileRead, offset: number): Record<string, unknown> {
  const base = { available: true, source, root: read.root, path: read.path, size: read.size, mtime: read.mtime };
  if (read.binary) return { ...base, binary: true, note: "A binary file: not shown as text." };
  const text = read.content ?? "";
  const end = offset + CONTEXT_TEXT_LIMIT;
  return {
    ...base, binary: false, offset, text: text.slice(offset, end), totalChars: text.length,
    truncated: text.length > end || read.truncated === true,
    ...(text.length > end ? { nextOffset: end } : {}),
    ...(read.truncated ? { truncatedAtBytes: read.truncatedAtBytes, totalBytes: read.totalBytes } : {}),
  };
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

/** Who an authenticated HTTP caller must be to be offered a tool: work tools (the work loop, orientation, and
 *  communication with seats) reach a team within the caller's scope; workspace tools read the work tree and context when
 *  the caller's grant includes them; owner tools administer the instance (launch, stop, snapshot and restore, discover and
 *  bind, add seats, validate or inspect local files by path, the event log) and are offered only to an owner grant for now.
 *  A local caller (stdio, or HTTP with no auth configured) is the owner. */
export type McpAccessClass = "work" | "workspace" | "owner";

/** An authenticated HTTP caller: the seat it acts as comes with it (the DaemonClient built for it); this is what it may
 *  reach. A session is in scope when it is the caller's seat or a seat of one of its rigs; an item, when its source or
 *  destination is. */
export type McpAccess = { principal: string; owner: boolean; rigs: readonly string[]; roots: readonly string[]; workspace: boolean };

/** What each tool calls and what it does, kept beside the registrations. The MCP contract tests check that it names every
 *  registered tool, that each tool's annotations match its effect, and that each route is mounted in the daemon. Tools that
 *  take a rig name also read GET /api/rigs/summary to resolve it. */
export const MCP_OPERATIONS: ReadonlyArray<{ tool: string; routes: readonly string[]; effect: "read" | "additive" | "destructive"; access: McpAccessClass }> = [
  { tool: "rig_up", routes: ["POST /api/up"], effect: "destructive", access: "owner" },
  { tool: "rig_down", routes: ["POST /api/down"], effect: "destructive", access: "owner" },
  { tool: "rig_ps", routes: ["GET /api/ps"], effect: "read", access: "work" },
  { tool: "rig_status", routes: ["GET /healthz"], effect: "read", access: "work" },
  { tool: "rig_snapshot_create", routes: ["POST /api/rigs/:rigId/snapshots"], effect: "additive", access: "owner" },
  { tool: "rig_snapshot_list", routes: ["GET /api/rigs/:rigId/snapshots"], effect: "read", access: "owner" },
  { tool: "rig_restore", routes: ["POST /api/rigs/:rigId/restore/:snapshotId"], effect: "destructive", access: "owner" },
  { tool: "rig_restore_status", routes: ["GET /api/rigs/:rigId/restore/status/:attemptId"], effect: "read", access: "owner" },
  { tool: "rig_discover", routes: ["POST /api/discovery/scan"], effect: "destructive", access: "owner" },
  { tool: "rig_bind", routes: ["POST /api/discovery/:id/bind"], effect: "destructive", access: "owner" },
  { tool: "rig_bundle_inspect", routes: ["POST /api/bundles/inspect"], effect: "read", access: "owner" },
  { tool: "rig_agent_validate", routes: ["POST /api/agents/validate"], effect: "read", access: "owner" },
  { tool: "rig_rig_validate", routes: ["POST /api/rigs/import/validate"], effect: "read", access: "owner" },
  { tool: "rig_rig_nodes", routes: ["GET /api/rigs/:rigId/nodes"], effect: "read", access: "work" },
  { tool: "rig_send", routes: ["POST /api/transport/send"], effect: "destructive", access: "work" },
  { tool: "rig_capture", routes: ["POST /api/transport/capture"], effect: "read", access: "work" },
  { tool: "rig_chatroom_send", routes: ["POST /api/rigs/:rigId/chat/send"], effect: "additive", access: "work" },
  { tool: "rig_chatroom_watch", routes: ["GET /api/rigs/:rigId/chat/history"], effect: "read", access: "work" },
  { tool: "rig_add", routes: ["POST /api/rigs/:rigId/pods/:podNamespace/members"], effect: "additive", access: "owner" },
  { tool: "rig_queue_create", routes: ["POST /api/queue/create", "GET /api/queue/:qitemId"], effect: "additive", access: "work" },
  { tool: "rig_queue_show", routes: ["GET /api/queue/:qitemId", "GET /api/queue/:qitemId/transitions", "GET /api/queue/list"], effect: "read", access: "work" },
  { tool: "rig_queue_list", routes: ["GET /api/queue/list"], effect: "read", access: "work" },
  { tool: "rig_queue_claim", routes: ["POST /api/queue/:qitemId/claim"], effect: "destructive", access: "work" },
  { tool: "rig_queue_update", routes: ["POST /api/queue/:qitemId/update"], effect: "destructive", access: "work" },
  { tool: "rig_telemetry_events", routes: ["GET /api/telemetry/v1/events"], effect: "read", access: "owner" },
  { tool: "rig_whoami", routes: ["GET /api/whoami"], effect: "read", access: "work" },
  { tool: "rig_team", routes: ["GET /api/rigs/:rigId", "GET /api/rigs/:rigId/nodes"], effect: "read", access: "work" },
  { tool: "rig_slices", routes: ["GET /api/slices"], effect: "read", access: "workspace" },
  { tool: "rig_mission", routes: ["GET /api/missions/:missionId"], effect: "read", access: "workspace" },
  { tool: "rig_context_pack", routes: ["GET /api/context-packs/library/by-ref"], effect: "read", access: "workspace" },
  { tool: "rig_context_get", routes: ["GET /api/context-packs/library/resolve-address"], effect: "read", access: "workspace" },
  { tool: "rig_artifact_read", routes: ["GET /api/queue/:qitemId", "GET /api/files/roots", "GET /api/files/read"], effect: "read", access: "work" },
  { tool: "rig_human_decision_room", routes: ["GET /api/queue/:qitemId", "GET /api/gateway/human/:entityId/decision-room"], effect: "read", access: "work" },
  { tool: "rig_queue_decide", routes: ["POST /api/queue/:qitemId/delegated-decision"], effect: "destructive", access: "work" },
];

// Short guidance a client may show the model (the server's MCP instructions).
const INSTRUCTIONS = [
  "This server reaches an OpenRig team as one seat: the one named by OPENRIG_SESSION_NAME where the server was configured, or, over authenticated HTTP, the seat of the caller's grant (rig_whoami shows which, and whether the caller is authenticated; rig_team shows a rig's seats and its lead). The daemon attributes this server's writes to that seat.",
  "To hand work to a seat, use rig_queue_create and keep its qitemId; read the answer later with rig_queue_show, which names the next item when the work was handed on. Queue items are durable: they outlive this conversation and this server.",
  "Tools marked read-only change nothing. A seat whose activity is unknown is not idle, and an accepted request (a restore's attemptId) is not a finished one.",
  "A question reserved for a person is theirs to answer: don't answer it on their behalf. rig_queue_decide records a decision only inside the decision room of the mode they have on, beside their answers and never as one.",
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
  // is a snake_case error on its own. The slice and mission routes send a hint where others send a message.
  const error = typeof data.error === "string" ? data.error : undefined;
  const prose = typeof data.message === "string" ? data.message : typeof data.hint === "string" ? data.hint : undefined;
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
export function createMcpServer(client: DaemonClient, options: { seat?: string; access?: McpAccess } = {}): McpServer {
  const server = new McpServer({
    name: "openrig",
    version: CLI_VERSION,
  }, { instructions: INSTRUCTIONS });
  const { access } = options;
  // The seat this server acts as: the authenticated caller's, else OPENRIG_SESSION_NAME where it was configured.
  const seatOf = (): string | undefined => options.seat ?? readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  const accessClass = new Map(MCP_OPERATIONS.map((op) => [op.tool, op.access]));
  // A local caller (no access) is offered every tool; an authenticated one, its class's.
  const offered = (tool: string): boolean => {
    if (!access || access.owner) return true;
    const kind = accessClass.get(tool);
    return kind === "work" || (kind === "workspace" && access.workspace);
  };
  const scope = access && !access.owner ? scopeFor(access, seatOf) : null;
  const caller = access ? { authenticated: true, principal: access.principal } : { authenticated: false, identity: "declared" };
  /** For an authenticated non-owner: the error for an item it can't reach (or can't read), else null. `owner` asks
   *  whether it may change the item, which needs the item's owner in scope. */
  const itemOutOfScope = async (qitemId: string, need: "item" | "owner" = "item"): Promise<TextResult | null> => {
    if (!scope) return null;
    const item = await client.get(`/api/queue/${encodeURIComponent(qitemId)}`);
    if (item.status >= 400) return mapResult(item);
    if (scope[need](item.data)) return null;
    return outOfScope(need === "owner" && scope.item(item.data) ? `Item ${qitemId}'s owner` : `Item ${qitemId}`);
  };
  /** For an authenticated non-owner: the name of the rig a handle resolves to when it's one of its rigs, else the error
   *  (outside its rigs, or a handle the rig list can't resolve). */
  const scopedRigName = async (handle: string): Promise<TextResult | string> => {
    const rig = await rigIdFor(client, handle);
    if ("content" in rig) return rig;
    if (!rig.resolved) return outOfScope(`Rig ${handle}`);
    const detail = await client.get(`/api/rigs/${encodeURIComponent(rig.id)}`);
    if (detail.status >= 400) return mapResult(detail);
    const name = ((detail.data ?? {}) as RigDetail).rig?.name;
    return scope?.rig(name) ? name as string : outOfScope(`Rig ${handle}`);
  };
  const rigOutOfScope = async (handle: string): Promise<TextResult | null> => {
    if (!scope) return null;
    const name = await scopedRigName(handle);
    return typeof name === "string" ? null : name;
  };

  // 1. rig_up — launch from a spec, bundle or topology, or restore an existing rig by name
  if (offered("rig_up")) server.tool(
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
  if (offered("rig_down")) server.tool(
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
  if (offered("rig_ps")) server.tool(
    "rig_ps",
    "List rigs and their status",
    {},
    READ_ONLY,
    async () => {
      try {
        const res = await client.get("/api/ps");
        if (scope && res.status < 400 && Array.isArray(res.data)) return mapResult({ ...res, data: res.data.filter((entry) => scope.rig((entry as { name?: unknown }).name)) });
        return mapResult(res);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 4. rig_status — daemon health
  if (offered("rig_status")) server.tool(
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
  if (offered("rig_snapshot_create")) server.tool(
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
  if (offered("rig_snapshot_list")) server.tool(
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
  if (offered("rig_restore")) server.tool(
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
  if (offered("rig_restore_status")) server.tool(
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
  if (offered("rig_discover")) server.tool(
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
  if (offered("rig_bind")) server.tool(
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
  if (offered("rig_bundle_inspect")) server.tool(
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
  if (offered("rig_agent_validate")) server.tool(
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
  if (offered("rig_rig_validate")) server.tool(
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
  if (offered("rig_rig_nodes")) server.tool(
    "rig_rig_nodes",
    "Get node inventory for a rig — session names, status, attach commands, resume commands",
    {
      rigId: z.string().describe("Rig name or identifier"),
    },
    READ_ONLY,
    async ({ rigId }) => {
      try {
        const denied = await rigOutOfScope(rigId);
        if (denied) return denied;
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
  if (offered("rig_send")) server.tool(
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
        if (scope && !scope.session(session)) return outOfScope(`Session ${session}`);
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
  if (offered("rig_capture")) server.tool(
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
        let rigName = rig;
        if (scope) {
          if (session && !scope.session(session)) return outOfScope(`Session ${session}`);
          if (pod && !rig) return outOfScope(`Pod ${pod} without its rig`);
          // The route finds the rig by name, so send the name this check authorized: a handle that is one rig's id and
          // another rig's name must not reach the second rig's terminals.
          if (rig) {
            const name = await scopedRigName(rig);
            if (typeof name !== "string") return name;
            rigName = name;
          }
        }
        const body: Record<string, unknown> = {};
        if (session) body.session = session;
        if (rigName) body.rig = rigName;
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
  if (offered("rig_chatroom_send")) server.tool(
    "rig_chatroom_send",
    "Send a message to a rig's chatroom as this server's seat",
    {
      rigName: z.string().describe("Rig name or identifier"),
      body: z.string().describe("Message body"),
    },
    ADDITIVE,
    async ({ rigName, body }) => {
      try {
        const denied = await rigOutOfScope(rigName);
        if (denied) return denied;
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
  if (offered("rig_chatroom_watch")) server.tool(
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
        const denied = await rigOutOfScope(rigName);
        if (denied) return denied;
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
  if (offered("rig_add")) server.tool(
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
  if (offered("rig_queue_create")) server.tool(
    "rig_queue_create",
    "Hand a task to another seat as a durable queue item. Returns its qitemId: read the answer later with rig_queue_show. If the call times out, check rig_queue_show with the same qitemId before retrying; never retry with a new id. To ask for a revision of earlier work, name it in revises: the new item opens with 'Revision of <id>' and records it in its chainOfRecord.",
    {
      destination: z.string().describe("Destination seat (e.g. dev-impl@my-rig)"),
      body: z.string().describe("The task: what to do and what to return"),
      summary: z.string().optional().describe("One-line summary"),
      tags: z.array(z.string()).optional().describe("Tags, e.g. mission:<name>"),
      priority: z.string().optional().describe("Priority (as rig queue create --priority)"),
      tier: z.string().optional().describe("Tier (as rig queue create --tier)"),
      qitemId: z.string().optional().describe("Request id to reuse when retrying the same create (default: a new id)"),
      revises: z.string().optional().describe("The qitemId of the work this asks to revise"),
    },
    ADDITIVE,
    async ({ destination, body, summary, tags, priority, tier, qitemId, revises }) => {
      if (scope && !scope.session(destination)) return outOfScope(`Destination ${destination}`);
      // A revision carries its original's lineage as a handoff does: the original's chain, then the original.
      let lineage: { chainOfRecord: string[]; body: string } | undefined;
      if (revises) {
        try {
          const original = await client.get(`/api/queue/${encodeURIComponent(revises)}`);
          if (original.status >= 400) return mapResult(original);
          if (scope && !scope.item(original.data)) return outOfScope(`Item ${revises}`);
          const prior = (original.data ?? {}) as { qitemId?: unknown; chainOfRecord?: unknown };
          const originalId = typeof prior.qitemId === "string" ? prior.qitemId : revises;
          const chain = Array.isArray(prior.chainOfRecord) ? prior.chainOfRecord.filter((link): link is string => typeof link === "string") : [];
          lineage = { chainOfRecord: [...chain, originalId], body: `Revision of ${originalId}.\n\n${body}` };
        } catch (err) {
          return caught(err);
        }
      }
      const id = qitemId ?? `qitem-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(8).toString("hex")}`;
      try {
        const res = await client.post("/api/queue/create", {
          qitemId: id, destinationSession: destination, body: lineage?.body ?? body, summary, tags, priority, tier,
          ...(lineage ? { chainOfRecord: lineage.chainOfRecord } : {}),
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
  if (offered("rig_queue_show")) server.tool(
    "rig_queue_show",
    "Read one queue item and its transitions. For a task you handed off, this is where its answer is: the state, the closure reason and target, the notes the assignee recorded, and evidenceRef when it names an artifact (read it with rig_artifact_read). When the item was handed on, successor names the next item (on another host: its id and host); follow it with rig_queue_show. null means none was found. A revision names the work it revises in chainOfRecord.",
    {
      qitemId: z.string().describe("The qitemId returned by rig_queue_create (or any queue item)"),
    },
    READ_ONLY,
    async ({ qitemId }) => {
      try {
        const id = encodeURIComponent(qitemId);
        const item = await client.get(`/api/queue/${id}`);
        if (item.status >= 400) return mapResult(item);
        if (scope && !scope.item(item.data)) return outOfScope(`Item ${qitemId}`);
        const transitions = await client.get(`/api/queue/${id}/transitions`);
        if (transitions.status >= 400) return mapResult(transitions);
        const row = (item.data ?? {}) as { state?: unknown; closureReason?: unknown; closureTarget?: unknown };
        const handedOn = row.state === "handed-off" || row.closureReason === "handed_off_to";
        let successor = handedOn ? await successorOf(client, qitemId, row.closureTarget) : undefined;
        if (scope && successor && "destinationSession" in successor && !scope.session(successor.destinationSession)) successor = { unknown: true, code: "out_of_scope" };
        return mapResult({ status: 200, data: { item: item.data, transitions: transitions.data, ...(handedOn ? { successor } : {}) } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 21. rig_queue_list — list queue items
  if (offered("rig_queue_list")) server.tool(
    "rig_queue_list",
    "List queue items. owned: assigned to this seat. mine: this seat is the source or the destination. Without a scope, this seat's rig. Without state, open items only (all adds closed ones); a state filter returns exactly those states, closed ones included. since finds work updated after a time; handedOffFrom finds where a handed-off item went.",
    {
      owned: z.boolean().optional().describe("Only items assigned to this seat (overrides destination)"),
      mine: z.boolean().optional().describe("Items this seat sent or owns"),
      destination: z.string().optional().describe("Filter by destination seat"),
      source: z.string().optional().describe("Filter by source seat"),
      state: z.string().optional().describe("Only these states, comma-separated; closed states included when named"),
      all: z.boolean().optional().describe("Without state: include closed items"),
      since: z.string().optional().describe("Only items updated at or after this ISO-8601 time, e.g. done work since Monday: state done, since 2026-10-19"),
      handedOffFrom: z.string().optional().describe("The items handed on from this qitemId, in any state and any rig"),
      limit: z.number().int().positive().optional().describe("Result limit (default 100)"),
    },
    READ_ONLY,
    async ({ owned, mine, destination, source, state, all, since, handedOffFrom, limit }) => {
      try {
        const params = new URLSearchParams();
        const sessionName = seatOf();
        if ((owned || mine) && !sessionName) {
          const message = "owned and mine need this server's seat: set OPENRIG_SESSION_NAME in its env, or filter by destination or source";
          return errorResult(JSON.stringify({ ok: false, error: message }), "seat_required", message);
        }
        if (scope) {
          if (destination && !owned && !scope.session(destination)) return outOfScope(`Destination ${destination}`);
          if (source && !scope.session(source)) return outOfScope(`Source ${source}`);
          const defaultRig = sessionName?.split("@")[1];
          if (!owned && !mine && !destination && !source && !handedOffFrom && !scope.rig(defaultRig)) return outOfScope(`Rig ${defaultRig ?? "(none)"}`);
        }
        if (owned) params.set("destinationSession", sessionName!);
        else if (mine) params.set("as", sessionName!);
        else if (!destination && !source && !handedOffFrom && sessionName?.includes("@")) params.set("rig", sessionName.split("@")[1]!);
        if (!all && !handedOffFrom) params.set("activeOnly", "1");
        params.set("compact", "1");
        // owned means assigned to this seat; another destination can't widen it to someone else's items.
        if (destination && !owned) params.set("destinationSession", destination);
        if (source) params.set("sourceSession", source);
        if (state) params.set("state", state);
        if (since) params.set("updatedSince", since);
        if (handedOffFrom) params.set("handedOffFrom", handedOffFrom);
        params.set("limit", String(limit ?? 100));
        const res = await client.get(`/api/queue/list?${params.toString()}`);
        const ignored = res.status < 400 ? ignoredFilter(res.data, { since, handedOffFrom }) : null;
        if (ignored) {
          const message = `The daemon didn't apply ${ignored}, so this list isn't filtered by it; it needs a newer daemon.`;
          return errorResult(JSON.stringify({ ok: false, error: message }), "filter_unsupported", message);
        }
        // An authenticated caller sees only the rows in its scope, whatever the filters matched.
        if (scope && res.status < 400 && Array.isArray(res.data)) return mapResult({ ...res, data: res.data.filter((row) => scope.item(row)) }, undefined, { structured: true });
        return mapResult(res, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 22. rig_queue_claim — take an item assigned to this seat
  if (offered("rig_queue_claim")) server.tool(
    "rig_queue_claim",
    "Claim a queue item assigned to this seat before working on it.",
    { qitemId: z.string().describe("The queue item to claim") },
    DESTRUCTIVE,
    async ({ qitemId }) => {
      try {
        const denied = await itemOutOfScope(qitemId);
        if (denied) return denied;
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/claim`, {}), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 23. rig_queue_update — record progress, block, or close with the answer
  if (offered("rig_queue_update")) server.tool(
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
        const denied = await itemOutOfScope(qitemId, "owner");
        if (denied) return denied;
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/update`, {
          state, closureReason, closureTarget, summary, evidenceRef, blockedOn, wakeAfterSeconds, transitionNote: note, resolution, reopen,
        }), undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 24. rig_telemetry_events — one bounded page of event metadata, the page `rig telemetry events` reads
  if (offered("rig_telemetry_events")) server.tool(
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
  if (offered("rig_whoami")) server.tool(
    "rig_whoami",
    "Show which OpenRig seat this server acts as: its rig, pod, peers and edges, and caller: authenticated (a validated HTTP credential, with its principal) or declared (OPENRIG_SESSION_NAME where the server was configured, which nothing verifies).",
    {},
    READ_ONLY,
    async () => {
      try {
        const seat = seatOf();
        if (!seat) {
          const none = { ok: true, seat: null, caller, message: "This server has no seat: OPENRIG_SESSION_NAME isn't set where it was configured, so its writes aren't attributed to a seat." };
          return { content: [{ type: "text" as const, text: JSON.stringify(none) }], structuredContent: none };
        }
        const params = new URLSearchParams({ sessionName: seat, compact: "1" });
        const targetRepo = readOpenRigEnv("OPENRIG_TARGET_REPO", "RIGGED_TARGET_REPO")?.trim();
        if (targetRepo) params.set("targetRepo", targetRepo);
        const res = await client.get(`/api/whoami?${params.toString()}`);
        if (res.status >= 400) return mapResult(res);
        return mapResult({ ...res, data: { ...(res.data as Record<string, unknown>), caller } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 27. rig_team — a rig's seats and its lead
  if (offered("rig_team")) server.tool(
    "rig_team",
    "Show a rig's team: its lead, the rig's one delegates_to root (the seat that delegates to others and that nothing delegates to: the seat to delegate to), and each seat's pod, role, runtime, delegation (reportsTo, delegatesTo) and activity as the daemon reports it. Activity the daemon doesn't know reads unknown, never idle.",
    {
      rigId: z.string().describe("Rig name or identifier"),
    },
    READ_ONLY,
    async ({ rigId }) => {
      try {
        const rig = await rigIdFor(client, rigId);
        if ("content" in rig) return rig;
        const id = encodeURIComponent(rig.id);
        const detail = await client.get(`/api/rigs/${id}`);
        if (detail.status >= 400) return mapResult(detail);
        if (scope && !scope.rig(((detail.data ?? {}) as RigDetail).rig?.name)) return outOfScope(`Rig ${rigId}`);
        const nodes = await client.get(`/api/rigs/${id}/nodes`);
        if (nodes.status >= 400) return mapResult(nodes);
        return mapResult({ status: 200, data: teamView((detail.data ?? {}) as RigDetail, nodes.data) }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 28. rig_slices — the work tree's slices, as summaries
  if (offered("rig_slices")) server.tool(
    "rig_slices",
    "List the work tree's slices, most recently active first: name, mission, status, description and how many queue items name it. Paths and readiness detail are left out.",
    {
      missionId: z.string().optional().describe("Only this mission's slices"),
      filter: z.enum(["all", "active", "done", "blocked"]).optional().describe("Only slices with this status (default all)"),
      limit: z.number().int().positive().max(200).optional().describe("Most slices to return (default 50)"),
    },
    READ_ONLY,
    async ({ missionId, filter, limit }) => {
      try {
        const res = await client.get(`/api/slices${filter ? `?${new URLSearchParams({ filter }).toString()}` : ""}`);
        if (res.status >= 400) return mapResult(res);
        const all = (((res.data ?? {}) as { slices?: SliceEntry[] }).slices ?? []).filter((slice) => !missionId || slice.missionId === missionId);
        const shown = all.slice(0, limit ?? 50);
        return mapResult({ status: 200, data: { slices: shown.map(sliceSummary), totalCount: all.length, truncated: shown.length < all.length } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 29. rig_mission — one mission's status and slices
  if (offered("rig_mission")) server.tool(
    "rig_mission",
    "Read one mission: its status and its slices as summaries.",
    {
      missionId: z.string().describe("The mission's id (its folder name)"),
    },
    READ_ONLY,
    async ({ missionId }) => {
      try {
        const res = await client.get(`/api/missions/${encodeURIComponent(missionId)}`);
        if (res.status >= 400) return mapResult(res);
        const mission = (res.data ?? {}) as { missionId?: string; status?: unknown; slices?: SliceEntry[] };
        return mapResult({ status: 200, data: { missionId: mission.missionId ?? missionId, status: mission.status ?? null, slices: (mission.slices ?? []).map(sliceSummary) } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 30. rig_context_pack — one context pack's files
  if (offered("rig_context_pack")) server.tool(
    "rig_context_pack",
    "Show one context pack: its purpose and the files it declares (path, role, summary, estimated tokens), so a file can be read with rig_context_get as <pack>/<file>.",
    {
      ref: z.string().describe("The pack's ref, as rig context list shows it (e.g. project-world)"),
    },
    READ_ONLY,
    async ({ ref }) => {
      try {
        const res = await client.get(`/api/context-packs/library/by-ref?${new URLSearchParams({ ref }).toString()}`);
        if (res.status >= 400) return mapResult(res);
        const pack = (res.data ?? {}) as { relativePath?: string; name?: string; version?: string; purpose?: string | null; files?: Array<{ path: string; role?: string; summary?: string | null; estimatedTokens?: number | null }> };
        return mapResult({ status: 200, data: {
          ref: pack.relativePath ?? ref, name: pack.name, version: pack.version, purpose: pack.purpose ?? null,
          files: (pack.files ?? []).map((file) => ({ path: file.path, role: file.role, summary: file.summary ?? null, estimatedTokens: file.estimatedTokens ?? null })),
        } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 31. rig_context_get — one context file or section, as rig context get reads it
  if (offered("rig_context_get")) server.tool(
    "rig_context_get",
    `Read one context file or one section of it, as rig context get does: <pack>/<file>, or <pack>/<file>#<h2-slug>[/<h3-slug>]. Text over ${CONTEXT_TEXT_LIMIT} characters is cut (truncated: true); address a section to read the rest.`,
    {
      address: z.string().describe("<pack>/<file>[#<h2-slug>[/<h3-slug>]]"),
    },
    READ_ONLY,
    async ({ address }) => {
      try {
        const res = await client.get(`/api/context-packs/library/resolve-address?${new URLSearchParams({ address }).toString()}`);
        if (res.status >= 400) return mapResult(res);
        const found = (res.data ?? {}) as { address?: string; packRef?: string; filePath?: string; headerPath?: unknown; text?: string };
        const text = found.text ?? "";
        const cut = text.length > CONTEXT_TEXT_LIMIT;
        return mapResult({ status: 200, data: {
          address: found.address ?? address, packRef: found.packRef, filePath: found.filePath,
          ...(found.headerPath !== undefined ? { headerPath: found.headerPath } : {}),
          text: cut ? text.slice(0, CONTEXT_TEXT_LIMIT) : text,
          ...(cut ? { truncated: true, totalChars: text.length } : {}),
        } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 32. rig_artifact_read — a result's artifact, read through the daemon's shared roots
  if (offered("rig_artifact_read")) server.tool(
    "rig_artifact_read",
    `Read a finished item's artifact (its evidenceRef), or a named file, through the daemon's shared roots (OPENRIG_FILES_ALLOWLIST), as text: at most ${CONTEXT_TEXT_LIMIT} characters from offset; nextOffset reads on. An artifact outside every shared root, a link, or an item with no evidenceRef comes back as available: false with the reason and the shared roots' names; nothing outside those roots is read.`,
    {
      qitemId: z.string().optional().describe("Read this item's evidenceRef"),
      root: z.string().optional().describe("A shared root's name: with path, the file to read; with qitemId, the root a relative evidenceRef is under"),
      path: z.string().optional().describe("With root: the file's path inside that root"),
      offset: z.number().int().min(0).optional().describe("The character to start from (default 0)"),
    },
    READ_ONLY,
    async ({ qitemId, root, path, offset }) => {
      try {
        const read = async (source: string, rootName: string, inside: string): Promise<TextResult> => {
          const res = await client.get(`/api/files/read?${new URLSearchParams({ root: rootName, path: inside }).toString()}`);
          if (res.status >= 400) return mapResult(res);
          return mapResult({ status: 200, data: artifactView(source, (res.data ?? {}) as FileRead, offset ?? 0) }, undefined, { structured: true });
        };
        if (scope && root && !scope.root(root)) return outOfScope(`Root ${root}`);
        if (!qitemId) {
          if (root && path) return await read("path", root, path);
          const message = "Name an item (qitemId), or a file (root and path).";
          return errorResult(JSON.stringify({ ok: false, error: message }), "artifact_required", message);
        }
        const item = await client.get(`/api/queue/${encodeURIComponent(qitemId)}`);
        if (item.status >= 400) return mapResult(item);
        if (scope && !scope.item(item.data)) return outOfScope(`Item ${qitemId}`);
        const ref = ((item.data ?? {}) as { evidenceRef?: unknown }).evidenceRef;
        const rootsRes = await client.get("/api/files/roots");
        if (rootsRes.status >= 400) return mapResult(rootsRes);
        const roots = (((rootsRes.data ?? {}) as { roots?: SharedRoot[] }).roots ?? []).filter((entry) => !scope || scope.root(entry.name));
        const unavailable = (reason: string) => mapResult({ status: 200, data: {
          available: false, qitemId, reason, evidenceRef: typeof ref === "string" ? ref : null, roots: roots.map((entry) => entry.name),
        } }, undefined, { structured: true });
        if (typeof ref !== "string" || !ref.trim()) return unavailable("This item names no artifact: it has no evidenceRef.");
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) return unavailable("The evidenceRef is a link, not a file in a shared root: open it where it lives.");
        if (roots.length === 0) return unavailable("This daemon shares no roots (OPENRIG_FILES_ALLOWLIST is empty), so no artifact can be read through it.");
        if (!nodePath.isAbsolute(ref)) {
          return root ? await read("evidenceRef", root, ref) : unavailable("The evidenceRef is a relative path: name the shared root it's under (root).");
        }
        const shared = underSharedRoot(roots, ref);
        if (!shared) return unavailable("The evidenceRef is outside every shared root as the daemon lists them, so it isn't read. If it reaches a root through a link, read the file with root and path.");
        return await read("evidenceRef", shared.root, shared.path);
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 33. rig_human_decision_room — before deciding a question asked of a person: the room their mode gives the team
  if (offered("rig_human_decision_room")) server.tool(
    "rig_human_decision_room",
    "Before deciding a question you asked a person: the decision room of the mode they have on, in their own words (what the team may decide for them meanwhile, and what it may not), or none, with why. You judge whether your decision falls inside it; with none, the question stays theirs to answer.",
    {
      qitemId: z.string().describe("Your pending ask to the person (a queue item addressed to <person>@external)"),
    },
    READ_ONLY,
    async ({ qitemId }) => {
      try {
        const item = await client.get(`/api/queue/${encodeURIComponent(qitemId)}`);
        if (item.status >= 400) return mapResult(item);
        if (scope && !scope.item(item.data)) return outOfScope(`Item ${qitemId}`);
        const row = (item.data ?? {}) as { destinationSession?: unknown; humanIntent?: unknown };
        // A person is addressed as <entityId>@external, the daemon's external session form; an update asks nothing.
        const person = typeof row.destinationSession === "string" ? /^([A-Za-z0-9._:-]+)@external$/.exec(row.destinationSession) : null;
        if (!person || row.humanIntent === "update") {
          const message = `${qitemId} isn't a decision asked of a person: it's ${row.humanIntent === "update" ? "an update" : "addressed"} to ${String(row.destinationSession)}`;
          return errorResult(JSON.stringify({ ok: false, error: "not-a-decision", message }), "not-a-decision", message);
        }
        const res = await client.get(`/api/gateway/human/${encodeURIComponent(person[1]!)}/decision-room`);
        if (res.status >= 400) return mapResult(res);
        return mapResult({ status: 200, data: { qitemId, ...(res.data as Record<string, unknown>), entityId: person[1] } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 34. rig_queue_decide — a decision made on a person's behalf, inside their decision room, beside their answers
  if (offered("rig_queue_decide")) server.tool(
    "rig_queue_decide",
    "Record a decision you made on a person's behalf, on your own pending ask to them, inside the decision room of the mode they have on: read it first with rig_human_decision_room and pass its applicationId. It's recorded beside their answers, never as one, and the ask closes. The daemon refuses it when they have no room, their mode changed since you read it, the ask is a permission prompt or an approval gate, they've started answering, or another seat asked. This server never answers as the person.",
    {
      qitemId: z.string().describe("Your pending ask to the person"),
      applicationId: z.string().describe("decisionRoom.applicationId from rig_human_decision_room: the room you judged against"),
      choices: z.array(z.object({
        questionId: z.string().optional().describe("The question's id, when the ask has structured questions"),
        chosen: z.string().describe("The option's id; for an ask without questions, the choice in words"),
      })).describe("One choice per structured question; for an ask without questions, one choice without questionId"),
      reason: z.string().describe("Why this choice"),
      reversible: z.boolean().describe("Whether the decision can be undone"),
    },
    DESTRUCTIVE,
    async ({ qitemId, applicationId, choices, reason, reversible }) => {
      try {
        const denied = await itemOutOfScope(qitemId);
        if (denied) return denied;
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/delegated-decision`, { applicationId, choices, reason, reversible }), undefined, { structured: true });
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
