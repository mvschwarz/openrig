import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { positiveIntArg } from "../cli-error.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig watchdog` — coordination primitive Watchdog (PL-004 Phase C).
 *
 * Backed by `/api/watchdog`. Operates only via the daemon HTTP API.
 *
 * Per PRD § Watchdog: scheduler is daemon-native and joins the
 * supervision tree. Phase D includes workflow-keepalive alongside the
 * Phase C watchdog policies.
 */

export interface WatchdogDeps extends StatusDeps {}

async function withClient<T>(
  deps: WatchdogDeps,
  fn: (client: DaemonClient) => Promise<T>,
): Promise<T | undefined> {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (!daemonStatusGuard(status)) return undefined;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactWatchdogJob(job: Record<string, unknown>): Record<string, unknown> {
  return {
    jobId: job.jobId,
    policy: job.policy,
    targetSession: job.targetSession,
    intervalSeconds: job.intervalSeconds,
    lastEvaluationAt: job.lastEvaluationAt,
    lastFireAt: job.lastFireAt,
    actionable: job.actionable,
    lastActionableAt: job.lastActionableAt,
    state: job.state,
    registeredAt: job.registeredAt,
    terminalReason: job.terminalReason,
    bindingState: job.bindingState,
  };
}

export function watchdogCommand(depsOverride?: WatchdogDeps): Command {
  const cmd = new Command("watchdog").description(
    "Coordination Watchdog — daemon-native scheduler for reminders, artifact gates, workflow health, idle gates, and context usage",
  );
  const getDeps = (): WatchdogDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("register")
    .description(
      "Register a watchdog; queue block --wake-watchdog attaches its job id. " +
      "Context transcripts measured 113K–153K tokens/MB. The margin is the protection " +
      "because prompt-bound consumers act only at turn boundaries",
    )
    .option("--spec <path>", "Path to YAML spec file (optional for context-usage-threshold)")
    .requiredOption("--policy <policy>", "Policy name (one of: periodic-reminder, artifact-pool-ready, edge-artifact-required, workflow-keepalive, idle-gate-qitem, context-usage-threshold)")
    .requiredOption("--target-session <session>", "Canonical <member>@<rig> target")
    .requiredOption("--interval-seconds <n>", "Evaluation interval (positive integer)")
    .requiredOption("--registered-by <session>", "Registering session (for audit)")
    .option("--threshold-bytes <n>", "(context-usage-threshold) transcript byte threshold")
    .option("--threshold-mb <n>", "(context-usage-threshold) transcript threshold in decimal MB")
    .option("--watched-file <path>", "(context-usage-threshold) explicit transcript file; recorded context path is the fallback")
    .option("--requires-job <jobId>", "(context-usage-threshold) require this earlier job's receipt for the same occupant")
    .option("--message <text>", "(context-usage-threshold) message delivered when the threshold fires")
    .option("--active-wake-interval-seconds <n>", "(pool-ready-specific) wake-up cadence when actionable artifacts exist")
    .option("--scan-interval-seconds <n>", "(pool-ready-specific) artifact pool scan cadence")
    .option("--json", "JSON output for agents")
    .addHelpText("after", "\nTranscript density varies by session shape; do not tune a context threshold near the context wall.\n\nThe returned job id can be attached to a deliberate park with: rig queue block <qitemId> --on <blocker> --continuation <what-resumes> --wake-watchdog <jobId>")
    .action(async (opts: {
      spec?: string;
      policy: string;
      targetSession: string;
      intervalSeconds: string;
      registeredBy: string;
      activeWakeIntervalSeconds?: string;
      scanIntervalSeconds?: string;
      thresholdBytes?: string;
      thresholdMb?: string;
      watchedFile?: string;
      requiresJob?: string;
      message?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      let specYaml: string;
      const isContextUsageThreshold = opts.policy === "context-usage-threshold";
      if (!opts.spec && !isContextUsageThreshold) {
        console.error("--spec is required unless --policy is context-usage-threshold");
        process.exitCode = 1;
        return;
      }
      if (opts.thresholdBytes !== undefined && opts.thresholdMb !== undefined) {
        console.error("Use only one of --threshold-bytes or --threshold-mb");
        process.exitCode = 1;
        return;
      }
      const thresholdBytes = opts.thresholdBytes !== undefined
        ? Number(opts.thresholdBytes)
        : opts.thresholdMb !== undefined
          ? Number(opts.thresholdMb) * 1_000_000
          : undefined;
      if (
        isContextUsageThreshold &&
        thresholdBytes !== undefined &&
        (!Number.isInteger(thresholdBytes) || thresholdBytes <= 0)
      ) {
        console.error("Context threshold must resolve to a positive whole number of bytes");
        process.exitCode = 1;
        return;
      }
      if (isContextUsageThreshold && !opts.spec && thresholdBytes === undefined) {
        console.error("Context threshold requires --threshold-bytes or --threshold-mb when --spec is omitted");
        process.exitCode = 1;
        return;
      }
      const watchedFilePath = opts.watchedFile ? resolve(opts.watchedFile) : undefined;
      if (opts.spec) {
        try {
          specYaml = readFileSync(opts.spec, "utf-8");
        } catch (err) {
          console.error(`Failed to read spec file ${opts.spec}: ${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
          return;
        }
      } else {
        specYaml = [
          "policy: context-usage-threshold",
          "target:",
          `  session: ${JSON.stringify(opts.targetSession)}`,
          ...(opts.message ? [`message: ${JSON.stringify(opts.message)}`] : []),
          "context:",
          `  threshold_bytes: ${thresholdBytes}`,
          ...(watchedFilePath ? [`  watched_file: ${JSON.stringify(watchedFilePath)}`] : []),
          ...(opts.requiresJob ? [`  requires: ${JSON.stringify(opts.requiresJob)}`] : []),
          "",
        ].join("\n");
      }
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/watchdog/register", {
          policy: opts.policy,
          specYaml,
          targetSession: opts.targetSession,
          intervalSeconds: Number.parseInt(opts.intervalSeconds, 10),
          activeWakeIntervalSeconds: opts.activeWakeIntervalSeconds
            ? Number.parseInt(opts.activeWakeIntervalSeconds, 10)
            : undefined,
          scanIntervalSeconds: opts.scanIntervalSeconds
            ? Number.parseInt(opts.scanIntervalSeconds, 10)
            : undefined,
          watchedFilePath,
          thresholdBytes,
          requiresJobId: opts.requiresJob,
          registeredBySession: opts.registeredBy,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("List watchdog jobs (default: active + compact + at most 100)")
    .option("-a, --all", "Include stopped and terminal history")
    .option("--full", "Show complete per-job fields")
    .option("--limit <n>", "Result limit (default: 100 unless --full)", positiveIntArg)
    .option("--json", "JSON output for agents (compact unless --full)")
    .addHelpText("after", `
Default: active jobs, compact fields, at most 100 records.
Use --all for stopped/terminal history and --full for complete per-job fields.
The pre-0.5.8 complete array remains available with: rig watchdog list --all --full`)
    .action(async (opts: { all?: boolean; full?: boolean; limit?: number; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/watchdog/list");
        if (res.status >= 400 || !Array.isArray(res.data)) {
          printResult(opts.json ?? false, res.data, res.status);
          return;
        }
        const byState = opts.all
          ? res.data
          : res.data.filter((job) => isRecord(job) && job.state === "active");
        const limit = opts.limit ?? (opts.full ? undefined : 100);
        if (limit !== undefined && byState.length > limit) {
          console.error(
            `Showing ${limit} of ${byState.length} matching watchdog jobs; ` +
            "use --full for every active job or --all --full for complete history.",
          );
        }
        const bounded = limit === undefined
          ? byState
          : [...byState]
              .sort((a, b) =>
                Number(isRecord(b) && b.actionable === true) -
                Number(isRecord(a) && a.actionable === true))
              .slice(0, limit);
        const body = opts.full
          ? bounded
          : bounded.map((job) => isRecord(job) ? compactWatchdogJob(job) : job);
        printResult(opts.json ?? false, body, res.status);
      });
    });

  cmd
    .command("show <jobId>")
    .description("Show one watchdog job")
    .option("--json", "JSON output for agents")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("status <jobId>")
    .description("Show one watchdog job + recent evaluation history")
    .option("--json", "JSON output for agents")
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}/status`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("stop <jobId>")
    .description("Stop a watchdog job (operator-stopped; scheduler skips it)")
    .option("--reason <text>", "Stop reason (free-form; recorded in terminal_reason)")
    .option("--json", "JSON output for agents")
    .action(async (jobId: string, opts: { reason?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>(`/api/watchdog/${encodeURIComponent(jobId)}/stop`, {
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
