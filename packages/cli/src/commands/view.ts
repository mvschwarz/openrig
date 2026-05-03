import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig view` — coordination primitive L5 (view) commands (PL-004 Phase B).
 *
 * Backed by `/api/views`. 6 built-in views (recently-active, founder,
 * pod-load, escalations, held, activity) + custom view registration.
 */

export interface ViewDeps extends StatusDeps {}

async function withClient<T>(
  deps: ViewDeps,
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

export function viewCommand(depsOverride?: ViewDeps): Command {
  const cmd = new Command("view").description(
    "Coordination L5 — daemon-backed views over coordination state",
  );
  const getDeps = (): ViewDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  cmd
    .command("list")
    .description("List built-in + custom views")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/views/list");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <viewName>")
    .description(
      "Run a view (built-in or custom). Built-in views: recently-active, founder, pod-load, escalations, held, activity",
    )
    .option("--rig <rig>", "Filter by rig name (matches destination_session OR source_session @<rig>)")
    .option("--limit <n>", "Result row limit", "100")
    .option("--json", "JSON output for agents")
    .action(async (viewName: string, opts: { rig?: string; limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.rig) params.set("rig", opts.rig);
      if (opts.limit) params.set("limit", opts.limit);
      const query = params.toString();
      await withClient(deps, async (client) => {
        const path = `/api/views/${encodeURIComponent(viewName)}${query ? `?${query}` : ""}`;
        const res = await client.get<unknown>(path);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("register")
    .description("Register or update a custom view")
    .requiredOption("--name <name>", "Custom view name (must NOT collide with built-in names)")
    .requiredOption("--definition <sql>", "SQL definition (operator-supplied; not validated for taxonomy)")
    .requiredOption("--session <session>", "Registering operator session")
    .option("--json", "JSON output for agents")
    .action(async (opts: { name: string; definition: string; session: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/views/custom/register", {
          viewName: opts.name,
          definition: opts.definition,
          registeredBySession: opts.session,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
