export interface TmuxProbeResult {
  installed: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
  code: "available" | "no_server" | "not_installed" | "unhealthy";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

/**
 * Whether this tmux can serve `capture-pane -p`, which OpenRig uses to read every agent's screen. A tmux whose server exits
 * on it fails every seat at launch (#980: Oracle Linux 10's packaged `next-3.4`, also outside OpenRig). It runs the
 * getting-started guide's check on a throwaway socket with no config, so the person's own sessions are never touched,
 * and always removes that server. A throwaway server that won't start is reported as not checked, not as a failure.
 */
export function probeTmuxCapture(exec: (cmd: string) => string, socket = `openrig-check-${process.pid}`): TmuxCaptureResult {
  const tmux = `tmux -L ${socket} -f /dev/null`;
  try { exec(`${tmux} new-session -d -s check`); }
  catch (err) { return { status: "skipped", detail: errorMessage(err).trim() }; }
  try {
    exec(`${tmux} capture-pane -p -t check`);
    return { status: "pass" };
  } catch (err) {
    return { status: "fail", detail: errorMessage(err).trim() };
  } finally {
    try { exec(`${tmux} kill-server`); } catch { /* the throwaway server already exited */ }
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
      code: "not_installed",
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
      code: "not_installed",
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
