// #275 (OPR.0.6.5.5) — "my rig command can't reach the daemon": BLOCKED is not DOWN.
//
// The ONE blocked-connection guidance, shared by the transport render (cli-error.ts) and the
// precheck guard (daemon-lifecycle.ts) so both entry points say the same thing. Kept apart from
// both so neither depends on the other.
import path from "node:path";
import { existsSync } from "node:fs";

const BLOCKED_CONNECTION_CODES = new Set(["EPERM", "EACCES"]);

/** True when THIS machine refused to make the connection (a sandbox or security policy), as
 *  opposed to a daemon that refused it. The daemon may still be running. */
export function isBlockedConnectionCode(code: string | undefined): code is string {
  return code !== undefined && BLOCKED_CONNECTION_CODES.has(code);
}

const HELP_SECTION = "The agent is waiting for permission or can't reach the daemon";

/** Never advises starting a daemon, and names no access setting: whether a seat gets network
 *  access is the user's choice, taught in the help guide section it routes to. The guide is the
 *  offline copy, because `rig context get` itself needs the daemon this shell cannot reach. */
export function blockedConnectionGuidance(
  code: string,
  env: NodeJS.ProcessEnv = process.env,
  helpPath: string | undefined = getOfflineHelpPath(),
): { consequence: string; action: string } {
  const guide = helpPath
    ? `the help guide at ${helpPath}, section "${HELP_SECTION}"`
    : `the help guide (https://www.openrig.dev/help/agents), section "${HELP_SECTION}"`;
  const blocked = `This machine blocked the connection (${code}), so the daemon may still be running.`;
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === "1") {
    return {
      consequence: `${blocked} This shell runs in a Codex sandbox with network access off, which blocks the local OpenRig daemon (#275). The seat cannot change its own sandbox.`,
      action: `Do not start another daemon. Tell the user this seat cannot reach OpenRig from its sandbox; whether it gets network access is their choice. See ${guide}.`,
    };
  }
  return {
    consequence: blocked,
    action: `Do not start another daemon. Check what restricts this shell's network access, such as a sandbox or security policy. See ${guide}.`,
  };
}

/** The help guide that ships with this CLI, readable without the daemon. `baseDir` is this
 *  module's directory (`src/` in a checkout, `dist/` when installed). In a source checkout its
 *  `docs/` wins, as in resolveDaemonPath; then the copy the package build places under
 *  `daemon/docs/reference/`. An installed package (under `node_modules`) never looks outside
 *  itself. Pure: `exists` is injected. */
export function resolveOfflineHelpPath(baseDir: string, exists: (p: string) => boolean): string | undefined {
  const bundled = path.resolve(baseDir, "../daemon/docs/reference/help.md");
  const installed = path.resolve(baseDir).split(path.sep).includes("node_modules");
  const candidates = installed ? [bundled] : [path.resolve(baseDir, "../../../docs/reference/help.md"), bundled];
  return candidates.find((candidate) => exists(candidate));
}

export function getOfflineHelpPath(): string | undefined {
  return resolveOfflineHelpPath(import.meta.dirname, existsSync);
}
