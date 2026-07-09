import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, printDaemonNotRunning } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { followInstance } from "./workflow-follow.js";
import {
  composeAttentionRollup,
  renderInstanceList,
  renderInstanceShow,
  renderStatus,
  renderTraceTree,
} from "./workflow-render.js";
import { describeDaemonRejection, formatThreePart } from "./workflow-errors.js";

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
  } else if (status >= 400) {
    // WF3 FR-5: named daemon rejections render the house what/why/fix
    // 3-part in human mode; unrecognized bodies keep the raw-JSON
    // fallback. --json (above) stays the RAW body byte-identically;
    // exit codes below are unchanged.
    const rejection = describeDaemonRejection(body);
    if (rejection) {
      for (const line of formatThreePart(rejection)) process.stderr.write(`${line}\n`);
    } else {
      console.log(JSON.stringify(body, null, 2));
    }
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

// OPR.0.4.6.FAC1 (arch ruling 2026-07-07): instantiate-time advisories
// (currently the spec-default-target.rig degrade-to-unbound notice) MUST
// be LOUD. Always write to STDERR — even in --json mode the structured
// body already carries `advisories`, but an operator piping stdout to a
// consumer still needs to see the warning, so it lands on stderr in both
// modes. Non-fatal: never sets a non-zero exit code.
export function printWorkflowAdvisories(advisories: string[] | undefined): void {
  if (!advisories || advisories.length === 0) return;
  for (const line of advisories) {
    process.stderr.write(`⚠ workflow advisory: ${line}\n`);
  }
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
    .option("--rig <name>", "Bind the instance to this rig (overrides the spec's target.rig default; roles resolve to seats on this rig)")
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
      rig?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instanceId?: string;
          entryStepId?: string;
          entryOwnerSession?: string;
          status?: string;
          instance?: { boundRig?: string | null };
          advisories?: string[];
        }>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
          targetRig: opts.rig,
        });
        printResult(opts.json ?? false, res.data, res.status);
        printWorkflowAdvisories(res.data?.advisories);
        const body = res.data ?? {};
        const instanceId = asString(body.instanceId) ?? "(no instance id)";
        const entryStepId = asString(body.entryStepId);
        const owner = asString(body.entryOwnerSession) ?? opts.entryOwner ?? "(default from spec)";
        const boundRig = asString(body.instance?.boundRig ?? undefined);
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Instantiated workflow from ${specPath} (instance ${instanceId})`,
          state: `${body.status ?? "active"}${boundRig ? `; bound to rig ${boundRig}` : ""}; entry packet ${entryStepId ?? "pending"} owned by ${owner}`,
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
        // WF3 FR-2: human mode renders the table; --json byte-identical (BR-2).
        if (opts.json || res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const body = res.data as { instances?: unknown[] } | unknown[];
        const rows = (Array.isArray(body) ? body : body?.instances ?? []) as Parameters<typeof renderInstanceList>[0];
        for (const line of renderInstanceList(rows)) console.log(line);
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
        // WF3 FR-2: human summary headed by the status line; --json byte-identical (BR-2).
        if (opts.json || res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        for (const line of renderInstanceShow(res.data as Parameters<typeof renderInstanceShow>[0])) console.log(line);
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
        const res = await client.get<{ instance?: unknown; trail?: unknown[] }>(
          `/api/workflow/${encodeURIComponent(instanceId)}/trace`,
        );
        // WF3 FR-2: human mode renders the per-step tree (mini-req 2's
        // one-screen bar); --json byte-identical (BR-2).
        if (opts.json || res.status >= 400 || !res.data?.instance) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const instance = res.data.instance as Parameters<typeof renderTraceTree>[0];
        const trail = (res.data.trail ?? []) as Parameters<typeof renderTraceTree>[1];
        for (const line of renderTraceTree(instance, trail)) console.log(line);
      });
    });

  // OPR.0.4.6.WF1 FR-8 (G6): `continue` RELABELED to its real
  // inspector semantics. The wire has been a read-only frontier+trail
  // inspector since Phase D v1, but the label said "Mechanically
  // advance" and the summary printed "Advanced instance ..." — the
  // label-vs-wire lie dies here. A true mechanical advance would mint
  // a closure without the owner's truthful exit, violating
  // owner-as-author + BR-2 (project is the sole advance write path) —
  // arch-endorsed as architecture, not just wording.
  cmd
    .command("continue <instanceId>")
    .description("Inspect an instance's current frontier + step trail (read-only; advancing happens via 'rig workflow project')")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Read-only: reports where the instance is and how it got there so the
frontier owner can continue truthfully. To actually advance, the packet
OWNER closes it via:
  $ rig workflow project --instance <id> --current-packet <qitem> --exit <exit> --actor-session <you>

Examples:
  $ rig workflow continue WF01ABC
  $ rig workflow continue WF01ABC --json
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instance?: { status?: string; currentFrontier?: string[]; currentStepId?: string | null };
          trail?: unknown[];
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/continue`, {});
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        const status = body.instance?.status ?? "(unknown)";
        const frontier = body.instance?.currentFrontier ?? [];
        const stepId = body.instance?.currentStepId ?? null;
        const trailLen = body.trail?.length ?? 0;
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Inspected instance ${instanceId} (read-only; no state changed)`,
          state: `status = ${status}; step = ${stepId ?? "(terminal)"}; frontier = [${frontier.join(", ")}]; trail rows = ${trailLen}`,
          next: frontier.length > 0
            ? `The frontier owner advances via: rig workflow project --instance ${instanceId} --current-packet ${frontier[0]} --exit <handoff|waiting|done|failed> --actor-session <owner>`
            : `Terminal or empty frontier - see: rig workflow trace ${instanceId}`,
        });
      });
    });

  // OPR.0.4.6.WF3 FR-1 — the follow verbs. Two verbs, ONE renderer
  // (workflow-follow.ts). BR-1 verb honesty: `run` instantiates AND
  // follows; `watch` ONLY watches — neither advances a step (project
  // remains the sole advance path). Outcome-as-exit-code by default
  // (the kubectl choice): completed=0, workflow-failed=3 (distinct
  // from the shipped 1=4xx / 2=5xx transport codes), so
  // `rig workflow run … && next-thing` is honest in scripts.
  cmd
    .command("run <specPath>")
    .description("Instantiate a workflow AND follow it live to a terminal state (exit 0 completed / 3 failed)")
    .requiredOption("--root-objective <text>", "Root objective for the run")
    .requiredOption("--created-by <session>", "Session creating the instance (canonical <member>@<rig>)")
    .option("--entry-owner <session>", "Override default entry-step owner")
    .option("--rig <name>", "Bind the instance to this rig (overrides the spec's target.rig default; roles resolve to seats on this rig)")
    .option("--json", "Stream events as JSON lines for agents")
    .addHelpText("after", `
