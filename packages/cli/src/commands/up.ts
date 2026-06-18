import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError } from "../client.js";
import { getDaemonStatus, getDaemonUrl, startDaemon, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

const LONG_RUNNING_UP_TIMEOUT_MS = 120_000;

/** OPR.0.3.4.2 — default interactive [y/N] prompt for the awaiting-decision
 *  ASK (TTY only; tests inject promptYesNo instead). Default answer: No. */
async function defaultPromptYesNo(question: string): Promise<boolean> {
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// OPR.0.3.2.22 Bug 3 helper — mirrors cwd-resolution.isPathInsideRoot in
// the daemon so the CLI can decide whether a path-form sourceRef lives
// inside the daemon install root without importing the daemon package.
function isPathInsideRoot(candidate: string, root: string): boolean {
  const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !nodePath.isAbsolute(relative));
}

export function upCommand(
  depsOverride?: StatusDeps & {
    lifecycleDeps?: LifecycleDeps;
    preflightExec?: (cmd: string) => Promise<string>;
    /** OPR.0.3.4.2 — injectable [y/N] prompt for the awaiting-decision ASK
     *  (tests drive it; default = readline on stdin, offered on TTY only). */
    promptYesNo?: (question: string) => Promise<boolean>;
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
    .option("--fresh <seats...>", "Deliberately fresh-prime the named seats (logical ids) instead of resuming their original sessions (operation B; reported as fresh-primed)")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (source: string, opts: { plan?: boolean; yes?: boolean; cwd?: string; target?: string; existing?: boolean; fresh?: string[]; json?: boolean; host?: string }) => {
      const deps = getDepsF();

      if (opts.host) {
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const body = {
          sourceRef: source,
          plan: opts.plan,
          autoApprove: opts.yes,
          cwdOverride: opts.cwd,
          targetRoot: opts.target,
          existing: opts.existing,
          freshLogicalIds: opts.fresh,
        };
        const result = await runRemoteHttpOp(opts.host, "POST", "/api/up", body, deps, opts);
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
      // OPR.0.3.3.19 (AC-7): archived rigs are excluded from default `rig up`
      // name resolution. If <source> matches ONLY an archived rig (no active
      // rig of that name), refuse with an honest error pointing at
      // `rig unarchive` - never silently restore an archived rig, never
      // silently fall through. Applies to both default and --existing paths.
      if (isRigName) {
        const activeSummaries = await fetchRigSummaries();
        const activeMatch = activeSummaries.some((r) => r.name === source);
        if (!activeMatch) {
          try {
            const archRes = await client.get<Array<{ id: string; name: string }>>(
              "/api/rigs/summary?archived=only",
            );
            const archivedMatches = (archRes.data ?? []).filter((r) => r.name === source);
            if (archivedMatches.length > 0) {
              // `rig unarchive` resolves by rig ID, not name (it posts to
              // /api/rigs/<rigId>/unarchive), so the remediation MUST name the
              // id - telling the operator `rig unarchive <name>` would 404. If
              // the name is ambiguous across multiple archived rigs, surface the
              // id list rather than guessing a single target.
              const ids = archivedMatches.map((r) => r.id);
              if (opts.json) {
                console.log(JSON.stringify({
                  error: "rig_archived",
                  rig: source,
                  archivedRigIds: ids,
                  action: ids.length === 1
                    ? `rig unarchive ${ids[0]}`
                    : `rig unarchive <rigId> (archived rigs named '${source}': ${ids.join(", ")})`,
                }));
              } else if (ids.length === 1) {
                console.error(`Rig "${source}" is archived, so it is hidden from 'rig up' name resolution.`);
                console.error(`  Bring it back first: rig unarchive ${ids[0]}`);
                console.error(`  Then power it on:    rig up ${source}`);
              } else {
                console.error(`${ids.length} archived rigs are named "${source}"; they are hidden from 'rig up' name resolution.`);
                console.error(`  Unarchive the one you want by id (then 'rig up'):`);
                for (const id of ids) console.error(`    rig unarchive ${id}`);
              }
              process.exitCode = 1;
              return;
            }
          } catch {
            // Archived-summary probe failed (e.g. older daemon) - fall through
            // to normal resolution; there are no archive semantics to enforce.
          }
        }
      }
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

      // OPR.0.3.2.22 Bug 3 — extend the bare `rig up <builtin>` default-cwd
      // treatment to path-form. Builtin starter specs declare member-level
      // cwd: "." which resolves to the spec directory (inside the daemon's
      // install root). Without --cwd that trips getOpenRigInstallCwdError
      // at preflight. Bare-name form is already rescued at the
      // resolveLibrarySpec branch above (entry.sourceType === "builtin");
      // path-form `rig up <install-internal-spec>` is the remaining gap.
      //
      // Detection: source is path-form (not isRigName, not isRigBundle),
      // no --cwd was given, no defaultLibraryCwdOverride was set by the
      // bare-name branch above, AND the resolved path lives inside the
      // daemon's install root (fetched via /api/info). When all hold,
      // default cwdOverride to process.cwd() so the operator's project
      // dir is used as launch cwd, and print a one-line notice. If
      // /api/info is unavailable, fall through silently — the daemon
      // preflight will still surface the install-cwd error.
      //
      // Structural redesign of how builtin starter specs declare cwd is
      // out of scope (deferred to 0.3.3 per the slice triage).
      if (!opts.cwd && !isRigName && !isRigBundle && defaultLibraryCwdOverride === undefined) {
        try {
          // Short timeout: a healthy daemon answers /api/info in <100ms; if
          // it doesn't, fall through to the daemon's own preflight error
          // rather than adding a multi-second stall to every rig up.
          const infoRes = await client.get<{ installRoot?: string }>("/api/info", { timeoutMs: 2000 });
          const installRoot = infoRes.data?.installRoot;
          if (installRoot && isPathInsideRoot(sourceRef, installRoot)) {
            defaultLibraryCwdOverride = process.cwd();
            if (!opts.json) {
              console.log("Defaulting cwd to current directory because the spec lives inside the OpenRig install.");
            }
          }
        } catch {
          // /api/info unavailable — fall through. The daemon preflight
          // returns getOpenRigInstallCwdError if this is in fact the
          // install-internal case; the operator gets the same hint they
          // would have gotten pre-Bug-3.
        }
      }

      // OPR.0.3.4.4 — honest async: a client timeout / connection loss in
      // APPLY mode does NOT mean the operation failed; the daemon may still
      // be processing. Report in-progress/unknown with a verify command,
      // never a bare connection failure (the false-failure that caused the
      // outage's wrong next move). No operation id is surfaced client-side
      // on timeout today, so the honest message is the MVP floor.
      const printHonestTimeout = (err: DaemonConnectionError): void => {
        console.error(`The CLI timed out waiting for the daemon, but the operation may STILL BE IN PROGRESS.`);
        console.error(`This does not mean the operation failed; the daemon may still be processing it.`);
        console.error(`Verify the actual state with: rig ps`);
        console.error(`(underlying: ${err.message})`);
        process.exitCode = 1;
      };

      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/up", {
          sourceRef,
          plan: opts.plan ?? false,
          autoApprove: opts.yes ?? false,
          cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
          targetRoot,
          // OPR.0.3.4.2 — operation B opt-in seats (deliberate fresh-prime).
          freshLogicalIds: opts.fresh,
        }, opts.plan ? undefined : { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
      } catch (err) {
        if (err instanceof DaemonConnectionError && !opts.plan) {
          printHonestTimeout(err);
          return;
        }
        throw err;
      }

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

      // OPR.0.3.4.4 — read-only restore plan preview (`--plan` on the
      // existing-rig path). Renders intended per-seat actions; nothing ran.
      if (resStatus === "plan" && res.data["mode"] === "restore") {
        const planRigName = res.data["rigName"] as string | undefined;
        const planSnapshot = res.data["snapshot"] as { id: string; kind: string; createdAt: string } | null;
        console.log(`Plan: restore rig "${planRigName ?? source}" (read-only preview)`);
        if (planSnapshot) {
          console.log(`Snapshot: ${planSnapshot.id} (kind=${planSnapshot.kind}, captured ${planSnapshot.createdAt})`);
        } else if (res.data["wouldCaptureCurrentState"] === true) {
          console.log(`Snapshot: none usable — apply would first capture current DB state as an auto-rehydrate snapshot.`);
        }
        const planNodes = (res.data["nodes"] as Array<{ logicalId: string; intendedAction: string; reason?: string }>) ?? [];
        for (const n of planNodes) {
          console.log(`  ${n.logicalId}: ${n.intendedAction}${n.reason ? ` — ${n.reason}` : ""}`);
        }
        console.log("No changes made.");
        return;
      }

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
        const nodes = (res.data["nodes"] as Array<{ logicalId: string; status: string; error?: string }>) ?? [];
        for (const n of nodes) {
          // OPR.0.3.4.2 — the five-term vocabulary renders distinctly; the
          // awaiting-decision reason is part of the line (not a dead end).
          if (n.status === "awaiting-decision" && n.error) {
            console.log(`  ${n.logicalId}: awaiting-decision — ${n.error}`);
          } else {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
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

        // OPR.0.3.4.2 — the actionable ASK/offer for awaiting-decision seats.
        // TTY: interactive [y/N] per seat; accepted seats re-run as a
        // deliberate fresh-prime (operation B). Headless: the machine status
        // stays awaiting-decision with the explicit --fresh hint. NEVER an
        // auto-substitution.
        const awaiting = nodes.filter((n) => n.status === "awaiting-decision");
        if (awaiting.length > 0) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || Boolean(deps.promptYesNo);
          if (interactive) {
            const ask = deps.promptYesNo ?? defaultPromptYesNo;
            const accepted: string[] = [];
            for (const n of awaiting) {
              const reason = n.error ?? "original session unresumable";
              const yes = await ask(`Couldn't resume original session for ${n.logicalId} (reason: ${reason}). Start a fresh primed session instead? [y/N] `);
              if (yes) accepted.push(n.logicalId);
            }
            if (accepted.length > 0) {
              let freshRes: { status: number; data: Record<string, unknown> };
              try {
                freshRes = await client.post<Record<string, unknown>>("/api/up", {
                  sourceRef,
                  plan: false,
                  autoApprove: opts.yes ?? false,
                  cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
                  targetRoot,
                  freshLogicalIds: accepted,
                }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
              } catch (err) {
                if (err instanceof DaemonConnectionError) {
                  printHonestTimeout(err);
                  return;
                }
                throw err;
              }
              const freshNodes = (freshRes.data["nodes"] as Array<{ logicalId: string; status: string }>) ?? [];
              for (const n of freshNodes.filter((fn) => accepted.includes(fn.logicalId))) {
                console.log(`  ${n.logicalId}: ${n.status}`);
              }
            } else {
              console.log(`  No fresh sessions started. Re-run with --fresh <seat...> when you decide.`);
            }
          } else {
            for (const n of awaiting) {
              console.error(`  ${n.logicalId}: awaiting-decision — no session started. To deliberately fresh-prime: rig up --existing ${source} --fresh ${n.logicalId}`);
            }
          }
        }

        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted" || nodes.some((n) => n.status === "failed" || n.status === "awaiting-decision")) {
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
