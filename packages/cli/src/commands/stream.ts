import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig stream` — coordination primitive L1 commands (PL-004 Phase A).
 *
 * Backed by `/api/stream`. Operates only via the daemon HTTP API.
 * Does NOT touch the POC `rigx-stream-proto` filesystem state.
 */

export interface StreamDeps extends StatusDeps {}

async function withClient<T>(
  deps: StreamDeps,
  fn: (client: DaemonClient) => Promise<T>
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    console.error("Daemon not running. Start it with: rig daemon start");
    process.exitCode = 1;
    return undefined;
  }
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

export function streamCommand(depsOverride?: StreamDeps): Command {
  const cmd = new Command("stream").description("Coordination L1 — append-only intake stream");
  const getDeps = (): StreamDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("emit")
    .description("Append a stream item")
    .requiredOption("--source <session>", "Source session (e.g. velocity-driver@openrig-velocity-claude)")
    .requiredOption("--body <text>", "Stream item body")
    .option("--hint-destination <session>", "Hint at intended destination seat")
    .option("--hint-type <type>", "Hint type (e.g. review, handoff, idea)")
    .option("--hint-urgency <urgency>", "Hint urgency (routine, urgent, critical)")
    .option("--hint-tags <tags>", "Comma-separated hint tags")
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
    .option("--limit <n>", "Result limit", "100")
    .option("--after <sortKey>", "Cursor pagination — return items after this sort key")
    .option("--include-archived", "Include archived items")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      source?: string;
      hintDestination?: string;
      limit: string;
      after?: string;
      includeArchived?: boolean;
      json?: boolean;
    }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.source) params.set("sourceSession", opts.source);
      if (opts.hintDestination) params.set("hintDestination", opts.hintDestination);
      if (opts.limit) params.set("limit", opts.limit);
      if (opts.after) params.set("afterSortKey", opts.after);
      if (opts.includeArchived) params.set("includeArchived", "true");
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <streamItemId>")
    .description("Fetch one stream item by id")
    .option("--json", "JSON output for agents")
    .action(async (streamItemId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/stream/${encodeURIComponent(streamItemId)}`);
        printResult(opts.json ?? false, res.data, res.status);
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

  return cmd;
}
