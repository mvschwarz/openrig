// The connector's view of a remote hub: the queue tools an external grant offers its participant (list its own items,
// claim, show, update), reached over MCP's Streamable HTTP with that participant's bearer. Nothing here decides what to
// do with an item; it only says what the hub answered, and sorts a failure into what the caller must do about it.
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
}

/** `revoked`: the hub refused the credential (401), so the binding ends. `unavailable`: the hub or its grant authority
 *  couldn't answer, or the connection failed, so try later. `refused`: the hub answered this one call with an error. */
export type HubErrorKind = "revoked" | "unavailable" | "refused";

export class HubError extends Error {
  constructor(readonly kind: HubErrorKind, message: string) {
    super(message);
  }
}

export interface HubSession {
  listOwned(state: "pending" | "in-progress", limit: number): Promise<HubItem[]>;
  claim(qitemId: string): Promise<void>;
  show(qitemId: string): Promise<HubItem>;
  note(qitemId: string, note: string): Promise<void>;
  close(qitemId: string, input: { closureReason: string; resolution: string; note?: string }): Promise<void>;
  end(): Promise<void>;
}

export type HubConnect = (hubUrl: string, token: string) => Promise<HubSession>;

/** A failure, sorted. The hub's own MCP endpoint answers 401 for an unknown or revoked credential and 503 when its grant
 *  authority can't answer (`packages/cli/src/mcp-http.ts`). */
export function hubFailure(error: unknown): HubError {
  if (error instanceof HubError) return error;
  if (error instanceof StreamableHTTPError && error.code === 401) {
    return new HubError("revoked", "The hub refused this participant's credential: it's unknown there or was revoked.");
  }
  const message = error instanceof Error ? error.message : String(error);
  return new HubError("unavailable", `The hub couldn't be reached: ${message.slice(0, 300)}`);
}

function parsed(result: { isError?: boolean; content?: unknown }): unknown {
  const content = Array.isArray(result.content) ? result.content as Array<{ type?: string; text?: string }> : [];
  const text = content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  if (result.isError) throw new HubError("refused", text.slice(0, 500) || "The hub refused this call.");
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
  };
};

/** Connect to a hub as one participant. The bearer goes only in this transport's Authorization header. */
export const connectMcpHub: HubConnect = async (hubUrl, token) => {
  const transport = new StreamableHTTPClientTransport(new URL(hubUrl), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "openrig-network-connector", version: "1" });
  try {
    await client.connect(transport);
  } catch (error) {
    await client.close().catch(() => {});
    throw hubFailure(error);
  }
  const call = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return parsed(await client.callTool({ name, arguments: args }) as { isError?: boolean; content?: unknown });
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
      return item(shown?.item ?? shown);
    },
    note: async (qitemId, note) => { await call("rig_queue_update", { qitemId, note }); },
    close: async (qitemId, input) => {
      await call("rig_queue_update", { qitemId, state: "done", closureReason: input.closureReason, resolution: input.resolution, ...(input.note ? { note: input.note } : {}) });
    },
    end: async () => { await client.close().catch(() => {}); },
  };
};
