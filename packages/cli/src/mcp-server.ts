import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import nodePath from "node:path";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { DaemonConnectionError, DaemonTimeoutError, terminalAuthHeaders, type DaemonClient, type DaemonResponse } from "./client.js";
import { readOpenRigEnv } from "./openrig-compat.js";
import { resolveRigHandle } from "./rig-handle.js";
import { formatSeatActivity, type SeatActivityFields } from "./lib/seat-activity.js";
import { CLI_VERSION } from "./version.js";
import { ConfigStore } from "./config-store.js";
import { readRosters } from "./commands/roster.js";
import { mcpPresenceFilePath, readPresence } from "./mcp-presence.js";

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
async function successorOf(client: DaemonClient, qitemId: string, closureTarget: unknown,
  /** For an external caller: which successor rows it may see; a cross-host successor's parties are unknown here, so it
   *  can't. */
  visible?: (row: unknown) => boolean): Promise<Record<string, unknown> | null> {
  const remote = typeof closureTarget === "string" ? /^(qitem-[^@]+)@([^@]+)$/.exec(closureTarget) : null;
  if (remote) return visible ? { unknown: true, code: "out_of_scope" } : { qitemId: remote[1], host: remote[2] };
  try {
    const res = await client.get(`/api/queue/list?${new URLSearchParams({ handedOffFrom: qitemId, compact: "1", limit: "5" }).toString()}`);
    if (res.status >= 400) return { unknown: true, code: (mapResult(res).structuredContent as { code: string }).code };
    if (!Array.isArray(res.data)) return { unknown: true, code: "unexpected_response" };
    if (ignoredFilter(res.data, { handedOffFrom: qitemId })) return { unknown: true, code: "filter_unsupported" };
    const rows = res.data as Array<{ qitemId?: string; sourceSession?: string; destinationSession?: string; state?: string }>;
    if (visible && rows.length > 0 && !visible(rows[0])) return { unknown: true, code: "out_of_scope" };
    const [next, ...others] = visible ? rows.filter((row) => visible(row)) : rows;
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

/** A rig's hosted member: a tool that lives outside a terminal (an assistant, a bot) and reaches the team over this server
 *  under a grant. Its roster entry authors what it's good at and its limits; it has no node or pane, and OpenRig doesn't
 *  observe it between calls, so its activity is unknown, never idle. */
type HostedMember = { session: string; roster: string; capabilities: string[]; useWhen: string; caveat: string | null; pane: null; activity: "unknown";
  presence: HostedPresence };

/** What OpenRig last saw of a hosted member: its last call to this host's MCP server, and the latest ring among its recent
 *  rows. Presence isn't pickup (a claim on a row), and null is unknown, never idle. */
type HostedPresence = { lastCallAt: string | null; lastWake: { at: string; result: string; qitemId: string } | null; lastWakeScope: string };

/** The rows a hosted member's latest ring is read from. */
const PRESENCE_ROWS = 50;

/** The newest ring among a seat's rows, by its attempt time. Rows for another seat (a daemon that ignored the filter) don't count. */
function newestWake(rows: unknown, seat: string): HostedPresence["lastWake"] {
  let newest: HostedPresence["lastWake"] = null;
  for (const row of Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []) {
    if (row.destinationSession !== seat) continue;
    const at = row.lastNudgeAttempt, result = row.lastNudgeWireResult ?? row.lastNudgeResult, qitemId = row.qitemId;
    if (typeof at !== "string" || typeof result !== "string" || typeof qitemId !== "string") continue;
    if (!newest || at > newest.at) newest = { at, result, qitemId };
  }
  return newest;
}

const ROSTERS_INCOMPLETE = "Some rosters couldn't be read, so hosted members may be missing.";

/** The roster members marked hosted, on this host, whose seat is in this rig and isn't one of its nodes. A roster folder that
 *  doesn't exist means none. One that can't be inspected or read, or a host id that isn't known yet, is said, never read as
 *  none. The note stays generic (a scoped caller doesn't see other rosters' names or errors); the detail goes to this
 *  server's log. */
async function hostedMembersOf(folder: string, rigName: string, nodeSeats: ReadonlySet<string>,
  selfHostId: () => Promise<string | null>, presenceOf: (seat: string) => Promise<HostedPresence>): Promise<{ members: HostedMember[]; note?: string }> {
  try {
    statSync(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { members: [] };
    console.error(`rig_team: the roster folder ${folder} can't be inspected: ${(error as Error).message}`);
    return { members: [], note: ROSTERS_INCOMPLETE };
  }
  const { rosters, warnings } = readRosters(folder);
  if (warnings.length > 0) console.error(`rig_team: ${warnings.join("; ")}`);
  const unread = warnings.length > 0 ? { note: ROSTERS_INCOMPLETE } : {};
  const candidates = rosters.flatMap((roster) => roster.members
    .filter((member) => member.hosted === true && member.seat.endsWith(`@${rigName}`) && !nodeSeats.has(member.seat))
    .map((member) => ({ roster: roster.id, member })));
  if (candidates.length === 0) return { members: [], ...unread };
  const host = await selfHostId();
  if (!host) return { members: [], note: "This daemon's host id isn't known yet, so hosted members on its rosters can't be matched to it." };
  // A seat in two rosters is one member: the first roster (by file name) supplies its entry.
  const members = new Map<string, HostedMember>();
  for (const { roster, member } of candidates) {
    if (member.host !== host || members.has(member.seat)) continue;
    members.set(member.seat, { session: member.seat, roster, capabilities: member.capabilities, useWhen: member.use_when,
      caveat: member.caveat ?? null, pane: null, activity: "unknown", presence: await presenceOf(member.seat) });
  }
  return { members: [...members.values()], ...unread };
}

type SliceEntry = { name?: string; missionId?: string | null; displayName?: string; status?: string; description?: string | null; qitemCount?: number; lastActivityAt?: string | null };

/** A slice's summary fields, without its paths and readiness detail. */
function sliceSummary(slice: SliceEntry): Record<string, unknown> {
  return {
    name: slice.name, missionId: slice.missionId ?? null, displayName: slice.displayName, status: slice.status,
    description: slice.description ?? null, qitemCount: slice.qitemCount, lastActivityAt: slice.lastActivityAt ?? null,
  };
}

type Scope = {
  session(value: unknown): boolean; item(row: unknown): boolean; owner(row: unknown): boolean; rig(name: unknown): boolean; root(name: unknown): boolean;
  /** A new item's destination. */
  destination(value: unknown): boolean;
  /** A handed-on item's successor, by its destination. */
  successor(destination: unknown): boolean;
  /** An item whose artifact may be read. */
  artifact(row: unknown): boolean;
  /** Whether a file may be read by root and path, without an item. */
  paths: boolean;
  /** Whether every list is limited to the caller's own items. */
  ownListsOnly: boolean;
  /** For an external caller: whether a party a row names (a handoff's new owner, a closure target, a blocker) may be
   *  shown. Every row an external caller receives goes through projectForExternal, and successors are checked whole
   *  (successorOf). Absent for every other caller, whose responses are as they were. */
  shows?: (party: unknown) => boolean;
  /** For an external caller: whether a seat named inside a transition note may stay (its own seat and its team's). */
  names?: (seat: string) => boolean;
};

type ExternalView = { shows: (party: unknown) => boolean; names: (seat: string) => boolean };

/** The external projection's predicates, for an external caller's scope only; null for every other caller. */
function externalView(scope: Scope | null): ExternalView | null {
  return scope?.shows && scope.names ? { shows: scope.shows, names: scope.names } : null;
}

const ITEM_ID = /qitem-[A-Za-z0-9][A-Za-z0-9_-]*(?:@[A-Za-z0-9._-]+)?/g;
const SEAT = /[A-Za-z0-9._-]+@[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?/g;

/** A transition note with every item id but the row's own, and every seat the external caller may not see, replaced.
 *  Notes the daemon writes on a parked row name its blocker ("blocker <id> wake attempted", "auto-unparked: blocker
 *  <id> …"), and a team's note can name anyone. */
function maskNote(note: string, ownId: unknown, names: (seat: string) => boolean): string {
  const ids: string[] = [];
  // Item ids first, set aside so a host-qualified id isn't read as a seat.
  const kept = note.replace(ITEM_ID, (id) => { ids.push(id === ownId ? id : "(out of scope)"); return `\u0000${ids.length - 1}\u0000`; });
  return kept.replace(SEAT, (seat) => names(seat) ? seat : "(out of scope)").replace(/\u0000(\d+)\u0000/g, (_m, i: string) => ids[Number(i)]!);
}

/** Whether a row's closure target names a party: a new owner, an escalation target, a replacement item or a blocker.
 *  A denial's or a cancel's target is the team's own text, kept unless it names a seat or an item. */
function namesParty(fields: Record<string, unknown>): boolean {
  const reason = fields.closureReason;
  return reason === "handed_off_to" || reason === "escalation" || reason === "superseded" || reason === "blocked_on"
    || fields.state === "blocked" || (typeof fields.closureTarget === "string" && /^qitem-|@/.test(fields.closureTarget));
}

/** What a hidden closure target's note says instead: the fact, without the party. */
const OUT_OF_SCOPE_NOTE: Readonly<Record<string, string>> = {
  handed_off_to: "handed on (out of scope)", escalation: "escalated (out of scope)", superseded: "superseded (out of scope)",
  blocked_on: "parked (out of scope)",
};

/**
 * One projection for every row an external caller receives (show's item and transitions, list rows, create's return).
 * The row's facts stay (state, closure reason); a party it names that the external caller may not see goes, whatever put
 * it there: a handoff, a park, an escalation or a supersede. That is handedOffTo, the closure target (and the note of
 * that closure, which can name it), blockedOn, the daemon's custody advisory, the waiting view's blocker, liveness and
 * backstop owners, the pickup receipt's evidence, a transition's wake arrangement, and the names inside transition
 * notes. The team's answer (resolution) and the task's body are left as written.
 */
function projectForExternal<T>(row: T, view: ExternalView): T {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const { shows, names } = view;
  const fields = { ...(row as Record<string, unknown>) };
  if (typeof fields.transitionNote === "string") fields.transitionNote = maskNote(fields.transitionNote, fields.qitemId, names);
  // A transition's wake arrangement names what it waits on (a blocker's id).
  const wake = fields.wake as { ref?: unknown } | null | undefined;
  if (wake && typeof wake === "object" && wake.ref != null && !shows(wake.ref)) delete fields.wake;
  if (typeof fields.handedOffTo === "string" && !shows(fields.handedOffTo)) fields.handedOffTo = null;
  if (fields.closureTarget != null && !shows(fields.closureTarget) && namesParty(fields)) {
    fields.closureTarget = null;
    if ("transitionNote" in fields) {
      const reason = typeof fields.closureReason === "string" ? fields.closureReason : null;
      fields.transitionNote = (reason && OUT_OF_SCOPE_NOTE[reason]) ?? `${reason ?? (fields.state === "blocked" ? "parked" : String(fields.state))} (out of scope)`;
    }
  }
  if (fields.blockedOn != null && !shows(fields.blockedOn)) fields.blockedOn = null;
  if (fields.closingTransition) fields.closingTransition = projectForExternal(fields.closingTransition, view);
  // The daemon's custody advisory names the target in its target and its message.
  const advisory = fields.handoffAdvisory as { target?: unknown } | null | undefined;
  if (advisory && typeof advisory === "object" && !shows(advisory.target)) delete fields.handoffAdvisory;
  // Who owes the next step, only when that's the row's own destination; a blocker's id, owner and state never.
  const waiting = fields.waiting as { owner?: unknown; state?: unknown } | null | undefined;
  if (waiting && typeof waiting === "object") {
    if (waiting.owner === fields.destinationSession) fields.waiting = { owner: waiting.owner, state: waiting.state };
    else delete fields.waiting;
  }
  const pickup = fields.pickup as { state?: unknown } | null | undefined;
  if (pickup && typeof pickup === "object") fields.pickup = { state: pickup.state };
  return fields as T;
}

/** What an authenticated non-owner caller may reach: its own seat, its rigs' seats, the items they send or own (to read),
 *  the items they own (to change), and its shared roots. A person (<entityId>@external) is never in a non-owner's scope. */
function scopeFor(access: McpAccess, seatOf: () => string | undefined): Scope {
  if (access.external) return externalScope(access, seatOf);
  const rigs = new Set(access.rigs);
  const session = (value: unknown): boolean => {
    if (typeof value !== "string" || !value) return false;
    const seat = seatOf();
    if (seat && (value === seat || value.startsWith(`${seat}@`))) return true;
    const rig = value.split("@")[1];
    return rig !== undefined && rig !== "external" && rigs.has(rig);
  };
  const item = (row: unknown): boolean => {
    const fields = (row ?? {}) as { sourceSession?: unknown; destinationSession?: unknown };
    return session(fields.sourceSession) || session(fields.destinationSession);
  };
  return {
    session,
    item,
    // The daemon's update has no owner check, so changing a row needs its owner in scope: a row a team seat handed to
    // another team, or a person's pending ask, stays readable and isn't the sender's to close or settle.
    owner: (row) => session(((row ?? {}) as { destinationSession?: unknown }).destinationSession),
    rig: (name) => typeof name === "string" && rigs.has(name),
    root: (name) => typeof name === "string" && access.roots.includes(name),
    destination: session,
    successor: session,
    artifact: item,
    paths: true,
    ownListsOnly: false,
  };
}

/** The grant service names an external caller's seat cus-<id>-caller@<rig>. v1 marks no seat as a caller, so an item
 *  from a seat of this shape is never the team's question to an external caller, and an external caller can't hand a
 *  task to one. The shape never grants anything. */
const CALLER_SHAPED = /^cus-.+-caller@[^@]+$/;

/** OpenRig's own tags that decide what a person asked about a row sees of its body: what Slack ingestion records about where
 *  the row came from and which parts of its body OpenRig wrote (the sender's channel, the attachments block, the body's
 *  digest), and `gate`, which with `workflow` marks a workflow's internal sign-off so the person's post shows its summary in
 *  place of the body. An external caller's create can't claim them; its other tags (`workflow` and
 *  `workflow:`/`instance:` among them) are kept. */
const OPENRIG_PROVENANCE_TAG = /^(?:founder-slack|inbound|shared-channel|gate)$|^participant:|^slack-/;

/** An external grant (openrig.grant/v1): a requester, narrower than a work grant. The grant's own seat is the
 *  only caller. It may hand tasks to its rigs' team seats (never a caller-shaped seat, a person or another host's
 *  seat), read the items it sent and the team's questions to it (never team-internal or another caller's items), follow
 *  a handed-on item only where it came back to it, and read the artifacts of its own items under its named roots. */
function externalScope(access: McpAccess, seatOf: () => string | undefined): Scope {
  const rigs = new Set(access.rigs);
  const caller = (value: unknown): boolean => typeof value === "string" && value !== "" && value === seatOf();
  // A seat of one of its rigs on this instance: member@rig, never a person or another host's seat.
  const member = (value: unknown): boolean => {
    if (typeof value !== "string") return false;
    const parts = value.split("@");
    return parts.length === 2 && parts[0] !== "" && parts[1] !== "external" && rigs.has(parts[1]!);
  };
  const team = (value: unknown): boolean => member(value) && !caller(value) && !CALLER_SHAPED.test(value as string);
  const field = (row: unknown, name: "sourceSession" | "destinationSession"): unknown => ((row ?? {}) as Record<string, unknown>)[name];
  const item = (row: unknown): boolean => caller(field(row, "sourceSession"))
    || (caller(field(row, "destinationSession")) && team(field(row, "sourceSession")));
  return {
    session: (value) => caller(value) || team(value),
    item,
    owner: () => false,
    rig: (name) => typeof name === "string" && rigs.has(name),
    root: (name) => typeof name === "string" && access.roots.includes(name),
    // A task goes to the team: never to the caller itself or to another caller-shaped seat, which v1 can't tell apart.
    destination: team,
    successor: caller,
    artifact: (row) => caller(field(row, "sourceSession")),
    paths: false,
    ownListsOnly: true,
    shows: caller,
    names: (seat) => caller(seat) || team(seat),
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
 *  destination is. An external grant (`external`) is narrower: see externalScope. */
export type McpAccess = {
  principal: string; owner: boolean; rigs: readonly string[]; roots: readonly string[]; workspace: boolean;
  /** An external caller's grant: the object/action pairs it names (openrig.grant/v1 `objects`). */
  external?: { objects: Readonly<Record<string, readonly string[]>> };
};

/** The tool each external object/action pair offers. A pair not listed here offers nothing. */
const EXTERNAL_TOOLS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  queue: { create: "rig_queue_create", show: "rig_queue_show", list: "rig_queue_list" },
  artifact: { read: "rig_artifact_read" },
};

function externalTools(objects: Readonly<Record<string, readonly string[]>>): Set<string> {
  const tools = new Set<string>();
  for (const [object, actions] of Object.entries(objects)) {
    for (const action of Array.isArray(actions) ? actions : []) {
      const tool = Object.hasOwn(EXTERNAL_TOOLS, object) && Object.hasOwn(EXTERNAL_TOOLS[object]!, action) ? EXTERNAL_TOOLS[object]![action] : undefined;
      if (tool) tools.add(tool);
    }
  }
  return tools;
}

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
  { tool: "rig_team", routes: ["GET /api/rigs/:rigId", "GET /api/rigs/:rigId/nodes", "GET /healthz"], effect: "read", access: "work" },
  { tool: "rig_slices", routes: ["GET /api/slices"], effect: "read", access: "workspace" },
  { tool: "rig_mission", routes: ["GET /api/missions/:missionId"], effect: "read", access: "workspace" },
  { tool: "rig_context_pack", routes: ["GET /api/context-packs/library/by-ref"], effect: "read", access: "workspace" },
  { tool: "rig_context_get", routes: ["GET /api/context-packs/library/resolve-address"], effect: "read", access: "workspace" },
  { tool: "rig_artifact_read", routes: ["GET /api/queue/:qitemId", "GET /api/files/roots", "GET /api/files/read"], effect: "read", access: "work" },
  { tool: "rig_human_decision_room", routes: ["GET /api/queue/:qitemId", "GET /api/gateway/human/:entityId/decision-room"], effect: "read", access: "work" },
  { tool: "rig_queue_decide", routes: ["POST /api/queue/:qitemId/delegated-decision"], effect: "destructive", access: "work" },
  { tool: "rig_queue_handoff", routes: ["POST /api/queue/:qitemId/handoff"], effect: "destructive", access: "work" },
  { tool: "rig_queue_unclaim", routes: ["POST /api/queue/:qitemId/unclaim"], effect: "destructive", access: "work" },
];

/** How a member works its inbox, and asks a person while keeping the work: one versioned text, carried in this server's
 *  instructions and quoted in docs/reference/hosted-members.md. Change it here, bump the version, and update the quote. */
export const MEMBER_WORKFLOW_VERSION = "member-workflow/v2";
/** What the connection itself authorizes. */
const MEMBER_AUTHORITY = "If the person connected you, that's basically authorized: claim the items in your inbox and do them without asking whether you may.";
export const MEMBER_WORKFLOW = [
  `Member workflow (${MEMBER_WORKFLOW_VERSION}). Your inbox is the items addressed to your seat: rig_queue_list with owned set. It's yours, not the team's queue. A wake, a ring or a message only points at it: list your inbox, then act.`,
  "For each item: claim it (rig_queue_claim), do it, then close it done with closure reason no-follow-on and the answer in resolution (rig_queue_update), or hand it on (rig_queue_handoff). Listing or reading an item doesn't take it.",
  "Say what you can reach from your grant, not from the tool list: a listed tool isn't access. rig_artifact_read's answer for an item names the shared roots you may read, and none means no shared files.",
  MEMBER_AUTHORITY,
  "When an item needs a person's approval before you can finish it, don't close it and don't take the action: keep the item and ask.",
  "If it came from a person (an address ending in @external that isn't a shared channel; the item's 'Shared channel:' line names one), set it blocked with blockedOn that person and, as its summary, the question with a short form of what you'll do: the person sees the summary and the item, not your note, which keeps the record. Link a longer draft as an https evidenceRef. Their answer returns the item to you in progress.",
  "Otherwise ask as a new item, to the seat it came from or, for a shared channel's item, to your rig's lead (rig_team shows it), with your question and draft. Then set yours blocked with blockedOn that new qitemId: when that item closes, yours returns to pending, to claim again.",
  "Nothing promises to wake you, so check your inbox again. Then finish the same item; don't open a new one.",
].join(" ");

// Short guidance a client may show the model (the server's MCP instructions). An external caller's connection asks the
// team for work and isn't one of its members, so it isn't given the member workflow.
const SHARED_INSTRUCTIONS = [
  "This server reaches an OpenRig team as one seat: the one named by OPENRIG_SESSION_NAME where the server was configured, or, over authenticated HTTP, the seat of the caller's grant (rig_whoami shows which, and whether the caller is authenticated; rig_team shows a rig's seats and its lead). The daemon attributes this server's writes to that seat.",
  "To hand work to a seat, use rig_queue_create and keep its qitemId; read the answer later with rig_queue_show, which names the next item when the work was handed on. To pass on work this seat holds, use rig_queue_handoff rather than closing it and creating another, so the work stays one chain. Queue items are durable: they outlive this conversation and this server.",
  "Tools marked read-only change nothing. A seat whose activity is unknown is not idle, and an accepted request (a restore's attemptId) is not a finished one.",
  "A question reserved for a person is theirs to answer: don't answer it on their behalf. rig_queue_decide records a decision only inside the decision room of the mode they have on, beside their answers and never as one.",
];
const INSTRUCTIONS = [...SHARED_INSTRUCTIONS, MEMBER_WORKFLOW].join("\n");
const EXTERNAL_INSTRUCTIONS = SHARED_INSTRUCTIONS.join("\n");

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
export function createMcpServer(client: DaemonClient, options: { seat?: string; access?: McpAccess; rostersFolder?: () => string; presenceFile?: () => string } = {}): McpServer {
  const server = new McpServer({
    name: "openrig",
    version: CLI_VERSION,
  }, { instructions: options.access?.external ? EXTERNAL_INSTRUCTIONS : INSTRUCTIONS });
  const { access } = options;
  const rostersFolder = options.rostersFolder ?? (() => nodePath.join(new ConfigStore().get("workspace.root") as string, "rosters"));
  const presenceFile = options.presenceFile ?? (() => mcpPresenceFilePath());
  // The seat this server acts as: the authenticated caller's, else OPENRIG_SESSION_NAME where it was configured.
  const seatOf = (): string | undefined => options.seat ?? readOpenRigEnv("OPENRIG_SESSION_NAME", "RIGGED_SESSION_NAME")?.trim();
  const accessClass = new Map(MCP_OPERATIONS.map((op) => [op.tool, op.access]));
  // A local caller (no access) is offered every tool; an authenticated one, its class's; an external caller, its
  // grant's pairs.
  const external = access?.external ? externalTools(access.external.objects) : null;
  const offered = (tool: string): boolean => {
    if (external) return external.has(tool);
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
  if (offered("rig_up")) server.registerTool(
    "rig_up",
    {
      description: "Launch a rig from a rig spec (.yaml), a .rigbundle or a .rigtopology, or restore an existing rig by its name from its latest snapshot",
      inputSchema: z.object({
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
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_down")) server.registerTool(
    "rig_down",
    {
      description: "Tear down a rig",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier to tear down"),
        delete: z.boolean().optional().describe("Delete rig record after stopping"),
        force: z.boolean().optional().describe("Kill sessions immediately"),
        snapshot: z.boolean().optional().describe("Take snapshot before teardown"),
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_ps")) server.registerTool(
    "rig_ps",
    {
      description: "List rigs and their status",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_status")) server.registerTool(
    "rig_status",
    {
      description: "Check daemon health",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_snapshot_create")) server.registerTool(
    "rig_snapshot_create",
    {
      description: "Create a snapshot for a rig",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
      }),
      annotations: ADDITIVE,
    },
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
  if (offered("rig_snapshot_list")) server.registerTool(
    "rig_snapshot_list",
    {
      description: "List snapshots for a rig",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_restore")) server.registerTool(
    "rig_restore",
    {
      description: "Start restoring a rig from a snapshot. It answers at once with an attemptId while the restore runs in the background; follow the attempt with rig_restore_status.",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
        snapshotId: z.string().describe("Snapshot identifier"),
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_restore_status")) server.registerTool(
    "rig_restore_status",
    {
      description: "Read where a restore attempt stands: the receipt for the attemptId rig_restore returned. An attempt with no completion yet (still running, or stopped before it finished) answers attempt_incomplete; it isn't a receipt.",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
        attemptId: z.number().int().positive().describe("The attemptId rig_restore returned"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_discover")) server.registerTool(
    "rig_discover",
    {
      description: "Scan for tmux sessions to discover",
      inputSchema: z.object({}),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_bind")) server.registerTool(
    "rig_bind",
    {
      description: "Bind a discovered session to an existing node or create a new node in a pod",
      inputSchema: z.object({
        discoveryId: z.string().describe("Discovery session identifier"),
        rigId: z.string().describe("Target rig name or identifier"),
        logicalId: z.string().optional().describe("Existing node logical ID (mode: bind to existing)"),
        podNamespace: z.string().optional().describe("Pod namespace to create node in (mode: create in pod)"),
        memberName: z.string().optional().describe("Member name for new node (required with podNamespace)"),
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_bundle_inspect")) server.registerTool(
    "rig_bundle_inspect",
    {
      description: "Inspect a .rigbundle file",
      inputSchema: z.object({
        bundlePath: z.string().describe("Path to .rigbundle file"),
      }),
      annotations: READ_ONLY,
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
        }, { structuralCode: "bundle_integrity_failed" });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 11. rig_agent_validate — validate an AgentSpec
  if (offered("rig_agent_validate")) server.registerTool(
    "rig_agent_validate",
    {
      description: "Validate an AgentSpec (agent.yaml) from YAML text",
      inputSchema: z.object({
        yaml: z.string().describe("YAML text of the agent spec"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_rig_validate")) server.registerTool(
    "rig_rig_validate",
    {
      description: "Validate a RigSpec (rig.yaml) from YAML text",
      inputSchema: z.object({
        yaml: z.string().describe("YAML text of the rig spec"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_rig_nodes")) server.registerTool(
    "rig_rig_nodes",
    {
      description: "Get node inventory for a rig — session names, status, attach commands, resume commands",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_send")) server.registerTool(
    "rig_send",
    {
      description: "Send a message to an agent's terminal using reliable two-step send",
      inputSchema: z.object({
        session: z.string().describe("Target session name (e.g. dev-impl@my-rig)"),
        text: z.string().describe("Message text to send"),
        verify: z.boolean().optional().describe("Verify delivery by checking pane content"),
        force: z.boolean().optional().describe("Send even if target appears mid-task"),
        waitForIdleSeconds: z.number().positive().optional().describe("Wait until explicit idle evidence before sending. If the seat is still busy or its activity is unknown when the wait ends, nothing is sent and nothing is kept; separate work belongs in a queue row"),
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_capture")) server.registerTool(
    "rig_capture",
    {
      description: "Capture terminal output from an agent session",
      inputSchema: z.object({
        session: z.string().optional().describe("Session name (omit for multi-target with rig/pod)"),
        rig: z.string().optional().describe("Capture all sessions in a rig"),
        pod: z.string().optional().describe("Capture all sessions in a pod"),
        lines: z.number().optional().describe("Number of lines to capture (default: 20)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_chatroom_send")) server.registerTool(
    "rig_chatroom_send",
    {
      description: "Send a message to a rig's chatroom as this server's seat",
      inputSchema: z.object({
        rigName: z.string().describe("Rig name or identifier"),
        body: z.string().describe("Message body"),
      }),
      annotations: ADDITIVE,
    },
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
  if (offered("rig_chatroom_watch")) server.registerTool(
    "rig_chatroom_watch",
    {
      description: "Read a rig's recent chatroom messages: the most recent ones (default 20), oldest first, optionally one topic's or one sender's. It returns what is there now and doesn't wait for new messages.",
      inputSchema: z.object({
        rigName: z.string().describe("Rig name or identifier"),
        topic: z.string().optional().describe("Only messages in this topic"),
        sender: z.string().optional().describe("Only messages from this seat"),
        limit: z.number().int().positive().optional().describe("How many recent messages (default 20)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_add")) server.registerTool(
    "rig_add",
    {
      description: "Add a single member to an existing pod in a running rig (the add_member converge op). Identity-migration-free: mints a fresh seat, nothing existing re-keys.",
      inputSchema: z.object({
        rigId: z.string().describe("Target rig name or identifier"),
        podNamespace: z.string().describe("Namespace of the existing pod to add the member to"),
        member: z.record(z.string(), z.unknown()).describe("Member fragment with spec snake_case fields: id, runtime, agent_ref, profile, cwd (and optional model, codex_config_profile, restore_policy, label)"),
        edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.string() })).optional().describe("Optional pod-local edges (from/to are member ids within the pod; resolved against the new member + existing pod-mates)"),
        rigRoot: z.string().optional().describe("Root directory for agent resolution"),
      }),
      annotations: ADDITIVE,
    },
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
  if (offered("rig_queue_create")) server.registerTool(
    "rig_queue_create",
    {
      description: "Hand a task to another seat as a durable queue item. Returns its qitemId: read the answer later with rig_queue_show. If the call times out, check rig_queue_show with the same qitemId before retrying; never retry with a new id. To ask for a revision of earlier work, name it in revises: the new item opens with 'Revision of <id>' and records it in its chainOfRecord.",
      inputSchema: z.object({
        destination: z.string().describe("Destination seat (e.g. dev-impl@my-rig)"),
        body: z.string().describe("The task: what to do and what to return"),
        summary: z.string().optional().describe("One-line summary"),
        tags: z.array(z.string()).optional().describe("Tags, e.g. mission:<name>"),
        priority: z.string().optional().describe("Priority (as rig queue create --priority)"),
        tier: z.string().optional().describe("Tier (as rig queue create --tier)"),
        qitemId: z.string().optional().describe("Request id to reuse when retrying the same create (default: a new id)"),
        revises: z.string().optional().describe("The qitemId of the work this asks to revise"),
        alert: z.boolean().optional().describe("For an ask to a person that's urgent: something only they can do, or an approval whose wait costs now (as rig queue create --alert). It stands out in Slack. Without it the ask still posts to Slack unless the person's Slack subscription is urgent-only, in which case it waits on Steering and the TUI"),
      }),
      annotations: ADDITIVE,
    },
    async ({ destination, body, summary, tags, priority, tier, qitemId, revises, alert }) => {
      if (scope && !scope.destination(destination)) return outOfScope(`Destination ${destination}`);
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
          qitemId: id, destinationSession: destination, body: lineage?.body ?? body, summary, priority, tier,
          tags: access?.external ? tags?.filter((tag) => !OPENRIG_PROVENANCE_TAG.test(tag)) : tags,
          ...(alert ? { humanAlert: true } : {}),
          ...(lineage ? { chainOfRecord: lineage.chainOfRecord } : {}),
        });
        // An external caller reusing the id of an item it can't see learns only that the id is taken, never that item's
        // parties.
        const conflict = (res.data ?? {}) as { error?: unknown; existingSource?: unknown; existingDestination?: unknown };
        if (scope?.shows && res.status === 409 && conflict.error === "qitem_id_reuse"
          && !scope.item({ sourceSession: conflict.existingSource, destinationSession: conflict.existingDestination })) {
          return mapResult({ status: 409, data: { error: "qitem_id_reuse", message: `qitemId ${id} is already taken. Retry with a new one.` } }, undefined, { structured: true });
        }
        // A create's return, a retry's stored row included, goes through the same external projection as show and list.
        const view = externalView(scope);
        return mapResult(view && res.status < 400 ? { ...res, data: projectForExternal(res.data, view) } : res, undefined, { structured: true });
      } catch (err) {
        const failure = caught(err);
        const text = `${(err as Error).message} The outcome is unknown: check rig_queue_show with qitemId ${id} before retrying, and retry only with that same qitemId.`;
        return { ...failure, content: [{ type: "text", text }], structuredContent: { ...failure.structuredContent, qitemId: id, outcome: "unknown" } };
      }
    },
  );

  // 20. rig_queue_show — one item with its transitions: a delegated task's answer is its own record
  if (offered("rig_queue_show")) server.registerTool(
    "rig_queue_show",
    {
      description: "Read one queue item and its transitions. For a task you handed off, this is where its answer is: the state, the closure reason and target, the notes the assignee recorded, and evidenceRef when it names an artifact (read it with rig_artifact_read). When the item was handed on, successor names the next item (on another host: its id and host); follow it with rig_queue_show. null means none was found. A revision names the work it revises in chainOfRecord.",
      inputSchema: z.object({
        qitemId: z.string().describe("The qitemId returned by rig_queue_create (or any queue item)"),
      }),
      annotations: READ_ONLY,
    },
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
        const view = externalView(scope);
        let successor = handedOn ? await successorOf(client, qitemId, row.closureTarget, view ? scope!.item : undefined) : undefined;
        if (scope && !view && successor && "destinationSession" in successor && !scope.successor(successor.destinationSession)) successor = { unknown: true, code: "out_of_scope" };
        const data = view
          ? { item: projectForExternal(item.data, view), transitions: Array.isArray(transitions.data) ? transitions.data.map((t) => projectForExternal(t, view)) : transitions.data }
          : { item: item.data, transitions: transitions.data };
        return mapResult({ status: 200, data: { ...data, ...(handedOn ? { successor } : {}) } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 21. rig_queue_list — list queue items
  if (offered("rig_queue_list")) server.registerTool(
    "rig_queue_list",
    {
      description: "List queue items. owned: assigned to this seat. mine: this seat is the source or the destination. Without a scope, this seat's rig. Without state, open items only (all adds closed ones); a state filter returns exactly those states, closed ones included. since finds work updated after a time; handedOffFrom finds where a handed-off item went.",
      inputSchema: z.object({
        owned: z.boolean().optional().describe("Only items assigned to this seat: its whole inbox (overrides destination)"),
        mine: z.boolean().optional().describe("Items this seat sent or owns"),
        destination: z.string().optional().describe("Filter by destination seat"),
        source: z.string().optional().describe("Filter by source seat"),
        state: z.string().optional().describe("Only these states, comma-separated; closed states included when named"),
        all: z.boolean().optional().describe("Without state: include closed items"),
        since: z.string().optional().describe("Only items updated at or after this ISO-8601 time, e.g. done work since Monday: state done, since 2026-10-19"),
        handedOffFrom: z.string().optional().describe("The items handed on from this qitemId, in any state and any rig"),
        limit: z.number().int().positive().optional().describe("Result limit (default 100)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ owned, mine: mineAsked, destination, source, state, all, since, handedOffFrom, limit }) => {
      try {
        const params = new URLSearchParams();
        const sessionName = seatOf();
        // An external caller lists its own items only, so the daemon's limit counts those and not the team's.
        const mine = mineAsked || (scope?.ownListsOnly === true && !owned);
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
        if (scope && res.status < 400 && Array.isArray(res.data)) {
          const view = externalView(scope);
          const rows = res.data.filter((row) => scope.item(row));
          return mapResult({ ...res, data: view ? rows.map((row) => projectForExternal(row, view)) : rows }, undefined, { structured: true });
        }
        return mapResult(res, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 22. rig_queue_claim — take an item assigned to this seat
  if (offered("rig_queue_claim")) server.registerTool(
    "rig_queue_claim",
    {
      description: "Claim a queue item assigned to this seat before working on it.",
      inputSchema: z.object({ qitemId: z.string().describe("The queue item to claim") }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_queue_update")) server.registerTool(
    "rig_queue_update",
    {
      description: "Update a queue item: add a note, block it, close it, or reopen a closed one. To answer a task, close it with state done, a closure reason and the answer in resolution, which the item keeps; note records why this transition happened.",
      inputSchema: z.object({
        qitemId: z.string().describe("The queue item to update"),
        state: z.string().optional().describe("New state (e.g. in-progress, blocked, done)"),
        closureReason: z.string().optional().describe("Why it closed: no-follow-on for finished work, or handed_off_to, denied, canceled, escalation or superseded (as rig queue update --closure-reason)"),
        closureTarget: z.string().optional().describe("Closure target, when the reason needs one"),
        note: z.string().optional().describe("Transition note: progress, or why this transition happened (required to reopen)"),
        resolution: z.string().optional().describe("The outcome the item keeps, stored only by the update that closes an open item (as rig queue update --resolution)"),
        reopen: z.boolean().optional().describe("Reopen a closed item: give an active state (pending, in-progress or blocked) and a note (as rig queue update --reopen)"),
        summary: z.string().optional().describe("Replace the one-line summary"),
        evidenceRef: z.string().optional().describe("Pointer to the durable artifact, stored on the item when closing with state done or parking on a human seat; other updates refuse it"),
        blockedOn: z.string().optional().describe("What it waits on, when blocking: another qitemId (this item returns to pending when that one closes), or the address of the person this item came from, not a shared channel (they're asked with this item's summary, and their answer returns it to you in progress)"),
        wakeAfterSeconds: z.number().int().positive().optional().describe("Wake this seat after this many seconds, when blocking. Delivered only to a seat with a terminal: an attached app can't receive it today, so the item just waits until it is checked."),
      }),
      annotations: DESTRUCTIVE,
    },
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
  if (offered("rig_telemetry_events")) server.registerTool(
    "rig_telemetry_events",
    {
      description: "Read one bounded page of event metadata: seq, rig, node, type and time, never payloads. Without a cursor it starts at the newest event and returns no rows; start retained reads the retained past instead. Continue with page.nextCursor and the same filters. coverage.gaps names any history it could not read, including a daemon restart, after which the old cursor can't continue.",
      inputSchema: z.object({
        cursor: z.string().optional().describe("page.nextCursor from the previous page; not with start"),
        start: z.enum(["latest", "retained"]).optional().describe("Without a cursor: latest (default) or retained"),
        rigId: z.string().optional().describe("Rig name or identifier; events with no rig are left out"),
        nodeId: z.string().optional().describe("Node identifier"),
        limit: z.number().int().min(1).max(128).optional().describe("Source rows to scan (default and maximum 128); a filter can return fewer"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_whoami")) server.registerTool(
    "rig_whoami",
    {
      description: "Show which OpenRig seat this server acts as: its rig, pod, peers and edges, and caller: authenticated (a validated HTTP credential, with its principal) or declared (OPENRIG_SESSION_NAME where the server was configured, which nothing verifies).",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
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
        // whoami knows a seat by its session. A hosted member (a tool outside any terminal) has none: the seat is its
        // grant's, so the authenticated caller is answered with that seat. Read only.
        if (res.status === 404 && access && !access.external && options.seat === seat) {
          const at = seat.indexOf("@");
          const member = { ok: true, seat, rig: at >= 0 ? seat.slice(at + 1) : null, session: null, caller,
            message: "This seat has no session here: it's the seat this connection's grant names, such as a hosted member's. rig_team shows its rig and hosted members, and rig_queue_list with owned set lists its work." };
          return { content: [{ type: "text" as const, text: JSON.stringify(member) }], structuredContent: member };
        }
        if (res.status >= 400) return mapResult(res);
        return mapResult({ ...res, data: { ...(res.data as Record<string, unknown>), caller } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 27. rig_team — a rig's seats and its lead
  if (offered("rig_team")) server.registerTool(
    "rig_team",
    {
      description: "Show a rig's team: its lead, the rig's one delegates_to root (the seat that delegates to others and that nothing delegates to: the seat to delegate to), and each seat's pod, role, runtime, delegation (reportsTo, delegatesTo) and activity as the daemon reports it. Activity the daemon doesn't know reads unknown, never idle. hostedMembers are the rig's members that live outside a terminal (roster entries marked hosted): their authored capabilities and limits, with no pane and activity unknown.",
      inputSchema: z.object({
        rigId: z.string().describe("Rig name or identifier"),
      }),
      annotations: READ_ONLY,
    },
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
        const view = teamView((detail.data ?? {}) as RigDetail, nodes.data);
        const rigName = ((detail.data ?? {}) as RigDetail).rig?.name ?? "";
        const inventory = Array.isArray(nodes.data) ? nodes.data as Array<{ logicalId?: string; canonicalSessionName?: string | null; hostSelfId?: string | null }> : [];
        // A node is a seat whether or not it has a session yet: its address derives from its logical id (pod.member).
        const nodeSeats = new Set(inventory.flatMap((seat) => [seat.canonicalSessionName,
          typeof seat.logicalId === "string" ? `${seat.logicalId.replace(".", "-")}@${rigName}` : null]).filter((name): name is string => typeof name === "string"));
        const hosted = await hostedMembersOf(rostersFolder(), rigName, nodeSeats,
          async () => inventory.find((seat) => typeof seat.hostSelfId === "string")?.hostSelfId
            ?? await client.get("/healthz").then((res) => (res.status < 400 ? ((res.data ?? {}) as { selfHostId?: string }).selfHostId ?? null : null), () => null),
          async (seat) => {
            const rows = await client.get(`/api/queue/list?${new URLSearchParams({ destinationSession: seat, compact: "1", limit: String(PRESENCE_ROWS) }).toString()}`)
              .then((res) => (res.status < 400 ? res.data : null), () => null);
            return { lastCallAt: readPresence(presenceFile())[seat]?.lastCallAt ?? null, lastWake: newestWake(rows, seat),
              lastWakeScope: `the latest ring among its ${PRESENCE_ROWS} most recent rows` };
          });
        return mapResult({ status: 200, data: { ...view, hostedMembers: hosted.members, ...(hosted.note ? { hostedMembersNote: hosted.note } : {}) } }, undefined, { structured: true });
      } catch (err) {
        return caught(err);
      }
    },
  );

  // 28. rig_slices — the work tree's slices, as summaries
  if (offered("rig_slices")) server.registerTool(
    "rig_slices",
    {
      description: "List the work tree's slices, most recently active first: name, mission, status, description and how many queue items name it. Paths and readiness detail are left out.",
      inputSchema: z.object({
        missionId: z.string().optional().describe("Only this mission's slices"),
        filter: z.enum(["all", "active", "done", "blocked"]).optional().describe("Only slices with this status (default all)"),
        limit: z.number().int().positive().max(200).optional().describe("Most slices to return (default 50)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_mission")) server.registerTool(
    "rig_mission",
    {
      description: "Read one mission: its status and its slices as summaries.",
      inputSchema: z.object({
        missionId: z.string().describe("The mission's id (its folder name)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_context_pack")) server.registerTool(
    "rig_context_pack",
    {
      description: "Show one context pack: its purpose and the files it declares (path, role, summary, estimated tokens), so a file can be read with rig_context_get as <pack>/<file>.",
      inputSchema: z.object({
        ref: z.string().describe("The pack's ref, as rig context list shows it (e.g. project-world)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_context_get")) server.registerTool(
    "rig_context_get",
    {
      description: `Read one context file or one section of it, as rig context get does: <pack>/<file>, or <pack>/<file>#<h2-slug>[/<h3-slug>]. Text over ${CONTEXT_TEXT_LIMIT} characters is cut (truncated: true); address a section to read the rest.`,
      inputSchema: z.object({
        address: z.string().describe("<pack>/<file>[#<h2-slug>[/<h3-slug>]]"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_artifact_read")) server.registerTool(
    "rig_artifact_read",
    {
      description: `Read a finished item's artifact (its evidenceRef), or a named file, through the daemon's shared roots (OPENRIG_FILES_ALLOWLIST), as text: at most ${CONTEXT_TEXT_LIMIT} characters from offset; nextOffset reads on. An artifact outside every shared root, a link, or an item with no evidenceRef comes back as available: false with the reason and the shared roots' names; nothing outside those roots is read.`,
      inputSchema: z.object({
        qitemId: z.string().optional().describe("Read this item's evidenceRef"),
        root: z.string().optional().describe("A shared root's name: with path, the file to read; with qitemId, the root a relative evidenceRef is under"),
        path: z.string().optional().describe("With root: the file's path inside that root"),
        offset: z.number().int().min(0).optional().describe("The character to start from (default 0)"),
      }),
      annotations: READ_ONLY,
    },
    async ({ qitemId, root, path, offset }) => {
      try {
        const read = async (source: string, rootName: string, inside: string): Promise<TextResult> => {
          const res = await client.get(`/api/files/read?${new URLSearchParams({ root: rootName, path: inside }).toString()}`);
          if (res.status >= 400) return mapResult(res);
          return mapResult({ status: 200, data: artifactView(source, (res.data ?? {}) as FileRead, offset ?? 0) }, undefined, { structured: true });
        };
        if (scope && root && !scope.root(root)) return outOfScope(`Root ${root}`);
        if (scope && !scope.paths && !qitemId) return outOfScope("A file named by root and path");
        if (!qitemId) {
          if (root && path) return await read("path", root, path);
          const message = "Name an item (qitemId), or a file (root and path).";
          return errorResult(JSON.stringify({ ok: false, error: message }), "artifact_required", message);
        }
        const item = await client.get(`/api/queue/${encodeURIComponent(qitemId)}`);
        if (item.status >= 400) return mapResult(item);
        if (scope && !scope.artifact(item.data)) return outOfScope(`Item ${qitemId}`);
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
  if (offered("rig_human_decision_room")) server.registerTool(
    "rig_human_decision_room",
    {
      description: "Before deciding a question you asked a person: the decision room of the mode they have on, in their own words (what the team may decide for them meanwhile, and what it may not), or none, with why. You judge whether your decision falls inside it; with none, the question stays theirs to answer.",
      inputSchema: z.object({
        qitemId: z.string().describe("Your pending ask to the person (a queue item addressed to <person>@external)"),
      }),
      annotations: READ_ONLY,
    },
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
  if (offered("rig_queue_decide")) server.registerTool(
    "rig_queue_decide",
    {
      description: "Record a decision you made on a person's behalf, on your own pending ask to them, inside the decision room of the mode they have on: read it first with rig_human_decision_room and pass its applicationId. It's recorded beside their answers, never as one, and the ask closes. The daemon refuses it when they have no room, their mode changed since you read it, the ask is a permission prompt or an approval gate, they've started answering, or another seat asked. This server never answers as the person.",
      inputSchema: z.object({
        qitemId: z.string().describe("Your pending ask to the person"),
        applicationId: z.string().describe("decisionRoom.applicationId from rig_human_decision_room: the room you judged against"),
        choices: z.array(z.object({
          questionId: z.string().optional().describe("The question's id, when the ask has structured questions"),
          chosen: z.string().describe("The option's id; for an ask without questions, the choice in words"),
        })).describe("One choice per structured question; for an ask without questions, one choice without questionId"),
        reason: z.string().describe("Why this choice"),
        reversible: z.boolean().describe("Whether the decision can be undone"),
      }),
      annotations: DESTRUCTIVE,
    },
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

  // 35. rig_queue_handoff — pass an item on to the next seat in one step, the route `rig queue handoff` uses
  if (offered("rig_queue_handoff")) server.registerTool(
    "rig_queue_handoff",
    {
      description: "Pass a queue item this seat holds on to the next seat in one step: the item closes as handed off and a new item opens for that seat, carrying the work's lineage in chainOfRecord, so whoever follows the work reaches the new item from rig_queue_show. Without body the new item keeps the task's text. If the call times out, check rig_queue_show on this qitemId before retrying: when it reads handed off, its successor is the new item, so don't hand it off again.",
      inputSchema: z.object({
        qitemId: z.string().describe("The queue item to pass on"),
        to: z.string().describe("The next seat (e.g. qa@my-rig)"),
        body: z.string().optional().describe("The task as the next seat should read it (default: the item's own text)"),
        note: z.string().optional().describe("Transition note on the item passed on: why it goes there"),
        summary: z.string().optional().describe("One-line summary for the new item"),
        tags: z.array(z.string()).optional().describe("Tags for the new item (default: the item's own)"),
        priority: z.string().optional().describe("Priority for the new item (default: the item's own)"),
        evidenceRef: z.string().optional().describe("Pointer to the durable artifact, which a new item for a person needs"),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ qitemId, to, body, note, summary, tags, priority, evidenceRef }) => {
      if (scope && !scope.session(to)) return outOfScope(`Destination ${to}`);
      try {
        const denied = await itemOutOfScope(qitemId, "owner");
        if (denied) return denied;
      } catch (err) {
        return caught(err);
      }
      try {
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/handoff`, {
          toSession: to, body, transitionNote: note, summary, tags, priority, evidenceRef,
        }), undefined, { structured: true });
      } catch (err) {
        const failure = caught(err);
        const text = `${(err as Error).message} The outcome is unknown: check rig_queue_show with qitemId ${qitemId} before retrying. If it reads handed off, its successor is the new item, so don't hand it off again.`;
        return { ...failure, content: [{ type: "text", text }], structuredContent: { ...failure.structuredContent, qitemId, outcome: "unknown" } };
      }
    },
  );

  // 36. rig_queue_unclaim — put back an item this seat claimed and won't finish
  if (offered("rig_queue_unclaim")) server.registerTool(
    "rig_queue_unclaim",
    {
      description: "Put back a queue item this seat claimed and won't finish: it returns to pending for its destination seat, ready to be claimed again, and the transition records why. Only a claimed (in-progress) item can be put back. To pass the work to another seat instead, use rig_queue_handoff.",
      inputSchema: z.object({
        qitemId: z.string().describe("The claimed queue item to put back"),
        reason: z.string().optional().describe("Why it's put back, recorded as 'unclaimed: <reason>' (default: manual)"),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ qitemId, reason }) => {
      try {
        const denied = await itemOutOfScope(qitemId, "owner");
        if (denied) return denied;
        return mapResult(await client.post(`/api/queue/${encodeURIComponent(qitemId)}/unclaim`, { reason }), undefined, { structured: true });
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
