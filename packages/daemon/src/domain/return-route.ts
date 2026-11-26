// A person's chosen conversation for one goal: the return route a goal row records when it's handed over with
// `rig queue create --return-route`, the successors its handoffs carry it to, and the escalations that deliver to it.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { isHumanSeatSessionRef, parseSessionName } from "./session-name.js";
import { getSelfHostId } from "./hosts/fanout-contract.js";
import { CONVERSATION_KEY_TAG_PREFIX } from "../conversation-key-surface.js";

/** How a row's return route was established:
 *  - `issued`: OpenRig issued it for this create (or earlier, to the conversation this create names by its key), and the
 *    caller's own identity is still the row's source;
 *  - `issued-actor`: OpenRig issued it for a caller with no identity, so it's also the row's declared source (claimed:v1);
 *  - `caller`: the caller's own identity (`self`);
 *  - `named`: an address the caller named;
 *  - `inherited`: the route of the one routed row the creating seat holds (`inheritedReturnRoute`). */
export type ReturnRouteBasis = "issued" | "issued-actor" | "caller" | "named" | "inherited";
export const RETURN_ROUTE_BASES: readonly ReturnRouteBasis[] = ["issued", "issued-actor", "caller", "named", "inherited"];

/** The rig an issued conversation address names: the kernel's, as the rigs skill's agreed addresses do. Nothing is launched
 *  or written for it; the queue takes tasks for any canonical address. */
export const RETURN_ROUTE_RIG = "kernel";

/** The address `--return-route auto` issues for one create. It's derived from the create's own id, so an exact retry (the
 *  CLI's `--id`) and a restarted daemon issue the same address, and two creates never share one, unless they're one
 *  conversation's (`conversationIssuedAddress`). */
export function issuedReturnAddress(qitemId: string): string {
  return `conversation-${createHash("sha256").update(qitemId).digest("hex").slice(0, 12)}@${RETURN_ROUTE_RIG}`;
}

/** A `conversation-key:` tag: the key of a person's own conversation (Claude Code or Codex), which only OpenRig writes,
 *  beside the address it issued that conversation. The routes keep it only from a client on this machine. */
export function isConversationKeyTag(tag: unknown): tag is string {
  return typeof tag === "string" && tag.startsWith(CONVERSATION_KEY_TAG_PREFIX);
}

/** The address OpenRig already issued the conversation a create names by its key (the `conversation-key:` tag that
 *  `rig queue create --return-route auto` and the MCP server's create record beside an issued address): the first one it
 *  was issued. So a conversation keeps one address however often it hands work over with `auto`, and its seats' prompts
 *  and its own wait read one route. Null when the create names no conversation, or several, when that conversation has no
 *  address yet, or when the record can't be read: the create then issues its own. */
export function conversationIssuedAddress(db: Database.Database, tags: unknown): string | null {
  if (!Array.isArray(tags)) return null;
  const keys = [...new Set(tags.filter((tag): tag is string => isConversationKeyTag(tag) && tag.length > CONVERSATION_KEY_TAG_PREFIX.length))];
  if (keys.length !== 1) return null;
  try {
    const row = db.prepare(`SELECT return_route FROM queue_items WHERE return_route_basis IN ('issued', 'issued-actor')
        AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?) ORDER BY ts_created, rowid LIMIT 1`)
      .get(keys[0]) as { return_route: string | null } | undefined;
    const route = row?.return_route ?? null;
    return route && splitRoute(route).host === null && isRouteAddress(route) ? route : null;
  } catch { return null; }
}

/** Every route note starts with this. They're delivery machinery, never someone picking the row up. */
export const RETURN_ROUTE_NOTE_PREFIX = "return-route ";
/** Recorded on the escalation a relay task carries, when an agent at the route claims that task: pickup only. */
export const RELAY_CLAIMED_PREFIX = `${RETURN_ROUTE_NOTE_PREFIX}relay-claimed`;
export const RELAY_TAG = "return-route-relay";
export const RELAY_FOR_PREFIX = "relay-for:";
export const RELAY_KEY_PREFIX = "relay-notification-key:";
/** A prompt alert raised for routed work stuck at a seat's prompt (held by the seat, or waiting on it) names that row. */
export const PROMPT_ROUTED_WORK_PREFIX = "prompt-routed-work:";

/** One relay task per delivery episode: the id comes from the episode's notification key. */
export function relayTaskId(notificationKey: string): string {
  return `qitem-route-relay-${createHash("sha256").update(notificationKey).digest("hex").slice(0, 24)}`;
}

/** Whether a row is this episode's relay task: at the episode's relay id, from OpenRig, and tagged for this escalation and
 *  key. Any other row that happens to hold the id isn't the relay, and it's never treated as one. */
export function isEpisodeRelay(row: { qitemId: string; sourceSession: string; tags?: string[] | null } | null,
  escalationId: string, notificationKey: string, openRigSender: string): boolean {
  if (!row || row.qitemId !== relayTaskId(notificationKey) || row.sourceSession !== openRigSender) return false;
  const tags = row.tags ?? [];
  return tags.includes(RELAY_TAG) && tags.includes(`${RELAY_FOR_PREFIX}${escalationId}`) && tags.includes(`${RELAY_KEY_PREFIX}${notificationKey}`);
}

