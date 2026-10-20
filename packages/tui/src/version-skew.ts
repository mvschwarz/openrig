// A TUI left open through a daemon upgrade or restart keeps running its old reads against the new
// daemon. On every connect and reconnect the TUI compares its own build with the daemon's /healthz;
// on a mismatch it says so and stops its background reads until it's restarted. A build or health
// answer that can't be read is unknown, never a mismatch, so it changes nothing.

export interface BuildIdentity {
  semver: string;
  commit: string;
}

/** `unreadable` is a failed /healthz read, which the caller may retry; `unknown` is an unstamped build on either side. */
export type VersionSkew = { state: "match" } | { state: "unknown" } | { state: "unreadable" } | { state: "mismatch"; message: string };

/** The launching CLI's build, as `rig tui` passes it in OPENRIG_TUI_CLI_IDENTITY:
 *  "<semver> · <commit>", optionally followed by " · dirty". Unstamped builds read as null. */
export function parseCliIdentity(raw: string | undefined): BuildIdentity | null {
  const [semver, commit] = (raw ?? "").split(" · ").map((part) => part.trim());
  if (!semver || !commit || semver === "version unstamped" || commit === "commit unstamped") return null;
  return { semver, commit };
}

/** Same version and commit is a match; either side unstamped or unreadable is unknown. A shorter
 *  commit matches a longer one it begins. */
export function compareBuilds(tui: BuildIdentity | null, health: unknown): VersionSkew {
  const daemon = health && typeof health === "object" ? health as { semver?: unknown; commit?: unknown } : null;
  if (!tui || typeof daemon?.semver !== "string" || typeof daemon.commit !== "string" || !daemon.semver || !daemon.commit) {
    return { state: "unknown" };
  }
  const sameCommit = tui.commit.startsWith(daemon.commit) || daemon.commit.startsWith(tui.commit);
  if (tui.semver === daemon.semver && sameCommit) return { state: "match" };
  // The status line is cut at the terminal's width, so the action comes first and the whole line fits 80 columns.
  return { state: "mismatch", message: `Restart rig tui: daemon is now ${daemon.semver} (${daemon.commit.slice(0, 8)}); auto-refresh off.` };
}

/** Reads /healthz once and compares. A failed read is unreadable. */
export async function checkVersionSkew(tui: BuildIdentity | null, readHealth: () => Promise<unknown>): Promise<VersionSkew> {
  if (!tui) return { state: "unknown" };
  try {
    return compareBuilds(tui, await readHealth());
  } catch {
    return { state: "unreadable" };
  }
}
