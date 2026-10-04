import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import { isGitHubBundleLink, importGitHubBundle, bundleIdentityLines, printBundleLinkError } from "../lib/bundle-source.js";
import { checkBundleFolder } from "../lib/bundle-check.js";
import type { StatusDeps } from "./status.js";
import { readDeclaredConfigurations, authoredMapping, resolveConfiguration, listConfigurations, stageConfiguration, ConfigurationError, type ChosenConfiguration } from "../lib/bundle-configuration.js";

/**
 * Read the CLI's own package.json version at call time (Item 1 / slice-05).
 * Function-level read on purpose: module-level constants would mask test
 * isolation per the audit-every-layer discipline.
 */
export function getCliVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = nodePath.join(nodePath.dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build the provenance block the CLI sends to /api/bundles/create. Reads
 * hostname, session name (from canonical OPENRIG_SESSION_NAME env), and
 * CLI version at call time. Operator notes come from the --notes flag.
 * Daemon adds daemonVersion server-side.
 */
function buildClientProvenance(notes: string | undefined): Record<string, string> {
  const out: Record<string, string> = {
    sourceHost: os.hostname(),
    cliVersion: getCliVersion(),
  };
  const session = process.env.OPENRIG_SESSION_NAME;
  if (typeof session === "string" && session.length > 0) out.authorSession = session;
  if (typeof notes === "string" && notes.length > 0) out.notes = notes;
  return out;
}

export function bundleCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bundle").description("Manage rig bundles");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (!daemonStatusGuard(status)) return null;
    return deps.clientFactory(getDaemonUrl(status));
  }

  // rig bundle create <spec> -o <path>
  cmd.command("create <spec>")
    .description("Create a .rigbundle from a rig spec or GitHub folder link")
    .requiredOption("-o, --output <path>", "Output path for .rigbundle")
    .option("--name <name>", "Bundle name", "my-bundle")
    .option("--bundle-version <ver>", "Bundle version", "0.1.0")
    .option("--include-packages <refs...>", "Package refs to include (default: all from spec)")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--preset <name>", "Build one of the configurations the bundle declares in configurations.yaml (for example all-claude)")
    .option("--seat <member=runtime>", "Use this runtime for one seat, within what configurations.yaml allows (pod.member=runtime); repeatable", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--notes <text>", "Operator notes captured in bundle provenance metadata")
    .option("--min-daemon-version <ver>", "Minimum daemon version required to install this bundle (Item 2 compatibility)")
    .option("--min-cli-version <ver>", "Minimum CLI version required to install this bundle (Item 2 compatibility)")
    .option("--allow-drift", "Bundle a spec that disagrees with the running rig of the same name; the divergence is stamped into bundle provenance")
    .option("--json", "JSON output")
    .action(async (spec: string, opts: { output: string; name: string; bundleVersion: string; includePackages?: string[]; rigRoot?: string; preset?: string; seat?: string[]; notes?: string; minDaemonVersion?: string; minCliVersion?: string; allowDrift?: boolean; json?: boolean }) => {
      const deps = getDepsF();
      if (isGitHubBundleLink(spec)) {
        try {
          const { res } = await importGitHubBundle(spec, deps, { ...opts, provenance: buildClientProvenance(opts.notes) });
          if (opts.json) console.log(JSON.stringify(res.data));
          else if (res.status >= 400) console.error(res.data.error ?? "Create failed");
          else {
            console.log(`Bundle created: ${opts.output}`);
            for (const line of bundleIdentityLines(res.data)) console.log(line);
            if (res.data.warning) console.warn(res.data.warning);
          }
          if (res.status >= 400) process.exitCode = 2;
        } catch (err) { printBundleLinkError(err, opts.json); }
        return;
      }
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      // Item 2 / slice-05: build compatibility from operator flags. Only included
      // in the request body when at least one of the two flags is set.
      const compatibility: Record<string, string> = {};
      if (opts.minDaemonVersion) compatibility.minDaemonVersion = opts.minDaemonVersion;
      if (opts.minCliVersion) compatibility.minCliVersion = opts.minCliVersion;
      const hasCompatibility = Object.keys(compatibility).length > 0;

      // QA-20260601 A1 repair (banked banked-create-install-long-running):
      // /create can take seconds-to-minutes (pod-aware assembler walk +
      // Item-6 cross-primitive vendoring + integrity-over-all-content +
      // tar pack). Default 5000ms CLI timeout (client.ts:31) is too short
      // for real-world bundles; daemon completes work but CLI reports
      // failure. Per-call 120s upper bound covers reasonable real-world
      // bundle sizes; if a bundle author hits this, the daemon-side
      // operation is async-completable in a future /bundles/jobs/<id>
      // surface (not in slice-05 scope).
      // Paths are resolved here, against the operator's cwd: the daemon would otherwise resolve
      // them against ITS cwd. Nothing is uploaded — the files must exist on the daemon's host.
      // A chosen configuration is applied to an owned copy of the rig folder; the author's folder is never changed.
      let specPath = nodePath.resolve(spec);
      let rigRoot = opts.rigRoot ? nodePath.resolve(opts.rigRoot) : undefined;
      let chosen: ChosenConfiguration | undefined;
      let stagingDir: string | undefined;
      if (opts.preset !== undefined || (opts.seat?.length ?? 0) > 0) {
        try {
          const rigDir = rigRoot ?? nodePath.dirname(specPath);
          const declared = readDeclaredConfigurations(nodePath.dirname(specPath));
          if (!declared) throw new ConfigurationError(`${nodePath.join(nodePath.dirname(specPath), "configurations.yaml")} doesn't exist, so this bundle offers no other configurations`);
          chosen = resolveConfiguration(declared, authoredMapping(specPath), { preset: opts.preset, seats: opts.seat });
          const staged = stageConfiguration(rigDir, specPath, declared, chosen);
          stagingDir = staged.stagingDir;
          specPath = staged.rigSpecPath;
          if (rigRoot) rigRoot = staged.stagingDir;
        } catch (err) {
          if (!(err instanceof ConfigurationError)) throw err;
          console.error(err.message);
          process.exitCode = 2;
          return;
        }
      }
      const res = await client.post<Record<string, unknown>>("/api/bundles/create", {
        specPath, bundleName: opts.name, bundleVersion: opts.bundleVersion, outputPath: nodePath.resolve(opts.output),
        includePackages: opts.includePackages,
        rigRoot,
        ...(chosen ? { configuration: { id: chosen.configurationId, ...(chosen.preset ? { preset: chosen.preset } : {}) } } : {}),
        provenance: buildClientProvenance(opts.notes),
        ...(hasCompatibility ? { compatibility } : {}),
        ...(opts.allowDrift ? { allowDrift: true } : {}),
      }, { timeoutMs: 120_000 });
      if (stagingDir) fs.rmSync(stagingDir, { recursive: true, force: true });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 2;
        return;
      }
      if (res.status >= 400) { console.error(res.data["error"] ?? "Create failed"); process.exitCode = 2; return; }
      console.log(`Bundle created: ${opts.output}`);
      if (chosen) console.log(`  Configuration: ${chosen.configurationId}${chosen.preset ? ` (${chosen.preset})` : ""}`);
      console.log(`  Name: ${res.data["bundleName"]} v${res.data["bundleVersion"]}`);
      console.log(`  Hash: ${res.data["archiveHash"]}`);
      // The daemon has returned this on every drifted export since Build B and the human path
      // dropped it — the operator saw a clean success while shipping a rig that does not exist.
      if (typeof res.data["warning"] === "string") console.warn(`\n${res.data["warning"]}`);
    });

  // rig bundle configurations <spec>
  cmd.command("configurations <spec>")
    .description("List the configurations a rig spec's configurations.yaml declares, with their configuration IDs")
    .option("--json", "JSON output")
    .action((spec: string, opts: { json?: boolean }) => {
      const specPath = nodePath.resolve(spec);
      const declared = readDeclaredConfigurations(nodePath.dirname(specPath));
      const authored = authoredMapping(specPath);
      const configurations = declared ? listConfigurations(declared, authored) : [];
      if (opts.json) {
        console.log(JSON.stringify({ declared: Boolean(declared), configurations }));
        return;
      }
      if (!declared) { console.log("No configurations.yaml: the bundle builds only as rig.yaml is written."); return; }
      for (const c of configurations) {
        const notes = [c.recommended ? "recommended" : "", c.authored ? "as rig.yaml is written" : ""].filter(Boolean).join(", ");
        console.log(`${c.preset}: ${c.configurationId}${notes ? `  (${notes})` : ""}`);
      }
      if (!configurations.some((c) => c.authored)) console.log("Note: no preset matches rig.yaml as written.");
    });

  // rig bundle inspect <path>
  cmd.command("inspect <path>")
    .description("Inspect a .rigbundle or build and inspect a GitHub folder link")
    .option("--preset <name>", "For a GitHub link, choose a declared configuration")
    .option("--seat <member=runtime>", "For a GitHub link, choose a declared seat runtime; repeatable", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--json", "JSON output")
    .action(async (bundlePath: string, opts: { json?: boolean; preset?: string; seat?: string[] }) => {
      const deps = getDepsF();
      let imported: Awaited<ReturnType<typeof importGitHubBundle>> | undefined;
      if (isGitHubBundleLink(bundlePath)) {
        try { imported = await importGitHubBundle(bundlePath, deps, opts); }
        catch (err) { printBundleLinkError(err, opts.json); return; }
        if (imported.res.status >= 400) {
          if (opts.json) console.log(JSON.stringify(imported.res.data)); else console.error(imported.res.data.error ?? "Create failed");
          process.exitCode = 2; return;
        }
        bundlePath = imported.bundlePath;
      }
      const client = imported?.client ?? await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bundles/inspect", { bundlePath: nodePath.resolve(bundlePath) });

      // Check for structured failures (200 with error or failed integrity)
      const hasError = typeof res.data["error"] === "string";
      const digestValid = res.data["digestValid"] === true;
      const integrityPassed = (res.data["integrityResult"] as Record<string, unknown> | undefined)?.["passed"] === true;
      const isFailed = hasError || !digestValid || !integrityPassed;

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || isFailed) process.exitCode = 2;
        return;
      }
      if (res.status >= 400 || hasError) {
        console.error(res.data["error"] ?? "Inspect failed");
        process.exitCode = 2;
        return;
      }

      const m = res.data["manifest"] as Record<string, unknown>;
      if (!m) { console.error("No manifest in response"); process.exitCode = 2; return; }
      console.log(`Bundle: ${m["name"]} v${m["version"]}`);
      for (const line of bundleIdentityLines(res.data)) console.log(line);
      console.log(`Digest valid: ${res.data["digestValid"]}`);
      const ir = res.data["integrityResult"] as Record<string, unknown>;
      console.log(`Integrity: ${ir["passed"] ? "PASS" : "FAIL"}`);
      if (!digestValid || !integrityPassed) process.exitCode = 2;
    });

  // rig bundle install <path>
  cmd.command("install <path>")
    .description("Install a .rigbundle or GitHub folder link (bootstrap from bundle)")
    .option("--preset <name>", "For a GitHub link, choose a declared configuration")
    .option("--seat <member=runtime>", "For a GitHub link, choose a declared seat runtime; repeatable", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--plan", "Plan mode")
    .option("--yes", "Auto-approve")
    .option("--target <root>", "Target root directory")
    .option("--cwd <path>", "Launch working directory for every member, for this install (for example, the repository the rig works on)")
    .option("--skip-version-check", "Operator-explicit override of the Item-2 install-time compatibility check (NOT recommended for routine use)")
    .option("--force", "Operator-explicit override of the Item-3 install-time conflict check (NOT recommended; conflicts may produce partial install state)")
    .option("--json", "JSON output")
    .action(async (bundlePath: string, opts: { plan?: boolean; yes?: boolean; target?: string; cwd?: string; skipVersionCheck?: boolean; force?: boolean; json?: boolean; preset?: string; seat?: string[] }) => {
      const deps = getDepsF();
      let imported: Awaited<ReturnType<typeof importGitHubBundle>> | undefined;
      if (isGitHubBundleLink(bundlePath)) {
        try { imported = await importGitHubBundle(bundlePath, deps, opts); }
        catch (err) { printBundleLinkError(err, opts.json); return; }
        if (imported.res.status >= 400) {
          if (opts.json) console.log(JSON.stringify(imported.res.data)); else console.error(imported.res.data.error ?? "Create failed");
          process.exitCode = 2; return;
        }
        bundlePath = imported.bundlePath;
      }
      const client = imported?.client ?? await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      // QA-20260601 A1 repair: /install completes a full bootstrap run
      // (resolve → vendor sibling primitives → boot rig sessions) which
      // can take many seconds for real bundles. Default 5000ms CLI
      // timeout (client.ts:31) caused CLI to report failure while
      // daemon completed the mutating install — operator-unsafe retry
      // path (rig_name_collision on second attempt). Bumped to 120s.
      let res: { status: number; data: Record<string, unknown> };
      try {
      res = await client.post<Record<string, unknown>>("/api/bundles/install", {
        bundlePath: nodePath.resolve(bundlePath), plan: opts.plan ?? false, autoApprove: opts.yes ?? false,
        targetRoot: opts.target ? nodePath.resolve(opts.target) : (imported ? process.cwd() : undefined),
        cwdOverride: opts.cwd ? nodePath.resolve(opts.cwd) : undefined,
        // Item 2 / slice-05 Checkpoint 3.3: send CLI version + skip flag for the
        // daemon-side install-time compatibility check. CLI version read at call
        // time (no module-level constant) via the existing getCliVersion helper.
        cliVersion: getCliVersion(),
        skipVersionCheck: opts.skipVersionCheck ?? false,
        // Item 3 / slice-05 Checkpoint 4.2: send force flag for the daemon-side
        // install-time conflict check. Operator-explicit override only.
        force: opts.force ?? false,
      }, { timeoutMs: 120_000 });
      } catch (err) {
        if (!imported) throw err;
        printBundleLinkError(new Error(`Bundle install outcome is unknown. Archive retained at ${bundlePath}; check rig ps and rig bundle history before retrying.`), opts.json);
        return;
      }
      if (imported) {
        const { source, configurationId, packageDigest, archiveHash, assembler } = imported.res.data;
        res.data = { ...res.data, source, configurationId, packageDigest, archiveHash, assembler };
      }
      if (imported && ["failed", "partial", "partially_restored", "not_attempted"].includes(String(res.data.status ?? res.data.rigResult))) process.exitCode = 2;


      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }
      if (res.status >= 400) {
        console.error(res.data["error"] ?? res.data["errors"] ?? "Install failed");
        process.exitCode = res.status === 409 ? 1 : 2;
        return;
      }

      const status = res.data["status"] as string;
      console.log(`Status: ${status}`);
      if (imported) for (const line of bundleIdentityLines(res.data)) console.log(line);
      if (res.data["rigId"]) console.log(`Rig: ${res.data["rigId"]}`);
      for (const line of bundleRoutingSummary(res.data)) console.log(line);
      for (const w of (res.data["warnings"] as string[] | undefined) ?? []) console.log(`Warning: ${w}`);
    });

  cmd.command("check <folder>")
    .description("Check the shareable bundle standard locally; advisory, no daemon or launch")
    .option("--json", "JSON output")
    .action(async (folder: string, opts: { json?: boolean }) => {
      const result = await checkBundleFolder(nodePath.resolve(folder));
      if (opts.json) console.log(JSON.stringify(result));
      else {
        console.log(`Bundle standard: ${result.standardVersion} (advisory)`);
        for (const check of result.checks) console.log(`${check.status}: ${check.ruleId}: ${check.reason}`);
      }
      if (result.checks.some(check => check.status === "finding")) process.exitCode = 1;
    });

  // rig bundle history — Item 4 / slice-05 Checkpoint 5.2
  cmd.command("history")
    .description("List bundle install audit records from ~/.openrig/bundle-audit.jsonl")
    .option("--rig <name>", "Filter to records whose targetRigName matches")
    .option("--since <iso>", "Filter to records installedAt >= this ISO timestamp")
    .option("--json", "JSON output")
    .action(async (opts: { rig?: string; since?: string; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const qs = new URLSearchParams();
      if (opts.rig) qs.set("rig", opts.rig);
      if (opts.since) qs.set("since", opts.since);
      const query = qs.toString();
      const path = query.length > 0 ? `/api/bundles/history?${query}` : "/api/bundles/history";

      const res = await client.get<Record<string, unknown>>(path);
      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 2;
        return;
      }
      if (res.status >= 400) {
        console.error(res.data["error"] ?? "History fetch failed");
        process.exitCode = 2;
        return;
      }
      const records = Array.isArray(res.data["records"]) ? res.data["records"] as Array<Record<string, unknown>> : [];
      if (records.length === 0) {
        console.log("No bundle install audit records found.");
        return;
      }
      console.log(`Bundle install history (${records.length} record${records.length === 1 ? "" : "s"}):`);
      for (const r of records) {
        const at = r["installedAt"] ?? "?";
        const rig = r["targetRigName"] ?? "?";
        const outcome = r["outcome"] ?? "?";
        const bundle = r["bundlePath"] ?? "?";
        console.log(`  ${at}  ${outcome.toString().padEnd(8)}  rig=${rig}  ${bundle}`);
      }
    });

  return cmd;
}

const ROUTING_LABELS: Array<[string, string]> = [
  ["contextPacksRouting", "Context packs"],
  ["skillsRouting", "Skills"],
  ["pluginsRouting", "Plugins"],
  ["workflowSpecsRouting", "Workflow specs"],
  ["agentImagesRouting", "Agent images"],
];

/** One line per routed kind: what landed, and each declared entry that did not. */
export function bundleRoutingSummary(data: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [key, label] of ROUTING_LABELS) {
    const routing = data[key] as { routedCount?: number; records?: Array<{ declaredPath?: string; id?: string; status?: string }> } | undefined;
    if (!routing || typeof routing.routedCount !== "number") continue;
    const rejected = (routing.records ?? []).filter((r) => r.status !== "routed");
    const detail = rejected.length > 0 ? `; not routed: ${rejected.map((r) => `${r.declaredPath ?? r.id ?? "?"} (${r.status ?? "?"})`).join(", ")}` : "";
    lines.push(`${label}: ${routing.routedCount} routed${detail}`);
  }
  return lines;
}
