// `rig community-harness list`: the community harnesses installed as presets under $OPENRIG_HOME/community-harnesses, each with its
// maintainer and declared limits. OpenRig hasn't tested these harnesses.
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, statusGuardMessage } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

interface CommunityHarnessWire {
  name: string;
  usable: boolean;
  maintainer?: string;
  limits?: string[];
  path: string;
  problem?: string;
}

export function communityHarnessCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("community-harness").description("Community harnesses installed as presets (not tested by OpenRig)");
  const getDeps = (): StatusDeps => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd.command("list")
    .description("List installed community harness presets, with maintainer and declared limits")
    .option("--json", "JSON output")
    .action(async (opts: { json?: boolean }) => {
      try {
        const deps = getDeps();
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          const gm = statusGuardMessage(status); throw new Error(`${gm.fact} ${gm.action}`);
        }
        const res = await deps.clientFactory(getDaemonUrl(status)).get<{ dir: string; harnesses: CommunityHarnessWire[] }>("/api/community-harnesses");
        if (res.status !== 200 || !res.data) throw new Error(`Daemon returned HTTP ${res.status}`);
        if (opts.json) { console.log(JSON.stringify(res.data, null, 2)); return; }
        if (res.data.harnesses.length === 0) {
          console.log(`No community harness presets installed. Add one as ${res.data.dir}/<name>.yaml.`);
          return;
        }
        for (const app of res.data.harnesses) {
          if (!app.usable) { console.log(`${app.name}: can't be used. ${app.problem}`); continue; }
          const limits = app.limits?.length ? ` Declared limits: ${app.limits.join("; ")}.` : "";
          console.log(`${app.name}: community harness, maintained by ${app.maintainer}, not tested by OpenRig.${limits}`);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
      }
    });
  return cmd;
}
