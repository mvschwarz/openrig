// The connector's view of a remote hub: the queue tools an external grant offers its participant (list its own items,
// claim, show, update, create, and the team it may address), reached over MCP's Streamable HTTP with that participant's
// bearer. Nothing here decides what to do with an item; it only says what the hub answered, and sorts a failure into
// what the caller must do about it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface HubItem {
  qitemId: string;
  sourceSession: string;
  destinationSession: string;
  state: string;
  body?: string | null;
  summary?: string | null;
  resolution?: string | null;
  closureReason?: string | null;
  /** For an item handed on there: the next item, when the hub names one this participant can read on the hub itself. */
  successor?: string | null;
}

/** The hub's own answer to rig_team, passed through: the seats and members this participant may address. */
export type HubTeam = Record<string, unknown>;

/** `revoked`: the hub refused the credential (401), so the binding ends. `unavailable`: the hub or its grant authority
 *  couldn't answer, or the connection failed, so try later. `refused`: the hub answered this one call with an error. */
export type HubErrorKind = "revoked" | "unavailable" | "refused";

export class HubError extends Error {
  /** `code`: the hub's own error code, when it gave one (destination_not_found, out_of_scope, qitem_id_reuse). */
  constructor(readonly kind: HubErrorKind, message: string, readonly code?: string) {
    super(message);
  }
}

export interface HubSession {
  listOwned(state: "pending" | "in-progress", limit: number): Promise<HubItem[]>;
  claim(qitemId: string): Promise<void>;
  show(qitemId: string): Promise<HubItem>;
  note(qitemId: string, note: string): Promise<void>;
  /** Close the way the queue closes an item: done with a closure reason (no-follow-on, canceled or denied), or failed. */
  close(qitemId: string, input: { state: "done" | "failed"; closureReason: string | null; resolution: string }): Promise<void>;
  /** The team this participant may address. A member grant names its rig; an external grant may omit it. */
  team(rigId?: string): Promise<HubTeam>;
  /** Create an item for a peer under an id the caller chose. The hub answers a retry of one that landed with the stored
   *  item, and `createWarning` when the retry's body wasn't saved. */
  create(input: { qitemId: string; destination: string; body: string; summary?: string | null }): Promise<HubItem & { createWarning?: string }>;
  end(): Promise<void>;
}

/** `signal` closes the connection when it aborts, which ends any call still waiting on the hub. */
export type HubConnect = (hubUrl: string, token: string, signal?: AbortSignal) => Promise<HubSession>;

/** A failure, sorted. The hub's own MCP endpoint answers 401 for an unknown or revoked credential and 503 when its grant
 *  authority can't answer (`packages/cli/src/mcp-http.ts`). */
