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

/** The supported route: a second OpenRig home on one user account isn't isolation. */
const SEPARATE_MACHINE = "One user account isn't an isolated test environment: for a test that needs its own OpenRig, use another machine, such as a VM or VPS.";

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
      + `${SEPARATE_MACHINE} Point OPENRIG_HOME, HOME and CODEX_HOME at a directory that does not contain the real home, or unset OPENRIG_HOME. Starting anyway.`;
  }
  const codexDir = input.codexHome || nodePath.join(input.home, ".codex");
  const codexHome = canonical(codexDir);
  const leaks: string[] = [];
  // What this daemon itself still writes outside its home (startup.ts's global skill refresh and the Codex
  // adapter's managed config), named so a person can find and undo it.
  const writes: string[] = [];
  if (!homeInside) {
    leaks.push(`HOME=${input.home}`);
    writes.push(`at start it refreshes OpenRig's own skills (openrig-skills, refocusing, rigs) in ${nodePath.join(input.home, ".claude", "skills")} `
      + `and ${nodePath.join(input.home, ".agents", "skills")} when its bundled copies are newer, keeping the earlier copies in ${nodePath.join(input.openrigHome, "backups", "managed-refresh")}`);
  }
  if (!isInside(codexHome, root)) {
    leaks.push(`CODEX_HOME=${input.codexHome || `${codexDir} (derived from HOME)`}`);
    writes.push(`with Codex hooks enabled, its managed setup can update ${nodePath.join(codexDir, "config.toml")} and, when present, `
      + `${nodePath.join(codexDir, "hooks.json")}, pointing OpenRig's activity hooks at this home's hook relay; that setup runs at daemon start `
      + `once there is a Codex seat and at later Codex launches, so a Codex home that several daemons use follows whichever set it up most recently`);
  }
  if (leaks.length === 0) return undefined;
  return `[openrig] home isolation advisory: OPENRIG_HOME=${input.openrigHome} is not the default location, `
    + `but ${leaks.join(" and ")} resolve${leaks.length === 1 ? "s" : ""} outside it, so this daemon still writes there: ${writes.join("; and ")}. `
    + `Its seats and startup steps can also read and write outside the isolated home. `
    + `${SEPARATE_MACHINE} Pointing HOME and CODEX_HOME inside the isolated home keeps these writes inside it. Starting anyway.`;
}
