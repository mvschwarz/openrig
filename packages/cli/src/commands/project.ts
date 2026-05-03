import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig project` — coordination primitive L2 (classifier) commands (PL-004 Phase B).
 *
 * Backed by `/api/projects`. Operates only via the daemon HTTP API.
 *
 * Per PRD § L2: classifier judgment stays with the agent; daemon enforces
 * the lease + idempotency + reclaim contract.
 */

export interface ProjectDeps extends StatusDeps {}

async function withClient<T>(
  deps: ProjectDeps,
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

export function projectCommand(depsOverride?: ProjectDeps): Command {
  const cmd = new Command("project").description(
    "Coordination L2 — agent-backed classifier with daemon-enforced lease + idempotency + reclaim",
  );
  const getDeps = (): ProjectDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  // ---- Lease lifecycle ----

  cmd
    .command("lease-acquire")
    .description("Acquire the active classifier lease for the caller")
    .requiredOption("--session <session>", "Classifier session name")
    .option(
      "--evaluate-deadness-first",
      "Before acquire, call evaluateDeadness to clear any stale TTL-expired or dead-holder lease (per PRD § L2 deadness-detection)",
    )
    .option("--json", "JSON output for agents")
    .action(async (opts: { session: string; evaluateDeadnessFirst?: boolean; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/acquire", {
          classifierSession: opts.session,
          evaluateDeadnessFirst: opts.evaluateDeadnessFirst,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-heartbeat")
    .description("Send a heartbeat for an active classifier lease (extends TTL)")
    .requiredOption("--lease-id <id>", "Lease ID")
    .requiredOption("--session <session>", "Classifier session name")
    .option("--json", "JSON output for agents")
    .action(async (opts: { leaseId: string; session: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/heartbeat", {
          leaseId: opts.leaseId,
          classifierSession: opts.session,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-show")
    .description("Show the currently-active classifier lease")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/projects/lease");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Operator-verb reclaim ----

  cmd
    .command("reclaim-classifier")
    .description(
      "Operator-verb: reclaim the active classifier lease. Use --if-dead to refuse if holder is still alive.",
    )
    .requiredOption("--session <session>", "Session that will hold the new lease")
    .option("--if-dead", "Only reclaim if the current holder is reported dead by the liveness check")
    .option("--reason <text>", "Reclaim reason (free-form; recorded in classifier_leases.reclaim_reason)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { session: string; ifDead?: boolean; reason?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/reclaim-classifier", {
          byClassifierSession: opts.session,
          ifDead: opts.ifDead,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Project a stream item ----

  cmd
    .command("classify <streamItemId>")
    .description(
      "Project a stream item with classification fields (idempotent on stream_item_id; requires active lease)",
    )
    .requiredOption("--session <session>", "Classifier session name (must hold active lease)")
    .option("--type <type>", "Classification type (e.g., idea, bug, feature-request)")
    .option("--urgency <urgency>", "Classification urgency (e.g., normal, high, critical)")
    .option("--maturity <maturity>", "Classification maturity (e.g., concept, drafted, ratified)")
    .option("--confidence <confidence>", "Classification confidence (e.g., low, medium, high)")
    .option("--destination <destination>", "Classification destination (downstream slice/seat)")
    .option("--action <action>", "Action type (e.g., create, advance)")
    .option("--json", "JSON output for agents")
    .action(async (streamItemId: string, opts: {
      session: string;
      type?: string;
      urgency?: string;
      maturity?: string;
      confidence?: string;
      destination?: string;
      action?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/project", {
          streamItemId,
          classifierSession: opts.session,
          classificationType: opts.type,
          classificationUrgency: opts.urgency,
          classificationMaturity: opts.maturity,
          classificationConfidence: opts.confidence,
          classificationDestination: opts.destination,
          action: opts.action,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- List + show ----

  cmd
    .command("list")
    .description("List project classifications with filters")
    .option("--session <session>", "Filter by classifier session")
    .option("--destination <destination>", "Filter by classification destination")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output for agents")
    .action(async (opts: { session?: string; destination?: string; limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.session) params.set("classifierSession", opts.session);
      if (opts.destination) params.set("classificationDestination", opts.destination);
      if (opts.limit) params.set("limit", opts.limit);
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <projectId>")
    .description("Show one project classification")
    .option("--json", "JSON output for agents")
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
