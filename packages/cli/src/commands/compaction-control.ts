import { Command } from "commander";
import { DaemonClient, terminalAuthHeaders } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface CompactionControlDeps {
  lifecycleDeps: LifecycleDeps;
  clientFactory: (url: string) => Pick<DaemonClient, "get" | "post">;
}

function defaultDeps(): CompactionControlDeps {
  return {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };
}

async function getClient(deps: CompactionControlDeps) {
  const status = await getDaemonStatus(deps.lifecycleDeps);
  if (status.state !== "running" || status.healthy === false) {
    console.error("Daemon is not running. Start it with: rig daemon start");
    process.exitCode = 1;
    return null;
  }
  return deps.clientFactory(getDaemonUrl(status));
}

function printResponse(
  response: { status: number; data: unknown },
  json: boolean | undefined,
  success: string,
): void {
  if (json) {
    console.log(JSON.stringify(response.data));
  } else if (response.status < 400) {
    console.log(success);
  } else {
    const data = response.data as { error?: string; message?: string };
    console.error(data.message ?? data.error ?? `Request failed (HTTP ${response.status})`);
  }
  if (response.status >= 400) process.exitCode = response.status >= 500 ? 2 : 1;
}

export function compactionControlCommand(depsOverride?: CompactionControlDeps): Command {
  const command = new Command("compaction-control")
    .description("Create, inspect, and clear generation-scoped Claude compaction decisions");
  const deps = () => depsOverride ?? defaultDeps();

  command.addCommand(
    new Command("hold")
      .argument("<session>", "Target Claude session")
      .requiredOption("--reason <text>", "Why automatic compaction must not act")
      .option("--json", "JSON output for agents")
      .action(async (session: string, options: { reason: string; json?: boolean }) => {
        const client = await getClient(deps());
        if (!client) return;
        const response = await client.post("/api/compaction/control", {
          session,
          direction: "hold",
          reason: options.reason,
        }, { headers: terminalAuthHeaders() });
        printResponse(response, options.json, `Compaction hold created for ${session}.`);
      }),
  );

  command.addCommand(
    new Command("authorize")
      .argument("<session>", "Target Claude session")
      .requiredOption(
        "--automatic-reason <reason>",
        "One refusal to lift: disabled, post_restore_cooldown, or stale_generation",
      )
      .requiredOption("--reason <text>", "Why this one attempt is authorized")
      .option("--json", "JSON output for agents")
      .action(async (
        session: string,
        options: { automaticReason: string; reason: string; json?: boolean },
      ) => {
        const client = await getClient(deps());
        if (!client) return;
        const response = await client.post("/api/compaction/control", {
          session,
          direction: "authorize",
          automaticReason: options.automaticReason,
          reason: options.reason,
        }, { headers: terminalAuthHeaders() });
        printResponse(response, options.json, `One compaction attempt authorized for ${session}.`);
      }),
  );

  command.addCommand(
    new Command("list")
      .option("--session <session>", "Limit decisions to one session")
      .option("--json", "JSON output for agents")
      .action(async (options: { session?: string; json?: boolean }) => {
        const client = await getClient(deps());
        if (!client) return;
        const query = options.session ? `?session=${encodeURIComponent(options.session)}` : "";
        const response = await client.get(`/api/compaction/control${query}`, {
          headers: terminalAuthHeaders(),
        });
        if (options.json || response.status >= 400) {
          printResponse(response, options.json, "Compaction decisions listed.");
          return;
        }
        const data = response.data as {
          decisions?: Array<{
            decisionId?: string;
            sessionName?: string;
            direction?: string;
            active?: boolean;
            lastObservedAt?: string | null;
            lastObservedOutcome?: string | null;
          }>;
        };
        const decisions = data.decisions ?? [];
        if (decisions.length === 0) {
          console.log("No compaction decisions.");
          return;
        }
        for (const decision of decisions) {
          console.log([
            decision.decisionId ?? "unknown-id",
            decision.sessionName ?? "unknown-session",
            decision.direction ?? "unknown-direction",
            decision.active === false ? "inactive" : "active",
            `lastObservedAt=${decision.lastObservedAt ?? "never"}`,
            `lastObservedOutcome=${decision.lastObservedOutcome ?? "none"}`,
          ].join(" "));
        }
      }),
  );

  command.addCommand(
    new Command("clear")
      .argument("<decision-id>", "Decision ID")
      .requiredOption("--reason <text>", "Why the decision is being cleared")
      .option("--json", "JSON output for agents")
      .action(async (decisionId: string, options: { reason: string; json?: boolean }) => {
        const client = await getClient(deps());
        if (!client) return;
        const response = await client.post(
          `/api/compaction/control/${encodeURIComponent(decisionId)}/clear`,
          { reason: options.reason },
          { headers: terminalAuthHeaders() },
        );
        printResponse(response, options.json, `Compaction decision ${decisionId} cleared.`);
      }),
  );

  return command;
}
