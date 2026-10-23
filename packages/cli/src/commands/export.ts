import nodePath from "node:path";
import fs from "node:fs";
import { Command } from "commander";
import { writeTextAtomically } from "../atomic-text-write.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { rigIdForHandle } from "../rig-handle.js";

export interface ExportDeps extends StatusDeps {
  writeFile: (path: string, content: string) => void;
  exists?: (path: string) => boolean;
}

export function exportCommand(depsOverride?: ExportDeps): Command {
  const cmd = new Command("export").description("Export a rig spec as YAML");
  const getDeps = (): ExportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    writeFile: (p, content) => writeTextAtomically(p, content, "export"),
    exists: (p) => fs.existsSync(p),
  };

  cmd
    .argument("<rig>", "Rig name or ID to export")
    .option("-o, --output <path>", "Output file path", "rig.yaml")
    .action(async (rigId: string, opts: { output: string }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (!daemonStatusGuard(status)) return;

      const client = deps.clientFactory(getDaemonUrl(status));
      const target = await rigIdForHandle(client, rigId);
      if (!target.ok) { console.error(target.message); process.exitCode = 1; return; }
      const res = await client.getText(`/api/rigs/${encodeURIComponent(target.id)}/spec`);

      if (res.status === 404) {
        console.error(`Rig '${rigId}' not found`);
        process.exitCode = 1;
      } else if (res.status >= 400) {
        console.error(`Export failed: ${res.data}`);
        process.exitCode = 1;
      } else {
        deps.writeFile(opts.output, res.data);
        console.log(`Exported to ${opts.output}`);
        for (const line of String(res.data).split("\n")) if (line.startsWith("# Not carried: ")) console.log(line.slice(2));

        // Check for referenced culture_file and startup files resolving from the output directory
        const checkExists = deps.exists ?? ((p) => fs.existsSync(p));
        const outDir = nodePath.dirname(nodePath.resolve(opts.output));
        const rawRoot = res.headers?.get("X-Rig-Root");
        let recordedRoot: string | undefined;
        if (rawRoot) {
          try {
            recordedRoot = decodeURIComponent(rawRoot);
          } catch {
            recordedRoot = rawRoot;
          }
        }

        try {
          const { parse } = await import("yaml");
          const parsed = parse(res.data) as Record<string, unknown> | null;
          if (parsed && typeof parsed === "object") {
            const filesToCheck: string[] = [];
            if (typeof parsed["cultureFile"] === "string") {
              filesToCheck.push(parsed["cultureFile"]);
            } else if (typeof parsed["culture_file"] === "string") {
              filesToCheck.push(parsed["culture_file"]);
            }

            const startup = parsed["startup"] as { files?: Array<{ path?: string; required?: boolean }> } | undefined;
            if (startup && Array.isArray(startup.files)) {
              for (const f of startup.files) {
                if (typeof f?.path === "string" && f.required !== false && !filesToCheck.includes(f.path)) {
                  filesToCheck.push(f.path);
                }
              }
            }

            for (const fileRel of filesToCheck) {
              const targetPath = nodePath.resolve(outDir, fileRel);
              if (!checkExists(targetPath)) {
                const originNote = recordedRoot ? ` (came from ${recordedRoot})` : "";
                console.warn(
                  `Warning: Referenced file '${fileRel}'${originNote} does not exist relative to '${outDir}'. ` +
                  `A rig launched from this export fails its startup until the file is copied next to it (or the export is imported with --rig-root ${recordedRoot ?? "<folder>"}).`
                );
              }
            }
          }
        } catch {
          // If YAML parsing fails, do not block export
        }
      }
    });

  return cmd;
}