/** Said on a cross-host create or handoff whose return route couldn't go with it: the work goes, without the route. */
export const RETURN_ROUTE_NOT_CARRIED = "return_route_not_carried";
export const RETURN_ROUTE_NOT_CARRIED_TAG = "return-route-not-carried";
export function routeNotCarriedMessage(route: string): string {
  return `The return route ${route} wasn't carried: this daemon doesn't know its own host id, so the route couldn't say which ` +
    `host the conversation is on. The work went on without it, and its escalations there take that host's usual route.`;
}
/** Said on a create whose named or self return route is a registered person's address: the work goes, without the route. */
export function routeIsPersonMessage(route: string): string {
  return `The return route ${route} wasn't kept: it's a registered person's address, and a person is reached through the ` +
    `gateway, not a return route. The work went on without it, and its escalations take this host's usual route. For a ` +
    `return route, use auto or an agent conversation's address.`;
}

/** What kind of prompt a seat's activity reports: a choice (a selection menu, such as a usage-limit dialog), a permission
 *  prompt, or a kind it doesn't say. Read from the reason the activity already records; nothing new is probed. */
export type PromptKind = "choice" | "permission" | "unknown";
export function promptKindFromReason(reason: string | null | undefined): PromptKind {
  return reason === "selection_prompt" ? "choice" : reason === "permission_prompt" ? "permission" : "unknown";
}

/** A route's address, and the host it names when it was carried from another host (`member@rig@host`). */
export function splitRoute(route: string): { address: string; host: string | null } {
  const parts = route.split("@");
  return parts.length === 3 ? { address: `${parts[0]}@${parts[1]}`, host: parts[2]! } : { address: route, host: null };
}

/** A route's address when the conversation is on this host; null when it names another host, which this daemon doesn't
 *  deliver to. */
export function routeOnThisHost(route: string): string | null {
  const { address, host } = splitRoute(route);
  return host === null || host === getSelfHostId() ? address : null;
}

/** An agent conversation's queue address (member@rig, or member@rig@host carried from another host). A person's address
 *  isn't one: a person is reached through the gateway. */
export function isRouteAddress(value: string): boolean {
  if (value !== value.trim() || /\s/.test(value)) return false;
  const parts = value.split("@");
  if (parts.length === 3 && !parts[2]) return false;
  if (parts.length < 2 || parts.length > 3) return false;
  const { address } = splitRoute(value);
  return parseSessionName(address).kind === "canonical" && !isHumanSeatSessionRef(address);
}

export type RouteResolution =
  | { kind: "route"; route: string; anchors: string[] }
  | { kind: "conflict"; routes: string[]; anchors: string[] }
  | { kind: "none" };

/** The route for work a seat creates without naming one: the route of the one routed row it holds (open, addressed to it),
 *  so a goal's work keeps reaching the person's conversation when the seat gives it out as a new row rather than handing the
 *  goal on. Two distinct routes are a conflict and give none, as the resolver below treats them. A row addressed to the
 *  route itself (a question to that conversation, on this host) gets none, so its own escalation can't relay back to it; a
 *  route naming another host is kept as stored, even when its address matches a local one. */
export function inheritedReturnRoute(db: Database.Database, holder: string, destination: string): string | null {
  try {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('queue_items') WHERE name = 'return_route'").get()) return null;
    const routes = db.prepare(`SELECT DISTINCT return_route FROM queue_items WHERE destination_session = ?
        AND state IN ('pending','in-progress','blocked') AND return_route IS NOT NULL`).all(holder) as Array<{ return_route: string }>;
    if (routes.length !== 1) return null;
    const route = routes[0]!.return_route;
    const local = routeOnThisHost(route);
    return local !== null && local === (routeOnThisHost(destination) ?? destination) ? null : route;
  } catch { return null; }
}

/** The open rows blocked on one row that carry a route: the work that waits on it. */
const WAITERS_SQL = "SELECT qitem_id, return_route FROM queue_items WHERE blocked_on = ? AND state = 'blocked' AND return_route IS NOT NULL";

/** The return route an escalation reaches through its actual work. It reads the rows the escalation concerns (itself, the rows
 *  its `recovery-for:` tags carry, and routed work stuck at the prompted seat), each by its own route or else by the routed
 *  rows blocked on it. No other row is read, so two conversations on one team stay distinct whatever else is open. Several
 *  distinct routes are a conflict, never a choice. */
export function resolveEscalationReturnRoute(db: Database.Database, row: { qitemId: string; tags?: string[] | null }): RouteResolution {
  try {
    if (!db.prepare("SELECT 1 FROM pragma_table_info('queue_items') WHERE name = 'return_route'").get()) return { kind: "none" };
  } catch { return { kind: "none" }; }
  const concerned = [row.qitemId];
  for (const tag of row.tags ?? []) {
    if (typeof tag !== "string") continue;
    if (tag.startsWith("recovery-for:")) concerned.push(tag.slice("recovery-for:".length));
    if (tag.startsWith(PROMPT_ROUTED_WORK_PREFIX)) concerned.push(tag.slice(PROMPT_ROUTED_WORK_PREFIX.length));
  }
  const own = db.prepare("SELECT return_route FROM queue_items WHERE qitem_id = ?");
  const waiters = db.prepare(WAITERS_SQL);
  const routes = new Map<string, string[]>();
  const add = (route: string, anchor: string) => {
    if (!routes.has(route)) routes.set(route, []);
    if (!routes.get(route)!.includes(anchor)) routes.get(route)!.push(anchor);
  };
  for (const id of [...new Set(concerned)]) {
    const route = (own.get(id) as { return_route: string | null } | undefined)?.return_route;
    if (route) { add(route, id); continue; }
    for (const waiter of waiters.all(id) as Array<{ qitem_id: string; return_route: string }>) add(waiter.return_route, waiter.qitem_id);
  }
  if (routes.size === 0) return { kind: "none" };
  const anchors = [...new Set([...routes.values()].flat())];
  if (routes.size > 1) return { kind: "conflict", routes: [...routes.keys()].sort(), anchors };
  return { kind: "route", route: [...routes.keys()][0]!, anchors };
}