export function hubFailure(error: unknown): HubError {
  if (error instanceof HubError) return error;
  if (error instanceof StreamableHTTPError && error.code === 401) {
    return new HubError("revoked", "The hub refused this participant's credential: it's unknown there or was revoked.");
  }
  if (error instanceof StreamableHTTPError && typeof error.code === "number" && error.code >= 300 && error.code < 400) {
    return new HubError("unavailable", `The hub redirected the connection somewhere else, and the participant's token isn't sent there (${error.message.slice(0, 300)}). Connect the binding to the hub's own URL.`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HubError("unavailable", `The hub couldn't be reached: ${message.slice(0, 300)}`);
}

/** The hub's codes for a request it couldn't make to its own daemon (unreachable, timed out, or failed in flight): try
 *  again later, as for a connection that failed here. */
const HUB_TRANSIENT_CODES = new Set(["daemon_unreachable", "daemon_timeout", "request_failed"]);

/** A tool result as the connector reads it: the JSON it carries, or a HubError. Exported for its own cells. */
export function parseHubToolResult(result: { isError?: boolean; content?: unknown; structuredContent?: unknown }): unknown {
  const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  if (result.isError) {
    const detail = (result.structuredContent ?? {}) as { code?: unknown; outcome?: unknown; retryable?: unknown };
    const code = typeof detail.code === "string" ? detail.code : undefined;
    // A create whose outcome the hub couldn't tell, new work its fair-use limit holds back, or a request the hub couldn't
    // make to its own daemon is to be tried again (a create with the same id); none is a refusal.
    const kind = detail.outcome === "unknown" || detail.retryable === true || (code !== undefined && HUB_TRANSIENT_CODES.has(code))
      ? "unavailable" : "refused";
    throw new HubError(kind, text.slice(0, 500) || "The hub refused this call.", code);
  }
  try { return JSON.parse(text); } catch { throw new HubError("refused", "The hub answered with something that isn't JSON."); }
}

const item = (value: unknown): HubItem => {
  const row = (value ?? {}) as Record<string, unknown>;
  if (typeof row.qitemId !== "string") throw new HubError("refused", "The hub answered without an item id.");
  return {
    qitemId: row.qitemId,
    sourceSession: String(row.sourceSession ?? ""),
    destinationSession: String(row.destinationSession ?? ""),
    state: String(row.state ?? ""),
    body: typeof row.body === "string" ? row.body : null,
    summary: typeof row.summary === "string" ? row.summary : null,
    resolution: typeof row.resolution === "string" ? row.resolution : null,
    closureReason: typeof row.closureReason === "string" ? row.closureReason : null,
  };
};

/** A handed-on item's successor as rig_queue_show names it: readable on the hub itself, or not followed. One on another
 *  host, or one the hub couldn't name, isn't readable through this participant. */
const successorId = (value: unknown): string | null => {
  const next = (value ?? null) as { qitemId?: unknown; host?: unknown; unknown?: unknown } | null;
  return next && typeof next.qitemId === "string" && next.host === undefined && next.unknown === undefined ? next.qitemId : null;
};

/** Connect to a hub as one participant. The bearer goes only in this transport's Authorization header. The SDK's
 *  same-origin policy, set explicitly, follows a redirect only within the hub's origin, or to its https form on the same
 *  host with default ports, so the bearer follows only those; any other redirect fails with its target named. */
export const connectMcpHub: HubConnect = async (hubUrl, token, signal) => {
  const transport = new StreamableHTTPClientTransport(new URL(hubUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    redirectPolicy: "same-origin",
  });
  const client = new Client({ name: "openrig-network-connector", version: "1" });
  const close = () => { void client.close().catch(() => {}); };
  if (signal?.aborted) throw new HubError("unavailable", "The pass ended before it reached the hub.");
  signal?.addEventListener("abort", close, { once: true });
  try {
    await client.connect(transport);
  } catch (error) {
    signal?.removeEventListener("abort", close);
    await client.close().catch(() => {});
    throw hubFailure(error);
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return parseHubToolResult(await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: unknown; structuredContent?: unknown });
    } catch (error) {
      throw hubFailure(error);
    }
  };
  return {
    listOwned: async (state, limit) => {
      const rows = await call("rig_queue_list", { owned: true, state, limit });
      if (!Array.isArray(rows)) throw new HubError("refused", "The hub's list wasn't a list.");
      return rows.map(item);
    },
    claim: async (qitemId) => { await call("rig_queue_claim", { qitemId }); },
    show: async (qitemId) => {
      const shown = await call("rig_queue_show", { qitemId }) as Record<string, unknown>;
      return { ...item(shown?.item ?? shown), successor: successorId(shown?.successor) };
    },
    note: async (qitemId, note) => { await call("rig_queue_update", { qitemId, note }); },
    close: async (qitemId, input) => {
      await call("rig_queue_update", { qitemId, state: input.state, ...(input.closureReason ? { closureReason: input.closureReason } : {}), resolution: input.resolution });
    },
    team: async (rigId) => {
      const team = await call("rig_team", rigId ? { rigId } : {});
      if (!team || typeof team !== "object" || Array.isArray(team)) throw new HubError("refused", "The hub's team wasn't an object.");
      return team as HubTeam;
    },
    create: async (input) => {
      const created = await call("rig_queue_create", { qitemId: input.qitemId, destination: input.destination, body: input.body,
        ...(input.summary ? { summary: input.summary } : {}) }) as Record<string, unknown>;
      const warning = (created?.createWarning ?? null) as { code?: unknown } | null;
      return { ...item(created), ...(typeof warning?.code === "string" ? { createWarning: warning.code } : {}) };
    },
    end: async () => { signal?.removeEventListener("abort", close); await client.close().catch(() => {}); },
  };
};
