// #69 — Newer Codex attaches the interactive TUI to one machine-wide `codex app-server`
// daemon, and tool shells run under that daemon's environment. A seat's tools can then
// act under another seat's OpenRig identity. `--no-daemon` keeps the app-server inside the
// seat's own process tree, but older Codex rejects the flag. So OpenRig asks the binary the
// seat will actually run, once per launch: `codex --help` in the seat's working directory
// with the launch PATH (a relative PATH entry then resolves exactly as it will in the pane).
//   supported → Codex usage that lists a `--no-daemon` option: launch with it;
//   legacy    → Codex usage without that option: keep the existing invocation;
//   unknown   → failure, timeout or non-Codex output: refuse rather than start a possibly
//               shared seat.

export type CodexDaemonSupport =
  | { kind: "supported" }
  | { kind: "legacy" }
  | { kind: "unknown"; detail: string };

/** Detects support for the Codex a seat in `cwd` would run. */
export type CodexDaemonSupportDetector = (cwd: string) => Promise<CodexDaemonSupport>;

const CODEX_USAGE = /^Usage: codex(?:[ \t]|$)/m;
const NO_DAEMON_OPTION = /^[ \t]*--no-daemon(?:[ \t]|$)/m;

/** Classifies one `codex --help` run; `runHelp` resolves with its output or rejects. */
export async function probeCodexDaemonSupport(runHelp: () => Promise<string>): Promise<CodexDaemonSupport> {
  let help: string;
  try {
    help = await runHelp();
  } catch (error) {
    return { kind: "unknown", detail: `codex --help failed: ${String(error instanceof Error ? error.message : error).split("\n")[0]}` };
  }
  if (!CODEX_USAGE.test(help)) return { kind: "unknown", detail: "codex --help did not print Codex usage" };
  return NO_DAEMON_OPTION.test(help) ? { kind: "supported" } : { kind: "legacy" };
}

/** The production detector: runs `codex --help` asynchronously, so the daemon keeps serving. */
export function codexDaemonSupportProbe(launchPath?: string, timeoutMs = 10_000): CodexDaemonSupportDetector {
  return (cwd) => probeCodexDaemonSupport(async () => {
    const { execFile } = await import("node:child_process");
    const env = launchPath ? { ...process.env, PATH: launchPath } : process.env;
    return new Promise<string>((resolve, reject) => {
      execFile("codex", ["--help"], { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf-8" }, (error, stdout) => {
        if (error) reject(error.killed ? new Error(`timed out after ${timeoutMs} ms`) : error);
        else resolve(stdout);
      });
    });
  });
}

export function unknownDaemonSupportMessage(detail: string): string {
  return `Cannot tell whether the installed Codex supports --no-daemon (${detail}). `
    + "Without it, a Codex that shares one app-server daemon across sessions may run this "
    + "seat's tools under another seat's identity, so OpenRig did not launch it. Make sure "
    + "`codex --help` runs in the seat's working directory with the daemon's PATH, then launch again.";
}
