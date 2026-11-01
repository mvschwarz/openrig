import { Command } from "commander";
import { DaemonClient, DaemonResponseError, type DaemonResponse } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { readSelectedHost } from "../host-selection.js";
import { resolveRigHandle } from "../rig-handle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface EdgeEnd {
  logicalId: string;
  nodeId: string | null;
}

interface EdgeSuccess {
  ok: true;
  rigId: string;
  outcome: "would_add" | "added" | "present" | "would_remove" | "removed";
  edge: { id?: string; kind: string; from: EdgeEnd; to: EdgeEnd };
  rollback?: string;
  routing?: {
    orchestrator?: { seat: string; from: string | null; to: string | null };
    representative?: { from: string | null; to: string | null };
  };
}

type EdgeOpResult =
  | EdgeSuccess
  | { ok: false; code: string; message: string; candidates?: string[] };

const NO_EDGE_ROUTE = "This daemon has no edge route. Upgrade it to a version with `rig edge`, then retry.";

function report(result: EdgeOpResult, opts: { json?: boolean }): void {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else if (!result.ok) console.error(`${result.code}: ${result.message}`);
  else {
    const { edge } = result;
    const line = `${edge.kind} ${edge.from.logicalId} -> ${edge.to.logicalId}`;
    const id = edge.id ? `  edge ${edge.id}` : "";
    switch (result.outcome) {
      case "would_add":
        console.log(`plan     add ${line} in rig ${result.rigId}`);
        console.log(`         from node ${edge.from.nodeId}, to ${edge.to.nodeId === null
          ? `${edge.to.logicalId} (resolved when used)` : `node ${edge.to.nodeId}`}`);
        console.log("         nothing written (--plan)");
        break;
      case "added":
        console.log(`added    ${line}${id}`);
        console.log(`         rollback: ${result.rollback}`);
        break;
      case "present":
        console.log(`present  ${line}${id} (already there; nothing written)`);
        break;
      case "would_remove":
        console.log(`plan     remove ${line}${id} from rig ${result.rigId}`);
        console.log("         nothing written (--plan)");
        break;
      case "removed":
        console.log(`removed  ${line}${id}`);
        break;
    }
    const { orchestrator, representative } = result.routing ?? {};
    if (orchestrator) {
      console.log(`         routing: ${orchestrator.seat}'s orchestrator (its stuck-row findings and recovery) is now ${orchestrator.to ?? "none"}, was ${orchestrator.from ?? "none"}`);
    }
    if (representative) {
      console.log(`         routing: the rig's representative (where a person's Slack message in the rig's mapped channel goes, unless that channel names an inbound seat) is now ${representative.to ?? "none, so such a message goes to Slack's inbound destination"}, was ${representative.from ?? "none"}`);
    }
    if (result.outcome === "added" || result.outcome === "removed") {
      console.log(`         capture this topology with \`rig snapshot ${result.rigId}\`; restore uses the selected snapshot`);
    }
  }
  if (!result.ok) process.exitCode = 1;
}

export function edgeCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("edge").description("Add or remove typed edges between existing seats");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  const run = async (
    rigHandle: string,
    opts: { json?: boolean },
    send: (client: DaemonClient, rigId: string) => Promise<DaemonResponse<EdgeOpResult>>,
  ) => {
    const deps = getDeps();
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status, { json: opts.json })) return;
    const client = deps.clientFactory(getDaemonUrl(status));
    const resolution = await resolveRigHandle(client, rigHandle);
    const selectedHost = readSelectedHost();
    // Match rig add: names copied from a selected remote must not silently
    // mutate a same-named rig on the local daemon. Explicit local IDs still work.
    if (selectedHost !== "local" && (resolution.kind === "ambiguous" || (resolution.kind === "resolved" && resolution.byName))) {
      report({
        ok: false, code: "remote_host_selected",
        message: `Host '${selectedHost}' is selected, but rig edge only targets the local daemon. Run it on that host or pass an explicit local rig ID (rig host select local; rig ps --json).`,
      }, opts);
      return;
    }
    if (resolution.kind === "ambiguous") {
      report({
        ok: false, code: "rig_ambiguous", candidates: resolution.ids,
        message: `'${rigHandle}' matches ${resolution.ids.length} rigs. Re-run with one of these IDs: ${resolution.ids.join(", ")}.`,
      }, opts);
      return;
    }
    if (resolution.kind === "not_found") {
      report({ ok: false, code: "rig_not_found", message: `rig '${rigHandle}' not found; list active rigs with rig ps --json, or use an archived rig's exact ID` }, opts);
      return;
    }
    const rigId = resolution.kind === "resolved" ? resolution.id : rigHandle;
    let result: EdgeOpResult;
    try {
      const response = await send(client, rigId);
      result = response.data;
      // Older daemons have used both JSON not_found and plain-text 404 pages.
      if (response.status === 404 && (!result || !("code" in result))) {
        result = { ok: false, code: "edge_route_missing", message: NO_EDGE_ROUTE };
      }
    } catch (err) {
      if (!(err instanceof DaemonResponseError) || err.status !== 404) throw err;
      result = { ok: false, code: "edge_route_missing", message: NO_EDGE_ROUTE };
    }
    report(result, opts);
  };

  cmd
    .command("add")
    .description("Ensure one typed edge; an existing edge is unchanged")
    .argument("<rig>", "Target rig name or ID")
    .argument("[from]", "Existing source seat logical ID, such as orch.lead")
    .argument("[to]", "Target logical ID, or a same-daemon address for escalates_to")
    .option("--kind <kind>", "delegates_to, spawned_by, can_observe, collaborates_with or escalates_to")
    .option("--plan", "Validate the request and show the change without writing")
    .option("--json", "JSON output for agents")
    .addHelpText("after", `
Examples:
  rig edge add my-rig orch.lead review.reviewer --kind delegates_to
  rig edge add my-rig orch.lead review.reviewer --kind delegates_to --plan --json
  rig edge add my-rig work.lead review-advisor@coord --kind escalates_to

Use existing, fully qualified logical IDs in <rig> for both same-pod and
cross-pod edges. For escalates_to only, the target may instead be a canonical
same-daemon seat address (pod-member@rig), resolved when used; that rig or seat
need not exist yet. Cross-host and synthetic destinations are unsupported.
Run it once per edge. A repeat reports the existing edge and its ID, and writes
nothing. No seats or sessions are changed.`)
    .action(async (rig: string, from: string | undefined, to: string | undefined, opts: { kind?: string; plan?: boolean; json?: boolean }) => {
      if (!from || !to || !opts.kind) {
        report({ ok: false, code: "validation_failed", message: "Supply from, to and --kind" }, opts);
        return;
      }
      const body = { from, to, kind: opts.kind, plan: opts.plan === true };
      await run(rig, opts, (client, rigId) => client.post<EdgeOpResult>(`/api/rigs/${encodeURIComponent(rigId)}/edges`, body));
    });

  cmd
    .command("remove")
    .description("Remove exactly one edge, by the ID that rig edge add returned")
    .argument("<rig>", "Target rig name or ID")
    .argument("<edge-id>", "Edge ID")
    .option("--plan", "Show what would change and write nothing")
    .option("--json", "JSON output for agents")
    .action((rig: string, edgeId: string, opts: { plan?: boolean; json?: boolean }) =>
      run(rig, opts, (client, rigId) => client.delete<EdgeOpResult>(
        `/api/rigs/${encodeURIComponent(rigId)}/edges/${encodeURIComponent(edgeId)}${opts.plan ? "?plan=1" : ""}`,
      )));

  return cmd;
}
