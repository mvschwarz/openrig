import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface ContextDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => DaemonClient;
}

interface NodeEntry {
  rigId: string;
  rigName: string;
  logicalId: string;
  canonicalSessionName: string | null;
  runtime: string | null;
  contextUsage?: {
    usedPercentage: number | null;
    remainingPercentage: number | null;
    contextWindowSize: number | null;
    source: string | null;
    availability: string | null;
    sampledAt: string | null;
    fresh: boolean;
  };
  [key: string]: unknown;
}

interface Seat {
  session: string;
  rig: string;
  logicalId: string;
  runtime: string;
  usedPercentage: number | null;
  remainingPercentage: number | null;
  contextWindowSize: number | null;
  urgency: "critical" | "warning" | "low" | "unknown";
  freshness: "fresh" | "stale" | "none";
  status: string;
  displayStatus: string;
  source: string | null;
  availability: string;
  sampledAt: string | null;
  staleness: string;
  fresh: boolean;
}

const FRESHNESS_THRESHOLD_S = 600; // 10 minutes

function ageLabel(sampledAt: string | null): string {
  if (!sampledAt) return "\u2014";
  const age = Math.max(0, Math.floor((Date.now() - new Date(sampledAt).getTime()) / 1000));
  if (age < 60) return "<1m ago";
  const minutes = Math.floor(age / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function computeFreshness(sampledAt: string | null): "fresh" | "stale" | "none" {
  if (!sampledAt) return "none";
  const age = (Date.now() - new Date(sampledAt).getTime()) / 1000;
  return age <= FRESHNESS_THRESHOLD_S ? "fresh" : "stale";
}

function analyze(node: NodeEntry): Seat {
  const ctx = node.contextUsage ?? {} as Partial<NonNullable<NodeEntry["contextUsage"]>>;
  const used = ctx.usedPercentage != null ? Math.round(ctx.usedPercentage) : null;
  const remaining = ctx.remainingPercentage != null ? Math.round(ctx.remainingPercentage) : null;
  const window = ctx.contextWindowSize ?? null;
  const sampledAt = ctx.sampledAt ?? null;
  const source = ctx.source ?? null;
  const availability = ctx.availability ?? (used != null ? "known" : "unknown");

  if (used == null) {
    return {
      session: node.canonicalSessionName ?? "",
      rig: node.rigName ?? "",
      logicalId: node.logicalId ?? "",
      runtime: node.runtime ?? "unknown",
      usedPercentage: null, remainingPercentage: null, contextWindowSize: null,
      urgency: "unknown", freshness: "none", status: "unknown", displayStatus: "unknown",
      source, availability, sampledAt, staleness: "\u2014", fresh: false,
    };
  }

  const urgency: "critical" | "warning" | "low" = used >= 80 ? "critical" : used >= 60 ? "warning" : "low";
  const freshness = computeFreshness(sampledAt);
  let status: string;
  let displayStatus: string;

  if (urgency === "critical") {
    status = freshness === "fresh" ? "critical" : "critical_stale";
    displayStatus = freshness === "fresh" ? "CRITICAL" : "CRITICAL (stale)";
  } else if (urgency === "warning") {
    status = freshness === "fresh" ? "warning" : "warning_stale";
    displayStatus = freshness === "fresh" ? "WARNING" : "WARNING (stale)";
  } else if (freshness === "fresh") {
    status = "ok";
    displayStatus = "ok";
  } else {
    status = "stale";
    displayStatus = "stale";
  }

  return {
    session: node.canonicalSessionName ?? "",
    rig: node.rigName ?? "",
    logicalId: node.logicalId ?? "",
    runtime: node.runtime ?? "unknown",
    usedPercentage: used, remainingPercentage: remaining, contextWindowSize: window,
    urgency, freshness, status, displayStatus,
    source, availability, sampledAt, staleness: ageLabel(sampledAt), fresh: freshness === "fresh",
  };
}

const STATUS_RANK: Record<string, number> = {
  critical: 0, critical_stale: 0,
  warning: 1, warning_stale: 1,
  stale: 2, ok: 3, unknown: 4,
};

function sortSeats(seats: Seat[]): Seat[] {
  return seats.sort((a, b) => {
    const ra = STATUS_RANK[a.status] ?? 9;
    const rb = STATUS_RANK[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    const pa = a.usedPercentage ?? -1;
    const pb = b.usedPercentage ?? -1;
    if (pa !== pb) return pb - pa; // higher percentage first
    if (a.rig !== b.rig) return a.rig.localeCompare(b.rig);
    return a.session.localeCompare(b.session);
  });
}

function isVisible(seat: Seat, threshold: number | null): boolean {
  if (threshold == null) return true;
  if (seat.status === "unknown") return true;
  if (seat.freshness === "stale") return true;
  return seat.usedPercentage != null && seat.usedPercentage >= threshold;
}

export function contextCommand(depsOverride?: ContextDeps): Command {
  const cmd = new Command("context")
    .description("Show context-usage across running agents")
    .addHelpText("after", `
Examples:
  rig context                    Show all seats with context usage
  rig context --rig openrig-pm   Show one rig
  rig context --threshold 80     Show seats at or above 80% (plus unknown + stale)
  rig context --refresh          Re-sample context before displaying
  rig context --json             JSON output for agents`);

  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .option("--json", "JSON output for agents")
    .option("--rig <name>", "Show one rig only")
    .option("--threshold <pct>", "Show seats at or above this percentage")
    .option("--refresh", "Re-sample context usage before displaying")
    .action(async (opts: { json?: boolean; rig?: string; threshold?: string; refresh?: boolean }) => {
      const deps = getDepsF();

      // Strict threshold validation — reject non-integer input
      let threshold: number | null = null;
      if (opts.threshold != null) {
        const parsed = Number(opts.threshold);
        if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
          console.error("rig context: --threshold must be an integer percentage (0-100)");
          process.exitCode = 2;
          return;
        }
        threshold = parsed;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon is not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }
      const client = deps.clientFactory(getDaemonUrl(status));

      try {
        // Get rig list to iterate
        const psResult = await client.get<Array<{ rigId: string; name: string }>>("/api/ps");
        const rigs = psResult.data ?? [];
        const targetRigs = opts.rig
          ? rigs.filter((r) => r.name === opts.rig)
          : rigs;

        if (opts.rig && targetRigs.length === 0) {
          console.error(`Rig "${opts.rig}" not found. List rigs with: rig ps`);
          process.exitCode = 1;
          return;
        }

        // Refresh once globally if requested (pollOnce samples all active Claude sessions).
        // Refresh failure is a hard error — do not silently display stale data as if refreshed.
        if (opts.refresh && targetRigs.length > 0) {
          const firstRig = targetRigs[0]!;
          try {
            const refreshResult = await client.get(`/api/rigs/${firstRig.rigId}/nodes?refresh=true`);
            if (refreshResult.status >= 400) {
              console.error("Context refresh failed. Data may be stale.");
              console.error(`Detail: ${JSON.stringify(refreshResult.data)}`);
              console.error("Fix: retry without --refresh to see stale data, or check daemon logs.");
              process.exitCode = 2;
              return;
            }
          } catch (refreshErr) {
            console.error("Context refresh failed. Data may be stale.");
            console.error(`Detail: ${refreshErr instanceof Error ? refreshErr.message : String(refreshErr)}`);
            console.error("Fix: retry without --refresh to see stale data, or check daemon logs.");
            process.exitCode = 2;
            return;
          }
        }

        // Fetch node inventory per rig (without refresh — already done globally)
        const allNodes: NodeEntry[] = [];
        for (const rig of targetRigs) {
          const nodesResult = await client.get<NodeEntry[]>(`/api/rigs/${rig.rigId}/nodes`);
          if (Array.isArray(nodesResult.data)) {
            allNodes.push(...nodesResult.data);
          }
        }

        const seats = sortSeats(
          allNodes
            .map(analyze)
            .filter((s) => isVisible(s, threshold))
        );

        const summary = {
          total: seats.length,
          known: seats.filter((s) => s.usedPercentage != null).length,
          critical: seats.filter((s) => s.urgency === "critical").length,
          warning: seats.filter((s) => s.urgency === "warning").length,
          ok: seats.filter((s) => s.status === "ok").length,
          stale: seats.filter((s) => s.freshness === "stale").length,
          unknown: seats.filter((s) => s.status === "unknown").length,
        };

        if (opts.json) {
          console.log(JSON.stringify({ seats, summary }, null, 2));
          return;
        }

        // Human-readable output
        const title = opts.rig ? `CONTEXT USAGE - ${opts.rig}` : "CONTEXT USAGE - all rigs";
        console.log(title);
        console.log(
          `${"seat".padEnd(42)} ${"runtime".padEnd(12)} ${"context".padStart(7)} ${"window".padStart(8)} ${"sampled".padStart(10)}  status`
        );
        for (const seat of seats) {
          const context = seat.usedPercentage == null ? "?" : `${seat.usedPercentage}%`;
          const window = seat.contextWindowSize == null ? "?" : String(seat.contextWindowSize);
          console.log(
            `${seat.session.slice(0, 42).padEnd(42)} ${seat.runtime.slice(0, 12).padEnd(12)} ${context.padStart(7)} ${window.padStart(8)} ${seat.staleness.padStart(10)}  ${seat.displayStatus}`
          );
        }
        console.log();
        console.log(
          `FLEET SUMMARY: ${summary.known}/${summary.total} known | ` +
          `${summary.critical} CRITICAL | ${summary.warning} WARNING | ` +
          `${summary.ok} ok | ${summary.stale} stale | ${summary.unknown} unknown`
        );
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  return cmd;
}
