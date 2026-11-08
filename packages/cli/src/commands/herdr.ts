import { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { describeModInstall, installRigMods, resolveHerdrAppHome } from "@openrig/daemon/herdr-app";

export interface HerdrDeps {
  installMods?: typeof installRigMods;
  env?: NodeJS.ProcessEnv;
}

/**
 * `rig herdr install`: OpenRig's mods for Rig-layout views in a herdr-app home (the strip, cell headers, pad and ended
 * cells). A mod folder someone made or changed is never replaced. Opening a herdr-app view installs the mods if missing.
 */
export function herdrCommand(deps: HerdrDeps = {}): Command {
  const cmd = new Command("herdr").description("OpenRig inside herdr-app: install its mods");
  cmd
    .command("install")
    .description("Install or update OpenRig's herdr-app mods in an app home (default: herdr-app's own, from HERDR_APP_HOME or ~/.config/herdr-app)")
    .option("--app-home <dir>", "herdr-app home to install into")
    .option("--json", "JSON output for agents")
    .action(async (opts: { appHome?: string; json?: boolean }) => {
      const appHome = opts.appHome ? resolve(opts.appHome) : resolveHerdrAppHome(deps.env ?? process.env);
      if (!isAbsolute(appHome)) { console.error("--app-home must be a folder path."); process.exitCode = 1; return; }
      const mods = await (deps.installMods ?? installRigMods)(appHome);
      if (opts.json) console.log(JSON.stringify({ ok: mods.ok, appHome, mods }, null, 2));
      else console.log(describeModInstall(mods));
      if (!mods.ok) process.exitCode = 1;
    });
  return cmd;
}
