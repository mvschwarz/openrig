import nodePath from "node:path";
import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface RigDeps extends StatusDeps {
  readFile: (path: string) => string;
}

export function rigCommand(depsOverride?: RigDeps): Command {
  const cmd = new Command("spec").description("Manage rig specs");
  const getDeps = (): RigDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  // rig spec validate <path>
  cmd
    .command("validate <path>")
    .description("Validate a rig spec (pure schema validation)")
    .option("--json", "JSON output")
    .action(async (filePath: string, opts: { json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        if (status.state === "running" && status.healthy === false) {
          console.error("Daemon unhealthy — healthz check failed. Restart with: rig daemon start");
        } else {
          console.error("Daemon not running. Start it with: rig daemon start");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      const res = await client.postText<{ valid?: boolean; errors?: string[]; name?: string }>("/api/rigs/import/validate", yaml);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.valid) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        const data = res.data;
        if (data.errors && data.errors.length > 0) {
          console.error(`Rig spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        } else {
          console.error(`Validation failed (HTTP ${res.status}). Check rig spec YAML syntax.`);
        }
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.valid) {
        const nameMatch = yaml.match(/^name:\s*(.+)$/m);
        const name = nameMatch?.[1]?.replace(/^["']|["']$/g, "").trim() ?? "unknown";
        console.log(`Rig spec valid: ${name}`);
      } else {
        if (data.errors && data.errors.length > 0) {
          console.error(`Rig spec invalid:\n${data.errors.map((e) => `  ${e}`).join("\n")}\nFix: update ${filePath} and re-validate.`);
        }
        process.exitCode = 1;
      }
    });

  // rig spec preflight <path>
  cmd
    .command("preflight <path>")
    .description("Run preflight diagnostics on a rig spec")
    .option("--rig-root <root>", "Root directory for pod-aware resolution")
    .option("--json", "JSON output")
    .action(async (filePath: string, opts: { rigRoot?: string; json?: boolean }) => {
      const deps = getDeps();

      let yaml: string;
      try {
        yaml = deps.readFile(filePath);
      } catch {
        console.error(`Cannot read file: ${filePath}`);
        process.exitCode = 1;
        return;
      }

      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (status.state !== "running" || status.healthy === false) {
        if (status.state === "running" && status.healthy === false) {
          console.error("Daemon unhealthy — healthz check failed. Restart with: rig daemon start");
        } else {
          console.error("Daemon not running. Start it with: rig daemon start");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(getDaemonUrl(status));

      const rigRoot = opts.rigRoot
        ? nodePath.resolve(opts.rigRoot)
        : nodePath.dirname(nodePath.resolve(filePath));

      const extraHeaders: Record<string, string> = { "X-Rig-Root": rigRoot };

      const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml, "text/yaml", extraHeaders);

      if (opts.json) {
        console.log(JSON.stringify(res.data));
        if (res.status >= 400 || !res.data.ready) process.exitCode = 1;
        return;
      }

      if (res.status >= 400) {
        console.error(`Preflight failed (HTTP ${res.status}). Check your spec and rig-root path.`);
        process.exitCode = 1;
        return;
      }

      const data = res.data;
      if (data.errors && data.errors.length > 0) {
        console.log("Preflight errors:");
        for (const e of data.errors) console.log(`  - ${e}`);
      }
      if (data.warnings && data.warnings.length > 0) {
        console.log("Preflight warnings:");
        for (const w of data.warnings) console.log(`  - ${w}`);
      }
      if (data.ready) {
        console.log("Preflight ready");
      } else {
        console.log("Preflight not ready");
        process.exitCode = 1;
      }
    });

  return cmd;
}
