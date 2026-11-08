// The herdr-app pieces the CLI uses directly (`rig herdr install`): OpenRig's mods in an app home, and how
// herdr-app finds its home. Everything that talks to a running window stays in the daemon.
export { RIG_MODS, describeModInstall, installRigMods, type ModInstallResult } from "./domain/terminal/herdr-app-install.js";
export { herdrAppSocketPath, resolveHerdrAppHome } from "./domain/terminal/herdr-app-transport.js";
