import { readFileSync } from "node:fs";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig watchdog` — coordination primitive Watchdog (PL-004 Phase C).
 *
 * Backed by `/api/watchdog`. Operates only via the daemon HTTP API.
 *
 * Per PRD § Watchdog: scheduler is daemon-native and joins the
 * supervision tree. Three policies in scope at v1; workflow-keepalive
 * deferred to Phase D.
 */

export interface WatchdogDeps extends StatusDeps {}

async function withClient<T>(
  deps: WatchdogDeps,
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

export function watchdogCommand(depsOverride?: WatchdogDeps): Command {
  const cmd = new Command("watchdog").description(
    "Coordination Watchdog — daemon-native scheduler for periodic-reminder, artifact-pool-ready, edge-artifact-required (PL-004 Phase C; workflow-keepalive ships in Phase D)",
  );
  const getDeps = (): WatchdogDeps =>
    depsOverride ?? {
      lifecycleDeps: realDeps(),
      clientFactory: (url: string) => new DaemonClient(url),
    };

  cmd
    .command("register")
    .description("Register a new watchdog job from a YAML spec file")
    .requiredOption("--spec <path>", "Path to YAML spec file (policy + target + interval + context)")
    .requiredOption("--policy <policy>", "Policy name (one of: periodic-reminder, artifact-pool-ready, edge-artifact-required)")
    .requiredOption("--target-session <session>", "Canonical <member>@<rig> target")
    .requiredOption("--interval-seconds <n>", "Evaluation interval (positive integer)")
    .requiredOption("--registered-by <session>", "Registering session (for audit)")
    .option("--active-wake-interval-seconds <n>", "(pool-ready-specific) wake-up cadence when actionable artifacts exist")
    .option("--scan-interval-seconds <n>", "(pool-ready-specific) artifact pool scan cadence")
    .option("--json", "JSON output for agents")
    .action(async (opts: {
      spec: string;
      policy: string;
      targetSession: string;
      intervalSeconds: string;
      registeredBy: string;
      activeWakeIntervalSeconds?: string;
      scanIntervalSeconds?: string;
      json?: boolean;
    }) => {
      const deps = getDeps();
      let specYaml: string;
      try {
        specYaml = readFileSync(opts.spec, "utf-8");
      } catch (err) {
        console.error(`Failed to read spec file ${opts.spec}: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return;
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
          registeredBySession: opts.registeredBy,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("list")
    .description("List all watchdog jobs")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/watchdog/list");
        printResult(opts.json ?? false, res.data, res.status);
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
