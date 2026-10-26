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

interface ExportedStartupBlock {
  files?: Array<{ path?: string; required?: boolean }>;
}

/** Copy only the declared local culture, preserving any recipient file. */
function copyCulture(file: string, root: string, outDir: string): void {
  if (nodePath.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw new Error("culture path must stay inside the rig folder");
  const sourceRoot = fs.realpathSync(root), source = fs.realpathSync(nodePath.resolve(root, file));
  const inside = (base: string, target: string) => target.startsWith(base.endsWith(nodePath.sep) ? base : base + nodePath.sep);
  if (!inside(sourceRoot, source) || !fs.statSync(source).isFile()) throw new Error("culture source is not a file inside the rig folder");
  const target = nodePath.resolve(outDir, file);
  if (fs.lstatSync(target, { throwIfNoEntry: false })) {
    console.warn(`Warning: kept existing culture '${target}'; check it matches the team before sharing.`);
    return;
  }
  let parent = nodePath.dirname(target);
  while (!fs.existsSync(parent)) parent = nodePath.dirname(parent);
  const outputRoot = fs.realpathSync(outDir), realParent = fs.realpathSync(parent);
  if (realParent !== outputRoot && !inside(outputRoot, realParent)) throw new Error("culture destination resolves outside the export folder");
  fs.mkdirSync(nodePath.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  console.log(`Copied culture to ${target}`);
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
            if (parsed["name"] === "starter") {
              console.warn("Warning: this export still installs as 'starter'. Before sharing, rename the team's name in rig.yaml; changing the bundle name alone does not rename the installed rig.");
            }
            const pods = parsed["pods"] as Array<{
              id?: string;
              startup?: ExportedStartupBlock;
              members?: Array<{ id?: string; agent_ref?: string }>;
            }> | undefined;
            for (const pod of Array.isArray(pods) ? pods : []) {
              for (const member of Array.isArray(pod.members) ? pod.members : []) {
                const local = typeof member.agent_ref === "string" && member.agent_ref.startsWith("local:") ? nodePath.normalize(member.agent_ref.slice(6)) : null;
                if (typeof member.agent_ref === "string" && (member.agent_ref.startsWith("path:") || nodePath.isAbsolute(member.agent_ref.replace(/^local:/, ""))
                    || (local !== null && (local === ".." || local.startsWith(".." + nodePath.sep))))) {
                  console.warn(`Warning: ${pod.id}.${member.id} has an agent_ref outside this folder and is not portable. Copy that agent and its imports into this folder and use local: refs before sharing, or use rig bundle create with the original --rig-root to vendor them into an archive.`);
                }
              }
            }
            const culture = parsed["culture_file"] ?? parsed["cultureFile"];
            if (typeof culture === "string" && recordedRoot) {
              try {
                if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname)) throw new Error("the daemon is remote; copy it from the recorded rig root on that host");
                copyCulture(culture, recordedRoot, outDir);
              } catch (error) {
                console.warn(`Warning: could not copy culture '${culture}' from '${recordedRoot}': ${(error as Error).message}`);
              }
            }
            const filesToCheck: string[] = [];
            if (typeof parsed["cultureFile"] === "string") {
              filesToCheck.push(parsed["cultureFile"]);
            } else if (typeof parsed["culture_file"] === "string") {
              filesToCheck.push(parsed["culture_file"]);
            }

            const startupBlocks = [
              parsed["startup"] as ExportedStartupBlock | undefined,
              ...(Array.isArray(pods) ? pods.map((pod) => pod.startup) : []),
            ];
            for (const startup of startupBlocks) {
              if (startup && Array.isArray(startup.files)) {
                for (const f of startup.files) {
                  if (typeof f?.path === "string" && f.required !== false && !filesToCheck.includes(f.path)) {
                    filesToCheck.push(f.path);
                  }
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
