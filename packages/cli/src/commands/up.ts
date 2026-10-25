import nodePath from "node:path";
import { isGitHubBundleLink, importGitHubBundle, bundleIdentityLines, printBundleLinkError } from "../lib/bundle-source.js";
import { getCliVersion, bundleRoutingSummary, bundleInstallError, startupAttentionSummary } from "./bundle.js";
import { showBundleBehaviourBeforeAction } from "../bundle-behaviour.js";
import { resolveEffectiveHost } from "../host-selection.js";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseYamlDoc } from "yaml";
import { Command } from "commander";
import { DaemonClient, DaemonConnectionError, DaemonTimeoutError } from "../client.js";
import { getDaemonStatus, getDaemonUrl, startDaemon, type LifecycleDeps, daemonStatusGuard } from "../daemon-lifecycle.js";
import { shouldAutoStartDaemon } from "../daemon-reachability.js";
import { prepareDaemonAutoStart } from "../daemon-auto-start.js";
import { freshSeatCommand, launchFreshSeat } from "../fresh-seat-command.js";
import type { StartOptions } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { formatThreePart, type ThreePartRejection } from "./workflow-errors.js";

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
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(relative));
}

// #226 — mirrors cwd-resolution.isFilesystemRoot in the daemon.
function isFilesystemRoot(cwd: string): boolean {
  const resolved = nodePath.resolve(cwd);
  return resolved === nodePath.parse(resolved).root;
}

const RENAME_REFUSAL = "--name applies to a new launch from a rig spec or bundle. An existing rig is restored under its own name; renaming an existing rig is not supported.";
const HOST_RENAME_REFUSAL = "--name over --host needs a spec path or bundle file, not a bare spec or rig name: pass the spec path or bundle file with --name.";

/** The mistakes the daemon would refuse in an env: block, caught before anything is sent. */
function checkEnvAssignment(assignment: string): string | null {
  const eq = assignment.indexOf("=");
  if (eq <= 0) return `expects KEY=VALUE, got "${assignment}"`;
  const name = assignment.slice(0, eq);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) return `"${name}" is not a valid name; names match ^[A-Z_][A-Z0-9_]*$`;
  if (name.startsWith("OPENRIG_")) return `"${name}" is reserved; OPENRIG_* names belong to OpenRig`;
  const value = assignment.slice(eq + 1);
  if (value === "") return `${name}: value must not be empty`;
  if (value.includes("\0")) return `${name}: value must not contain a NUL byte`;
  return null;
}

// OPR.0.4.4.11 (arch return R11-2) — pre-dispatch detection of a topology
// source for the --host rejection. Mirrors the daemon's FR-1 detection
// contract without importing the daemon package: `.rigtopology` extension,
// or a readable path-form YAML document with a top-level `rigs:` LIST.
export function sourceLooksLikeTopology(source: string): boolean {
  if (/\.rigtopology$/i.test(source)) return true;
  // Name-form sources (no slash, no known extension) keep rig-name
  // semantics — never sniffed (same precedence as the daemon router).
  if (!source.includes("/") && !source.match(/\.(ya?ml)$/i)) return false;
  try {
    const p = nodePath.resolve(source);
    if (!existsSync(p)) return false;
    const parsed: unknown = parseYamlDoc(readFileSync(p, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    return Array.isArray((parsed as Record<string, unknown>)["rigs"]);
  } catch {
    return false; // unreadable/unparseable — existing flows own the error
  }
}

/** #1654: a plan creates or changes no rig or seat, so a plan the daemon didn't answer is safe to run again, locally
 *  or with --host. Reported in place of the unknown-outcome guidance, which stays for writes. */
const PLAN_NOT_ANSWERED = "A plan doesn't create or change any rig or seat, so it's safe to run again. If the daemon stays slow, check it with: rig status";
function reportPlanNotAnswered(fact: string, error: string, json: boolean | undefined, extra: Record<string, unknown> = {}): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, ...extra, error, plan: true, changed: false, message: PLAN_NOT_ANSWERED }));
  } else {
    console.error(fact);
    console.error(PLAN_NOT_ANSWERED);
  }
  process.exitCode = 1;
}

