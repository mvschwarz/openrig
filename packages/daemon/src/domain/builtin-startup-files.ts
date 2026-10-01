// Startup files and projection resources that ship with OpenRig are stored per seat as
// absolute paths inside the install that created the seat (rigspec-instantiator resolves
// them from import.meta.dirname, or from a rig spec that lives in the install). After an
// upgrade that removes or moves that install, the stored paths go stale (#261). Delivery
// consumers and restore-check re-anchor them to the RUNNING install, so seats get this
// version's shipped content:
// - the four built-in startup files under daemon/assets (by logical name and known path);
// - startup files and projection resources under an install's daemon/specs (the kernel and
//   library rigs and agents), when both their root and their file lie in that same specs root.
// A packaged install (@openrig/cli/daemon/...) is re-anchored even while it still exists, so
// seats never keep an old version's shipped content. A dev checkout (packages/daemon/...) is
// re-anchored only when the stored file is missing: its files may be newer than, or absent
// from, the running install. Custom, user, plugin and other external paths are never rewritten.
import { existsSync } from "node:fs";
import nodePath from "node:path";

/** Logical name -> path relative to the daemon assets root, as rigspec-instantiator produces them. */
const BUILTIN_STARTUP_FILES: ReadonlyMap<string, string> = new Map([
  ["CULTURE-default.md", "guidance/CULTURE-default.md"],
  ["openrig-start.md", "guidance/openrig-start.md"],
  ["openrig-onboarding-01.md", "onboarding/01-world-and-purpose.md"],
  ["openrig-onboarding-02.md", "onboarding/02-self-and-competent-action.md"],
]);

type Exists = (path: string) => boolean;
type InstallLayout = "packaged" | "dev-checkout";

/** The running daemon's assets root (packages/daemon/assets, or <cli>/daemon/assets when packaged). */
export function runningBuiltinAssetsRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../../assets");
}

/** The running daemon's shipped specs root (packages/daemon/specs, or <cli>/daemon/specs when packaged). */
export function runningShippedSpecsRoot(): string {
  return nodePath.resolve(import.meta.dirname, "../../specs");
}

/** The layout of the OpenRig install whose daemon/<dir> root is `parts[0..i+1]`, if recognized. */
function layoutAt(parts: string[], i: number): InstallLayout | null {
  if (i >= 2 && parts[i - 1] === "cli" && parts[i - 2] === "@openrig") return "packaged";
  if (i >= 1 && parts[i - 1] === "packages") return "dev-checkout";
  return null;
}

/** The recognized OpenRig install's daemon/specs root containing `p`, with its layout. */
function shippedSpecsRootOf(p: string): { root: string; layout: InstallLayout } | null {
  const parts = nodePath.resolve(p).split(nodePath.sep);
  for (let i = parts.length - 2; i >= 1; i--) {
    if (parts[i] !== "daemon" || parts[i + 1] !== "specs") continue;
    const layout = layoutAt(parts, i);
    if (layout) return { root: parts.slice(0, i + 2).join(nodePath.sep), layout };
  }
  return null;
}

/** A stored file from a dev checkout is followed only when it is gone; a packaged one always. */
function shouldReanchor(layout: InstallLayout, storedFile: string, exists: Exists): boolean {
  return layout === "packaged" || !exists(storedFile);
}

/** Map a (root, file) pair stored under one install's daemon/specs onto the running specs root,
 *  preserving both relative paths. Null when the root is not in a recognized install's specs,
 *  the file lies outside that same specs root, or a dev-checkout file is still present. */
function mapUnderShippedSpecs(root: string, file: string, specsRoot: string, exists: Exists): { root: string; file: string } | null {
  const stored = shippedSpecsRootOf(root);
  if (!stored) return null;
  const resolvedFile = nodePath.resolve(file);
  if (!resolvedFile.startsWith(stored.root + nodePath.sep)) return null;
  if (!shouldReanchor(stored.layout, file, exists)) return null;
  return {
    root: nodePath.join(specsRoot, nodePath.relative(stored.root, nodePath.resolve(root))),
    file: nodePath.join(specsRoot, nodePath.relative(stored.root, resolvedFile)),
  };
}

/**
 * Re-anchor one stored startup file to the running install when it ships with OpenRig:
 * - a built-in: its logical name is one of the four built-ins, its stored absolutePath is
 *   exactly <ownerRoot>/<known relative path>, and ownerRoot is a recognized install's
 *   daemon/assets directory; or
 * - a shipped-spec file: its ownerRoot and absolutePath both lie under the same recognized
 *   install's daemon/specs (for example the kernel rig culture and agent role/startup files).
 * Dev-checkout files are re-anchored only when missing. Anything else (custom rig/agent files,
 * user content with a matching basename) is returned unchanged. Required, applicability,
 * delivery and every other field are preserved.
 */
export function reanchorBuiltinStartupFile<T extends { path: string; absolutePath: string; ownerRoot: string }>(
  file: T,
  assetsRoot: string = runningBuiltinAssetsRoot(),
  specsRoot: string = runningShippedSpecsRoot(),
  exists: Exists = existsSync,
): T {
  // Persisted contexts from older versions may lack ownerRoot/path; leave them exactly as stored.
  if (typeof file.ownerRoot !== "string" || typeof file.absolutePath !== "string") return file;
  const relative = typeof file.path === "string" ? BUILTIN_STARTUP_FILES.get(file.path) : undefined;
  if (relative) {
    const storedRoot = nodePath.resolve(file.ownerRoot);
    const parts = storedRoot.split(nodePath.sep);
    const i = parts.length - 2;
    const layout = parts[i] === "daemon" && parts[i + 1] === "assets" ? layoutAt(parts, i) : null;
    if (layout && nodePath.resolve(file.absolutePath) === nodePath.join(storedRoot, relative)) {
      return shouldReanchor(layout, file.absolutePath, exists)
        ? { ...file, absolutePath: nodePath.join(assetsRoot, relative), ownerRoot: assetsRoot }
        : file;
    }
  }
  const mapped = mapUnderShippedSpecs(file.ownerRoot, file.absolutePath, specsRoot, exists);
  return mapped ? { ...file, ownerRoot: mapped.root, absolutePath: mapped.file } : file;
}

/**
 * Re-anchor one stored projection entry to the running install when it is a shipped-spec
 * resource: both its sourcePath and its resource absolutePath lie under the same recognized
 * OpenRig install's daemon/specs root (dev-checkout resources only when missing). A resource
 * stored elsewhere (a plugin under ~/.openrig/plugins, user specs, custom paths) is returned
 * unchanged even when its sourcePath is a shipped spec. Identifiers, category, target and
 * merge behavior are preserved.
 */
export function reanchorShippedProjectionEntry<T extends { sourcePath: string; absolutePath: string }>(
  entry: T,
  specsRoot: string = runningShippedSpecsRoot(),
  exists: Exists = existsSync,
): T {
  // Persisted entries from older versions may lack sourcePath; leave them exactly as stored.
  if (typeof entry.sourcePath !== "string" || typeof entry.absolutePath !== "string") return entry;
  const mapped = mapUnderShippedSpecs(entry.sourcePath, entry.absolutePath, specsRoot, exists);
  return mapped ? { ...entry, sourcePath: mapped.root, absolutePath: mapped.file } : entry;
}
