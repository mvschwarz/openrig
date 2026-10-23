import { Command } from "commander";
import { resolveEffectiveHost } from "../host-selection.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { resolveRigHandle } from "../rig-handle.js";
import { shellQuote } from "../cross-host-executor.js";
import { resolveIdentitySource } from "./whoami.js";

interface DownOptions {
  delete?: boolean;
  force?: boolean;
  snapshot?: boolean;
  yes?: boolean;
  json?: boolean;
  host?: string;
}

interface DownDeps extends StatusDeps {
  promptYesNo?: (question: string) => Promise<boolean>;
}

interface OwnRigWarning {
  fact: string;
  consequence: string;
  action: string;
}

async function confirmOwnRig(
  rigId: string,
  opts: DownOptions,
  deps: DownDeps,
  readIdentity: (path: string) => Promise<unknown>,
): Promise<OwnRigWarning | false | undefined> {
  const source = resolveIdentitySource({});
  if (!source) return;
  // A local session name can identify a different seat on the selected host.
  if (opts.host && !source.nodeId) return;
  const params = new URLSearchParams(source.nodeId ? { nodeId: source.nodeId } : { sessionName: source.sessionName! });
  params.set("compact", "1");
  let caller: { identity?: { rigId?: string; attachmentType?: string } } | undefined;
  try { caller = await readIdentity(`/api/whoami?${params}`) as typeof caller; }
  catch { return; } // An unresolved caller is not proof of membership; keep the existing teardown path.
  if (caller?.identity?.rigId !== rigId) return;

  const warning: OwnRigWarning = {
    fact: `Your current seat belongs to rig ${rigId}.`,
    consequence: caller.identity.attachmentType === "external_cli"
      ? "OpenRig doesn't stop externally attached sessions. This stops the rig's managed sessions and their work."
      : "This ends your own session and stops the rig's other managed seats and their work. OpenRig doesn't stop externally attached sessions.",
    action: ["rig", "down", shellQuote(rigId), "--yes", ...(opts.delete ? ["--delete"] : []),
      ...(opts.force ? ["--force"] : []), ...(opts.snapshot ? ["--snapshot"] : []),
      ...(opts.json ? ["--json"] : []), ...(opts.host ? ["--host", shellQuote(opts.host)] : [])].join(" "),
  };
  if (!opts.json) console.error(`Warning: ${warning.fact} ${warning.consequence}`);
  if (opts.yes) return warning;

  if (deps.promptYesNo || (process.stdin.isTTY && process.stderr.isTTY)) {
    const question = `${opts.json ? `${warning.fact} ${warning.consequence}\n` : ""}Stop this rig? [y/N] `;
    let accepted: boolean;
    if (deps.promptYesNo) accepted = await deps.promptYesNo(question);
    else {
      const { createInterface } = await import("node:readline");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      accepted = await new Promise<boolean>(resolve => {
        rl.once("close", () => resolve(false));
        rl.question(question, answer => { resolve(/^y(es)?$/i.test(answer.trim())); rl.close(); });
      });
    }
    if (accepted) return warning;
  }
  if (opts.json) console.log(JSON.stringify({ rigId, error: { code: "own_rig_confirmation_required", ...warning } }));
  else console.error(`Nothing stopped. To proceed: ${warning.action}`);
  process.exitCode = 1;
  return false;
}

interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
  /** Team skill files kept in seats' own storage: edited, or never recorded as OpenRig's. */
  keptSkills?: string[];
  /** Managed guidance blocks a person edited, kept in their file as `<file>: <block id>`. */
  keptGuidance?: string[];
  /** Seats joined with `rig attach` as an external CLI, which OpenRig doesn't stop. */
  leftRunning?: string[];
}

interface DownAgentEntry {
  nodeKind: string;
  logicalId: string;
  canonicalSessionName?: string | null;
  sessionStatus: string | null;
  activityState?: { display?: string } | null;
  agentActivity?: { state?: string };
}