Streams each step event as it happens; exits when the workflow reaches
a terminal state. Exit codes: 0 = completed, 3 = workflow failed,
1/2 = transport errors (4xx/5xx). If the event stream drops, the
command reconnects, then degrades to polling — announced, never a
silent freeze.

Examples:
  $ rig workflow run workflows/conveyor.workflow.md \\
      --root-objective "Ship it" --created-by orch-lead@my-rig
  $ rig workflow run ./spec.yaml --root-objective x --created-by a@b --json
`)
    .action(async (specPath: string, opts: {
      rootObjective: string;
      createdBy: string;
      entryOwner?: string;
      rig?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          instanceId?: string;
          instance?: { instanceId?: string };
          advisories?: string[];
        }>("/api/workflow/instantiate", {
          specPath,
          rootObjective: opts.rootObjective,
          createdBySession: opts.createdBy,
          entryOwnerSession: opts.entryOwner,
          targetRig: opts.rig,
        });
        printWorkflowAdvisories(res.data?.advisories);
        // The daemon returns the nested InstantiateResult shape
        // ({instance:{instanceId}}); tolerate a flattened {instanceId}
        // too (walk-caught: reading only the flat field made `run`
        // print-and-exit-0 without ever following — the same
        // flattening confusion as the pre-existing instantiate
        // summary polish note from WF-1 rev1-r2).
        const instanceId =
          asString(res.data?.instance?.instanceId) ?? asString(res.data?.instanceId);
        if (res.status >= 400 || !instanceId) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        if (!opts.json) console.log(`● instance ${instanceId} created — following`);
        const code = await followInstance(client, instanceId, { json: opts.json ?? false });
        if (code !== 0) process.exitCode = code;
      });
    });

  cmd
    .command("watch <instanceId>")
    .description("Attach to an in-flight instance and follow it live (read-only; exit mirrors the outcome)")
    .option("--json", "Stream events as JSON lines for agents")
    .addHelpText("after", `
Read-only: renders the instance's current state (snapshot), then
streams live events until a terminal state. Attaching to an already
fast-moving instance is safe — steps that closed before attach render
from the snapshot exactly once. Exit codes: 0 = completed, 3 =
workflow failed, 1/2 = transport errors.

Examples:
  $ rig workflow watch WF01ABC
  $ rig workflow watch WF01ABC --json
