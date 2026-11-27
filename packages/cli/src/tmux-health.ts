export interface TmuxProbeResult {
  installed: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
  /** not_installed only on evidence that there's no tmux to run. not_runnable: this shell was refused permission to start
   *  it (EPERM or EACCES, as in a sandbox). check_failed: the version check failed some other way (a timeout, say). In
   *  both, whether tmux is installed is unknown. */
  code: "available" | "no_server" | "not_installed" | "not_runnable" | "check_failed" | "unhealthy";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What a failed `tmux -V` shows. Only evidence of no tmux to run (no such command or file, a shell's exit 127) is
 *  not_installed. A process this shell was refused permission to start (a sandbox can do this) is not_runnable. Anything
 *  else, such as a timeout, is check_failed. The last two say nothing about whether tmux exists. */
function classifyVersionFailure(err: unknown): "not_installed" | "not_runnable" | "check_failed" {
  const e = err as { code?: unknown; status?: unknown; stderr?: unknown } | null;
  if (e?.code === "EPERM" || e?.code === "EACCES") return "not_runnable";
  if (e?.code === "ENOENT" || e?.status === 127) return "not_installed";
  return /\bnot found\b|no such file or directory/i.test(`${String(e?.stderr ?? "")} ${errorMessage(err)}`) ? "not_installed" : "check_failed";
}

/** What to say when `tmux -V` failed without showing that tmux is missing (not_runnable or check_failed). */
export function buildTmuxVersionCheckFailure(code: "not_runnable" | "check_failed", detail: string): { message: string; reason: string; fix: string } {
  if (code === "not_runnable") {
    return {
      message: `tmux couldn't be run from this shell (${detail}).`,
      reason: "This shell was refused permission to start a process, as a sandbox can do. That doesn't show whether tmux is installed, and OpenRig needs to run it.",
      fix: "Check with `command -v tmux` from a shell outside the sandbox, and run OpenRig from a shell that can start tmux. Installing tmux won't help if it is already there.",
    };
  }
  return {
    message: `tmux's version check couldn't be completed (${detail}).`,
    reason: "`tmux -V` failed without showing whether tmux is installed, and OpenRig needs to run it.",
    fix: "Run `tmux -V` yourself to see what happens. If it isn't installed, install it (brew install tmux on macOS, apt install tmux on Debian/Ubuntu); if it hangs or errors, fix that tmux first.",
  };
}

export function isTmuxNoServerMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("no server running")
    || normalized.includes("failed to connect to server")
    || (normalized.includes("error connecting to") && normalized.includes("no such file or directory"));
}

export function buildTmuxControlFailure(message: string): { message: string; reason: string; fix: string } {
  return {
    message: "tmux installed, but the default control socket is unhealthy.",
    reason: `OpenRig uses tmux control commands to launch, inspect, and manage agent sessions. The default tmux socket is returning: ${message}`,
    fix: "Capture any needed state from visible tmux panes, then restart the default tmux server before retrying OpenRig. If this happened after a machine restore, treat it as attention required rather than a healthy running state.",
  };
}

export type TmuxCaptureResult = { status: "pass" } | { status: "fail"; detail: string } | { status: "skipped"; detail: string };

/** Each probe command's bound: a tmux that hangs instead of crashing must not hang the check that diagnoses it. */
export const TMUX_CAPTURE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether this tmux can serve `capture-pane -p`, which OpenRig uses to read every agent's screen. A tmux whose server exits
 * on it fails every seat at launch (#980: Oracle Linux 10's packaged `next-3.4`, also outside OpenRig). It runs the
 * getting-started guide's check on a throwaway socket with no config, so the person's own sessions are never touched.
 * Every command is bounded, and the throwaway server always gets a cleanup attempt, even after a create that failed or
 * timed out (it may have started anyway). A throwaway server that won't start is reported as not checked, not a failure.
 */
export function probeTmuxCapture(exec: (cmd: string, opts: { timeoutMs: number }) => string,
  socket = `openrig-check-${process.pid}`): TmuxCaptureResult {
  const run = (args: string) => exec(`tmux -L ${socket} -f /dev/null ${args}`, { timeoutMs: TMUX_CAPTURE_PROBE_TIMEOUT_MS });
  try {
    try { run("new-session -d -s check"); }
    catch (err) { return { status: "skipped", detail: errorMessage(err).trim() }; }
    try {
      run("capture-pane -p -t check");
      return { status: "pass" };
    } catch (err) {
      return { status: "fail", detail: errorMessage(err).trim() };
    }
  } finally {
    try { run("kill-server"); } catch { /* no throwaway server is left, or it already exited */ }
  }
}

export function buildTmuxCaptureFailure(version: string | null, detail: string): { message: string; reason: string; fix: string } {
  return {
    message: `This tmux (${version ?? "unknown version"}) can't capture a pane: \`capture-pane -p\` failed on a throwaway server (${detail}).`,
    reason: "OpenRig reads each agent's screen with `capture-pane -p`. A tmux whose server exits on it makes every seat fail at launch. " +
      "Oracle Linux 10's packaged tmux (`tmux -V` shows `next-3.4`) does this, also outside OpenRig (issue #980).",
    fix: "Put a tmux that passes this check first on your PATH (one report built tmux 3.5a into /usr/local/bin), then restart the daemon " +
      "from a shell where `tmux -V` shows it. The getting-started guide's \"When the kernel's seats all fail at the first start\" has the steps.",
  };
}

export function probeTmuxControl(exec: (cmd: string) => string): TmuxProbeResult {
  let version: string;
  try {
    version = exec("tmux -V").trim();
  } catch (err) {
    return {
      installed: false,
      available: false,
      version: null,
      detail: errorMessage(err),
      code: classifyVersionFailure(err),
    };
  }

  try {
    exec("tmux list-sessions");
    return {
      installed: true,
      available: true,
      version,
      detail: null,
      code: "available",
    };
  } catch (err) {
    const detail = errorMessage(err).trim();
    if (isTmuxNoServerMessage(detail)) {
      return {
        installed: true,
        available: true,
        version,
        detail,
        code: "no_server",
      };
    }
    return {
      installed: true,
      available: false,
      version,
      detail,
      code: "unhealthy",
    };
  }
}

export async function probeTmuxControlAsync(exec: (cmd: string) => Promise<string>): Promise<TmuxProbeResult> {
  let version: string;
  try {
    version = (await exec("tmux -V")).trim();
  } catch (err) {
    return {
      installed: false,
      available: false,
      version: null,
      detail: errorMessage(err),
      code: classifyVersionFailure(err),
    };
  }

  try {
    await exec("tmux list-sessions");
    return {
      installed: true,
      available: true,
      version,
      detail: null,
      code: "available",
    };
  } catch (err) {
    const detail = errorMessage(err).trim();
    if (isTmuxNoServerMessage(detail)) {
      return {
        installed: true,
        available: true,
        version,
        detail,
        code: "no_server",
      };
    }
    return {
      installed: true,
      available: false,
      version,
      detail,
      code: "unhealthy",
    };
  }
}
