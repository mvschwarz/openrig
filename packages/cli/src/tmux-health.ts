import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TmuxProbeResult {
  installed: boolean;
  available: boolean;
  version: string | null;
  detail: string | null;
  code: "available" | "no_server" | "not_installed" | "unhealthy";
}

export function tmuxInstallGuidance(platform: string = process.platform): string {
  return platform === "win32"
    ? "Install psmux for native Windows and put its directory (including tmux.exe) on PATH before unrelated tmux installations; open a new shell and verify tmux -V. See docs/reference/windows-support-experiment.md for experimental support limits."
    : "Install tmux (brew install tmux on macOS, apt install tmux on Debian/Ubuntu).";
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

/** Each probe command's bound: a tmux that hangs instead of crashing must not hang the check that diagnoses it. */
export const TMUX_CAPTURE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Whether this tmux can serve `capture-pane -p`, which OpenRig uses to read every agent's screen. A tmux whose server exits
 * on it fails every seat at launch (#980: Oracle Linux 10's packaged `next-3.4`, also outside OpenRig). It runs the
 * getting-started guide's check on a throwaway socket with no config, so the person's own sessions are never touched.
 * Every command is bounded, and the throwaway server always gets a cleanup attempt, even after a create that failed or
 * timed out (it may have started anyway). A throwaway server that won't start is reported as not checked, not a failure.
 */
export function probeTmuxCapture(exec: (cmd: string, opts: { timeoutMs: number; env?: NodeJS.ProcessEnv }) => string,
  socket = `openrig-check-${process.pid}`, platform: string = process.platform): TmuxCaptureResult {
  const emptyConfig = platform === "win32" ? "NUL" : "/dev/null";
  let probeRoot: string | null = null;
  try { if (platform === "win32") probeRoot = mkdtempSync(join(tmpdir(), "openrig-capture-")); }
  catch (err) { return { status: "skipped", detail: `Could not create an isolated capture-probe home: ${errorMessage(err)}` }; }
  const env = probeRoot ? Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !["HOME", "USERPROFILE", "PSMUX_DATA_DIR", "PSMUX_CONFIG_FILE", "TMUX", "TMUX_PANE"].includes(key.toUpperCase()))) : undefined;
  if (env && probeRoot) Object.assign(env, { HOME: probeRoot, USERPROFILE: probeRoot, PSMUX_DATA_DIR: join(probeRoot, "psmux"), PSMUX_CONFIG_FILE: "NUL" });
  const run = (args: string) => exec(`tmux -L ${socket} -f ${emptyConfig} ${args}`, {
    timeoutMs: TMUX_CAPTURE_PROBE_TIMEOUT_MS, ...(env ? { env } : {}),
  });
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
    let stopped = false;
    try { run("kill-server"); stopped = true; } catch { /* Preserve the owned home when termination is unconfirmed. */ }
    if (probeRoot && stopped) try { rmSync(probeRoot, { recursive: true, force: true }); }
    catch { /* A retained owned directory is safer than forcing a live handle. */ }
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
