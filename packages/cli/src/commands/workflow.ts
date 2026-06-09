import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
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
    printDaemonNotRunning();
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

// release-0.3.2 slice 01 GA polish — every mutating workflow command
// ends with a 3-line what/state/next summary in human mode so the
// operator doesn't have to grep the raw JSON for the outcome. JSON
// mode keeps the daemon response verbatim — agent consumers parse
// the structured body, not the human summary.
export interface OutcomeSummary {
  what: string;
  state: string;
  next: string;
}

// release-0.3.2 slice 01 BC repair — runtime validator for the
// project --exit enum. TypeScript types don't enforce at runtime;
// without this guard `--exit banana` would forward to the daemon
// transactional-scribe surface. Match the same 3-part error shape
// used elsewhere in the slice.
export const PROJECT_EXIT_KINDS = ["handoff", "waiting", "done", "failed"] as const;
export type ProjectExitKind = (typeof PROJECT_EXIT_KINDS)[number];

export function isProjectExitKind(value: unknown): value is ProjectExitKind {
  return typeof value === "string" && (PROJECT_EXIT_KINDS as readonly string[]).includes(value);
}

function emit3PartError(json: boolean, fact: string, consequence: string, action: string): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { fact, consequence, action } }, null, 2));
  } else {
    process.stderr.write(`Error: ${fact}\n${consequence}\n${action}\n`);
  }
  process.exitCode = 1;
}

