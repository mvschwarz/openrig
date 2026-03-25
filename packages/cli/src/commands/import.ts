import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ImportDeps extends StatusDeps {
  readFile: (path: string) => string;
}

export function importCommand(depsOverride?: ImportDeps): Command {
  const cmd = new Command("import").description("Import a rig spec from YAML");
  const getDeps = (): ImportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    readFile: (p) => fs.readFileSync(p, "utf-8"),
  };

  cmd
    .argument("<path>", "Path to YAML rig spec file")
    .option("--instantiate", "Instantiate the rig after import")
    .option("--preflight", "Run preflight checks")
    .action(async (filePath: string, opts: { instantiate?: boolean; preflight?: boolean }) => {
      const deps = getDeps();

      // Read local file first (before daemon check — fail fast on missing file)
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
          console.error("Daemon unhealthy — healthz failed");
        } else {
          console.error("Daemon not running");
        }
        process.exitCode = 1;
        return;
      }

      const client = deps.clientFactory(`http://localhost:${status.port}`);

      if (opts.preflight) {
        const res = await client.postText<{ ready?: boolean; warnings?: string[]; errors?: string[] }>("/api/rigs/import/preflight", yaml);
        if (res.status >= 400) {
          console.error(`Preflight failed: ${JSON.stringify(res.data)}`);
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
          console.log("Preflight passed");
        }
        return;
      }

      if (opts.instantiate) {
        const res = await client.postText<{ rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> } | { ok: false; code: string; errors?: string[]; message?: string }>("/api/rigs/import", yaml);
        if (res.status === 409 || res.status === 400) {
          const data = res.data as { ok: false; code: string; errors?: string[]; message?: string };
          const detail = data.errors?.join(", ") ?? data.message ?? `status ${res.status}`;
          console.error(`Import failed: ${detail}`);
          process.exitCode = 1;
        } else if (res.status >= 400) {
          console.error(`Import failed: ${JSON.stringify(res.data)}`);
          process.exitCode = 1;
        } else {
          const data = res.data as { rigId: string; specName: string; specVersion: string; nodes: Array<{ logicalId: string; status: string }> };
          console.log(`Rig created: ${data.specName} (${data.rigId})`);
          for (const n of data.nodes) {
            console.log(`  ${n.logicalId}: ${n.status}`);
          }
        }
        return;
      }

      // Default: validate only
      const res = await client.postText<{ valid?: boolean; errors?: string[] }>("/api/rigs/import/validate", yaml);
      if (res.status >= 400) {
        console.error(`Validation failed: ${JSON.stringify(res.data)}`);
        process.exitCode = 1;
        return;
      }
      const data = res.data;
      if (data.valid) {
        console.log("Valid");
      } else {
        console.log("Invalid:");
        for (const e of data.errors ?? []) console.log(`  - ${e}`);
      }
    });

  return cmd;
}
