import { Command } from "commander";
import fs from "node:fs";
import { DaemonClient } from "../client.js";
import { getDaemonStatus } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface ExportDeps extends StatusDeps {
  writeFile: (path: string, content: string) => void;
}

export function exportCommand(depsOverride?: ExportDeps): Command {
  const cmd = new Command("export").description("Export a rig spec as YAML");
  const getDeps = (): ExportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
  };

  cmd
    .argument("<rigId>", "Rig ID to export")
    .option("-o, --output <path>", "Output file path", "rig.yaml")
    .action(async (rigId: string, opts: { output: string }) => {
      const deps = getDeps();
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

      const client = deps.clientFactory(`http://127.0.0.1:${status.port}`);
      const res = await client.getText(`/api/rigs/${encodeURIComponent(rigId)}/spec`);

      if (res.status === 404) {
        console.error(`Rig '${rigId}' not found`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Export failed: ${res.data}`);
        process.exitCode = 1;
      } else {
        deps.writeFile(opts.output, res.data);
        console.log(`Exported to ${opts.output}`);
      }
    });

  return cmd;
}
