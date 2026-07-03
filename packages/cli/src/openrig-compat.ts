import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const warnedKeys = new Set<string>();

/**
 * Sentinel file a QA/test fixture drops in its scratch OPENRIG_HOME to mark
 * the home as fixture-scoped. This is the preferred (most-honest) signal.
 */
export const FIXTURE_HOME_MARKER = ".openrig-fixture";

/**
 * OPR.0.4.3.12 — PATH-ONLY predicate: is `home` a fixture-scoped OpenRig home?
 *
 * Recognizes a fixture home by EITHER an explicit sentinel marker file
 * (`.openrig-fixture`, preferred/most-honest) OR the temp-path QA convention
 * (an `openrig-qa*` home under a system temp root, e.g.
 * `OPENRIG_HOME=/tmp/openrig-qa-…-home`).
 *
 * Deliberately has NO ConfigStore dependency: `ConfigStore` imports this
 * module, so importing it here would create a cycle. Callers that need the
 * divergent-daemon-target confirmation (restore-check) compose this path
 * predicate with `ConfigStore.resolveWithSource` at the call site.
 */
export function isFixtureScopedHome(home: string): boolean {
  if (!home) return false;
  // 1. Explicit sentinel marker file in the home — the most honest signal.
  if (existsSync(join(home, FIXTURE_HOME_MARKER))) return true;
  // 2. Temp-path QA-fixture convention: an `openrig-qa*` home under a
  //    system temp root.
  const tempRoots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders"];
  const underTemp = tempRoots.some(
    (root) => home === root || home.startsWith(root.endsWith("/") ? root : `${root}/`),
  );
  return underTemp && /(^|\/)openrig-qa[^/]*/.test(home);
}

export function getOpenRigHome(): string {
  const configured = readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME");
  if (configured !== undefined) return configured;
  return join(homedir(), ".openrig");
}

export function getLegacyRiggedHome(): string {
  return join(homedir(), ".rigged");
}

export const OPENRIG_HOME = getOpenRigHome();
export const LEGACY_RIGGED_HOME = getLegacyRiggedHome();

function warnOnce(key: string, message: string): void {
  if (warnedKeys.has(key)) return;
  warnedKeys.add(key);
  console.warn(message);
}

export function readOpenRigEnv(primary: string, legacy?: string): string | undefined {
  const primaryValue = process.env[primary];
  if (primaryValue !== undefined && primaryValue !== "") return primaryValue;

  if (legacy) {
    const legacyValue = process.env[legacy];
    if (legacyValue !== undefined && legacyValue !== "") {
      warnOnce(`env:${legacy}`, `Warning: ${legacy} is deprecated; use ${primary} instead.`);
      return legacyValue;
    }
  }

  return undefined;
}

export function getPreferredOpenRigHome(): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();

  if (existsSync(openrigHome)) return openrigHome;
  if (existsSync(legacyRiggedHome)) {
    warnOnce(
      "path:home",
      `Warning: using legacy state directory ${legacyRiggedHome}; migrate to ${openrigHome}.`,
    );
    return legacyRiggedHome;
  }
  return openrigHome;
}

export function getDefaultOpenRigPath(filename: string): string {
  return join(getOpenRigHome(), filename);
}

export function getCompatibleOpenRigPath(filename: string): string {
  const openrigHome = getOpenRigHome();
  const legacyRiggedHome = getLegacyRiggedHome();
  const primaryPath = join(openrigHome, filename);
  if (existsSync(primaryPath)) return primaryPath;

  const legacyPath = join(legacyRiggedHome, filename);
  if (existsSync(legacyPath)) {
    warnOnce(
      `path:${filename}`,
      `Warning: using legacy state path ${legacyPath}; migrate to ${primaryPath}.`,
    );
    return legacyPath;
  }

  return primaryPath;
}