/** Best-effort facts from the ordinary inventory, before teardown changes it. */
async function showAgentsBeforeDown(rigId: string, readInventory: () => Promise<unknown>): Promise<void> {
  let facts = "agent sessions unknown; work status unknown";
  try {
    const inventory = await readInventory();
    if (Array.isArray(inventory) && inventory.every(n => n && typeof n.nodeKind === "string"
      && typeof n.logicalId === "string" && (n.sessionStatus === null || typeof n.sessionStatus === "string"))) {
      const agents = (inventory as DownAgentEntry[]).filter(n => n.nodeKind === "agent"
        && ["running", "idle", "unknown"].includes(n.sessionStatus ?? ""));
      facts = agents.length === 0 ? "no agent sessions reported live" : "recorded agent sessions: " + agents.map(n => {
        // A running process or an assigned queue row does not prove work in progress.
        // Prefer the daemon's arbitrated activity; older daemons expose agentActivity.
        const activity = n.activityState
          ? n.activityState.display
          : n.agentActivity?.state === "running" ? "working"
          : n.agentActivity?.state === "idle" ? "idle"
          : n.agentActivity?.state === "needs_input" ? "needs-input" : "unknown";
        const work = ["working", "idle", "needs-input"].includes(activity ?? "") ? activity : "unknown";
        return `${n.canonicalSessionName || n.logicalId} (activity: ${work})`;
      }).join(", ");
    }
  } catch { /* Unavailable inventory is an unknown fact, never a teardown gate. */ }
  console.error(`Before stopping ${rigId}: ${facts}.`);
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

/**
 * `rig down <rig>` - tear down a rig by name or id.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function downCommand(depsOverride?: DownDeps): Command {
  const cmd = new Command("down").description("Tear down a rig")
    .addHelpText("after", `
rig down stops every agent in the rig: their sessions end, and any work in progress stops with them.
Before running it, check who is working (rig ps --nodes --rig <rig>) and that the person asked for it;
don't stop a team you didn't start unless asked. OpenRig snapshots the rig first (best-effort), and
rig up <rig> --existing brings it back, resuming each seat's conversation where its harness allows. With
--delete the rig record is removed too, so it can't be brought back that way.
When your resolved seat belongs to this rig, confirm before stopping it. Without a terminal,
the command warns and exits without stopping; re-run with --yes to confirm explicitly.`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig>", "Rig name or id to tear down")
    .option("--delete", "Delete rig record after stopping")
    .option("--force", "Kill sessions immediately")
    .option("--snapshot", "Take snapshot before teardown")
    .option("--yes", "Confirm stopping the rig your current seat belongs to")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (rigHandle: string, opts: DownOptions) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly.
      opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();

      if (opts.host) {
        const { runRemoteHttpOp, resolveRemoteRigId } = await import("../remote-host-ops.js");
        const rigIdResult = await resolveRemoteRigId(opts.host, rigHandle, deps);
        if (!rigIdResult.ok) {
          if (opts.json) console.log(JSON.stringify(rigIdResult));
          else console.error(`Error: ${rigIdResult.error}`);
          process.exitCode = 1;
          return;
        }
        if (!opts.json) {
          await showAgentsBeforeDown(rigIdResult.rigId, async () => {
            const inventory = await runRemoteHttpOp(opts.host!, "GET", `/api/rigs/${encodeURIComponent(rigIdResult.rigId)}/nodes`, undefined, deps, { timeoutMs: 2_000 });
            return inventory.ok ? inventory.data : undefined;
          });
        }
        const warning = await confirmOwnRig(rigIdResult.rigId, opts, deps, async path => {
          const identity = await runRemoteHttpOp(opts.host!, "GET", path, undefined, deps, { timeoutMs: 2_000 });
          return identity.ok ? identity.data : undefined;
        });
        if (warning === false) return;
        const result = await runRemoteHttpOp(opts.host, "POST", `/api/down`, { rigId: rigIdResult.rigId, delete: opts.delete, force: opts.force, snapshot: opts.snapshot }, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(warning ? { ...result, warning } : result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`Error on host ${opts.host}: ${result.error}`);
          process.exitCode = 1;
        }
        if (result.ok) {
          const teardown = result.data as Partial<TeardownResult> | undefined;
          if (teardown?.errors && teardown.errors.length > 0) process.exitCode = 2;
        }
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Resolve the handle (name OR id) to a concrete id BEFORE the teardown POST.
      // Ambiguous/not-found halt here and never reach `/api/down` - for a
      // destructive op, ambiguity must stop, never guess (AC-3 load-bearing).
      const resolution = await resolveRigHandle(client, rigHandle);

      if (resolution.kind === "ambiguous") {
        const fact = `'${resolution.name}' matches ${resolution.ids.length} rigs.`;
        const consequence = "Refusing to tear down: an ambiguous name could destroy the wrong rig.";
        const action = `Re-run with the specific id, e.g. ${resolution.ids.map((id) => `rig down ${id}`).join("  |  ")}`;
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action, candidates: resolution.ids } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      if (resolution.kind === "not_found") {
        const fact = `No rig found matching '${resolution.handle}'.`;
        const consequence = "Nothing was torn down.";
        const action = "List rigs with: rig ps";
        if (opts.json) {
          console.log(JSON.stringify({ error: { fact, consequence, action } }));
        } else {
          console.error(`Error: ${fact}`);
          console.error(`  ${consequence}`);
          console.error(`  ${action}`);
        }
        process.exitCode = 2;
        return;
      }

      // resolved -> the looked-up id; passthrough -> the raw handle (summary
      // unavailable; daemon resolves by exact id, 404s if absent). Either way
      // the SAME existing teardown path + guards run below - no forked path.
      const rigId = resolution.kind === "resolved" ? resolution.id : resolution.handle;

      if (!opts.json) {
        await showAgentsBeforeDown(rigId, async () => {
          const inventory = await client.get<unknown>(`/api/rigs/${encodeURIComponent(rigId)}/nodes`, { timeoutMs: 2_000 });
          return inventory.status === 200 ? inventory.data : undefined;
        });
      }

      const warning = await confirmOwnRig(rigId, opts, deps, async path => {
        const identity = await client.get<unknown>(path, { timeoutMs: 2_000 });
        return identity.status === 200 ? identity.data : undefined;
      });
      if (warning === false) return;
      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        rigId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(warning ? { ...res.data, warning } : res.data));
        if (res.status >= 400) {
          process.exitCode = 2;
        } else {
          const r = res.data as TeardownResult;
          if (r.errors && r.errors.length > 0) process.exitCode = 2;
          else if (r.alreadyStopped && !r.deleted) process.exitCode = 1;
        }
        return;
      }

      // HTTP error
      if (res.status >= 400) {
        const errMsg = (res.data as { error: string }).error ?? "unknown error";
        console.error(`Down failed: ${errMsg} (HTTP ${res.status}). Check rig ID with: rig ps`);
        process.exitCode = 2;
        return;
      }

      const result = res.data as TeardownResult;
      // OPR.0.7.0.13: say what was kept and why, whatever else happened.
      if (result.keptSkills && result.keptSkills.length > 0) {
        console.log(`Kept ${result.keptSkills.length} team skill file(s) in the seats' own storage: edited, or not recorded as OpenRig's:`);
        for (const file of result.keptSkills) console.log(`  ${file}`);
      }
      if (result.keptGuidance && result.keptGuidance.length > 0) {
        console.log(`Kept ${result.keptGuidance.length} edited OpenRig block(s) in guidance files; remove them by hand if you don't want them:`);
        for (const block of result.keptGuidance) console.log(`  ${block}`);
      }

      if (result.leftRunning && result.leftRunning.length > 0) {
        console.log(`Not stopped: ${result.leftRunning.join(", ")}. Joined with rig attach as an external CLI, which OpenRig doesn't stop or check.`);
      }

      // Exit code: errors first, then deleted, then alreadyStopped
      if (result.errors.length > 0) {
        console.log(`Rig ${rigId}: ${result.sessionsKilled} session(s) killed`);
        if (result.deleted) console.log("Rig deleted");
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        for (const e of result.errors) console.error(`  warning: ${e}`);
        process.exitCode = 2;
        return;
      }

      if (result.deleted) {
        console.log(`Rig ${rigId} deleted. ${result.sessionsKilled} session(s) killed.`);
        if (result.snapshotId) console.log(`Snapshot: ${result.snapshotId}`);
        return;
      }

      if (result.alreadyStopped) {
        console.log(`Rig ${rigId} already stopped`);
        process.exitCode = 1;
        return;
      }

      // Clean stop with post-command handoff
      console.log(`Rig ${rigId} stopped. ${result.sessionsKilled} session(s) killed.`);
      if (result.snapshotId) {
        console.log(`Snapshot: ${result.snapshotId}`);
        // Post-command handoff: how to restore (check for duplicate names)
        const rigName = (res.data as Record<string, unknown>)["rigName"] as string | undefined;
        const isUniqueName = (res.data as Record<string, unknown>)["isUniqueName"] as boolean | undefined;
        if (rigName && isUniqueName !== false) {
          console.log(`To restore: rig up ${shellQuote(rigName)} --existing`);
        } else {
          console.log(`To restore: rig restore ${result.snapshotId} --rig ${rigId}`);
        }
      }
    });

  return cmd;
}
