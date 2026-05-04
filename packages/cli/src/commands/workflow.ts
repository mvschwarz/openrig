import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig workflow` — daemon-native Workflow Runtime (PL-004 Phase D).
 *
 * Backed by `/api/workflow`. Operates only via the daemon HTTP API.
 *
 * Per PRD § L4 Workflow Runtime: workflow specs are markdown/YAML
 * authoritative, daemon caches a read-through copy. Owner-as-author
 * + workflow-as-transactional-scribe: owner closure + next-qitem
 * projection happen in the SAME daemon transaction. Lost handoffs
 * are impossible by design.
 */

export interface WorkflowDeps extends StatusDeps {}

async function withClient<T>(
  deps: WorkflowDeps,
  fn: (client: DaemonClient) => Promise<T>,
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

export function workflowCommand(depsOverride?: WorkflowDeps): Command {
  const cmd = new Command("workflow").description(
    "Daemon-native Workflow Runtime — declarative spec + transactional-scribe step projection (PL-004 Phase D)",
  );
  const getDeps = (): WorkflowDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("validate <specPath>")
    .description("Validate a workflow spec file (returns structured ok/error report)")
    .option("--json", "JSON output for agents")
    .action(async (specPath: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/workflow/validate", { specPath });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("instantiate <specPath>")
    .description("Create a workflow instance + entry-step qitem from a spec")
    .requiredOption("--root-objective <text>", "Root objective for the run")
    .requiredOption("--created-by <session>", "Session creating the instance (canonical <member>@<rig>)")
    .option("--entry-owner <session>", "Override default entry-step owner")
    .option("--json", "JSON output for agents")
    .action(async (specPath: string, opts: {
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("project")
    .description("Close a current packet AND project the next-step packet (transactional-scribe; one daemon transaction)")
    .requiredOption("--instance <id>", "Workflow instance id")
    .requiredOption("--current-packet <qitem-id>", "qitem being closed (must be on instance frontier)")
    .requiredOption("--exit <kind>", "Closure exit kind: handoff | waiting | done | failed")
    .requiredOption("--actor-session <session>", "Session closing the packet (owner-as-author)")
    .option("--result-note <text>", "Closure result note (audit context)")
    .option("--blocked-on <ref>", "For waiting exits: blocker reference (qitem id, gate name)")
    .option("--next-owner <session>", "Override default next-step owner")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      instance: string;
      currentPacket: string;
      exit: "handoff" | "waiting" | "done" | "failed";
      actorSession: string;
      resultNote?: string;
      blockedOn?: string;
      nextOwner?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/workflow/project", {
          instanceId: opts.instance,
          currentPacketId: opts.currentPacket,
          exit: opts.exit,
          actorSession: opts.actorSession,
          resultNote: opts.resultNote,
          blockedOn: opts.blockedOn,
          nextOwnerSession: opts.nextOwner,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("List workflow instances; optionally filter by status")
    .option("--status <s>", "Filter by status (active | waiting | completed | failed)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { status?: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.status) params.set("status", opts.status);
      const qs = params.toString();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/workflow/list${qs ? `?${qs}` : ""}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // RSI v2 starter v0: list cached workflow_specs (NOT instances). The
  // existing `rig workflow list` lists instances; this is the
  // complementary surface for inspecting which specs are registered,
  // including the new built-in starter(s) shipped at daemon startup.
  // Built-in rows display a `(built-in)` indicator in human output and
  // an `isBuiltIn: true` field in JSON output.
  cmd
    .command("specs")
    .description("List registered workflow specs; built-in starters tagged with (built-in)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<{ specs: Array<{
          name: string; version: string; purpose: string | null;
          targetRig: string | null; coordinationTerminalTurnRule: string;
          sourcePath: string; cachedAt: string; isBuiltIn: boolean;
        }> }>("/api/workflow/specs");
        if (opts.json) {
          printResult(true, res.data, res.status);
          return;
        }
        if (res.status >= 400) {
          printResult(false, res.data, res.status);
          return;
        }
        const rows = res.data.specs ?? [];
        if (rows.length === 0) {
          console.log("No workflow specs registered.");
          return;
        }
        // Compact human table — name, version, source, indicator.
        for (const row of rows) {
          const indicator = row.isBuiltIn ? " (built-in)" : "";
          console.log(`${row.name} v${row.version}${indicator}`);
          if (row.purpose) console.log(`  purpose: ${row.purpose.replace(/\n/g, " ").slice(0, 120)}`);
          console.log(`  source: ${row.sourcePath}`);
        }
      });
    });

  cmd
    .command("show <instanceId>")
    .description("Show one workflow instance")
    .option("--json", "JSON output for agents")
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/workflow/${encodeURIComponent(instanceId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("trace <instanceId>")
    .description("Show one workflow instance + its append-only step trail (audit-only verdict)")
    .option("--json", "JSON output for agents")
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/workflow/${encodeURIComponent(instanceId)}/trace`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("continue <instanceId>")
    .description("Mechanically advance an instance after truthful closure (idempotent inspector in v1)")
    .option("--json", "JSON output for agents")
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/workflow/${encodeURIComponent(instanceId)}/continue`, {});
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
