import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { streamOutcome } from "./stream-outcome.js";

/**
 * `rig stream` — coordination primitive L1 commands (PL-004 Phase A).
 *
 * Backed by `/api/stream`. Operates only via the daemon HTTP API.
 * Does NOT touch the POC `rigx-stream-proto` filesystem state.
 */

export interface StreamDeps extends StatusDeps {
  fetchImpl?: typeof fetch;
}

interface WatchedStreamItem {
  tsEmitted: string;
  sourceSession: string;
  body: string;
  [key: string]: unknown;
}

async function withClient<T>(
  deps: StreamDeps,
  fn: (client: DaemonClient) => Promise<T>
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
  const client = deps.clientFactory(getDaemonUrl(status));
  return fn(client);
}

function printResult(json: boolean, body: unknown, status: number): void {
  if (json) {
    console.log(JSON.stringify(body));
  } else {
    console.log(JSON.stringify(body, null, 2));
  }
  if (status >= 400) process.exitCode = status >= 500 ? 2 : 1;
}

function isWatchedStreamItem(value: unknown): value is WatchedStreamItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.tsEmitted === "string"
    && typeof item.sourceSession === "string"
    && typeof item.body === "string";
}

function printWatchData(data: string, json: boolean): void {
  try {
    const item = JSON.parse(data) as unknown;
    if (!isWatchedStreamItem(item)) return;
    if (json) console.log(JSON.stringify(item));
    else console.log(`[${item.tsEmitted} ${item.sourceSession}] ${item.body}`);
  } catch {
    // The daemon emits one JSON item per data line. Ignore malformed frames.
  }
}

async function consumeWatch(body: ReadableStream<Uint8Array>, json: boolean): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const consumeLines = (flush: boolean): void => {
    const lines = buffer.split("\n");
    buffer = flush ? "" : (lines.pop() ?? "");
    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith("data:")) printWatchData(line.slice(5).trim(), json);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeLines(false);
    }
    buffer += decoder.decode();
    if (buffer) {
      buffer += "\n";
      consumeLines(true);
    }
  } finally {
    reader.releaseLock();
  }
}