export function printOutcomeSummary(json: boolean, status: number, summary: OutcomeSummary | null): void {
  if (json || !summary || status >= 400) return;
  console.log("");
  console.log(`  what:  ${summary.what}`);
  console.log(`  state: ${summary.state}`);
  console.log(`  next:  ${summary.next}`);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
    .addHelpText("after", `
Examples:
  $ rig workflow validate workflows/conveyor-starter.workflow.md
  $ rig workflow validate ./my-spec.workflow.md --json | jq .ok
`)
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
    .addHelpText("after", `
Examples:
  $ rig workflow instantiate workflows/conveyor.workflow.md \\
      --root-objective "Ship release-0.3.2" \\
      --created-by orch-lead@openrig-velocity

  $ rig workflow instantiate ./my-spec.workflow.md \\
      --root-objective "Run dogfood" \\
      --created-by velocity-driver@openrig-velocity \\
      --entry-owner velocity-qa@openrig-velocity --json
`)
    .action(async (specPath: string, opts: {
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instanceId?: string;
          entryStepId?: string;
          entryOwnerSession?: string;
          status?: string;
        }>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const instanceId = asString(body.instanceId) ?? "(no instance id)";
        const entryStepId = asString(body.entryStepId);
        const owner = asString(body.entryOwnerSession) ?? opts.entryOwner ?? "(default from spec)";
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Instantiated workflow from ${specPath} (instance ${instanceId})`,
          state: `${body.status ?? "active"}; entry packet ${entryStepId ?? "pending"} owned by ${owner}`,
          next: entryStepId
            ? `Inspect: rig workflow show ${instanceId} | Open packet: rig queue show ${entryStepId}`
            : `Inspect: rig workflow show ${instanceId}`,
        });
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
    .addHelpText("after", `
Examples:
  # handoff to the spec's default next step
  $ rig workflow project \\
      --instance WF01ABC \\
      --current-packet QITEM-123 \\
      --exit handoff \\
      --actor-session velocity-driver@openrig-velocity \\
      --result-note "implementation green; ready for review"

  # close the run cleanly
  $ rig workflow project --instance WF01ABC --current-packet QITEM-9 \\
      --exit done --actor-session orch-lead@openrig-velocity

  # block on an external gate
  $ rig workflow project --instance WF01ABC --current-packet QITEM-4 \\
      --exit waiting --actor-session velocity-qa@openrig-velocity \\
      --blocked-on "founder-gate-2"
`)
    .action(async (opts: {
      instance: string;
      currentPacket: string;
      exit: string;
      actorSession: string;
      resultNote?: string;
      blockedOn?: string;
      nextOwner?: string;
      json?: boolean;
    }) => {
      // HG-6 — runtime-validate the --exit enum BEFORE the daemon
      // call. TypeScript types are erased at runtime; without this
      // guard `--exit banana` would forward to the transactional
      // workflow surface.
      if (!isProjectExitKind(opts.exit)) {
        emit3PartError(
          Boolean(opts.json),
          `--exit must be one of ${PROJECT_EXIT_KINDS.join(" | ")} (got "${opts.exit}").`,
          "rig workflow project did not run; daemon was not contacted.",
          `Pass a valid exit kind. Example: --exit handoff.`,
        );
        return;
      }
      const exitKind: ProjectExitKind = opts.exit;
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          closedPacketId?: string;
          nextPacketId?: string;
          nextOwnerSession?: string;
          instanceStatus?: string;
        }>("/api/workflow/project", {
          instanceId: opts.instance,
          currentPacketId: opts.currentPacket,
          exit: exitKind,
          actorSession: opts.actorSession,
          resultNote: opts.resultNote,
          blockedOn: opts.blockedOn,
          nextOwnerSession: opts.nextOwner,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const closedId = asString(body.closedPacketId) ?? opts.currentPacket;
        const nextId = asString(body.nextPacketId);
        const nextOwner = asString(body.nextOwnerSession) ?? opts.nextOwner ?? "(default from spec)";
        const status = body.instanceStatus ?? (opts.exit === "done" ? "completed" : opts.exit === "failed" ? "failed" : "active");
        const whatTail = nextId ? ` and projected ${nextId} to ${nextOwner}` : (opts.exit === "done" ? " (instance done)" : "");
        const nextAction = nextId
          ? `Inspect: rig queue show ${nextId}`
          : (opts.exit === "done" || opts.exit === "failed")
            ? `Inspect: rig workflow show ${opts.instance}`
            : `Wait for upstream; rig workflow show ${opts.instance} to monitor`;
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Closed ${closedId} (${opts.exit})${whatTail}`,
          state: `instance ${opts.instance} = ${status}`,
          next: nextAction,
        });
      });
    });

  cmd
    .command("list")
    .description("List workflow instances; optionally filter by status")
    .option("--status <s>", "Filter by status (active | waiting | completed | failed)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  $ rig workflow list
  $ rig workflow list --status active --json
  $ rig workflow list --status waiting | jq -r '.instances[].instanceId'
`)
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

  // List cached workflow_specs (NOT instances). The existing
  // `rig workflow list` lists instances; this is the complementary
  // surface for inspecting which specs are registered, including any
  // built-in starter(s) shipped at daemon startup.
  // Built-in rows display a `(built-in)` indicator in human output and
  // an `isBuiltIn: true` field in JSON output.
  cmd
    .command("specs")
    .description("List registered workflow specs; built-in starters tagged with (built-in)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  $ rig workflow specs
  $ rig workflow specs --json | jq '.specs[] | select(.isBuiltIn==false)'
`)
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
    .addHelpText("after", `
Examples:
  $ rig workflow show WF01ABC
  $ rig workflow show WF01ABC --json | jq '.instance.status'
`)
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
    .addHelpText("after", `
Examples:
  $ rig workflow trace WF01ABC
  $ rig workflow trace WF01ABC --json | jq '.trail[] | {step, actor, exit}'
`)
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
    .addHelpText("after", `
Examples:
  $ rig workflow continue WF01ABC
  $ rig workflow continue WF01ABC --json
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          advanced?: boolean;
          nextPacketId?: string;
          nextOwnerSession?: string;
          instanceStatus?: string;
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/continue`, {});
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const advanced = body.advanced !== false;
        const nextId = asString(body.nextPacketId);
        const nextOwner = asString(body.nextOwnerSession) ?? "(unknown)";
        const status = body.instanceStatus ?? "(unknown)";
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: advanced
            ? `Advanced instance ${instanceId}${nextId ? ` to packet ${nextId}` : ""}`
            : `No advance for instance ${instanceId} (already at frontier or terminal)`,
          state: `instance status = ${status}${nextId ? `; next owner = ${nextOwner}` : ""}`,
          next: nextId ? `Inspect: rig queue show ${nextId}` : `Inspect: rig workflow trace ${instanceId}`,
        });
      });
    });

  return cmd;
}
