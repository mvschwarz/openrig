import { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import { describeModInstall, installRigKeys, installRigMods, resolveHerdrAppHome, type KeysResult, type ModInstallResult } from "@openrig/daemon/herdr-app";

export interface HerdrDeps {
  installMods?: typeof installRigMods;
  installKeys?: typeof installRigKeys;
  env?: NodeJS.ProcessEnv;
}

/**
 * `rig herdr install`: OpenRig's mods for Rig-layout views in a herdr-app home (the strip, cell headers, pad and ended
 * cells). A mod folder someone made or changed is never replaced. `--keys` also binds alt-arrows in the `layout:rig`
 * section of keys.json to move between a view's cells (opt-in: herdr-app then treats keys.json as yours);
 * `--keys --remove` removes exactly those bindings again. Opening a herdr-app view installs the mods if missing.
 */
export function herdrCommand(deps: HerdrDeps = {}): Command {
  const cmd = new Command("herdr").description("OpenRig inside herdr-app: install its mods and, if you want them, its keys");
  cmd
    .command("install")
    .description("Install or update OpenRig's herdr-app mods in an app home (default: herdr-app's own, from HERDR_APP_HOME or ~/.config/herdr-app)")
    .option("--app-home <dir>", "herdr-app home to install into")
    .option("--keys", "Also bind alt-arrows in keys.json section layout:rig to move between a Rig view's cells (opt-in)")
    .option("--remove", "With --keys: remove OpenRig's key bindings again (mods stay)")
    .option("--json", "JSON output for agents")
    .action(async (opts: { appHome?: string; keys?: boolean; remove?: boolean; json?: boolean }) => {
      const appHome = opts.appHome ? resolve(opts.appHome) : resolveHerdrAppHome(deps.env ?? process.env);
      if (!isAbsolute(appHome)) { console.error("--app-home must be a folder path."); process.exitCode = 1; return; }
      if (opts.remove && !opts.keys) { console.error("--remove applies to --keys: rig herdr install --keys --remove"); process.exitCode = 1; return; }
      let mods: ModInstallResult | undefined;
      if (!opts.remove) mods = await (deps.installMods ?? installRigMods)(appHome);
      let keys: KeysResult | undefined;
      if (opts.keys) keys = await (deps.installKeys ?? installRigKeys)(appHome, { remove: opts.remove === true });
      const ok = (mods?.ok ?? true) && (keys?.ok ?? true);
      if (opts.json) console.log(JSON.stringify({ ok, appHome, ...(mods ? { mods } : {}), ...(keys ? { keys } : {}) }, null, 2));
      else {
        if (mods) console.log(describeModInstall(mods));
        if (keys) console.log(keys.message);
      }
      if (!ok) process.exitCode = 1;
    });
  return cmd;
}
