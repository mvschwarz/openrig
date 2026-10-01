// Built-in OpenRig startup files are stored per seat as absolute paths inside the
// install that created the seat (rigspec-instantiator resolves them from
// import.meta.dirname). After an upgrade that removes or moves that install, the
// stored paths go stale (#261). Delivery consumers re-anchor recognized built-ins to
// the RUNNING install's assets, so seats get this version's shipped guidance. Projection
// entries whose source and resource ship inside an install's daemon/specs (the kernel and
// library agents) are re-anchored the same way.
import nodePath from "node:path";

/** Logical name -> path relative to the daemon assets root, as rigspec-instantiator produces them. */
const BUILTIN_STARTUP_FILES: ReadonlyMap<string, string> = new Map([
  ["CULTURE-default.md", "guidance/CULTURE-default.md"],
  ["openrig-start.md", "guidance/openrig-start.md"],
  ["openrig-onboarding-01.md", "onboarding/01-world-and-purpose.md"],
  ["openrig-onboarding-02.md", "onboarding/02-self-and-competent-action.md"],
]);

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
  const relative = BUILTIN_STARTUP_FILES.get(file.path);
  if (!relative) return file;
  const storedRoot = nodePath.resolve(file.ownerRoot);
  if (nodePath.basename(storedRoot) !== "assets" || nodePath.basename(nodePath.dirname(storedRoot)) !== "daemon") return file;
  if (nodePath.resolve(file.absolutePath) !== nodePath.join(storedRoot, relative)) return file;
  return { ...file, absolutePath: nodePath.join(assetsRoot, relative), ownerRoot: assetsRoot };
}

/** The running daemon's shipped specs root (packages/daemon/specs, or <cli>/daemon/specs when packaged). */
export function runningShippedSpecsRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../../specs");
}

/** The OpenRig install's daemon/specs root containing `p`, recognized only in the packaged
 *  (@openrig/cli/daemon/specs) or dev-checkout (packages/daemon/specs) layout. */
function shippedSpecsRootOf(p: string): string | null {
  const parts = nodePath.resolve(p).split(nodePath.sep);
  for (let i = parts.length - 2; i >= 2; i--) {
    if (parts[i] !== "daemon" || parts[i + 1] !== "specs") continue;
    const packaged = parts[i - 1] === "cli" && parts[i - 2] === "@openrig";
    const devCheckout = parts[i - 1] === "packages";
    if (packaged || devCheckout) return parts.slice(0, i + 2).join(nodePath.sep);
  }
  return null;
}

/**
 * Re-anchor one stored projection entry to the running install when it is a shipped-spec
 * resource: both its sourcePath and its resource absolutePath lie under the same OpenRig
 * install's daemon/specs root. A resource stored elsewhere (a plugin under ~/.openrig/plugins,
 * user specs, custom paths) is returned unchanged even when its sourcePath is a shipped spec.
 * Identifiers, category, target and merge behavior are preserved.
 */
export function reanchorShippedProjectionEntry<T extends { sourcePath: string; absolutePath: string }>(
  entry: T,
  specsRoot: string = runningShippedSpecsRoot(),
): T {
  const storedRoot = shippedSpecsRootOf(entry.sourcePath);
  if (!storedRoot) return entry;
  const source = nodePath.resolve(entry.sourcePath);
  const resource = nodePath.resolve(entry.absolutePath);
  if (!resource.startsWith(storedRoot + nodePath.sep)) return entry;
  return {
    ...entry,
    sourcePath: nodePath.join(specsRoot, nodePath.relative(storedRoot, source)),
    absolutePath: nodePath.join(specsRoot, nodePath.relative(storedRoot, resource)),
  };
}