export function streamCommand(depsOverride?: StreamDeps): Command {
  const cmd = new Command("stream").description("Coordination L1 — append-only intake stream");
  const getDeps = (): StreamDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("emit")
    .description("Append a stream item")
    .requiredOption("--source <session>", "Source session (e.g. dev-build@starter)")
    .requiredOption("--body <text>", "Stream item body")
    .option("--hint-destination <session>", "Hint at intended destination seat")
    .option("--hint-type <type>", "Hint type (e.g. review, handoff, idea)")
    .option("--hint-urgency <urgency>", "Hint urgency (routine, urgent, critical)")
    .option("--hint-tags <tags>", "Comma-separated hint tags")
    .option("--format <fmt>", "Observation body format")
    .option("--interrupt", "Mark item as interrupting")
    .option("--id <streamItemId>", "Idempotent stream_item_id (skip if not provided)")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source: string;
      body: string;
      hintDestination?: string;
      hintType?: string;
      hintUrgency?: string;
      hintTags?: string;
      format?: string;
      interrupt?: boolean;
      id?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const tags = opts.hintTags ? opts.hintTags.split(",").map((s) => s.trim()).filter(Boolean) : null;
      await withClient(deps, async (client) => {
        const res = await client.post<Record<string, unknown>>("/api/stream/emit", {
          streamItemId: opts.id,
          sourceSession: opts.source,
          body: opts.body,
          ...(opts.format ? { format: opts.format } : {}),
          hintDestination: opts.hintDestination ?? null,
          hintType: opts.hintType ?? null,
          hintUrgency: opts.hintUrgency ?? null,
          hintTags: tags,
          interrupt: opts.interrupt ?? false,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("List stream items chronologically")
    .option("--source <session>", "Filter by source session")
    .option("--hint-destination <session>", "Filter by hint destination")
    .option("--tag <tag>", "Filter by exact hint tag")
    .option("--since <iso>", "Include items emitted at or after this ISO timestamp")
    .option("--until <iso>", "Include items emitted at or before this ISO timestamp")
    .option("--limit <n>", "Result limit", "100")
    .option("--after <sortKey>", "Cursor pagination — return items after this sort key")
    .option("--include-archived", "Include archived items")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source?: string;
      hintDestination?: string;
      tag?: string;
      since?: string;
      until?: string;
      limit: string;
      after?: string;
      includeArchived?: boolean;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.hintDestination) params.set("hintDestination", opts.hintDestination);
      if (opts.tag) params.set("hintTag", opts.tag);
      if (opts.since) params.set("since", opts.since);
      if (opts.until) params.set("until", opts.until);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.after) params.set("afterSortKey", opts.after);
      if (opts.includeArchived) params.set("includeArchived", "true");
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("watch")
    .description("Watch the stream (initial replay + live items)")
    .option("--json", "Emit one StreamItem JSON object per line")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        try {
          const res = await (deps.fetchImpl ?? fetch)(`${client.baseUrl}/api/stream/sse`, {
            headers: { Accept: "text/event-stream" },
          });
          if (!res.ok) {
            console.error(`Watch failed (HTTP ${res.status})`);
            process.exitCode = res.status >= 500 ? 2 : 1;
            return;
          }
          if (!res.body) {
            console.error("Watch failed: response body missing");
            process.exitCode = 2;
            return;
          }
          await consumeWatch(res.body, opts.json ?? false);
        } catch (err) {
          console.error(`Watch error: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 2;
        }
      });
    });

  cmd
    .command("show <streamItemId>")
    .description("Fetch one stream item by id, with what became of it (routing, linked work and its state)")
    .option("--json", "JSON output for agents")
    .action(async (streamItemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}`);
        if (res.status >= 400 || !res.data || typeof res.data !== "object") { printResult(opts.json ?? false, res.data, res.status); return; }
        const outcome = await streamOutcome(client, streamItemId)
          .catch((error: unknown) => ({ stage: "unavailable", summary: error instanceof Error ? error.message : "routing records unavailable" }));
        printResult(opts.json ?? false, { ...(res.data as Record<string, unknown>), outcome }, res.status);
      });
    });

  cmd
    .command("archive <streamItemId>")
    .description("Soft-archive a stream item (audit row preserved)")
    .option("--json", "JSON output for agents")
    .action(async (streamItemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}/archive`, {});
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // Slice 22 outcome 9: hub readers. Naming the reader is enough; its filter defaults to items addressed to it or tagged
  // with its session, seat name or logical id.
  cmd
    .command("subscribe <readerSession>")
    .description("Subscribe a reader seat to stream items addressed to it or matching its topics (hint tags)")
    .option("--tags <tags>", "Comma-separated hint tags to match (any of); default: the reader's own ids")
    .option("--type <hintType>", "Match only this hint type")
    .option("--actor <session>", "Who sets this up, when not run from a managed seat")
    .option("--json", "JSON output for agents")
    .action(async (readerSession: string, opts: { tags?: string; type?: string; actor?: string; json?: boolean }) => {
      const hintTags = opts.tags ? opts.tags.split(",").map((s) => s.trim()).filter(Boolean) : [];
      await withClient(getDeps(), async (client) => {
        const res = await client.post<unknown>("/api/stream/subscriptions", { readerSession, hintTags, hintType: opts.type ?? null,
          ...(opts.actor ? { actor: opts.actor } : {}) });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("unsubscribe <readerSession>")
    .description("Remove a reader seat's stream subscription")
    .option("--json", "JSON output for agents")
    .action(async (readerSession: string, opts: { json?: boolean }) => {
      await withClient(getDeps(), async (client) => {
        const res = await client.delete<unknown>(`/api/stream/subscriptions/${encodeURIComponent(readerSession)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("subscriptions")
    .description("List stream subscriptions, each with its unread count and size")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      await withClient(getDeps(), async (client) => {
        const res = await client.get<unknown>("/api/stream/subscriptions");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("read")
    .description("Read the next page of your subscription (at most 20 items, 2,000-character excerpts) and advance your cursor")
    .option("--limit <n>", "Items in this page (at most 20)")
    .option("--reader <session>", "The reader, when not run from a managed seat")
    .option("--json", "JSON output for agents")
    .action(async (opts: { limit?: string; reader?: string; json?: boolean }) => {
      const limit = opts.limit === undefined ? undefined : Number(opts.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        console.error("--limit must be a positive integer");
        process.exitCode = 1;
        return;
      }
      await withClient(getDeps(), async (client) => {
        const res = await client.post<unknown>("/api/stream/read", { ...(limit ? { limit } : {}), ...(opts.reader ? { reader: opts.reader } : {}) });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
