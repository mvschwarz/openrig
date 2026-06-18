import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

const LONG_RUNNING_TIMEOUT_MS = 45_000;

interface RigSummaryEntry {
  id: string;
  name: string;
  archivedAt?: string | null;
  lifecycleState?: string;
}

/**
 * Outcome of resolving a `rig down <rig>` handle (name OR id) to a concrete id.
 * The destructive teardown only ever runs on a `resolved`/`passthrough` id;
 * `ambiguous`/`not_found` halt BEFORE any `/api/down` POST.
 */
type HandleResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous"; name: string; ids: string[] }
  | { kind: "not_found"; handle: string }
  // Summary unavailable (non-200 / fetch error): fall back to today's id-only
  // behavior - POST the raw handle as the id and let the daemon resolve it by
  // exact id (404 if absent). Safe: the daemon matches a single exact id, so a
  // name posted this way cannot tear down the wrong rig.
  | { kind: "passthrough"; handle: string };

/**
 * Resolve a `rig down` handle (rig name OR id) to a concrete rig id, mirroring
 * the `/api/rigs/summary` path `rig up` uses. Resolution is a PRE-STEP: the
 * existing teardown + guards downstream are unchanged; this only maps the
 * handle to an id.
 *
 * Safety order (destructive-op):
 *  1. id-exact-match FIRST, across ALL rigs incl. archived - an id is unique, so
 *     it is never ambiguous, and an archived rig's id must still reach the
 *     canonical teardown id path (AC-2 unchanged).
 *  2. else name-filter over ACTIVE (non-archived) rigs only:
 *     - exactly 1 active match -> resolve to that id;
 *     - >1 active matches      -> AMBIGUOUS: halt, never guess (load-bearing AC-3);
 *     - 0 active matches       -> NOT_FOUND: halt, honest error (AC-4).
 *
 * `/api/rigs/summary` defaults to ACTIVE-only and exposes `archivedAt`; we fetch
 * with `includeArchived=true` so an archived id still id-matches, then filter
 * names to active. So an active+archived same-name pair is NOT ambiguous (only
 * the active candidate counts), and an archived-only name does not resolve by
 * name (use the id, or the archive path).
 */
async function resolveRigHandle(client: DaemonClient, handle: string): Promise<HandleResolution> {
  let summaries: RigSummaryEntry[];
  try {
    // includeArchived=true so an archived rig's id still id-matches below
    // (preserving today's `rig down <id>` path); names are filtered to active.
    const res = await client.get<RigSummaryEntry[]>("/api/rigs/summary?includeArchived=true");
    if (res.status !== 200 || !Array.isArray(res.data)) {
      return { kind: "passthrough", handle };
    }
    summaries = res.data;
  } catch {
    return { kind: "passthrough", handle };
  }

  // 1. id-exact-match first, across ALL rigs incl. archived (AC-2: down by id,
  //    unchanged; ids are never ambiguous; archived ids still reach teardown).
  if (summaries.some((r) => r.id === handle)) {
    return { kind: "resolved", id: handle };
  }

  // 2. name-filter over ACTIVE (non-archived) rigs only, symmetric with `up`.
  const activeNameMatches = summaries.filter((r) => r.name === handle && r.archivedAt == null);
  if (activeNameMatches.length === 1) {
    return { kind: "resolved", id: activeNameMatches[0]!.id };
  }
  if (activeNameMatches.length > 1) {
    return { kind: "ambiguous", name: handle, ids: activeNameMatches.map((r) => r.id) };
  }
  return { kind: "not_found", handle };
}

/**
 * `rig down <rig>` - tear down a rig by name or id.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function downCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("down").description("Tear down a rig");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<rig>", "Rig name or id to tear down")
    .option("--delete", "Delete rig record after stopping")
    .option("--force", "Kill sessions immediately")
    .option("--snapshot", "Take snapshot before teardown")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (rigHandle: string, opts: { delete?: boolean; force?: boolean; snapshot?: boolean; json?: boolean; host?: string }) => {
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
        const result = await runRemoteHttpOp(opts.host, "POST", `/api/down`, { rigId: rigIdResult.rigId, delete: opts.delete, force: opts.force, snapshot: opts.snapshot }, deps, opts);
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          console.error(`Error on host ${opts.host}: ${result.error}`);
          process.exitCode = 1;
        }
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

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

      const res = await client.post<TeardownResult | { error: string }>("/api/down", {
        rigId,
        delete: opts.delete ?? false,
        force: opts.force ?? false,
        snapshot: opts.snapshot ?? false,
      }, { timeoutMs: LONG_RUNNING_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
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
          console.log(`To restore: rig up ${rigName}`);
        } else {
          console.log(`To restore: rig restore ${result.snapshotId} --rig ${rigId}`);
        }
      }
    });

  return cmd;
}
