import { prepareWorker, runProjectWake, type WakeOptions } from "./project-worker.js";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { experimentStatus, setExperiment, readBounded, JevRun, streamDecision, classifyCapture } from "./project-jev.js";
import fs from "node:fs";

/**
 * `rig project` — coordination primitive L2 (classifier) commands (PL-004 Phase B).
 *
 * Coordination uses `/api/projects`; optional experiment configuration/provider
 * processing is local to the invoking occupant.
 *
 * Per PRD § L2: classifier judgment stays with the agent; daemon enforces
 * the lease + idempotency + reclaim contract.
 */

export interface ProjectDeps extends StatusDeps {
  workerRead?: (file: string) => string;
  experimentEnv?: NodeJS.ProcessEnv;
  experimentFetch?: typeof fetch;
}

async function withClient<T>(
  deps: ProjectDeps,
  fn: (client: DaemonClient) => Promise<T>
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

export function projectCommand(depsOverride?: ProjectDeps): Command {
  const cmd = new Command("project").description(
    "Coordination L2 — agent-backed classifier with daemon-enforced lease + idempotency + reclaim",
  );
  const getDeps = (): ProjectDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
  };

  const experimental = cmd.command("experimental").description("Optional Jev experiment; advisory, finite foreground runs, disabled by default");
  for (const verb of ["enable", "disable", "status"] as const) {
    experimental.command(verb).requiredOption("--config <file>", "Explicit local experiment JSON; contains no credential")
      .option("--max-requests <n>", "Maximum requests per foreground run, 1..20")
      .option("--timeout-ms <n>", "Per-request deadline, 1000..30000")
      .option("--json", "JSON output")
      .action(opts => {
        try {
          if (verb !== "status") setExperiment(opts.config, verb === "enable", {
            ...(opts.maxRequests !== undefined ? {maxRequests: Number(opts.maxRequests)} : {}),
            ...(opts.timeoutMs !== undefined ? {timeoutMs: Number(opts.timeoutMs)} : {}),
          });
          printResult(true, experimentStatus(opts.config), 200);
        } catch (error) { printResult(true, {error: "experiment_config", message: error instanceof Error ? error.message : "unavailable"}, 400); }
      });
  }
  experimental.command("capture").description("Classify a selected archived capture; never captures a live terminal or changes its verdict")
    .requiredOption("--config <file>", "Explicit experiment configuration")
    .requiredOption("--input <file>", "Existing shadow JSONL archive (max 8 MiB)")
    .requiredOption("--output <file>", "New advisory JSONL result file; never overwrites input")
    .option("--json", "JSON output")
    .action(async opts => {
      let run: JevRun | undefined, fd: number | undefined;
      try {
        const deps = getDeps(), status = experimentStatus(opts.config, deps.workerRead);
        if (!status.enabled) { printResult(true, status, 200); return; }
        run = new JevRun(opts.config, deps.workerRead, deps.experimentEnv, deps.experimentFetch);
        const rows = readBounded(opts.input, 8 * 1024 * 1024).split("\n").filter(Boolean);
        fd = fs.openSync(opts.output, "wx", 0o600);
        process.once("SIGINT", run.stop); process.once("SIGTERM", run.stop);
        let inspected = 0, unavailable = 0;
        for (const line of rows.slice(0, run.config.maxRequests)) {
          if (run.stopped()) break;
          const result = await classifyCapture(run, JSON.parse(line));
          fs.writeFileSync(fd, JSON.stringify(result) + "\n"); inspected++;
          if (result.status === "unavailable" || result.result?.status === "unavailable") unavailable++;
        }
        printResult(true, {...run.status(), inspected, unavailable, remaining: rows.length - inspected, output: opts.output}, run.status().reason || unavailable ? 409 : 200);
      } catch { printResult(true, {error: "capture_experiment_unavailable", message: "No automatic retry; any existing output retains completed results."}, 409); }
      finally {
        if (fd !== undefined) fs.closeSync(fd);
        if (run) { process.removeListener("SIGINT", run.stop); process.removeListener("SIGTERM", run.stop); }
      }
    });

  for (const verb of ["candidates", "wake"] as const) {
    cmd.command(verb)
      .description(verb === "wake" ? "Run one bounded occupant wake with source-bound decisions or explicit Jev experiment; no registration" : "Read current source-bound candidates and eligible item IDs for the occupant")
      .requiredOption("--project <id>", "Selected configured project")
      .requiredOption("--taxonomy <file>", "Occupant-owned taxonomy/question YAML")
      .requiredOption("--classifier-version <version>", "Classifier version")
      .requiredOption("--evidence-epoch <epoch>", "Owner-authorized evidence epoch; candidate changes do not retry terminal attempts")
      .option("--decisions <file>", "JSON decisions bound to candidateSetVersion and each item's bodyHash")
      .option("--experiment <file>", "Opt-in experimental Jev config; replaces --decisions for one bounded wake")
      .option("--limit <count>", "Items per bounded wake (1..100)", "20")
      .option("--json", "JSON output")
      .action(async (opts: WakeOptions & {experiment?: string}) => {
        let run: JevRun | undefined;
        try {
          if (opts.experiment) {
            if (verb !== "wake" || opts.decisions) throw Error("--experiment is for wake only and cannot be combined with --decisions");
            const deps = getDeps(), status = experimentStatus(opts.experiment, deps.workerRead);
            if (!status.enabled) { printResult(true, status, 200); return; }
            run = new JevRun(opts.experiment, deps.workerRead, deps.experimentEnv, deps.experimentFetch);
            opts.limit = String(Math.min(Number(opts.limit), run.config.maxRequests));
            process.once("SIGINT", run.stop); process.once("SIGTERM", run.stop);
          }
        await withClient(getDeps(), async client => {
          try {
            const result = verb === "wake" ? await runProjectWake(client, opts, getDeps().workerRead, run ? {
              decide: prepared => streamDecision(run!, prepared), signal: run.controller.signal,
              shouldStop: run.stopped, timeoutMs: run.config.timeoutMs,
            } : undefined) : await prepareWorker(client, opts, getDeps().workerRead);
            console.log(JSON.stringify(run ? {...result, experiment: run.status()} : result));
            if ("result" in result && ["unavailable", "lease_lost"].includes(result.result.state)) process.exitCode = 1;
            if (run?.status().reason) process.exitCode = 1;
          } catch (error) { printResult(true, {error: "worker_unavailable", message: error instanceof Error ? error.message : "unavailable", phase: "prepare", nextWakeAt: new Date(Date.now() + 60_000).toISOString()}, 409); }
        });
        } catch (error) { printResult(true, {error: "experiment_unavailable", message: error instanceof Error ? error.message : "unavailable"}, 409); }
        finally { if (run) { process.removeListener("SIGINT", run.stop); process.removeListener("SIGTERM", run.stop); } }
      });
  }
  for (const verb of ["shadow-status", "shadow-drain", "shadow-stop"] as const) {
    const sub = cmd.command(verb).description("Inspect, drain or stop an explicitly configured private shadow sink; never enables capture");
    if (verb !== "shadow-status") sub.option("--actor <name>", "Attribute the request when operating outside a managed seat");
    sub.action(async (opts: { actor?: string }) => withClient(getDeps(), async client => {
      const result = verb === "shadow-status" ? await client.get("/api/projects/shadow") : await client.post(`/api/projects/shadow/${verb === "shadow-stop" ? "stop" : "drain"}`, opts.actor === undefined ? undefined : { actor: opts.actor });
      printResult(true, result.data, result.status);
    }));
  }

  // ---- Lease lifecycle ----

  cmd
    .command("lease-acquire")
    .description("Acquire the active classifier lease for the caller")
    .requiredOption("--session <session>", "Classifier session name")
    .option(
      "--evaluate-deadness-first",
      "Before acquire, call evaluateDeadness to clear any stale TTL-expired or dead-holder lease (per PRD § L2 deadness-detection)",
    )
    .option("--json", "JSON output for agents")
    .action(async (opts: { session: string; evaluateDeadnessFirst?: boolean; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/acquire", {
          classifierSession: opts.session,
          evaluateDeadnessFirst: opts.evaluateDeadnessFirst,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-heartbeat")
    .description("Send a heartbeat for an active classifier lease (extends TTL)")
    .requiredOption("--lease-id <id>", "Lease ID")
    .requiredOption("--session <session>", "Classifier session name")
    .option("--json", "JSON output for agents")
    .action(async (opts: { leaseId: string; session: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/lease/heartbeat", {
          leaseId: opts.leaseId,
          classifierSession: opts.session,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("lease-show")
    .description("Show the currently-active classifier lease")
    .option("--json", "JSON output for agents")
    .action(async (opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>("/api/projects/lease");
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Operator-verb reclaim ----

  cmd
    .command("reclaim-classifier")
    .description(
      "Operator-verb: reclaim the active classifier lease. Use --if-dead to refuse if holder is still alive.",
    )
    .requiredOption("--session <session>", "Session that will hold the new lease")
    .option("--if-dead", "Only reclaim if the current holder is reported dead by the liveness check")
    .option("--reason <text>", "Reclaim reason (free-form; recorded in classifier_leases.reclaim_reason)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { session: string; ifDead?: boolean; reason?: string; json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/reclaim-classifier", {
          byClassifierSession: opts.session,
          ifDead: opts.ifDead,
          reason: opts.reason,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- Project a stream item ----

  cmd
    .command("classify <streamItemId>")
    .description(
      "Project a stream item with classification fields (idempotent on stream_item_id; requires active lease)",
    )
    .requiredOption("--session <session>", "Classifier session name (must hold active lease)")
    .requiredOption("--lease-id <id>", "Lease ID this result was computed under (from lease-acquire); a replaced or expired lease is refused")
    .option("--attempt-id <id>", "Attempt ledger ID to mark written in the same transaction (omit for a manual classification)")
    .option("--execution-id <id>", "Execution ID from the attempt's begin (required with --attempt-id; a superseded execution is refused)")
    .option("--type <type>", "Classification type (e.g., idea, bug, feature-request)")
    .option("--urgency <urgency>", "Classification urgency (e.g., normal, high, critical)")
    .option("--maturity <maturity>", "Classification maturity (e.g., concept, drafted, ratified)")
    .option("--confidence <confidence>", "Classification confidence (e.g., low, medium, high)")
    .option("--destination <destination>", "Classification destination (downstream slice/seat)")
    .option("--action <action>", "Action type (e.g., create, advance)")
    .option("--area <area>", "Product area label")
    .option("--scope-ref <id>", "Mission/slice scope id (requires --candidate-set-version)")
    .option("--duplicate-of <streamItemId>", "Earlier stream item this one duplicates")
    .option("--needs-human <value>", "true | false (omit when unknown; unknown is not false)")
    .option("--classifier-version <v>", "Classifier version that produced the label")
    .option("--taxonomy-version <v>", "Taxonomy version the label uses")
    .option("--candidate-set-version <v>", "Version of the scope/roster candidate set the label was chosen from")
    .option("--json", "JSON output for agents")
    .action(async (streamItemId: string, opts: {
      session: string;
      leaseId: string;
      attemptId?: string;
      executionId?: string;
      area?: string;
      scopeRef?: string;
      duplicateOf?: string;
      needsHuman?: string;
      classifierVersion?: string;
      taxonomyVersion?: string;
      candidateSetVersion?: string;
      type?: string;
      urgency?: string;
      maturity?: string;
      confidence?: string;
      destination?: string;
      action?: string;
      json?: boolean;
    }) => {
      if (opts.needsHuman !== undefined && opts.needsHuman !== "true" && opts.needsHuman !== "false") {
        console.error("--needs-human must be true or false; omit it when unknown");
        process.exitCode = 1;
        return;
      }
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.post<unknown>("/api/projects/project", {
          streamItemId,
          classifierSession: opts.session,
          leaseId: opts.leaseId,
          attemptId: opts.attemptId,
          executionId: opts.executionId,
          area: opts.area,
          scopeRef: opts.scopeRef,
          duplicateOfStreamItemId: opts.duplicateOf,
          needsHuman: opts.needsHuman === undefined ? undefined : opts.needsHuman === "true",
          classifierVersion: opts.classifierVersion,
          taxonomyVersion: opts.taxonomyVersion,
          candidateSetVersion: opts.candidateSetVersion,
          classificationType: opts.type,
          classificationUrgency: opts.urgency,
          classificationMaturity: opts.maturity,
          classificationConfidence: opts.confidence,
          classificationDestination: opts.destination,
          action: opts.action,
        });
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  // ---- List + show ----

  cmd
    .command("list")
    .description("List project classifications with filters")
    .option("--session <session>", "Filter by classifier session")
    .option("--destination <destination>", "Filter by classification destination")
    .option("--area <area>", "Filter by area")
    .option("--scope-ref <id>", "Filter by scope ref")
    .option("--needs-human <value>", "Filter: true | false | unknown")
    .option("--limit <n>", "Result limit", "100")
    .option("--json", "JSON output for agents")
    .action(async (opts: { session?: string; destination?: string; area?: string; scopeRef?: string; needsHuman?: string; limit: string; json?: boolean }) => {
      const deps = getDeps();
      const params = new URLSearchParams();
      if (opts.session) params.set("classifierSession", opts.session);
      if (opts.destination) params.set("classificationDestination", opts.destination);
      if (opts.area) params.set("area", opts.area);
      if (opts.scopeRef) params.set("scopeRef", opts.scopeRef);
      if (opts.needsHuman) params.set("needsHuman", opts.needsHuman);
      if (opts.limit) params.set("limit", opts.limit);
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/list?${params.toString()}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  cmd
    .command("show <projectId>")
    .description("Show one project classification")
    .option("--json", "JSON output for agents")
    .action(async (projectId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      await withClient(deps, async (client) => {
        const res = await client.get<unknown>(`/api/projects/${encodeURIComponent(projectId)}`);
        printResult(opts.json ?? false, res.data, res.status);
      });
    });

  return cmd;
}
