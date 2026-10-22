import { Command } from "commander";
import { writeTextAtomically } from "../atomic-text-write.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl , daemonStatusGuard} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
import { rigIdForHandle } from "../rig-handle.js";

export interface ExportDeps extends StatusDeps {
  writeFile: (path: string, content: string) => void;
}

export function exportCommand(depsOverride?: ExportDeps): Command {
  const cmd = new Command("export").description("Export a rig spec as YAML");
  const getDeps = (): ExportDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    clientFactory: (url: string) => new DaemonClient(url),
    writeFile: (p, content) => writeTextAtomically(p, content, "export"),
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
      }
    });

  return cmd;
}
