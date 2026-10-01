// Startup files and projection resources that ship with OpenRig are stored per seat as
// absolute paths inside the install that created the seat (rigspec-instantiator resolves
// them from import.meta.dirname, or from a rig spec that lives in the install). After an
// upgrade that removes or moves that install, the stored paths go stale (#261). Delivery
// consumers and restore-check re-anchor them to the RUNNING install, so seats get this
// version's shipped content:
// - the four built-in startup files under daemon/assets (by logical name and known path);
// - startup files and projection resources under an install's daemon/specs (the kernel and
//   library rigs and agents), when both their root and their file lie in that same specs root.
// Custom, user, plugin and other external paths are never rewritten.
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

/** Map a (root, file) pair stored under one install's daemon/specs onto the running specs root,
 *  preserving both relative paths. Null when the root is not in a recognized install's specs
 *  or the file lies outside that same specs root. */
function mapUnderShippedSpecs(root: string, file: string, specsRoot: string): { root: string; file: string } | null {
  const storedRoot = shippedSpecsRootOf(root);
  if (!storedRoot) return null;
  const resolvedFile = nodePath.resolve(file);
  if (!resolvedFile.startsWith(storedRoot + nodePath.sep)) return null;
  return {
    root: nodePath.join(specsRoot, nodePath.relative(storedRoot, nodePath.resolve(root))),
    file: nodePath.join(specsRoot, nodePath.relative(storedRoot, resolvedFile)),
  };
}

/**
 * Re-anchor one stored startup file to the running install when it ships with OpenRig:
 * - a built-in: its logical name is one of the four built-ins, its stored absolutePath is
 *   exactly <ownerRoot>/<known relative path>, and ownerRoot is a daemon/assets directory; or
 * - a shipped-spec file: its ownerRoot and absolutePath both lie under the same recognized
 *   install's daemon/specs (for example the kernel rig culture and agent role/startup files).
 * Anything else (custom rig/agent files, user content with a matching basename) is returned
 * unchanged. Required, applicability, delivery and every other field are preserved.
 */
export function reanchorBuiltinStartupFile<T extends { path: string; absolutePath: string; ownerRoot: string }>(
  file: T,
  assetsRoot: string = runningBuiltinAssetsRoot(),
  specsRoot: string = runningShippedSpecsRoot(),
): T {
  const relative = BUILTIN_STARTUP_FILES.get(file.path);
  if (relative) {
    const storedRoot = nodePath.resolve(file.ownerRoot);
    if (nodePath.basename(storedRoot) === "assets" && nodePath.basename(nodePath.dirname(storedRoot)) === "daemon"
      && nodePath.resolve(file.absolutePath) === nodePath.join(storedRoot, relative)) {
      return { ...file, absolutePath: nodePath.join(assetsRoot, relative), ownerRoot: assetsRoot };
    }
  }
  const mapped = mapUnderShippedSpecs(file.ownerRoot, file.absolutePath, specsRoot);
  return mapped ? { ...file, ownerRoot: mapped.root, absolutePath: mapped.file } : file;
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
  const mapped = mapUnderShippedSpecs(entry.sourcePath, entry.absolutePath, specsRoot);
  return mapped ? { ...entry, sourcePath: mapped.root, absolutePath: mapped.file } : entry;
}