export const HOST_TOPOLOGY_REJECTION =
  "rig up --host cannot take a topology source: per-entry 'host:' in the manifest is the ONLY placement mechanism for topologies (two placement mechanisms must not coexist). Put 'host: <id>' on the entries you want placed remotely and run 'rig up <topology>' without --host.";

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
  rig up ./rig.yaml --name alpha
  rig up ./demo.rigbundle --target ~/work

An existing rig's name restores that rig from its automatically selected usable
snapshot, resuming seats where their harness allows; it refuses while any of its seats is live. A spec
whose rig name already exists starts a new team in place of the stopped one, which
is archived, and refuses if the old one may still be running. To bring a stopped
team back with its conversations, run rig up <rig-name> --existing, not the spec.
`);
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .argument("<source>", "GitHub bundle link, path to a .yaml rig spec or .rigbundle, or a library name such as secrets-manager")
    .option("--non-interruptive", "Accept harness first-launch warnings for this rig at full bypass; saved for later launches")
    .option("--no-non-interruptive", "Turn off this rig's saved warning-acceptance choice (stop an existing rig with rig down first)")
    .option("--plan", "Plan mode — preview without executing")
    .option("--yes", "Auto-approve trusted actions")
    .option("--cwd <path>", "Override launch working directory for all members for this run only")
    .option("--env <KEY=VALUE>", "Set a launch environment variable on every seat for this run only; repeatable. Not saved: a later restore uses the spec's env: block. Values are visible to local processes, so never pass secrets", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--name <rig>", "Launch the spec as a rig with this name instead of its name: field; the rig keeps it for --existing, snapshots and restore. The spec file is not changed")
    .option("--target <root>", "Install target for a .rigbundle (default: current directory). A v2 bundle is materialized there and relative member cwds resolve against it; --cwd still overrides launch cwd")
    .option("--preset <name>", "For a GitHub bundle link, choose a declared configuration")
    .option("--seat <member=runtime>", "For a GitHub bundle link, choose a declared seat runtime; repeatable", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--existing", "Treat <source> as an existing rig name; bypass library-spec name resolution")
    .option("--fresh <seats...>", "Deliberately fresh-prime the named seats (logical ids) instead of resuming their original sessions (operation B; reported as fresh-primed)")
    .option("--json", "JSON output for agents")
    .option("--host <id>", "Run on a remote host declared in ~/.openrig/hosts.yaml")
    .action(async (source: string, opts: { nonInterruptive?: boolean; plan?: boolean; yes?: boolean; cwd?: string; env?: string[]; name?: string; target?: string; existing?: boolean; fresh?: string[]; json?: boolean; host?: string; preset?: string; seat?: string[] }) => {
      // OPR.0.4.6.MH1 FR-2: selected-host routing — explicit --host wins;
      // else the persisted selection feeds the SHIPPED --host path; no
      // selection = today exactly. Topology
      // sources are EXEMPT: per-entry host: is the only topology placement
      // (shipped R11-2); implicit selection must not turn a flagless
      // topology up into the rejected --host form.
      if (!sourceLooksLikeTopology(source)) opts.host = resolveEffectiveHost(opts.host);
      const deps = getDepsF();
      const envOverride: Record<string, string> = {};
      for (const assignment of opts.env ?? []) {
        const problem = checkEnvAssignment(assignment);
        if (problem) {
          console.error(`--env ${problem}`);
          process.exitCode = 1;
          return;
        }
        const eq = assignment.indexOf("=");
        const name = assignment.slice(0, eq);
        // A seat's Claude or Codex home comes from env: in the spec, which restore, handover and status all read.
        if (name === "CLAUDE_CONFIG_DIR" || name === "CODEX_HOME") {
          console.error(`--env ${name} isn't applied: a seat's runtime home comes from env: in its rig spec (member or rig), so a restore, a handover and rig seat status all agree. Declare it there.`);
          continue;
        }
        envOverride[name] = assignment.slice(eq + 1);
      }
      const envOverrideBody = Object.keys(envOverride).length > 0 ? envOverride : undefined;
      if (envOverrideBody && sourceLooksLikeTopology(source)) {
        console.error("--env applies to a new launch from one rig spec or bundle. A topology launches several rigs from their own specs; put env: in each rig's spec instead.");
        process.exitCode = 1;
        return;
      }
      const rigName = opts.name;
      if (rigName !== undefined) {
        const problem = rigName === "" ? "--name needs a rig name."
          : sourceLooksLikeTopology(source) ? "--name applies to a new launch from one rig spec or bundle. A topology launches several rigs from their own specs; each takes its spec's name."
          : isGitHubBundleLink(source) ? "--name is not supported for a GitHub bundle link yet. Download the bundle and run rig up <file>.rigbundle --name <rig>, or launch without --name."
          : null;
        if (problem) {
          console.error(problem);
          process.exitCode = 1;
          return;
        }
      }

      // Link preparation verifies the effective endpoint before fetch or local auto-start.
      // Existing path/name dispatch below is unchanged.
      if (isGitHubBundleLink(source)) {
        try {
          const imported = await importGitHubBundle(source, deps, opts);
          if (imported.res.status >= 400) {
            if (opts.json) console.log(JSON.stringify(imported.res.data)); else console.error(imported.res.data.error ?? "Create failed");
            process.exitCode = 2; return;
          }
          const behaviour = await showBundleBehaviourBeforeAction(() => imported.client.post<Record<string, unknown>>(
            "/api/bundles/inspect", { bundlePath: imported.bundlePath },
          ));
          let installed: { status: number; data: Record<string, unknown> };
          try {
            installed = await imported.client.post<Record<string, unknown>>("/api/bundles/install", {
              bundlePath: imported.bundlePath, plan: opts.plan ?? false, autoApprove: opts.yes ?? false, nonInterruptive: opts.nonInterruptive,
              targetRoot: opts.target ? nodePath.resolve(opts.target) : process.cwd(),
              cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : undefined,
              envOverride: envOverrideBody,
              cliVersion: getCliVersion(),
            }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
          } catch {
            throw new Error(`Bundle install outcome is unknown. Archive retained at ${imported.bundlePath}; check rig ps and rig bundle history before retrying.`);
          }
          const { source: builtSource, configurationId, packageDigest, archiveHash, assembler } = imported.res.data;
          const data = { ...installed.data, source: builtSource, configurationId, packageDigest, archiveHash, assembler, ...(behaviour ? { behaviour } : {}) };
          if (opts.json) console.log(JSON.stringify(data));
          else {
            for (const line of bundleIdentityLines(data)) console.log(line);
            console.log(`Status: ${installed.data.status ?? (installed.status >= 400 ? "not attempted" : "unknown")}`);
            for (const line of startupAttentionSummary(installed.data)) console.log(line);
            if (installed.data.rigId) console.log(`Rig: ${installed.data.rigId}`);
            for (const line of bundleRoutingSummary(installed.data)) console.log(line);
            for (const warning of (installed.data.warnings as string[] | undefined) ?? []) console.warn(warning);
            if (installed.status >= 400) console.error(bundleInstallError(installed.data, false));
          }
          if (installed.status >= 400 || ["failed", "partial", "partially_restored", "not_attempted"].includes(String(installed.data.status ?? installed.data.rigResult))) process.exitCode = installed.status === 409 ? 1 : 2;
        } catch (err) { printBundleLinkError(err, opts.json); }
        return;
      }

      if (opts.host) {
        // OPR.0.4.4.11 R11-2: --host + topology source is REJECTED before
        // any dispatch — per-entry 'host:' is the only topology placement
        // mechanism. The daemon route carries the same rejection on its
        // public write path (double-sided enforcement, arch ruling 4).
        if (sourceLooksLikeTopology(source)) {
          if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: HOST_TOPOLOGY_REJECTION, code: "host_flag_topology" }));
          } else {
            console.error(HOST_TOPOLOGY_REJECTION);
          }
          process.exitCode = 1;
          return;
        }
        // The remote daemon restores a bare rig name from its own spec, so there is no launch for --env.
        if (envOverrideBody && !source.includes("/") && !/\.(ya?ml|rigbundle|rigtopology)$/i.test(source)) {
          console.error("--env applies to a new launch from a rig spec or bundle. A restore keeps the rig's own env: block; to change it, edit env: in the spec and launch again.");
          process.exitCode = 1;
          return;
        }
        if (rigName !== undefined && !source.includes("/") && !/\.(ya?ml|rigbundle|rigtopology)$/i.test(source)) {
          console.error(HOST_RENAME_REFUSAL);
          process.exitCode = 1;
          return;
        }
        const { runRemoteHttpOp } = await import("../remote-host-ops.js");
        const body = {
          sourceRef: source,
          plan: opts.plan,
          autoApprove: opts.yes, nonInterruptive: opts.nonInterruptive,
          cwdOverride: opts.cwd,
          envOverride: envOverrideBody,
          rigName,
          targetRoot: opts.target,
          existing: opts.existing,
          freshLogicalIds: opts.fresh,
        };
        const behaviour = /\.rigbundle$/i.test(source) && !opts.existing
          ? await showBundleBehaviourBeforeAction(async () => {
            const inspected = await runRemoteHttpOp(opts.host!, "POST", "/api/bundles/inspect", { bundlePath: source }, deps, opts);
            return { status: inspected.ok ? 200 : 500, data: (inspected.data ?? { error: inspected.error }) as Record<string, unknown> };
          }) : undefined;
        const result = await runRemoteHttpOp(opts.host, "POST", "/api/up", body, deps, { ...opts, timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS });
        if (behaviour) result.data = { ...(result.data as Record<string, unknown> | undefined), behaviour };
        if (opts.plan && !result.ok && result.outcomeUnknown) {
          const rest: Record<string, unknown> = { ...result };
          delete rest["outcomeUnknown"];
          reportPlanNotAnswered(`The daemon on host ${opts.host} didn't answer the plan${result.error ? `: ${result.error}` : ""}`, result.error ?? "no answer", opts.json, rest);
          return;
        }
        if (opts.json) {
          console.log(JSON.stringify(result));
          if (!result.ok) process.exitCode = 1;
        } else if (result.ok) {
          console.log(JSON.stringify(result.data, null, 2));
        } else {
          for (const line of formatRemoteUpFailure(opts.host, result)) console.error(line);
          process.exitCode = 1;
        }
        return;
      }

      // Run preflight before auto-start
      let status = await getDaemonStatus(deps.lifecycleDeps);
      // A plan is a preview. The daemon computes it, but starting a daemon here would also boot its kernel's agents and
      // spend their model turns, so --plan never starts one. Only a daemon the probe found absent is "not running"; a
      // blocked or unconfirmed probe keeps the status guard's own guidance below.
      if (opts.plan && (status.state === "stopped" || status.state === "stale")) {
        const fact = "rig up --plan asks the daemon for the plan, and no daemon is running for this OpenRig home. A preview doesn't start one, because starting a daemon also starts its kernel's agents.";
        const how = "Start it with rig daemon start (its kernel's agents start too) or rig daemon start --no-kernel (no agents), then run the plan again. Or run rig up without --plan to start everything and launch.";
        if (opts.json) console.log(JSON.stringify({ ok: false, code: "daemon_not_running", error: fact, plan: true, changed: false, message: how }));
        else { console.error(fact); console.error(how); }
        process.exitCode = 1;
        return;
      }
      // A busy daemon of this home gets the request instead of a start attempt (shouldAutoStartDaemon).
      if (!opts.plan && shouldAutoStartDaemon(status)) {
        let startOptions: StartOptions;
        try {
          const prepared = await prepareDaemonAutoStart(deps.lifecycleDeps, depsOverride?.preflightExec);
          startOptions = prepared.options;
          const preflightResult = prepared.preflight;
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
          await startDaemon(startOptions, deps.lifecycleDeps);
          status = await getDaemonStatus(deps.lifecycleDeps);
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err));
          process.exitCode = 2;
          return;
        }
      }

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));

      // Detect rig name vs file path: names don't contain / and don't end in
      // .yaml/.yml/.rigbundle/.rigtopology. OPR.0.4.4.11 (guard G-1): the
      // topology extension resolves as a PATH (same as yaml/rigbundle) so a
      // bare `factory.rigtopology` reaches the daemon's topology routing
      // instead of library/existing-rig name resolution. Extensionless
      // no-slash sources keep rig_name precedence byte-for-byte.
      const isRigName = !source.includes("/") && !source.match(/\.(ya?ml|rigbundle|rigtopology)$/i);
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
      const refuseArchivedName = async (name: string): Promise<boolean> => {
        const activeSummaries = await fetchRigSummaries();
        const activeMatch = activeSummaries.some((r) => r.name === name);
        if (!activeMatch) {
          try {
            const archRes = await client.get<Array<{ id: string; name: string }>>(
              "/api/rigs/summary?archived=only",
            );
            const archivedMatches = (archRes.data ?? []).filter((r) => r.name === name);
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
                  rig: name,
                  archivedRigIds: ids,
                  action: ids.length === 1
                    ? `rig unarchive ${ids[0]}`
                    : `rig unarchive <rigId> (archived rigs named '${name}': ${ids.join(", ")})`,
                }));
              } else if (ids.length === 1) {
                console.error(`Rig "${name}" is archived, so it is hidden from 'rig up' name resolution.`);
                console.error(`  Bring it back first: rig unarchive ${ids[0]}`);
                console.error(`  Then power it on:    rig up ${name}`);
              } else {
                console.error(`${ids.length} archived rigs are named "${name}"; they are hidden from 'rig up' name resolution.`);
                console.error(`  Unarchive the one you want by id (then 'rig up'):`);
                for (const id of ids) console.error(`    rig unarchive ${id}`);
              }
              process.exitCode = 1;
              return true;
            }
          } catch {
            // Archived-summary probe failed (e.g. older daemon) - fall through
            // to normal resolution; there are no archive semantics to enforce.
          }
        }
        return false;
      };
      // A restore brings the rig back from its own spec, so there is no launch to apply --env to.
      const refuseEnvOnRestore = (): boolean => {
        if (!envOverrideBody) return false;
        console.error("--env applies to a new launch from a rig spec or bundle. A restore keeps the rig's own env: block; to change it, edit env: in the spec and launch again.");
        process.exitCode = 1;
        return true;
      };
      // A restore brings the rig back under its own name; renaming an existing rig is out of scope.
      const refuseNameOnRestore = (): boolean => {
        if (rigName === undefined) return false;
        console.error(RENAME_REFUSAL);
        process.exitCode = 1;
        return true;
      };
      if (isRigName && opts.existing && refuseNameOnRestore()) return;
      // With --name a bare name can only mean a library spec to launch under the new name, so a rig of the
      // same name, running or archived, does not make it ambiguous; with no library match the restore refuses --name.
      const launchingUnderNewName = rigName !== undefined;
      if (isRigName && !launchingUnderNewName && await refuseArchivedName(source)) return;
      if (isRigName && !opts.existing) {
        try {
          const { resolveLibrarySpec } = await import("./specs.js");
          const entry = await resolveLibrarySpec(client, source, { kind: "rig" });
          // Library match found — check for existing-rig collision
          // Use /api/rigs/summary which mirrors findRigsByName (includes stopped rigs)
          const rigSummaries = await fetchRigSummaries();
          // An alias must not bypass the canonical name's existing/archive checks.
          const resolvedName = source === "first-project" && entry.name === "starter" && entry.sourceType === "builtin"
            ? entry.name : source;
          if (!launchingUnderNewName && resolvedName !== source && await refuseArchivedName(resolvedName)) return;
          const rigMatches = launchingUnderNewName ? [] : rigSummaries.filter((r) => r.name === source || r.name === resolvedName);
          if (rigMatches.length > 0) {
            console.error(`'${source}' is ambiguous — it matches both an existing rig restore target and a library spec.`);
            console.error(`  To launch the library spec: rig up ${entry.sourcePath}`);
            console.error(`  The rig-name match refers to a stopped rig / snapshot-backed restore path.`);
            console.error(`  To recover the existing rig instead of importing a starter: rig up ${rigMatches[0]!.name} --existing`);
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
        if (sourceRef === source && (refuseEnvOnRestore() || refuseNameOnRestore())) return;
        if (sourceRef === source && !opts.json) {
          const summaries = await fetchRigSummaries();
          const match = summaries.find((r) => r.name === source);
          if (match?.lifecycleState === "recoverable") {
            console.log(`Recovering rig "${source}" from latest snapshot or current DB state...`);
          } else if (match?.lifecycleState === "stopped") {
            console.log(`Turning on rig "${source}"...`);
          }
        }
      } else if (isRigName && opts.existing && refuseEnvOnRestore()) {
        return;
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
      const targetRoot = opts.target ? nodePath.resolve(opts.target) : (isRigBundle ? process.cwd() : undefined);

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

      // #226 — the launch continues, but a cwd this command chose (not an explicit --cwd) that is the
      // filesystem root puts every agent's project files there, which is rarely what the person meant.
      if (defaultLibraryCwdOverride !== undefined && isFilesystemRoot(defaultLibraryCwdOverride)) {
        console.error(`warning: launching in ${defaultLibraryCwdOverride} because it is your current directory. Agents write their project files (.claude/, .mcp.json and similar) in their working directory, and some may fail if it isn't writable. To launch in your project, run rig up again from it or pass --cwd <project dir>.`);
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

      const behaviour = isRigBundle ? await showBundleBehaviourBeforeAction(() => client.post<Record<string, unknown>>(
        "/api/bundles/inspect", { bundlePath: sourceRef },
      )) : undefined;
      let res: { status: number; data: Record<string, unknown> };
      try {
        res = await client.post<Record<string, unknown>>("/api/up", {
          sourceRef,
          plan: opts.plan ?? false,
          autoApprove: opts.yes ?? false, nonInterruptive: opts.nonInterruptive,
          cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : defaultLibraryCwdOverride,
          envOverride: envOverrideBody,
          rigName,
          targetRoot,
          // OPR.0.3.4.2 — operation B opt-in seats (deliberate fresh-prime).
          freshLogicalIds: opts.fresh,
        }, { timeoutMs: LONG_RUNNING_UP_TIMEOUT_MS }); // #1654: a plan runs an apply's preflight, Codex profile probes included
      } catch (err) {
        if (err instanceof DaemonConnectionError && !opts.plan) {
          printHonestTimeout(err);
          return;
        }
        if (opts.plan && (err instanceof DaemonTimeoutError || (err instanceof DaemonConnectionError && err.writeOutcome === "unknown"))) {
          reportPlanNotAnswered(`The daemon didn't answer the plan (${err.message}).`, err.message, opts.json);
          return;
        }
        throw err;
      }

      if (behaviour) res.data = { ...res.data, behaviour };

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        const rigResult = res.data["rigResult"] as string | undefined;
        if (rigResult === "partially_restored" || rigResult === "failed" || rigResult === "not_attempted") process.exitCode = 1;
        return;
      }

      // OPR.0.4.4.11 — topology aggregate rendering (full success OR honest
      // partial; the daemon returns the same closed {rigRef, host, status,
      // error?} entries either way, skipped entries explicitly present).
      const topoEntries = res.data["entries"] as Array<{ rigRef: string; host: string; status: string; error?: string }> | undefined;
      if (typeof res.data["topology"] === "string" && Array.isArray(topoEntries)) {
        const topoOk = res.data["ok"] === true;
        console.log(
          topoOk
            ? `Topology up: all ${topoEntries.length} rigs launched.`
            : "Topology up FAILED — honest partial state (started rigs stay up; no rollback):",
        );
        for (const e of topoEntries) {
          const tag = e.status === "ok" ? " ok " : e.status === "failed" ? "FAIL" : "skip";
          console.log(`  [${tag}] ${e.rigRef} @ ${e.host}${e.error ? ` — ${e.error}` : ""}`);
        }
        if (!topoOk) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const code = res.data["code"] as string | undefined;
        const error = res.data["error"] as Partial<ThreePartRejection> | null | undefined;
        if (error && typeof error === "object" && typeof error.fact === "string"
          && typeof error.consequence === "string" && typeof error.action === "string") {
          for (const line of formatThreePart(error as ThreePartRejection)) console.error(line);
          const nodes = res.data["attentionNodes"] as Array<{ logicalId: string; sessionName?: string; reason: string }> | undefined;
          for (const node of nodes ?? []) {
            console.error(`  ${node.logicalId}${node.sessionName ? ` (${node.sessionName})` : ""}: ${node.reason}`);
          }
        } else if (code === "cycle_error") {
          console.error("Cycle detected in rig topology. Check edge definitions for circular dependencies.");
        } else if (code === "validation_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Rig spec validation failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: update your rig spec and retry.`);
        } else if (code === "preflight_failed") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Preflight check failed:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: resolve the issues above and retry.`);
        } else if (code === "pre_restore_validation_failed") {
          printRestoreNotAttempted(res.data as RestoreNotAttemptedData);
        } else if (code === "invalid_topology_manifest") {
          const errors = (res.data["errors"] as string[]) ?? [];
          console.error(`Topology manifest invalid:\n${errors.map((e) => `  ${e}`).join("\n")}\nFix: the manifest key set is CLOSED — rigs[]{source, host?} plus optional concurrency.`);
        } else if (code === "rig_name_running" || code === "generation_unconfirmed" || code === "compose_project_conflict") {
          // S5b final-fix F1 (OPR.0.5.4.11): the guard's teaching refusal is
          // self-describing (running rig identity, what was checked,
          // nothing-created, alternatives) — render it verbatim, never the
          // generic unknown-error/validate-your-spec fallback. #141's
          // generation_unconfirmed refusal is self-describing the same way.
          const teaching = bundleInstallError(res.data, false);
          console.error(teaching);
        } else {
          const errorText = bundleInstallError(res.data, false);
          console.error(`Up failed: ${errorText} (HTTP ${res.status}). Check daemon logs or validate your spec with: rig spec validate <path>`);
          if (/agent_ref resolution failed|No agent\.yaml found/i.test(errorText)) {
            console.error("Hint: local: agent_ref paths resolve relative to the rig spec directory, not your shell cwd.");
            console.error("      Keep the agents/ tree beside the rig YAML, or switch those refs to path:/absolute/path.");
          }
        }
        // File disposition and generation recovery matter on every failure,
        // including validation and preflight refusals after materialization.
        for (const warning of (res.data["warnings"] as string[]) ?? []) console.error(`  warning: ${warning}`);
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
        const planNodes = (res.data["nodes"] as Array<{ logicalId: string; intendedAction: string; reason?: string; tokenState?: string; provenance?: string | null; lastVerified?: string | null; freshRequired?: boolean; runtimePrompt?: string }>) ?? [];
        for (const n of planNodes) {
          console.log(`  ${n.logicalId}: ${n.intendedAction}${n.reason ? ` — ${n.reason}` : ""}`);
          // OPR.0.4.3.20 FR-6 — per-seat token truth: present/missing/stale/unverified
          // + provenance + freshness + expected runtime prompt + explicit --fresh.
          if (n.tokenState) {
            const reverify = (n.tokenState === "stale" || n.tokenState === "unverified") ? " — re-verify" : "";
            const prov = n.provenance ? ` (${n.provenance})` : "";
            const verified = n.lastVerified ? `, verified ${n.lastVerified}` : "";
            const fresh = n.freshRequired ? "; --fresh required" : "";
            const prompt = n.runtimePrompt ? `; ${n.runtimePrompt}` : "";
            console.log(`      token: ${n.tokenState}${reverify}${prov}${verified}${fresh}${prompt}`);
          }
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
          // awaiting-decision reason is part of the line (not a dead end), and so is a failed seat's (such as a seat held
          // back for a missing startup file, with its fix).
          if ((n.status === "awaiting-decision" || n.status === "failed" || n.status === "left_attached") && n.error) {
            console.log(`  ${n.logicalId}: ${n.status} — ${n.error}`);
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
              // Each accepted seat starts alone, as the printed command does: a whole-rig restore naming it
              // is refused while the siblings this restore resumed are running.
              for (const id of accepted) {
                const launched = await launchFreshSeat(client, id, rigName ?? source);
                (launched.ok ? console.log : console.error)(`  ${id}: ${launched.message}`);
                if (launched.guidance) console.error(`    ${launched.guidance}`);
              }
            } else {
              console.log(`  No fresh sessions started. When you decide, start a seat fresh with:`);
              for (const n of awaiting) console.log(`    ${freshSeatCommand(n.logicalId, rigName ?? source)}`);
            }
          } else {
            for (const n of awaiting) {
              console.error(`  ${n.logicalId}: awaiting-decision — no session started. To deliberately fresh-prime: ${freshSeatCommand(n.logicalId, rigName ?? source)}`);
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
        // A seat that failed to launch says why (its named error), as --json already carries it: in the import stage's
        // result, or at the top level.
        type NodeResult = { logicalId: string; status: string; error?: string };
        const importDetail = stages.find((s) => s.stage === "import_rig") as { detail?: { nodes?: NodeResult[]; result?: { nodes?: NodeResult[] } } } | undefined;
        const launchNodes = importDetail?.detail?.nodes ?? importDetail?.detail?.result?.nodes ?? (res.data["nodes"] as NodeResult[] | undefined) ?? [];
        for (const n of launchNodes) {
          if (n.status === "failed" && n.error) console.error(`  ${n.logicalId}: failed: ${n.error}`);
        }
        for (const line of startupAttentionSummary(res.data)) console.log(line);

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

/** Render a failed remote `rig up` response without stringifying an unknown
 *  body as `[object Object]`. JSON mode keeps the complete RemoteOpResult;
 *  human mode shows known daemon guidance and safely falls back for older or
 *  partial error bodies. */
export function formatRemoteUpFailure(
  hostId: string,
  result: { error?: string; data?: unknown },
): string[] {
  const lines = [`Error on host ${hostId}${result.error ? `: ${result.error}` : ""}`];
  const payload = result.data !== null && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : undefined;
  const error = payload?.["error"];
  let detailAdded = false;

  if (typeof error === "string" && error.trim()) {
    lines.push(error.trim());
    detailAdded = true;
  } else if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const body = error as Record<string, unknown>;
    const fact = typeof body["fact"] === "string" ? body["fact"] : undefined;
    const consequence = typeof body["consequence"] === "string" ? body["consequence"] : undefined;
    const action = typeof body["action"] === "string" ? body["action"] : undefined;
    const message = typeof body["message"] === "string" ? body["message"].trim() : undefined;
    if (fact && consequence && action) {
      lines.push(...formatThreePart({ fact, consequence, action }));
      detailAdded = true;
    } else {
      if (fact) lines.push(`Error: ${fact}`);
      if (consequence) lines.push(consequence);
      if (action) lines.push(action);
      if (message) lines.push(message);
      detailAdded = Boolean(fact || consequence || action || message);
    }
  }

  if (!detailAdded && typeof payload?.["message"] === "string" && payload["message"].trim()) {
    lines.push(payload["message"].trim());
    detailAdded = true;
  }
  if (!detailAdded && Array.isArray(payload?.["errors"])) {
    const errors = payload["errors"].filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (errors.length > 0) {
      lines.push(...errors.map((entry) => `  ${entry.trim()}`));
      detailAdded = true;
    }
  }
  if (typeof payload?.["code"] === "string" && payload["code"].trim()) {
    lines.push(`Code: ${payload["code"].trim()}`);
  }
  for (const node of Array.isArray(payload?.["attentionNodes"]) ? payload["attentionNodes"] : []) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) continue;
    const entry = node as Record<string, unknown>;
    if (typeof entry["logicalId"] !== "string" || typeof entry["reason"] !== "string") continue;
    const session = typeof entry["sessionName"] === "string" ? ` (${entry["sessionName"]})` : "";
    lines.push(`  ${entry["logicalId"]}${session}: ${entry["reason"]}`);
    detailAdded = true;
  }
  if (Array.isArray(payload?.["warnings"])) {
    for (const warning of payload["warnings"]) {
      if (typeof warning === "string" && warning.trim()) lines.push(`  warning: ${warning.trim()}`);
    }
  }
  if (!detailAdded && typeof result.data === "string" && result.data.trim()) {
    lines.push(result.data.trim());
    detailAdded = true;
  }
  if (!detailAdded) lines.push("Remote daemon did not return a recognized error message.");
  return lines;
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
