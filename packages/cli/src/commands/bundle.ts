import nodePath from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export function bundleCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("bundle").description("Manage rig bundles");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  async function getClient(deps: StatusDeps): Promise<DaemonClient | null> {
    const status = await getDaemonStatus(deps.lifecycleDeps);
    if (status.state !== "running" || status.healthy === false) {
      console.error("Daemon not running");
      return null;
    }
    return deps.clientFactory(`http://127.0.0.1:${status.port}`);
  }

  // rigged bundle create <spec> -o <path>
  cmd.command("create <spec>")
    .description("Create a .rigbundle from a rig spec")
    .requiredOption("-o, --output <path>", "Output path for .rigbundle")
    .option("--name <name>", "Bundle name", "my-bundle")
    .option("--bundle-version <ver>", "Bundle version", "0.1.0")
    .option("--include-packages <refs...>", "Package refs to include (default: all from spec)")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--json", "JSON output")
    .action(async (spec: string, opts: { output: string; name: string; bundleVersion: string; includePackages?: string[]; rigRoot?: string; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bundles/create", {
        specPath: spec, bundleName: opts.name, bundleVersion: opts.bundleVersion, outputPath: opts.output,
        includePackages: opts.includePackages,
        rigRoot: opts.rigRoot ? nodePath.resolve(opts.rigRoot) : undefined,
      });

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400) process.exitCode = 2;
        return;
      }
      if (res.status >= 400) { console.error(res.data["error"] ?? "Create failed"); process.exitCode = 2; return; }
      console.log(`Bundle created: ${opts.output}`);
      console.log(`  Name: ${res.data["bundleName"]} v${res.data["bundleVersion"]}`);
      console.log(`  Hash: ${res.data["archiveHash"]}`);
    });

  // rigged bundle inspect <path>
  cmd.command("inspect <path>")
    .description("Inspect a .rigbundle")
    .option("--json", "JSON output")
    .action(async (bundlePath: string, opts: { json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bundles/inspect", { bundlePath });

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
      console.log(`Digest valid: ${res.data["digestValid"]}`);
      const ir = res.data["integrityResult"] as Record<string, unknown>;
      console.log(`Integrity: ${ir["passed"] ? "PASS" : "FAIL"}`);
      if (!digestValid || !integrityPassed) process.exitCode = 2;
    });

  // rigged bundle install <path>
  cmd.command("install <path>")
    .description("Install a .rigbundle (bootstrap from bundle)")
    .option("--plan", "Plan mode")
    .option("--yes", "Auto-approve")
    .option("--target <root>", "Target root directory")
    .option("--json", "JSON output")
    .action(async (bundlePath: string, opts: { plan?: boolean; yes?: boolean; target?: string; json?: boolean }) => {
      const deps = getDepsF();
      const client = await getClient(deps);
      if (!client) { process.exitCode = 1; return; }

      const res = await client.post<Record<string, unknown>>("/api/bundles/install", {
        bundlePath, plan: opts.plan ?? false, autoApprove: opts.yes ?? false, targetRoot: opts.target,
      });

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
      if (res.data["rigId"]) console.log(`Rig: ${res.data["rigId"]}`);
    });

  return cmd;
}
