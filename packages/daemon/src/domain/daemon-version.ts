import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO } from "../build-info.js";

/**
 * Use the packaged build stamp, as /healthz does. The CLI ships daemon/dist
 * without daemon/package.json. For unstamped development runs, read the
 * daemon's own package.json version at call time. Function-level read
 * on purpose: a module-level constant would mask test isolation per the
 * audit-every-layer discipline, and the read is cheap. Returns "unknown" on any
 * failure (missing/garbled package.json, no version field) so callers can
 * render an honest fallback rather than crash.
 *
 * Lifted from routes/bundles.ts (where it was introduced in slice-05 for bundle
 * provenance) to a shared helper for OPR.0.4.1.14, so the dashboard Field
 * Environment VERSION row can read the real running daemon version through the
 * health-summary route. The path is resolved relative to THIS module's own
 * location (import.meta.url), so it is correct regardless of the caller.
 */
export function getDaemonVersion(): string {
  if (BUILD_INFO.semver) return BUILD_INFO.semver;
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = nodePath.join(nodePath.dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
