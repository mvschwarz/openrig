import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, startDaemon, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;

export function upCommand(
  depsOverride?: StatusDeps & {
    lifecycleDeps?: LifecycleDeps;
    preflightExec?: (cmd: string) => Promise<string>;
  },
): Command {
  const cmd = new Command("up")
    .description("Launch a rig or managed app from a spec, library entry, or bundle")
    .addHelpText("after", `
Examples:
  rig up secrets-manager
  rig up ./rig.yaml
  rig up ./demo.rigbundle --target ~/work
`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<source>", "Path to a .yaml rig spec or .rigbundle, or a library name such as secrets-manager")
    .option("--plan", "Plan mode — preview without executing")
    .option("--yes", "Auto-approve trusted actions")
    .option("--cwd <path>", "Override launch working directory for all members for this run only")
    .option("--target <root>", "Target root directory for package installation (.rigbundle only; does not change agent cwd)")
    .option("--existing", "Treat <source> as an existing rig name; bypass library-spec name resolution")
    .option("--json", "JSON output for agents")
    .action(async (source: string, opts: { plan?: boolean; yes?: boolean; cwd?: string; target?: string; existing?: boolean; json?: boolean }) => {
      const deps = getDepsF();

      // Run preflight before auto-start
      let status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running") {
        let resolvedConfig: {
          daemon: { port: number; host: string };
          db: { path: string };
          transcripts: { enabled: boolean; path: string; lines: number; pollIntervalSeconds: number };
          workspace: { root: string };
        } | null = null;
        // bug-fix slice auth-bearer-tailscale-trust: track whether
        // daemon.host was operator-explicit (env or config file) vs
        // default-fallback. The daemon's multi-bind path (loopback +
        // tailscale auto-detect) only runs when OPENRIG_HOST is NOT
        // exported to the child, so we omit it on the default path.
        // Hoisted to function scope so the startDaemon block below can
        // read it after the preflight try-catch.
        let hostForDaemon: string | undefined;
        try {
          const { ConfigStore } = await import("../config-store.js");
          const { SystemPreflight } = await import("../system-preflight.js");
          const { execSync } = await import("node:child_process");
          const { OPENRIG_DIR } = await import("../daemon-lifecycle.js");
          const configStore = new ConfigStore();
          resolvedConfig = configStore.resolve();
          const hostResolution = configStore.resolveWithSource("daemon.host");
          hostForDaemon = hostResolution.source === "default"
            ? undefined
            : resolvedConfig.daemon.host;
          const preflightExec = depsOverride?.preflightExec ?? (async (cmd: string) =>
            execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }));
          const preflight = new SystemPreflight({
            exec: preflightExec,
            configStore,
            getDaemonStatus: () => getDaemonStatus(deps.lifecycleDeps),
            openrigHome: OPENRIG_DIR,
          });
          const preflightResult = await preflight.run();
          if (!preflightResult.ready) {
            for (const check of preflightResult.checks.filter((c) => !c.ok)) {
              console.error(`✗ ${check.name}: ${check.error}`);
              if (check.reason) console.error(`  Why: ${check.reason}`);
              if (check.fix) console.error(`  Fix: ${check.fix}`);
            }
            process.exitCode = 1;
            return;
          }
        } catch (preErr) {
          console.error(`Preflight error: ${preErr instanceof Error ? preErr.message : String(preErr)}`);
          process.exitCode = 1;
          return;
        }

        try {
          await startDaemon({
            port: resolvedConfig?.daemon.port,
            host: hostForDaemon,
            db: resolvedConfig?.db.path,
            transcriptsEnabled: resolvedConfig?.transcripts.enabled,
            transcriptsPath: resolvedConfig?.transcripts.path,
            transcriptsLines: resolvedConfig?.transcripts.lines,
            transcriptsPollIntervalSeconds: resolvedConfig?.transcripts.pollIntervalSeconds,
            workspaceRoot: resolvedConfig?.workspace.root,
          }, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }

      if (status.state !== "running" || status.healthy === false) {
        console.error("Daemon not running. Start it with: rig daemon start");
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      // Detect rig name vs file path: names don't contain / and don't end in .yaml/.yml/.rigbundle
      const isRigName = !source.includes("/") && !source.match(/\.(ya?ml|rigbundle)$/i);
      let sourceRef = isRigName ? source : nodePath.resolve(source);

      // If it looks like a name, check for library spec match
      let defaultLibraryCwdOverride: string | undefined;
      // Cache rig summaries so we can both detect ambiguity AND derive lifecycleState
      // for "Recovering ..." vs "Turning on ..." wording (post-L2).
      let rigSummariesCache: Array<{ id: string; name: string; lifecycleState?: string }> | null = null;
      const fetchRigSummaries = async () => {
        if (rigSummariesCache !== null) return rigSummariesCache;
        try {
          const res = await client.get<Array<{ id: string; name: string; lifecycleState?: string }>>("/api/rigs/summary");
          rigSummariesCache = res.data ?? [];
        } catch {
          rigSummariesCache = [];
        }
        return rigSummariesCache;
      };
      if (isRigName && !opts.existing) {
        try {
          const { resolveLibrarySpec } = await import("./specs.js");
          const entry = await resolveLibrarySpec(client, source, { kind: "rig" });
          // Library match found — check for existing-rig collision
          // Use /api/rigs/summary which mirrors findRigsByName (includes stopped rigs)
          const rigSummaries = await fetchRigSummaries();
          const rigMatches = rigSummaries.filter((r) => r.name === source);
          if (rigMatches.length > 0) {
            console.error(`'${source}' is ambiguous — it matches both an existing rig restore target and a library spec.`);
            console.error(`  To launch the library spec: rig up ${entry.sourcePath}`);
            console.error(`  The rig-name match refers to a stopped rig / snapshot-backed restore path.`);
            console.error(`  To power on the existing rig: rename or remove the library spec first, then retry.`);
            process.exitCode = 1;
            return;
          }
          sourceRef = entry.sourcePath;
          if (!opts.cwd && entry.kind === "rig" && entry.sourceType === "builtin") {
            defaultLibraryCwdOverride = process.cwd();
          }
        } catch (resolveErr) {
          // Ambiguity within library — surface it
          if ((resolveErr as Error).message?.includes("ambiguous")) {
            console.error((resolveErr as Error).message);
            process.exitCode = 1;
            return;
          }
          // Not found or other error — proceed with existing rig-name behavior
        }

        // Wording divergence (post-L2): if sourceRef stayed as the rig name we are
        // routing through the existing-rig restore path. Print "Recovering ..." or
        // "Turning on ..." per the rig's derived lifecycleState. Help text honesty:
        // "Recover" describes what `rig up` does; it does not promise success before
        // tester L4 VM proof completes.
        if (sourceRef === source && !opts.json) {
          const summaries = await fetchRigSummaries();
          const match = summaries.find((r) => r.name === source);
          if (match?.lifecycleState === "recoverable") {
            console.log(`Recovering rig "${source}" from latest snapshot or current DB state...`);
          } else if (match?.lifecycleState === "stopped") {
            console.log(`Turning on rig "${source}"...`);
          }
        }
      } else if (isRigName && opts.existing && !opts.json) {
        const summaries = await fetchRigSummaries();
        const match = summaries.find((r) => r.name === source);
        if (match?.lifecycleState === "recoverable") {
          console.log(`Recovering rig "${source}" from latest snapshot or current DB state...`);
        } else {
          console.log(`Turning on existing rig "${source}"...`);
        }
      }

      const isRigBundle = !isRigName && /\.rigbundle$/i.test(sourceRef);
      const targetRoot = opts.target ?? (isRigBundle ? process.cwd() : undefined);

      const res = await client.post<Record<string, unknown>>("/api/up", {
        sourceRef,
        plan: opts.plan ?? false,
        autoApprove: opts.yes ?? false,
        cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
        targetRoot,
      }, opts.plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        const rigResult = res.data["rigResult"] as string | undefined;
        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted") process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        if (code === "cycle_error") {
          console.error("Cycle detected in rig topology. Check edge definitions for circular dependencies.");
        } else if (code === "validation_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Rig spec validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: update your rig spec and retry.`);
        } else if (code === "preflight_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Preflight check failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: resolve the issues above and retry.`);
        } else if (code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data as RestoreNotAttemptedData);
        } else {
          const errorText = String(res.data["error"] ?? "unknown error");
          console.error(`Up failed: ${errorText} (HTTP ${res.status}). Check daemon logs or validate your spec with: rig spec validate <path>`);
          if (/agent_ref resolution failed|No agent\.yaml found/i.test(errorText)) {
            console.error("Hint: local: agent_ref paths resolve relative to the rig spec directory, not your shell cwd.");
            console.error("      Keep the agents/ tree beside the rig YAML, or switch those refs to path:/absolute/path.");
          }
        }
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      // Success output
      const resStatus = res.data["status"] as string;

      if (resStatus === "restored") {
        // Existing-rig power-on handoff
        const rigId = res.data["rigId"] as string;
        const rigName = res.data["rigName"] as string | undefined;
        const rigResult = res.data["rigResult"] as string | undefined;
        const snapshotKind = res.data["snapshotKind"] as string | undefined;
        // L3b: when the daemon falls back to a non-auto-pre-down snapshot, surface
        // the kind so operators see the manual fallback explicitly. The note is
        // printed BEFORE the "Rig restored" line so it's visible in the typical
        // top-of-output scan.
        if (snapshotKind && snapshotKind !== "auto-pre-down") {
          console.log(`Restoring from manual snapshot (kind=${snapshotKind}); no auto-pre-down snapshot available.`);
        }
        console.log(`Rig "${rigName ?? rigId}" restored (ID: ${rigId})`);
        if (rigResult) console.log(`Result: ${rigResult}`);
        const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
        for (const n of nodes) {
          console.log(`  ${n.logicalId}: ${n.status}`);
        }
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  warning: ${w}`);
        }
        // Attach command from server response (uses real canonical session name)
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }
        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted" || nodes.some((n) => n.status === "failed")) {
          process.exitCode = 1;
        }
      } else {
        // Fresh boot handoff
        const stages = (res.data["stages"] as Array<{ stage: string; status: string }>) ?? [];
        for (const s of stages) {
          console.log(`  ${s.stage}: ${s.status}`);
        }

        const rigId = res.data["rigId"] as string | undefined;
        if (rigId) {
          console.log(`\nRig: ${rigId}`);
          // Dashboard — use rig ui open (knows the real UI URL)
          console.log(`Dashboard: rig ui open`);
        }
        console.log(`Status: ${resStatus}`);

        // Surface warnings (e.g. transcript attach failures)
        const warnings = (res.data["warnings"] as string[]) ?? [];
        for (const w of warnings) {
          console.error(`  warning: ${w}`);
        }

        // Attach command from server response
        const attachCommand = res.data["attachCommand"] as string | undefined;
        if (attachCommand) {
          console.log(`Attach: ${attachCommand}`);
        }

        if (resStatus === "partial") process.exitCode = 1;
      }
    });

  return cmd;
}

interface RestoreBlocker {
  code: string;
  severity?: string;
  logicalId?: string;
  nodeId?: string;
  target?: string;
  path?: string;
  message: string;
  remediation: string;
}

interface RestoreNotAttemptedData {
  error?: string;
  rigResult?: string;
  blockers?: RestoreBlocker[];
}

function printRestoreNotAttempted(data: RestoreNotAttemptedData): void {
  console.error(`Restore blocked: ${data.error ?? "pre-restore validation failed"}`);
  if (data.rigResult) {
    console.error(`Result: ${data.rigResult}`);
  }
  for (const blocker of data.blockers ?? []) {
    const scope = blocker.logicalId ?? blocker.nodeId ?? blocker.target ?? blocker.code;
    console.error(`  ${scope}: ${blocker.message}`);
    if (blocker.path) console.error(`    path: ${blocker.path}`);
    console.error(`    remediation: ${blocker.remediation}`);
  }
}
