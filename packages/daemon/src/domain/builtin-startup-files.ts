// Built-in OpenRig startup files are stored per seat as absolute paths inside the
// install that created the seat (rigspec-instantiator resolves them from
// import.meta.dirname). After an upgrade that removes or moves that install, the
// stored paths go stale (#261). Delivery consumers re-anchor recognized built-ins to
// the RUNNING install's assets, so seats get this version's shipped guidance.
import nodePath from "node:path";

/** Logical name -> path relative to the daemon assets root, as rigspec-instantiator produces them. */
const BUILTIN_STARTUP_FILES: Readonly<Record<string, string>> = {
  "CULTURE-default.md": "guidance/CULTURE-default.md",
  "openrig-start.md": "guidance/openrig-start.md",
  "openrig-onboarding-01.md": "onboarding/01-world-and-purpose.md",
  "openrig-onboarding-02.md": "onboarding/02-self-and-competent-action.md",
};

/** The running daemon's assets root (packages/daemon/assets, or <cli>/daemon/assets when packaged). */
export function runningBuiltinAssetsRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../../assets");
}

/**
 * Re-anchor one stored startup file to the running install when it is a recognized
 * OpenRig built-in: its logical name is one of the four built-ins, its stored
 * absolutePath is exactly <ownerRoot>/<known relative path>, and ownerRoot is a
 * daemon/assets directory. Anything else (rig culture, rig/agent startup files,
 * user content with a matching basename) is returned unchanged. All other fields
 * are preserved.
 */
export function reanchorBuiltinStartupFile<T extends { path: string; absolutePath: string; ownerRoot: string }>(
  file: T,
  assetsRoot: string = runningBuiltinAssetsRoot(),
): T {
  const relative = BUILTIN_STARTUP_FILES[file.path];
  if (!relative) return file;
  const storedRoot = nodePath.resolve(file.ownerRoot);
  if (nodePath.basename(storedRoot) !== "assets" || nodePath.basename(nodePath.dirname(storedRoot)) !== "daemon") return file;
  if (nodePath.resolve(file.absolutePath) !== nodePath.join(storedRoot, relative)) return file;
  return { ...file, absolutePath: nodePath.join(assetsRoot, relative), ownerRoot: assetsRoot };
}
