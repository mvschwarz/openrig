import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

/** Resolve a path for comparison, following symlinks on the part that exists. */
function canonical(p: string): string {
  const resolved = nodePath.resolve(p);
  const tail: string[] = [];
  let probe = resolved;
  for (;;) {
    try {
      return nodePath.join(fs.realpathSync.native(probe), ...tail);
    } catch {
      const parent = nodePath.dirname(probe);
      if (parent === probe) return resolved;
      tail.unshift(nodePath.basename(probe));
      probe = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/**
 * An advisory when OPENRIG_HOME is isolated but HOME or CODEX_HOME still resolve to somewhere else.
 *
 * "Isolated" means OPENRIG_HOME is not `<account home>/.openrig`, where the account home is the user's
 * passwd home, which a scratch HOME variable doesn't change. The isolation root is whichever of HOME and
 * OPENRIG_HOME contains the other (a scratch HOME carrying its own `.openrig`, or a HOME nested inside
 * OPENRIG_HOME), except that the account's own home is never a root. HOME is a leak when neither contains
 * the other, or when it is the account home (OPENRIG_HOME=~/.openrig-dev with the real HOME);
 * a root that contains the account home (OPENRIG_HOME=<account home>, or HOME=/) isn't isolated at all; CODEX_HOME (explicit, or `<HOME>/.codex`) is a leak
 * when it is outside the root. Returns undefined for the default layout and for consistent isolation.
 */
export function homeIsolationAdvisory(input: { openrigHome: string; home: string; codexHome?: string; accountHome?: string }): string | undefined {
  const openrigHome = canonical(input.openrigHome);
  const home = canonical(input.home);
  let accountHome = input.accountHome;
  if (!accountHome) {
    try { accountHome = os.userInfo().homedir; } catch { return undefined; }
  }
  if (openrigHome === nodePath.join(canonical(accountHome), ".openrig")) return undefined;

  // The account's own home is never an isolation root, even when it contains OPENRIG_HOME.
  const homeIsAccount = home === canonical(accountHome);
  const homeContainsRig = !homeIsAccount && isInside(openrigHome, home);
  const rigContainsHome = isInside(home, openrigHome);
  const homeInside = homeContainsRig || rigContainsHome;
  const root = homeContainsRig ? home : openrigHome;
  if (isInside(canonical(accountHome), root)) {
    return `[openrig] home isolation advisory: OPENRIG_HOME=${input.openrigHome} is not the default location, `
      + `but the isolated root ${root} contains the real home ${accountHome}, so nothing inside it is isolated. `
      + `Point OPENRIG_HOME, HOME and CODEX_HOME at a directory that does not contain the real home, or unset OPENRIG_HOME. Starting anyway.`;
  }
  const codexHome = canonical(input.codexHome || nodePath.join(input.home, ".codex"));
  const leaks: string[] = [];
  if (!homeInside) leaks.push(`HOME=${input.home}`);
  if (!isInside(codexHome, root)) leaks.push(`CODEX_HOME=${input.codexHome || `${nodePath.join(input.home, ".codex")} (derived from HOME)`}`);
  if (leaks.length === 0) return undefined;
  return `[openrig] home isolation advisory: OPENRIG_HOME=${input.openrigHome} is not the default location, `
    + `but ${leaks.join(" and ")} resolve${leaks.length === 1 ? "s" : ""} outside it. `
    + `A seat or startup step run by this daemon can read or write outside the isolated home. `
    + `Point HOME and CODEX_HOME inside the isolated home, or unset OPENRIG_HOME. Starting anyway.`;
}