`)
    .action(async (instanceId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const code = await followInstance(client, instanceId, { json: opts.json ?? false });
        if (code !== 0) process.exitCode = code;
      });
    });

  // OPR.0.4.6.WF3 FR-4 — the ONE WF-3 mutation. BR-1: `route` routes;
  // it NEVER advances a step (hop count untouched; project remains the
  // sole advance path). Exception-lane by usage, not by gate.
  cmd
    .command("route <instanceId>")
    .description("Re-route the current frontier step to a new owner (same step, honest handoff closure; never advances)")
    .requiredOption("--to <session>", "New owner session (canonical <member>@<rig>)")
    .requiredOption("--actor-session <session>", "Session performing the re-route (recorded as provenance)")
    .option("--reason <text>", "Why the step is being re-routed (recorded in the audit trail)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Use when a step's owner is unresponsive (dead seat, compaction) and the
work should continue from the SAME step under a new owner. The old
owner's stale close attempts are structurally rejected afterwards
(packet_not_on_frontier).

Examples:
  $ rig workflow route WF01ABC --to dev2-driver@my-rig \\
      --actor-session orch-lead@my-rig --reason "owner seat dead"
`)
    .action(async (instanceId: string, opts: {
      to: string;
      actorSession: string;
      reason?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          stepId?: string | null;
          closedPacketId?: string;
          newPacketId?: string;
          fromSession?: string;
          toSession?: string;
          instanceStatus?: string;
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/route`, {
          toSession: opts.to,
          actorSession: opts.actorSession,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Re-routed step ${body.stepId ?? "?"} from ${body.fromSession ?? "?"} to ${body.toSession ?? opts.to} (packet ${body.closedPacketId ?? "?"} → ${body.newPacketId ?? "?"})`,
          state: `instance ${instanceId} = ${body.instanceStatus ?? "active"}; same step, new owner; no step advanced`,
          next: `The new owner advances via: rig workflow project --instance ${instanceId} --current-packet ${body.newPacketId ?? "<packet>"} --exit <exit> --actor-session ${opts.to}`,
        });
      });
    });

  // OPR.0.4.6.WF5 FR-4 — resume: redrive a FAILED instance from the
  // failed step (BR-1 verb honesty: resume re-drives, it never advances
  // a step itself and never re-runs completed steps; waiting instances
  // resume via the shipped project path, not this verb).
  cmd
    .command("resume <instanceId>")
    .description("Redrive a FAILED instance from its failed step (completed steps never re-run; one fresh max_hops window)")
    .requiredOption("--actor-session <session>", "Session performing the resume (recorded as provenance)")
    .option("--decision <text>", "Durable instruction for the step owner (lands in the redrive packet)")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Use after diagnosing an exception item: the instance returns to active,
REBOUND to the step that failed, with a fresh packet routed to that
step's re-resolved owner. The trail is preserved and extended; the
resolved exception occurrence closes; a NEW failure of the same step
raises a NEW occurrence honestly.

Examples:
  $ rig workflow resume WF01ABC --actor-session orch-lead@my-rig \\
      --decision "flaky fixture fixed in commit abc123 — retry"
`)
    .action(async (instanceId: string, opts: {
      actorSession: string;
      decision?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<{
          stepId?: string;
          newPacketId?: string;
          ownerSession?: string;
          resumeCount?: number;
          exceptionItemsClosed?: number;
        }>(`/api/workflow/${encodeURIComponent(instanceId)}/resume`, {
          actorSession: opts.actorSession,
          decision: opts.decision,
        });
        printResult(opts.json ?? false, res.data, res.status);
        const body = res.data ?? {};
        printOutcomeSummary(opts.json ?? false, res.status, {
          what: `Redrove instance ${instanceId} from step ${body.stepId ?? "?"} (redrive #${body.resumeCount ?? "?"}; packet ${body.newPacketId ?? "?"} → ${body.ownerSession ?? "?"}; ${body.exceptionItemsClosed ?? 0} exception item(s) resolved)`,
          state: `instance ${instanceId} = active, rebound to ${body.stepId ?? "?"}; completed steps untouched; fresh max_hops window`,
          next: `The owner advances via: rig workflow project --instance ${instanceId} --current-packet ${body.newPacketId ?? "<packet>"} --exit <exit> --actor-session ${body.ownerSession ?? "<owner>"}`,
        });
      });
    });

  // OPR.0.4.6.WF3 FR-3 part B — the needs-attention rollup. CLI-SIDE
  // composition per the arch ruling (Rev-4 rails): consumes the
  // API-carried instance.deadline classification + instance.status
  // from the SHIPPED read surface; counting/grouping/rendering only —
  // NO threshold or class is ever computed here, NO daemon route was
  // added (the WF-4-era web UI adds a daemon rollup endpoint under its
  // own authorization when it needs one; this verb is not the
  // permanent home of that composition).
  cmd
    .command("status")
    .description("Which instances need attention: counts + one row per failed/stuck/waiting instance with reason + next action (read-only)")
    .option("--json", "Rollup as JSON for agents")
    .addHelpText("after", `
Answers "what needs me" (list answers "what exists"). Every
attention-worthy instance appears exactly once with ALL its classes
(failed / stuck / waiting) and the actionable next step. A clean fleet
renders the proven-empty statement with counts — never a blank.

Examples:
  $ rig workflow status
  $ rig workflow status --json | jq '.attention[] | {instanceId, classes}'
`)
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/workflow/list");
        if (res.status >= 400) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const body = res.data as { instances?: unknown[] } | unknown[];
        const rows = (Array.isArray(body) ? body : body?.instances ?? []) as Parameters<typeof composeAttentionRollup>[0];
        const rollup = composeAttentionRollup(rows);
        if (opts.json) {
          console.log(JSON.stringify(rollup));
          return;
        }
        for (const line of renderStatus(rollup)) console.log(line);
      });
    });

  return cmd;
}
