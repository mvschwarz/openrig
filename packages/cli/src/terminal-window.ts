import { windowsPowerShell } from "@openrig/daemon/windows-launch";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { reportTmuxServerLimit, tmuxServerStartCommand } from "@openrig/daemon/tmux-server-start";
import { encodeTmuxViewerProof, parseTmuxViewerProof, TMUX_VIEWER_PROOF_OPTION, qualifiesTmuxViewer, tmuxViewerCloseArgs, TMUX_VIEWER_OPTION_SNAPSHOT, TMUX_VIEWER_KEPT } from "@openrig/daemon/terminal-viewer-guard";
import { terminalAuthHeaders, type DaemonClient } from "./client.js";
import { shellQuote } from "./cross-host-executor.js";
import { prepareHerdrLaunchConfig } from "./herdr-launch-config.js";
import { assertLocalTmux, isLocalTmuxHost, readTmuxServerArgs } from "./tmux-attachment.js";
import { openRexView } from "./terminal-window-rex.js";
import { resolveHerdrSocketPath, hasLiveHerdrAttachments, findLiveHerdrWorkspace, fixedSizeWorkspaceNote, herdrCloseCommand, type HerdrTab, type LiveWorkspaceSearch } from "@openrig/daemon/herdr-live-workspace";
import type { FollowControls, OpenAllResult, OpenAllRigResult, OpenViewResult } from "./commands/terminal.js";

import { readPlatformEnv, renderWindowsLaunch, renderWindowsLaunchArgv, readWindowsTileAttachArgv, execWindowsJobFile } from "@openrig/daemon/windows-launch";
import { windowsHerdrEnvironmentCommand } from "./windows-herdr-command.js";
import { detachedTerminalEnvironment } from "./terminal-environment.js";
import { windowsHostingColumns } from "./windows-terminal-columns.js";

interface Pane { seat: string; label: string; paneCommand: string; recoveryCommand?: string; attachArgv?: string[] }
interface Preview {
  planId: string;
  session?: string;
  tmux?: { mode: "inherit" | "isolated"; serverArgs?: readonly string[] };
  status: { launch?: { socketPath: string; session?: string }; providers?: Array<{ liveness?: { alive?: boolean }; status?: { launch?: { socketPath?: string } } }> };
  rigViewer?: boolean;
  viewDescriptor?: { kind?: "following" | "fixed"; name?: string };
  composed: { id: string; localTmuxServer?: readonly string[]; opened: Pane[]; pages: Pane[][]; columns?: number; kernelLayout?: string; spaceLabel?: string; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
  skipped?: Array<{ seat: string; reason: string }>;
  /** The composed view's remote tiles, complete; an older daemon's preview omits it, so their hosts are unknown. */
  remote?: Array<{ seat: string; host: string }>;
}

export interface WindowDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  exec(file: string, args: string[], timeoutMs?: number): Promise<string>;
  launch(file: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  id(): string;
  herdrConfig(socketPath: string, columns?: number): string;
  /** Hosting terminal measurement also works for an agent shell tool with piped stdio. */
  columns?(): Promise<number | undefined>;
  notice?(message: string): void;
}

export function defaultWindowDeps(sourceEnv: NodeJS.ProcessEnv = process.env): WindowDeps {
  const hostingEnv = { ...sourceEnv };
  const env = detachedTerminalEnvironment(hostingEnv);
  const run = promisify(execFile);
  return {
    platform: process.platform, env, exists: existsSync,
    exec: async (file, args, timeoutMs = 10_000) => {
      if (process.platform === "win32") return (await execWindowsJobFile(file, args, { env, timeout: timeoutMs })).stdout;
      const command = path.basename(file) === "tmux" ? tmuxServerStartCommand(file, args) : { file, args };
      try {
        const result = await run(command.file, command.args, { env, encoding: "utf8", timeout: timeoutMs });
        reportTmuxServerLimit(result.stderr);
        return result.stdout;
      } catch (error) {
        reportTmuxServerLimit((error as { stderr?: unknown }).stderr);
        throw error;
      }
    },
    launch: (file, args) => new Promise((resolve, reject) => {
      const child = spawn(file, args, { env, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    id: () => randomUUID().slice(0, 12),
    notice: message => process.stderr.write(`${message}\n`),
    herdrConfig: (socketPath, columns) => prepareHerdrLaunchConfig(process.platform !== "win32" ? env : {
      ...env,
      HERDR_CONFIG_PATH: readPlatformEnv(env,"HERDR_CONFIG_PATH","win32"),
      XDG_CONFIG_HOME: readPlatformEnv(env,"XDG_CONFIG_HOME","win32") ?? readPlatformEnv(env,"APPDATA","win32")
        ?? path.win32.join(readPlatformEnv(env,"USERPROFILE","win32") ?? homedir(),"AppData","Roaming"),
    }, socketPath, columns),
    columns: async () => {
      if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
      if (process.platform === "win32") return windowsHostingColumns(hostingEnv);
      try {
        const size = await run("/bin/sh", ["-c", "stty size < /dev/tty"], { encoding: "utf8", timeout: 1000 });
        const width = Number(size.stdout.trim().split(/\s+/)[1]);
        if (Number.isSafeInteger(width) && width > 0) return width;
      } catch { /* A detached shell tool may still name its hosting tmux pane. */ }
      if (process.env["TMUX"] && process.env["TMUX_PANE"]) {
        try {
          const size = await run("tmux", ["display-message", "-p", "-t", process.env["TMUX_PANE"], "#{window_width}"], { encoding: "utf8", timeout: 1000 });
          const width = Number(size.stdout.trim());
          if (Number.isSafeInteger(width) && width > 0) return width;
        } catch { /* An ancestor may still own the person's terminal. */ }
      }
      // An agent's shell tool has no terminal, but the agent process above it runs in the person's
      // terminal (a Ghostty or Terminal tab, or a Herdr pane). Read the nearest ancestor's terminal size.
      try {
        let pid = process.ppid;
        for (let depth = 0; depth < 8 && pid > 1; depth++) {
          const [parent, tty] = (await run("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 })).stdout.trim().split(/\s+/);
          if (tty && /^[A-Za-z0-9/]+$/.test(tty) && tty !== "??" && tty !== "?") {
            const size = await run("/bin/sh", ["-c", `stty size < /dev/${tty}`], { encoding: "utf8", timeout: 1000 });
            const width = Number(size.stdout.trim().split(/\s+/)[1]);
            return Number.isSafeInteger(width) && width > 0 ? width : undefined;
          }
          pid = Number(parent);
        }
      } catch { /* Unknown is a narrow layout, never an invented wide measurement. */ }
      return undefined;
    },
  };
}

/** A tmux started inside a Herdr pane sets TERM_PROGRAM=tmux but inherits Herdr's pane markers. */
function inHerdrPane(env: NodeJS.ProcessEnv): boolean {
  return env["HERDR_ENV"] === "1" && !!env["HERDR_PANE_ID"] && !!env["HERDR_SOCKET_PATH"];
}

/** Rex's markers, read the same way; inside a Herdr pane, Herdr keeps the view. */
export function inRex(env: NodeJS.ProcessEnv): boolean {
  return !inHerdrPane(env) && (env["TERM_PROGRAM"] === "rex"
    || (env["TERM_PROGRAM"] !== "herdr" && !!env["REX_SESSION"] && !!env["REX_BLOCK"] && !!env["REX_SERVER"]));
}

async function herdrBinary(deps: WindowDeps): Promise<string | null> {
  if (deps.platform === "win32") {
    const system = path.win32.join(readPlatformEnv(deps.env,"SystemRoot","win32") ?? "C:\\Windows","System32");
    const found = (await deps.exec(path.win32.join(system,"where.exe"),["herdr.exe"]).catch(()=>"")).trim().split(/\r?\n/);
    const install = readPlatformEnv(deps.env,"HERDR_INSTALL_DIR","win32");
    for (const binary of [...found,...(install?[path.win32.join(install,"herdr.exe")]:[])]) {
      if (!path.win32.isAbsolute(binary)) continue;
      try { await deps.exec(binary,["--version"]); return binary; } catch { /* next explicit installation */ }
    }
    return null;
  }
  const dir = deps.env["HERDR_INSTALL_DIR"] ?? path.join(deps.env["HOME"] ?? homedir(), ".local", "bin");
  for (const candidate of ["herdr", path.join(dir, "herdr")]) {
    try {
      await deps.exec(candidate, ["--version"]);
      const binary = candidate === "herdr" ? (await deps.exec("/bin/sh", ["-c", "command -v herdr"])).trim() : candidate;
      if (path.isAbsolute(binary)) return binary;
    } catch { /* The installer path also works when it is absent from PATH. */ }
  }
  return null;
}

/** New surfaces only. No System Events keystrokes or existing-terminal input. */
async function windowLauncher(deps: WindowDeps, notes: string[]): Promise<((command: string) => Promise<{ app: string; surface: string; columns?: number }>) | { currentHerdr: true } | string> {
  // Shell tools can pipe stdio while still running inside the person's terminal.
  const program = deps.env["TERM_PROGRAM"];
  const linuxHost = deps.platform !== "linux" ? undefined
    : deps.env["GNOME_TERMINAL_SERVICE"] ? "gnome-terminal"
    : deps.env["KONSOLE_VERSION"] ? "konsole" : deps.env["XTERM_VERSION"] ? "xterm" : undefined;
  const host = !program || program === "tmux" ? deps.env["__CFBundleIdentifier"] ?? linuxHost : program;
  if (deps.env["CI"] && !["0", "false"].includes(deps.env["CI"])) return "This is a CI run.";
  if (host === "herdr" || inHerdrPane(deps.env)) return { currentHerdr: true };
  if (deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]) return "This is an SSH session; no desktop window is opened over SSH.";
  if (deps.platform === "win32") {
    const system=path.win32.join(deps.env.SystemRoot ?? "C:\\Windows","System32");
    const powershell=windowsPowerShell(deps.env);
    const desktop=(await deps.exec(powershell,["-NoProfile","-NonInteractive","-Command","[System.Diagnostics.Process]::GetCurrentProcess().SessionId"],1000).catch(()=>"")).trim();
    if (!/^\d+$/.test(desktop) || Number(desktop)===0) return "No interactive Windows desktop session could be confirmed.";
    const terminal=(await deps.exec(path.win32.join(system,"where.exe"),["wt.exe"]).catch(()=>"")).trim().split(/\r?\n/)[0];
    if (!terminal || !path.win32.isAbsolute(terminal)) return "Windows Terminal is unavailable.";
    return async command => {
      await deps.launch(terminal,["--window","new","new-tab",powershell,"-NoLogo","-NoProfile","-EncodedCommand",Buffer.from(command,"utf16le").toString("base64")]);
      return {app:"Windows Terminal",surface:"window-requested"};
    };
  }
  if (deps.platform === "darwin") {
    const inGhostty = host === "ghostty" || host === "com.mitchellh.ghostty";
    const inTerminal = host === "Apple_Terminal" || host === "com.apple.Terminal";
    const newApp = !inGhostty && !inTerminal;
    // Desktop shell tools need no stdin TTY, but a background job must not summon an app.
    if (newApp && (await deps.exec("/bin/launchctl", ["managername"]).catch(() => "")).trim() !== "Aqua") {
      return "No local macOS desktop session could be confirmed.";
    }
    const app = !inTerminal ? ["/Applications/Ghostty.app", path.join(deps.env["HOME"] ?? homedir(), "Applications/Ghostty.app")].find(deps.exists) : undefined;
    let ghostty = false;
    if (app) {
      try {
        const version = await deps.exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]);
        const [major, minor] = version.trim().split(".").map(Number);
        ghostty = major! > 1 || (major === 1 && minor! >= 3);
      } catch { /* No other app is a substitute for the hosting terminal. */ }
    }
    if (inGhostty && !ghostty) return "The installed Ghostty does not provide a supported scripting interface (1.3 or newer required).";
    if (app && !ghostty) notes.push("The installed Ghostty could not be confirmed to support scripting (1.3 or newer required); using Terminal for this desktop caller.");
    const permissionNotice = `It is fine to click Allow if macOS asks to control ${ghostty ? "Ghostty" : "Terminal"}; this lets OpenRig open the view they asked for.`;
    if (newApp) notes.push(`Tell the person: ${permissionNotice} The app uses its own new-window size because this caller has no scriptable terminal window to copy.`);
    // A tab group shares bounds: copying its current bounds also leaves the original unchanged.
    const script = ghostty ? `on run argv
tell application "Ghostty"
  set cfg to new surface configuration
  set command of cfg to item 1 of argv
  if ${newApp ? "false" : "(count of windows) > 0"} then
    set newTab to new tab in front window with configuration cfg
    select tab newTab
    focus (focused terminal of newTab)
    activate window front window
    return "tab"
  else
    set newWindow to new window with configuration cfg
    activate window newWindow
    return "window"
  end if
end tell
end run` : `on run argv
tell application "Terminal"
  set personBounds to missing value
  ${newApp ? "-- No hosting Terminal window: keep the new-window profile defaults." : "if (count of windows) > 0 then set personBounds to bounds of front window"}
  set viewTab to do script ""
  set viewWindow to front window
  if personBounds is not missing value then set bounds of viewWindow to personBounds
  do script (item 1 of argv) in viewTab
  activate
  return "window:" & (number of columns of viewTab)
end tell
end run`;
    // A denied/uncertain Automation request is returned once, never replayed in another app.
    return async command => {
      if (newApp) deps.notice?.(permissionNotice);
      const reported = (await deps.exec("/usr/bin/osascript", ["-e", script, command], 120_000)).trim();
      const columns = Number(reported.split(":")[1]);
      notes.push(newApp
        ? `${ghostty ? "Ghostty" : "Terminal"} opened a new window using its own profile settings; no existing window was resized.`
        : ghostty
        ? "Ghostty keeps the person's window size; layout uses the hosting terminal's measured width when available."
        : "The new Terminal view copies the person's front-window bounds when available; existing window settings were kept.");
      return { app: ghostty ? "Ghostty" : "Terminal", surface: ghostty ? reported : "window", ...(Number.isSafeInteger(columns) && columns > 0 ? { columns } : newApp ? { columns: undefined } : {}) };
    };
  }
  if (deps.platform !== "linux") return `No supported desktop launcher on ${deps.platform}.`;
  if (!deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]) return "No desktop display is available.";
  for (const app of ["ghostty", "gnome-terminal", "konsole", "xterm"].filter(app => app === host)) {
    try { await deps.exec("/bin/sh", ["-c", `command -v ${app}`]); } catch { continue; }
    return async command => {
      const prefix = app === "ghostty" ? ["--window-width=140", "--window-height=40", "-e"]
        : app === "gnome-terminal" ? ["--window", "--geometry=140x40", "--"]
        : app === "konsole" ? ["-p", "TerminalColumns=140", "-p", "TerminalRows=40", "-e"]
        : app === "xterm" ? ["-geometry", "140x40", "-e"]
        : ["-e"];
      const args = [...prefix, "/bin/sh", "-c", command];
      await deps.launch(app, args);
      notes.push("Requested 140 columns by 40 rows for the new window. The desktop may adjust that size; enlarge it manually if needed.");
      return { app, surface: "window-requested" };
    };
  }
  return `Unrecognised or unavailable hosting terminal: ${JSON.stringify(host ?? "unknown")}.`;
}

/** Windows Terminal renders the same composition directly; source sessions stay intact. */
async function openWindowsTerminalView(client: DaemonClient, view: string, requestedProvider: string | undefined, deps: WindowDeps, expectedPlan?: string): Promise<OpenViewResult> {
  if (requestedProvider === "herdr") return failure("herdr", "Herdr is unavailable on Windows; use --provider tmux --window.");
  const refused = (reason: string) => ({ ...failure("tmux", `No terminal window was opened. ${reason}`), windowAttempted: false });
  const nativeEnv = (name: string) => readPlatformEnv(deps.env, name, "win32");
  const ci = nativeEnv("CI");
  if (ci && !["0", "false"].includes(ci)) return refused("This is a CI run.");
  if (nativeEnv("SSH_CONNECTION") || nativeEnv("SSH_CLIENT") || nativeEnv("SSH_TTY")) return refused("This is an SSH session; run the window command on the daemon's desktop.");
  const systemDirectory = path.win32.join(nativeEnv("SystemRoot") || "C:\\Windows", "System32");
  const powershell = windowsPowerShell(deps.env);
  const desktop = (await deps.exec(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[System.Diagnostics.Process]::GetCurrentProcess().SessionId"], 1000).catch(() => "")).trim();
  if (!/^\d+$/.test(desktop) || Number(desktop) === 0) return refused("No interactive Windows desktop session could be confirmed.");
  const binary = (await deps.exec(path.win32.join(systemDirectory, "where.exe"), ["wt.exe"]).catch(() => "")).trim().split(/\r?\n/)[0];
  if (!binary) return refused("Windows Terminal is unavailable. Install Windows Terminal, then retry.");
  const width = await deps.columns?.().catch(() => undefined);
  const viewport = Number.isSafeInteger(width) && width! > 0 ? `&viewportColumns=${width}` : "";
  const preview = await client.get<Preview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr${viewport}`);
  if (preview.status >= 400 || !("composed" in preview.data)) return refused((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
  const { composed, planId } = preview.data;
  if (expectedPlan !== undefined && expectedPlan !== planId) return refused("The terminal view changed since preview. Refresh the preview before opening.");
  if (!composed.opened.length) return { ...refused("No conversations are attachable."), absent: composed.absent, degraded: composed.degraded };
  const args = ["--window", "new"];
  let pages = 0;
  const surfaceArgs = (pane: Pane) => {
    const title = pane.label.replace(/[;\r\n\0]/g, " ");
    // The daemon's native tile already has an encoded, literal-data bootstrap.
    // Wrapping that again multiplies its size past CreateProcess's 32K limit.
    if (pane.attachArgv?.length && /(?:^|[\\/])powershell\.exe$/i.test(pane.attachArgv[0]!)
      && pane.attachArgv.includes("-EncodedCommand")) {
      return ["--title", title, "--suppressApplicationTitle", ...pane.attachArgv];
    }
    const command = renderWindowsLaunch(pane.paneCommand);
    const script = `Remove-Item Env:TMUX -ErrorAction SilentlyContinue; ${command}`;
    return ["--title", title, "--suppressApplicationTitle", powershell, "-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
  };
  type Tile = { pane: Pane } | { first: Tile; second: Tile; direction: string; fraction: number };
  const rowTile = (row: Pane[]): Tile => {
    if (row.length === 1) return { pane: row[0]! };
    const cut = Math.ceil(row.length / 2);
    return { first: rowTile(row.slice(0, cut)), second: rowTile(row.slice(cut)), direction: "-V", fraction: (row.length - cut) / row.length };
  };
  const gridTile = (rows: Pane[][]): Tile => {
    if (rows.length === 1) return rowTile(rows[0]!);
    const cut = Math.ceil(rows.length / 2);
    return { first: gridTile(rows.slice(0, cut)), second: gridTile(rows.slice(cut)), direction: "-H", fraction: (rows.length - cut) / rows.length };
  };
  const firstPane = (tile: Tile): Pane => "pane" in tile ? tile.pane : firstPane(tile.first);
  const append = (...command: string[]) => { if (args.length > 2) args.push(";"); args.push(...command); };
  for (const page of composed.pages) {
    if (!page.length) continue;
    const columns = Number.isSafeInteger(composed.columns) && composed.columns! > 0 ? composed.columns! : Math.ceil(Math.sqrt(page.length));
    const rows: Pane[][] = [];
    for (let i = 0; i < page.length; i += columns) rows.push(page.slice(i, i + columns));
    const tile = gridTile(rows);
    append("new-tab", ...surfaceArgs(firstPane(tile)));
    let nextId = 1;
    const focus = (id: number) => {
      append("move-focus", "first");
      for (let index = 0; index < id; index++) append("move-focus", "nextInOrder");
    };
    const split = (current: Tile, id: number) => {
      if ("pane" in current) return;
      focus(id);
      const secondId = nextId++;
      append("split-pane", current.direction, "--size", String(current.fraction), ...surfaceArgs(firstPane(current.second)));
      split(current.first, id);
      split(current.second, secondId);
    };
    split(tile, 0);
    pages++;
  }
  if (!pages) return refused("The daemon returned an empty view layout.");
  args.push(";", "focus-tab", "--target", "0");
  try {
    await deps.launch(binary, args);
  } catch (error) {
    return { ...failure("tmux", `Terminal window status is unknown. ${(error as Error).message} Inspect the desktop before retrying.`), windowAttempted: true };
  }
  return {
    provider: "tmux", ok: true, opened: composed.opened.map(pane => pane.seat), absent: composed.absent, degraded: composed.degraded, pages,
    window: { app: "Windows Terminal", surface: "window-requested" },
    notes: ["Requested a new Windows Terminal window using the daemon's existing view. Existing conversations were preserved.", "Check the new terminal shows the intended view; window creation alone is not visual confirmation."],
  };
}

function failure(provider: string, error: string): OpenViewResult {
  return { provider, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code: "terminal_window_failed" };
}

interface CreatedTmuxViewer {
  sessionName: string;
  sessionId: string;
  nonce: string;
  windowIds: string[];
  paneIds: string[];
  proof?: string;
  ownershipNote?: string;
}

interface CreatedPlaceholder {
  sessionId: string;
  windowId: string;
  paneId: string;
}

const TMUX_SESSION_ID_RE = /^\$\d+$/;
const TMUX_WINDOW_ID_RE = /^@\d+$/;
const TMUX_PANE_ID_RE = /^%\d+$/;

function parseCreatedTmuxIds(raw: string, action: string): CreatedPlaceholder {
  const lines = splitLines(raw);
  if (lines.length !== 1) {
    throw new Error(`Unexpected tmux ${action} creation response: expected 1 line, got ${lines.length}.`);
  }
  const parts = lines[0]!.split("|");
  if (parts.length !== 3) {
    throw new Error(`Unexpected tmux ${action} creation response format.`);
  }
  const [sessionId, windowId, paneId] = parts as [string, string, string];
  if (!TMUX_SESSION_ID_RE.test(sessionId) || !TMUX_WINDOW_ID_RE.test(windowId) || !TMUX_PANE_ID_RE.test(paneId)) {
    throw new Error(`Invalid tmux ${action} creation identifiers returned.`);
  }
  return { sessionId, windowId, paneId };
}

function sameIdSet(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = new Set(actual);
  const b = new Set(expected);
  return a.size === b.size && [...b].every(id => a.has(id));
}

function splitLines(raw: string): string[] {
  return raw.trim().split("\n").map(line => line.trim()).filter(Boolean);
}

function isTmuxNoServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/permission denied|operation not permitted|eacces|eperm/i.test(msg)) return false;
  return /\bno server running\b|\bno current target\b|failed to connect to server: (?:no such file|connection refused)|error connecting to [^\r\n]+ \(No such file or directory\)/i.test(msg);
}

function isOwnedRigViewer(composed: Preview["composed"], view: string, viewDescriptor?: { kind?: string }, rigViewer?: boolean): boolean {
  if (rigViewer !== undefined) return rigViewer;
  return !view.startsWith("saved:") && viewDescriptor?.kind !== "fixed" && Boolean(composed.id?.startsWith("rig:"));
}

function checkCurrentHerdrSocket(
  env: NodeJS.ProcessEnv,
  socket: string | undefined,
  platform: NodeJS.Platform = process.platform,
): { ok: true } | { ok: false; callerSession?: string } {
  const base = path.dirname(resolveHerdrSocketPath({ ...env, HERDR_SOCKET_PATH: undefined, HERDR_SESSION: undefined }, "default", platform));
  const callerSocket = resolveHerdrSocketPath(env, undefined, platform);
  if (socket && path.resolve(socket) === path.resolve(callerSocket)) return { ok: true };
  const socketParts = path.relative(base, path.resolve(callerSocket)).split(path.sep);
  const callerSession = socketParts.length === 1 && socketParts[0] === "herdr.sock" ? "default"
    : socketParts.length === 3 && socketParts[0] === "sessions" && socketParts[2] === "herdr.sock" ? socketParts[1] : undefined;
  return { ok: false, ...(callerSession !== undefined ? { callerSession } : {}) };
}

async function createTmuxViewerLayout(
  runTmux: (args: string[]) => Promise<string>,
  viewer: string,
  composed: Preview["composed"],
  placeholder?: CreatedPlaceholder,
  rigViewer = false,
  serverArgs: readonly string[] = [],
): Promise<CreatedTmuxViewer> {
  let expectedSessionId = placeholder?.sessionId;
  const expectedWindowIds: string[] = [];
  const expectedWindowSet = new Set<string>();
  const expectedPaneIds: string[] = [];
  const expectedPaneSet = new Set<string>();
  let usedPlaceholder = false;

  for (const [pageIndex, page] of composed.pages.entries()) {
    if (!page.length) continue;
    const name = `view-${pageIndex + 1}`;
    const first = page[0]!;
    const args = !expectedSessionId ? ["new-session", "-d", "-s", viewer, "-n", name] : ["new-window", "-d", "-t", `${viewer}:`, "-n", name];
    let pane: string;
    let currentWindowId: string;
    if (placeholder && !usedPlaceholder) {
      await runTmux(["respawn-pane", "-k", "-t", placeholder.paneId, `env -u TMUX ${first.paneCommand}`]);
      usedPlaceholder = true;
      if (expectedWindowSet.has(placeholder.windowId) || expectedPaneSet.has(placeholder.paneId)) {
        throw new Error("Duplicate tmux placeholder creation identifiers.");
      }
      expectedWindowIds.push(placeholder.windowId);
      expectedWindowSet.add(placeholder.windowId);
      expectedPaneIds.push(placeholder.paneId);
      expectedPaneSet.add(placeholder.paneId);
      currentWindowId = placeholder.windowId;
      pane = placeholder.paneId;
    } else {
      const action = !expectedSessionId ? "new-session" : "new-window";
      const created = parseCreatedTmuxIds(
        await runTmux([...args, "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", `env -u TMUX ${first.paneCommand}`]),
        action,
      );
      if (!expectedSessionId) {
        expectedSessionId = created.sessionId;
      } else if (created.sessionId !== expectedSessionId) {
        throw new Error(`Tmux ${action} returned unexpected session identifier "${created.sessionId}".`);
      }
      if (expectedWindowSet.has(created.windowId) || expectedPaneSet.has(created.paneId)) {
        throw new Error(`Tmux ${action} returned duplicate window or pane identifier.`);
      }
      expectedWindowIds.push(created.windowId);
      expectedWindowSet.add(created.windowId);
      expectedPaneIds.push(created.paneId);
      expectedPaneSet.add(created.paneId);
      currentWindowId = created.windowId;
      pane = created.paneId;
    }
    // Nested source clients on this server can make a new window too narrow to split.
    // Use the viewer's detached size only while splitting; always release to inherited client sizing.
    const [width, height] = (await runTmux(["show-options", "-Av", "-t", viewer, "default-size"])).trim().split("x");
    try {
      await runTmux(["resize-window", "-t", pane, "-x", width!, "-y", height!]);
      await runTmux(["select-pane", "-t", pane, "-T", first.label]);
      for (const item of page.slice(1)) {
        const splitCreated = parseCreatedTmuxIds(
          await runTmux(["split-window", "-d", "-h", "-t", pane, "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}", `env -u TMUX ${item.paneCommand}`]),
          "split-window",
        );
        if (splitCreated.sessionId !== expectedSessionId || splitCreated.windowId !== currentWindowId || expectedPaneSet.has(splitCreated.paneId)) {
          throw new Error("Tmux split-window returned an unexpected session, window, or duplicate pane identifier.");
        }
        expectedPaneIds.push(splitCreated.paneId);
        expectedPaneSet.add(splitCreated.paneId);
        pane = splitCreated.paneId;
        await runTmux(["select-pane", "-t", pane, "-T", item.label]);
        await runTmux(["select-layout", "-t", `${viewer}:${name}`, "even-horizontal"]);
      }
      await runTmux(["select-layout", "-t", `${viewer}:${name}`, composed.columns === page.length ? "even-horizontal" : "tiled"]);
    } finally {
      await runTmux(["set-option", "-wu", "-t", `${viewer}:${name}`, "window-size"]);
    }
  }
  if (!expectedSessionId || expectedWindowIds.length === 0 || expectedPaneIds.length === 0) {
    throw new Error(`No tmux viewer panes were created for "${viewer}".`);
  }
  await runTmux(["select-window", "-t", `${viewer}:view-1`]);
  const nonce = randomUUID();
  const sessionId = expectedSessionId;
  let proof: string | undefined;
  let ownershipNote: string | undefined;
  if (rigViewer) {
    const matchingSessions = splitLines(await runTmux(["list-sessions", "-F", "#{session_id}|#{session_name}"]))
      .map(line => {
        const sep = line.indexOf("|");
        return sep >= 0 ? [line.slice(0, sep), line.slice(sep + 1)] : ["", ""];
      })
      .filter(([id, name]) => id === sessionId || name === viewer);
    if (matchingSessions.length !== 1 || matchingSessions[0]![0] !== sessionId || matchingSessions[0]![1] !== viewer) {
      throw new Error(`Created tmux rig viewer session "${viewer}" (${sessionId}) failed session identity verification.`);
    }
    const liveWindowIds = splitLines(await runTmux(["list-windows", "-t", sessionId, "-F", "#{window_id}"]));
    const livePaneIds = splitLines(await runTmux(["list-panes", "-s", "-t", sessionId, "-F", "#{pane_id}"]));
    if (
      liveWindowIds.some(id => !TMUX_WINDOW_ID_RE.test(id)) ||
      livePaneIds.some(id => !TMUX_PANE_ID_RE.test(id)) ||
      new Set(liveWindowIds).size !== liveWindowIds.length ||
      new Set(livePaneIds).size !== livePaneIds.length ||
      !sameIdSet(liveWindowIds, expectedWindowIds) ||
      !sameIdSet(livePaneIds, expectedPaneIds)
    ) {
      throw new Error(`Tmux rig viewer session "${viewer}" contains unexplained windows or panes; refusing ownership registration.`);
    }
    try {
      const encoded = encodeTmuxViewerProof({ sessionId, sessionName: viewer, nonce,
        windowIds: expectedWindowIds, paneIds: expectedPaneIds, view: composed.id,
        endpoint: `tmux:${JSON.stringify([...serverArgs])}` });
      if (!parseTmuxViewerProof(encoded)) throw new Error("Ownership proof cannot be qualified.");
      await runTmux(["set-option", "-t", sessionId, TMUX_VIEWER_PROOF_OPTION, encoded]);
      // Publish the nonce last. Missing either option leaves the viewer unqualified.
      await runTmux(["set-option", "-t", sessionId, "@openrig_rig_viewer", nonce]);
      proof = encoded;
    } catch (err) {
      await runTmux(["set-option", "-u", "-t", sessionId, "@openrig_rig_viewer"]).catch(() => {});
      ownershipNote = `Viewer opened, but its ownership options could not be confirmed. rig terminal close --all cannot close an unqualified viewer. Inspect it manually (${err instanceof Error ? err.message : String(err)}).`;
    }
  }
  return {
    sessionName: viewer,
    sessionId,
    nonce,
    windowIds: [...expectedWindowIds],
    paneIds: [...expectedPaneIds],
    ...(proof ? { proof } : {}),
    ...(ownershipNote ? { ownershipNote } : {}),
  };
}

async function verifyAndCleanupFailedTmuxViewer(
  runTmux: (args: string[]) => Promise<string>,
  viewer: CreatedTmuxViewer,
): Promise<"closed" | "already_gone" | "unknown"> {
  if (!viewer.proof || !qualifiesTmuxViewer(viewer)) return "unknown";
  try {
    let sessIds: string[] = [];
    try {
      sessIds = splitLines(await runTmux(["list-sessions", "-F", "#{session_id}"]));
    } catch (err) {
      if (isTmuxNoServerError(err)) sessIds = [];
      else return "unknown";
    }
    if (!sessIds.includes(viewer.sessionId)) {
      return "already_gone";
    }
    const liveNonce = (await runTmux(["show-options", "-qv", "-t", viewer.sessionId, "@openrig_rig_viewer"])).trim();
    if (liveNonce !== viewer.nonce) return "unknown";
    const liveWins = splitLines(await runTmux(["list-windows", "-t", viewer.sessionId, "-F", "#{window_id}"]));
    const livePanes = splitLines(await runTmux(["list-panes", "-s", "-t", viewer.sessionId, "-F", "#{pane_id}"]));
    if (!sameIdSet(liveWins, viewer.windowIds) || !sameIdSet(livePanes, viewer.paneIds)) return "unknown";
    const clients = splitLines(await runTmux(["list-clients", "-t", viewer.sessionId, "-F", "#{client_name}"]));
    if (clients.length > 0) return "unknown";

    const snapshot = await runTmux(["display-message", "-p", "-t", viewer.sessionId, TMUX_VIEWER_OPTION_SNAPSHOT]);
    const closeArgs = tmuxViewerCloseArgs(viewer, snapshot, true);
    if (!closeArgs) return "unknown";
    if ((await runTmux(closeArgs)).trim() === TMUX_VIEWER_KEPT) return "unknown";
    let afterLines: string[] = [];
    try {
      afterLines = splitLines(await runTmux(["list-sessions", "-F", "#{session_id}"]));
    } catch (err) {
      if (isTmuxNoServerError(err)) afterLines = [];
      else return "unknown";
    }
    if (afterLines.includes(viewer.sessionId)) return "unknown";
    return "closed";
  } catch {
    return "unknown";
  }
}

/** Render the daemon's existing composition; never rediscover/relaunch kernel seats here. */
export async function openTerminalWindow(client: DaemonClient, view: string, requestedProvider?: string, deps = defaultWindowDeps(), expectedPlan?: string, requestedSession?: string, following?: FollowControls): Promise<OpenViewResult> {
  if (deps.platform === "win32") {
    const source=deps;
    const env={...source.env};
    for (const key of ["SystemRoot","HOME","APPDATA","USERPROFILE","XDG_CONFIG_HOME","HERDR_INSTALL_DIR","HERDR_SESSION","HERDR_SOCKET_PATH","HERDR_ENV","HERDR_PANE_ID","TERM_PROGRAM","CI","SSH_CONNECTION","SSH_CLIENT","SSH_TTY"]) {
      const value=readPlatformEnv(source.env,key,"win32"); if(value!==undefined)env[key]=value;
    }
    deps={...source,env,exec:(file,args,timeout)=>file!=="/usr/bin/env"?source.exec(file,args,timeout):source.exec(windowsPowerShell(env),["-NoProfile","-NonInteractive","-EncodedCommand",Buffer.from(windowsHerdrEnvironmentCommand(args),"utf16le").toString("base64")],timeout)};
  }
  const session = requestedSession?.trim();
  if (!following && session === undefined && (requestedProvider === "rex" || (deps.platform !== "win32" && requestedProvider === undefined && inRex(deps.env)))) {
    return openRexView(client, view, deps, expectedPlan);
  }
  const nativeCurrentHerdr = deps.platform === "win32" && (deps.env.TERM_PROGRAM === "herdr" || inHerdrPane(deps.env));
  const selectedProvider = requestedProvider ?? (session !== undefined || following || nativeCurrentHerdr ? "herdr" : undefined);
  const sessionFlag = session === undefined ? "" : ` --session ${shellQuote(session)}`;
  const sessionQuery = session === undefined ? "" : `&session=${encodeURIComponent(session)}`;
  let provider = selectedProvider ?? "herdr";
  let window: { app: string; surface: string; columns?: number } | undefined;
  let viewer: string | undefined;
  let windowAttempted = false;
  let manualCommand: string | undefined;
  let currentHerdr = false;
  const recovery = `rig terminal open ${shellQuote(view)} --window${selectedProvider && ["herdr", "tmux"].includes(selectedProvider) ? ` --provider ${shellQuote(selectedProvider)}` : ""}${sessionFlag}`;
  const failed = (reason: string): OpenViewResult => ({ ...failure(provider,
    currentHerdr ? `The current Herdr view outcome could not be confirmed. ${reason} Inspect the selected space before retrying: ${recovery}`
      : window ? `A terminal window was requested, but the view outcome could not be confirmed. ${reason} Inspect the terminal before retrying: ${recovery}`
      : windowAttempted ? `Terminal window status is unknown. ${reason} Inspect the desktop before retrying: ${recovery}`
        : `No terminal window was opened. ${reason} On the daemon's desktop, run: ${recovery}`), windowAttempted, ...(session !== undefined ? { session } : {}) });
  const windowNotes: string[] = [];
  try {
    if (!isLocalTmuxHost(client.baseUrl)) throw new Error("The window launcher must run on the daemon's own desktop; the configured daemon is remote.");
    if (following && selectedProvider !== "herdr") throw new Error("Following requires the qualified Herdr provider.");
    if (session !== undefined && selectedProvider !== "herdr") throw new Error("--session selects a Herdr session; use --provider herdr.");
    if (selectedProvider && !["herdr", "tmux"].includes(selectedProvider)) throw new Error("--window supports herdr, rex or tmux. Use cmux without --window.");
    if (deps.platform === "win32" && selectedProvider !== "herdr") return await openWindowsTerminalView(client, view, selectedProvider, deps, expectedPlan);
    const launchWindow = await windowLauncher(deps, windowNotes);
    const measured = typeof launchWindow !== "string" ? await deps.columns?.().catch(() => undefined) : undefined;
    let viewportColumns = Number.isSafeInteger(measured) && measured! > 0 ? measured : undefined;
    const herdr = selectedProvider === "tmux" ? null : await herdrBinary(deps);
    if (!herdr && selectedProvider === "herdr") throw new Error(session === undefined
      ? "Herdr is not installed. Run rig setup, or use --provider tmux --window."
      : "Herdr is not installed, so the requested session cannot be opened. Install Herdr with rig setup.");
    provider = herdr ? "herdr" : "tmux";
    // Preview is provider-neutral composition, including saved-view membership, absences and quoting.
    const previewUrl = () => `/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr${sessionQuery}${viewportColumns === undefined ? "" : `&viewportColumns=${viewportColumns}`}`;
    const preview = await client.get<Preview | OpenViewResult>(previewUrl(), { headers: terminalAuthHeaders() });
    if (preview.status >= 400 || !("composed" in preview.data)) {
      return failed((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
    }
    if (session !== undefined && (preview.data.session !== session || preview.data.status.launch?.session !== session || !preview.data.status.launch.socketPath)) {
      return failed("The daemon did not confirm the requested Herdr session. Update the daemon before opening a named session.");
    }
    const launchTarget = preview.data.status.launch;
    let { composed, planId, remote } = preview.data;
    await assertLocalTmux(client, preview.data.tmux?.mode, "The window launcher must run on the daemon's own desktop; its instance identity could not be confirmed locally.");
    const tmuxServer = readTmuxServerArgs(composed.localTmuxServer);
    if (expectedPlan !== undefined && expectedPlan !== planId) {
      return failure(provider, "The terminal view changed since preview. Refresh the preview before opening.");
    }
    if (!composed.opened.length && !following) return { ...failed("No conversations are attachable."), absent: composed.absent, degraded: composed.degraded };
    const measureWindow = async () => {
      if (window && "columns" in window && window.columns !== viewportColumns && composed.kernelLayout) {
        viewportColumns = window.columns;
        const next = await client.get<Preview | OpenViewResult>(previewUrl(), { headers: terminalAuthHeaders() });
        if (next.status >= 400 || !("composed" in next.data)) throw new Error("Could not compose the measured terminal view.");
        await assertLocalTmux(client, next.data.tmux?.mode, "The window launcher must run on the daemon's own desktop; its instance identity could not be confirmed locally.");
        if (session !== undefined && (next.data.session !== session || next.data.status.launch?.socketPath !== launchTarget?.socketPath)) {
          throw new Error("The selected Herdr endpoint changed while opening the window. Inspect it before retrying.");
        }
        if (expectedPlan !== undefined && expectedPlan !== next.data.planId) throw new Error("The measured terminal layout differs from the expected preview; refresh the preview before opening.");
        if (JSON.stringify(readTmuxServerArgs(next.data.composed.localTmuxServer)) !== JSON.stringify(tmuxServer)) {
          throw new Error("The daemon's tmux server changed while opening the window; refresh the preview before retrying.");
        }
        ({ composed, planId, remote } = next.data);
        if (!composed.opened.length) throw new Error("No conversations are attachable after opening the terminal.");
      }
      if (composed.kernelLayout) windowNotes.push(viewportColumns === undefined
        ? "Terminal width could not be measured; the OpenRig view uses the operator-only first page."
        : `OpenRig view layout measured at ${viewportColumns} columns: ${viewportColumns >= 120 ? "dashboard and operator side by side; advisor on a separate page" : "operator first; dashboard and advisor on separate pages"}.`);
    };
    const socket = launchTarget?.socketPath;
    if (typeof launchWindow === "object") {
      provider = "herdr";
      if (selectedProvider === "tmux") return failed("The current Herdr view requires provider herdr; no extra window was opened.");
      const socketCheck = checkCurrentHerdrSocket(deps.env, socket, deps.platform);
      if (!socketCheck.ok) {
        const here = socketCheck.callerSession
          ? `You're in Herdr session ${JSON.stringify(socketCheck.callerSession)}. To place the view here, run: rig terminal open ${shellQuote(view)} --session ${shellQuote(socketCheck.callerSession)}. ` : "";
        return failed(`The current Herdr endpoint differs from the selected endpoint; no space was opened in another session. ${here}Use --provider herdr without --window to place a view in the selected session.`);
      }
      if (!herdr) return failed("The Herdr executable is unavailable; no space was opened.");
      // Set only once a space may open, so the refusals above read as "nothing was opened".
      currentHerdr = true;
      windowNotes.push("Using the current Herdr session; no terminal window or personal config was changed.");
    }
    let configEnv = "";
    let configPrefix = "";
    let nativeConfig: string | undefined;
    if (herdr && socket && !currentHerdr) {
      try {
        const narrow = deps.herdrConfig(socket);
        if (deps.platform === "win32") nativeConfig = narrow;
        const wide = typeof launchWindow === "function" && deps.platform !== "win32" ? deps.herdrConfig(socket, 160) : narrow;
        if (narrow === wide) configEnv = ` HERDR_CONFIG_PATH=${shellQuote(narrow)}`;
        else configPrefix = `set -- $(stty size 2>/dev/null); if [ "${'${2:-0}'}" -ge 160 ]; then export HERDR_CONFIG_PATH=${shellQuote(wide)}; else export HERDR_CONFIG_PATH=${shellQuote(narrow)}; fi; exec `;
        windowNotes.push("Your Herdr config is kept when present; otherwise the sidebar starts open at 160 columns and collapsed below.");
      } catch (error) {
        windowNotes.push(`Could not prepare OpenRig's private Herdr settings (${error instanceof Error ? error.message : String(error)}); Herdr starts with its usual sidebar.`);
      }
    }
    const directCommand = herdr && socket && deps.platform === "win32"
      ? renderWindowsLaunchArgv([herdr],{HERDR_SOCKET_PATH:socket,...(nativeConfig?{HERDR_CONFIG_PATH:nativeConfig}:{})},{remove:["TMUX","HERDR_SESSION","HERDR_SOCKET_PATH"]})
      : herdr && socket
      ? `${configPrefix}env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)}${configEnv} ${shellQuote(herdr)}`
      : `env -u TMUX ${composed.opened[0]!.paneCommand.replace(/^ssh (?!-t(?:\s|$))/, "ssh -t ")}`;
    manualCommand = herdr && socket ? directCommand
      : `env -u TMUX ${(composed.opened[0]!.recoveryCommand ?? composed.opened[0]!.paneCommand).replace(/^ssh (?!-t(?:\s|$))/, "ssh -t ")}`;
    if (typeof launchWindow === "string") {
      const headless = deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]
        || (deps.platform === "linux" && !deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]);
      const where = headless ? "Open a new SSH session to the daemon's host" : "Open a new terminal window on the daemon's host";
      const notes = herdr && socket
        ? [`After the person starts Herdr, have the agent place this view by running: rig terminal open ${shellQuote(view)} --provider herdr${sessionFlag}`] : [];
      return { ...failure(provider, `No terminal window was opened. ${launchWindow} ${where} and run: ${manualCommand}`), windowAttempted: false, absent: composed.absent, degraded: composed.degraded, notes: [...notes, ...windowNotes] };
    }

    if (herdr) {
      const endpoint = launchTarget;
      if (!endpoint?.socketPath) throw new Error("The daemon does not report its herdr endpoint. Update the daemon, or use --provider tmux --window.");
      // A CLI session would override the daemon's resolved socket in Herdr.
      if (typeof launchWindow === "function") {
        windowAttempted = true;
        window = await launchWindow(configPrefix ? `/bin/sh -c ${shellQuote(directCommand)}` : directCommand);
      }
      await measureWindow();
      let alive = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await client.get<{ session?: string; providers: Array<{ liveness: { alive: boolean }; status?: { launch?: { socketPath: string } } }> }>(`/api/terminal/status?provider=herdr${sessionQuery}`, { headers: terminalAuthHeaders() });
        if (session !== undefined && (status.data.session !== session || status.data.providers?.[0]?.status?.launch?.socketPath !== endpoint.socketPath)) {
          throw new Error("The daemon did not confirm the selected Herdr endpoint after the window request. Inspect it before retrying.");
        }
        if (status.data.providers?.[0]?.liveness.alive) { alive = true; break; }
        await deps.sleep(250);
      }
      if (!alive) throw new Error("The terminal was requested, but herdr's control socket did not become ready. Inspect the new terminal before retrying.");
      // Inventory is read-only: a failed read must not prevent the first open.
      // Scope each tab list to its workspace, on the daemon's exact endpoint.
      const herdrArgs = ["-u", "TMUX", "-u", "HERDR_SESSION", "-u", "HERDR_SOCKET_PATH", `HERDR_SOCKET_PATH=${endpoint.socketPath}`, herdr];
      if (following) {
        // Follow has a stable journaled workspace. A changed membership plan
        // must never enter the one-shot plan-label/new-workspace path below.
        const answer = await client.post<OpenViewResult>("/api/terminal/follow", { view, provider: "herdr", ...following,
          ...(session !== undefined ? { session } : {}), ...(expectedPlan !== undefined ? { expectedPlan } : {}) },
          { timeoutMs: 45_000, headers: terminalAuthHeaders() });
        if (!answer.data.ok || !answer.data.workspaceId) return { ...answer.data, window, notes: [...(answer.data.notes ?? []), ...windowNotes] };
        const selectedArgs = herdrArgs;
        const selectedStatus = JSON.parse(await deps.exec("/usr/bin/env", [...selectedArgs, "status", "server", "--json"]));
        const selectedBody = selectedStatus?.result ?? selectedStatus;
        if (selectedStatus.error || selectedBody?.running !== true || selectedBody.socket !== endpoint.socketPath) {
          throw new Error("The Herdr CLI did not confirm the daemon's exact following endpoint; no tab lookup or focus was requested.");
        }
        const listed = JSON.parse(await deps.exec("/usr/bin/env", [...selectedArgs, "tab", "list", "--workspace", answer.data.workspaceId]));
        const tab = (listed?.result?.tabs as HerdrTab[] | undefined)?.find(t => t.workspace_id === answer.data.workspaceId);
        if (!tab) throw new Error("The stable following workspace has no confirmed tab. Inspect it before retrying.");
        const focused = JSON.parse(await deps.exec("/usr/bin/env", [...selectedArgs, "tab", "focus", tab.tab_id]));
        if (focused?.result?.tab?.tab_id !== tab.tab_id || focused.result.tab.workspace_id !== tab.workspace_id) throw new Error("Following tab selection was not confirmed.");
        return { ...answer.data, window, notes: [...(answer.data.notes ?? []), ...windowNotes] };
      }
      // Pinned to the endpoint the inventory read, as the daemon's note is: a bare herdr follows the caller's shell, which may name another server.
      const closeCommand = (id: string) => herdrCloseCommand(deps.platform ?? process.platform, endpoint.socketPath, id, { posix: shellQuote(herdr) });
      let found: LiveWorkspaceSearch = { unconfirmed: [], stale: [], fixedSize: [] };
      try {
        found = await findLiveHerdrWorkspace({ id: composed.id, planId, pages: composed.pages, ...(composed.spaceLabel ? { spaceLabel: composed.spaceLabel } : {}) },
          { platform: deps.platform, herdr: args => deps.exec("/usr/bin/env", [...herdrArgs, ...args]), exec: (file, args) => deps.exec(file, args), serverArgs: tmuxServer });
      } catch (err) {
        windowNotes.push(`Could not check existing Herdr workspaces: ${(err as Error).message} Creating a fresh workspace; existing workspaces are kept.`);
      }
      // In the person's own Herdr, its focused space is what they are looking at.
      const shownNote = async (workspaceId?: string) => {
        if (currentHerdr) try {
          const listed = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "workspace", "list"]));
          const focused = (listed?.result?.workspaces as Array<{ workspace_id?: string; label?: string; focused?: boolean }> | undefined)?.find(ws => ws?.focused);
          if (focused && (workspaceId ? focused.workspace_id === workspaceId : !!composed.spaceLabel && focused.label === composed.spaceLabel)) {
            return `Herdr shows the ${focused.label ?? "view's"} space in the person's current session.`;
          }
        } catch { /* Unconfirmed: say so below. */ }
        return currentHerdr ? "Herdr did not confirm the view's space is focused; ask the person whether they see it." : "Check the new terminal shows the intended view; window creation alone is not visual confirmation.";
      };
      for (const id of found.fixedSize) windowNotes.push(fixedSizeWorkspaceNote(id, closeCommand(id)));
      for (const id of found.stale) {
        if (found.fixedSize.includes(id)) continue;
        windowNotes.push(`Workspace ${id} has an older or different plan for this view and was kept. After inspecting it, close it if no longer needed: ${closeCommand(id)}`);
      }
      for (const id of found.unconfirmed) {
        if (found.fixedSize.includes(id)) continue;
        windowNotes.push(`Could not confirm live attachments in workspace ${id}. Its contents were kept. After inspecting it, close it if no longer needed: ${closeCommand(id)}`);
      }
      const existing = found.live;
      if (existing) {
        const focused = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "tab", "focus", existing.tab_id])) as {
          result?: { tab?: { tab_id?: string; workspace_id?: string } };
        };
        if (focused?.result?.tab?.tab_id !== existing.tab_id || focused.result.tab.workspace_id !== existing.workspace_id) {
          throw new Error("Herdr did not confirm the existing view selection; no replacement space was created.");
        }
        return {
          provider, ok: true, opened: [], absent: composed.absent, degraded: composed.degraded, pages: 0, window,
          ...(session !== undefined ? { session } : {}),
          reusedWorkspace: { id: existing.workspace_id, tabId: existing.tab_id, view: composed.id },
          notes: [...windowNotes, "Existing local tmux attachments were confirmed and workspace contents were kept; no layout refresh or new tiles were requested.", await shownNote(existing.workspace_id)],
        };
      }
      const result = await client.post<OpenViewResult>("/api/terminal/open", { view, provider: "herdr", ...(session !== undefined ? { session } : {}), expectedPlan: planId, ...(viewportColumns !== undefined ? { viewportColumns } : {}) }, { timeoutMs: 45_000 });
      if (result.status >= 400) return { ...failed(result.data.error ?? `The daemon refused the view (HTTP ${result.status}).`), window, notes: windowNotes, absent: composed.absent, degraded: composed.degraded };
      if (!Array.isArray(result.data?.opened)) throw new Error("The terminal opened, but the daemon returned no view result. Inspect it before retrying.");
      if (session !== undefined && result.data.session !== session) throw new Error("The daemon's response did not confirm the selected Herdr session. Inspect the selected endpoint before retrying.");
      return { ...result.data, window, notes: [...(result.data.notes ?? []), ...windowNotes, await shownNote()] };
    }

    if (typeof launchWindow !== "function") throw new Error("No terminal window launcher is available.");
    const tmux = (await deps.exec("/bin/sh", ["-c", "command -v tmux"]).catch(() => "")).trim();
    if (!tmux) throw new Error("tmux is unavailable; run rig setup first.");
    const runTmux = (args: string[]) => deps.exec(tmux, [...tmuxServer, ...args]);
    const serverWords = tmuxServer.map((arg, index) => index % 2 ? shellQuote(arg) : arg).join(" ");
    const tmuxCommand = `${shellQuote(tmux)}${serverWords ? ` ${serverWords}` : ""}`;
    viewer = `openrig-view-${deps.id()}`;
    let placeholder: CreatedPlaceholder | undefined;
    if (composed.kernelLayout) {
      // This is our fresh, empty viewer, never a source seat. Attach it first so Terminal can
      // report the real new window width before we select the OpenRig view layout.
      placeholder = parseCreatedTmuxIds(
        await runTmux(["new-session", "-d", "-s", viewer, "-n", "view-1", "-P", "-F", "#{session_id}|#{window_id}|#{pane_id}"]),
        "placeholder new-session",
      );
      windowAttempted = true;
      window = await launchWindow(`env -u TMUX ${tmuxCommand} attach-session -t ${shellQuote(`=${viewer}`)}`);
      await measureWindow();
    }
    const rigViewer = isOwnedRigViewer(composed, view, preview.data.viewDescriptor, preview.data.rigViewer);
    const createdViewer = await createTmuxViewerLayout(runTmux, viewer, composed, placeholder, rigViewer, tmuxServer);
    if (createdViewer.ownershipNote) windowNotes.push(createdViewer.ownershipNote);
    if (!window) {
      windowAttempted = true;
      window = await launchWindow(`env -u TMUX ${tmuxCommand} attach-session -t ${shellQuote(`=${viewer}`)}`);
    }
    return { provider, ok: true, opened: composed.opened.map(pane => pane.seat), ...(Array.isArray(remote) ? { remote } : {}), absent: composed.absent, degraded: composed.degraded, pages: composed.pages.length, window, notes: [`Viewing session: ${viewer}. Existing conversations were preserved.`, ...windowNotes, "Check the new terminal shows the intended view; window creation alone is not visual confirmation."] };
  } catch (err) {
    if (windowAttempted && /-1743\b/.test(`${(err as Error).message} ${(err as { stderr?: string }).stderr ?? ""}`)) {
      windowNotes.push("macOS denied Automation access. In System Settings > Privacy & Security > Automation, allow the calling app to control the terminal app before trying again.");
      if (manualCommand) windowNotes.push(`To continue without Automation, open a terminal yourself and run: ${manualCommand}`);
      if (provider === "herdr") windowNotes.push(`After Herdr starts, have the agent place the view: rig terminal open ${shellQuote(view)} --provider herdr${sessionFlag}`);
    }
    return { ...failed((err as Error).message), ...(window ? { window } : {}), ...(windowNotes.length || viewer ? { notes: [...windowNotes, ...(viewer ? [`Viewing session ${viewer} may exist. Inspect it before retrying; no existing conversation was replaced.`] : [])] } : {}) };
  }
}

export async function openAllTerminalWindows(
  client: DaemonClient,
  requestedProvider?: string,
  deps = defaultWindowDeps(),
  requestedSession?: string,
): Promise<OpenAllResult> {
  const selected = requestedProvider?.trim();
  const session = requestedSession?.trim();
  const windowNotes: string[] = [];
  if (!isLocalTmuxHost(client.baseUrl)) {
    return { ok: false, provider: selected ?? "herdr", rigs: [], code: "remote_daemon", error: "The window launcher must run on the daemon's own desktop; the configured daemon is remote." };
  }
  if (selected && ["herdr-app", "cmux", "rex"].includes(selected)) {
    return { ok: false, provider: selected, rigs: [], code: "unsupported_provider", error: `--all supports herdr or tmux --window; ${selected} is unsupported.` };
  }
  if (selected && !["herdr", "tmux"].includes(selected)) {
    return { ok: false, provider: selected, rigs: [], code: "unknown_provider", error: `unknown provider '${selected}'` };
  }
  if (session !== undefined && selected === "tmux") {
    return { ok: false, provider: "tmux", rigs: [], code: "unsupported_terminal_session", error: "--session selects a Herdr session; use --provider herdr." };
  }

  const launchWindow = await windowLauncher(deps, windowNotes);
  if (typeof launchWindow === "string") {
    return { ok: false, provider: selected ?? "herdr", rigs: [], windowAttempted: false, code: "terminal_window_failed", error: `No terminal window was opened. ${launchWindow}`, notes: windowNotes };
  }
  if (typeof launchWindow === "object" && selected === "tmux") {
    return {
      ok: false,
      provider: "tmux",
      rigs: [],
      windowAttempted: false,
      code: "terminal_window_failed",
      error: "No terminal window was opened. The current Herdr view requires provider herdr; no extra window was opened.",
      ...(windowNotes.length ? { notes: windowNotes } : {}),
    };
  }

  const herdr = selected === "tmux" ? null : await herdrBinary(deps);
  if (!herdr && (selected === "herdr" || session !== undefined)) {
    return {
      ok: false,
      provider: "herdr",
      ...(session !== undefined ? { session } : {}),
      rigs: [],
      windowAttempted: false,
      code: session !== undefined ? "unsupported_terminal_session" : "terminal_window_failed",
      error: session !== undefined
        ? "Herdr is not installed, so the requested session cannot be opened. Install Herdr with rig setup."
        : "Herdr is not installed. Run rig setup, or use --provider tmux --window.",
    };
  }
  if (herdr) {
    return openAllHerdrWindow(client, deps, herdr, launchWindow, session, windowNotes);
  }
  if (typeof launchWindow !== "function") {
    return {
      ok: false,
      provider: "herdr",
      ...(session !== undefined ? { session } : {}),
      rigs: [],
      windowAttempted: false,
      code: "terminal_window_failed",
      error: "No terminal window was opened. The Herdr executable is unavailable; no space was opened.",
      ...(windowNotes.length ? { notes: windowNotes } : {}),
    };
  }
  return openAllTmuxWindows(client, deps, launchWindow, windowNotes);
}

async function openAllHerdrWindow(
  client: DaemonClient,
  deps: WindowDeps,
  herdr: string,
  launchWindow: ((command: string) => Promise<{ app: string; surface: string; columns?: number }>) | { currentHerdr: true },
  session: string | undefined,
  windowNotes: string[],
): Promise<OpenAllResult> {
  let window: { app: string; surface: string } | undefined;
  let windowAttempted = false;
  let openAllRequested = false;
  try {
    const sessionQuery = session === undefined ? "" : `&session=${encodeURIComponent(session)}`;
    const statusRes = await client.get<{ session?: string; tmux?: { mode?: "inherit" | "isolated" }; providers: Array<{ liveness?: { alive: boolean }; status?: { launch?: { socketPath?: string; session?: string } } }> }>(`/api/terminal/status?provider=herdr${sessionQuery}`, { headers: terminalAuthHeaders() });
    if (statusRes.status >= 400) {
      return { ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [], windowAttempted: false, code: "terminal_window_failed", error: `Could not read terminal status (HTTP ${statusRes.status}).` };
    }
    if (session !== undefined && statusRes.data?.session !== session) {
      return { ok: false, provider: "herdr", session, rigs: [], windowAttempted: false, code: "terminal_session_mismatch", error: "The daemon did not confirm the requested Herdr session." };
    }
    await assertLocalTmux(client, statusRes.data.tmux?.mode, "The window launcher must run on the daemon's own desktop; its instance identity could not be confirmed locally.");
    const socket = statusRes.data.providers?.[0]?.status?.launch?.socketPath;
    if (!socket) {
      return { ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [], windowAttempted: false, code: "terminal_window_failed", error: "The daemon does not report its herdr endpoint. Update the daemon, or use --provider tmux --window." };
    }
    if (typeof launchWindow === "object") {
      const socketCheck = checkCurrentHerdrSocket(deps.env, socket, deps.platform);
      if (!socketCheck.ok) {
        const here = socketCheck.callerSession
          ? `You're in Herdr session ${JSON.stringify(socketCheck.callerSession)}. ` : "";
        return {
          ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [], windowAttempted: false,
          code: "terminal_window_failed",
          error: `The current Herdr endpoint differs from the selected endpoint; no space was opened in another session. ${here}Use --provider herdr without --window to place views in the selected session.`,
          notes: windowNotes,
        };
      }
      windowNotes.push("Using the current Herdr session; no terminal window or personal config was changed.");
    }
    if (typeof launchWindow === "function") {
      let configEnv = "";
      try { configEnv = ` HERDR_CONFIG_PATH=${shellQuote(deps.herdrConfig(socket))}`; } catch { /* Optional config. */ }
      const directCommand = `env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)}${configEnv} ${shellQuote(herdr)}`;
      windowAttempted = true;
      try {
        window = await launchWindow(directCommand);
      } catch (err) {
        if (/-1743\b/.test(`${(err as Error).message} ${(err as { stderr?: string }).stderr ?? ""}`)) {
          windowNotes.push("macOS denied Automation access. In System Settings > Privacy & Security > Automation, allow the calling app to control the terminal app before trying again.");
        }
        return { ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [], windowAttempted, code: "terminal_window_failed", error: (err as Error).message, notes: windowNotes };
      }
    }
    let alive = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      const probe = await client.get<{ providers: Array<{ liveness: { alive: boolean }; status?: { launch?: { socketPath?: string } } }> }>(`/api/terminal/status?provider=herdr${sessionQuery}`, { headers: terminalAuthHeaders() });
      const ready = probe.data.providers?.[0];
      if (ready?.liveness.alive && ready.status?.launch?.socketPath === socket) { alive = true; break; }
      await deps.sleep(250);
    }
    if (!alive) {
      return { ok: false, provider: "herdr", ...(session !== undefined ? { session } : {}), rigs: [], window, windowAttempted, code: "herdr_unavailable", error: "The terminal was requested, but herdr's control socket did not become ready.", notes: windowNotes };
    }
    openAllRequested = true;
    const res = await client.post<OpenAllResult>("/api/terminal/open-all",
      { provider: "herdr", reuseLive: true, ...(session !== undefined ? { session } : {}) },
      { timeoutMs: 45_000, headers: terminalAuthHeaders() });
    const body = res.data && typeof res.data === "object" ? res.data : undefined;
    const bodyNotes = body && Array.isArray(body.notes) ? body.notes : [];
    if (res.status >= 400 || !body || !Array.isArray(body.rigs)) {
      return {
        ...(body ?? {}),
        ok: false,
        provider: body?.provider ?? "herdr",
        ...(session !== undefined ? { session } : {}),
        rigs: Array.isArray(body?.rigs) ? body.rigs : [],
        ...(window ? { window } : {}),
        windowAttempted,
        error: body?.error ?? (res.status >= 400 ? `Daemon refused bulk terminal open (HTTP ${res.status}).` : "Daemon returned an invalid bulk terminal open response."),
        notes: [...bodyNotes, ...windowNotes],
      };
    }
    if (session !== undefined && body.session !== session) {
      return {
        ...body,
        ok: false,
        code: "terminal_session_mismatch",
        error: `The daemon's response did not confirm selected Herdr session ${JSON.stringify(session)}. Inspect the selected endpoint before retrying.`,
        ...(window ? { window } : {}),
        windowAttempted,
        notes: [...bodyNotes, ...windowNotes],
      };
    }
    return { ...body, ...(window ? { window } : {}), notes: [...bodyNotes, ...windowNotes] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (openAllRequested && typeof launchWindow === "object") {
      windowNotes.push("The /api/terminal/open-all request had already been sent to the current Herdr session; inspect Herdr before retrying.");
    }
    const error = window
      ? `A terminal window was requested, but the bulk view outcome could not be confirmed. ${message}`
      : windowAttempted
        ? `Terminal window status is unknown. ${message}`
        : openAllRequested
          ? `The current Herdr bulk view outcome could not be confirmed. ${message}`
          : `No terminal window was opened. ${message}`;
    return {
      ok: false,
      provider: "herdr",
      ...(session !== undefined ? { session } : {}),
      rigs: [],
      ...(window ? { window } : {}),
      windowAttempted,
      code: "terminal_window_failed",
      error,
      ...(windowNotes.length ? { notes: windowNotes } : {}),
    };
  }
}

async function openAllTmuxWindows(
  client: DaemonClient,
  deps: WindowDeps,
  launchWindow: (command: string) => Promise<{ app: string; surface: string; columns?: number }>,
  windowNotes: string[],
): Promise<OpenAllResult> {
  let tmux = "";
  let tmuxServer: string[] = [];
  let runTmux: (args: string[]) => Promise<string>;
  let tmuxCommand = "";
  let rigIdentities: Array<{ id: string; name: string }> = [];
  try {
    tmux = (await deps.exec("/bin/sh", ["-c", "command -v tmux"]).catch(() => "")).trim();
    if (!tmux) {
      return { ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed", error: "tmux is unavailable; run rig setup first." };
    }
    const statusRes = await client.get<{ tmux?: { mode?: "inherit" | "isolated"; serverArgs?: unknown } }>("/api/terminal/status", { headers: terminalAuthHeaders() });
    if (statusRes.status >= 400) {
      return { ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "terminal_window_failed", error: `Cannot inspect tmux status (HTTP ${statusRes.status}).` };
    }
    await assertLocalTmux(client, statusRes.data.tmux?.mode, "The window launcher must run on the daemon's own desktop; its instance identity could not be confirmed locally.");
    tmuxServer = readTmuxServerArgs(statusRes.data.tmux?.serverArgs);
    runTmux = (args: string[]) => deps.exec(tmux, [...tmuxServer, ...args]);
    const serverWords = tmuxServer.map((arg, index) => index % 2 ? shellQuote(arg) : arg).join(" ");
    tmuxCommand = `${shellQuote(tmux)}${serverWords ? ` ${serverWords}` : ""}`;

    const viewsRes = await client.get<{ rigIdentities?: Array<{ id: string; name: string }>; error?: string }>("/api/terminal/views", { headers: terminalAuthHeaders() });
    if (viewsRes.status >= 400 || !Array.isArray(viewsRes.data?.rigIdentities)) {
      return {
        ok: false, provider: "tmux", rigs: [], windowAttempted: false, code: "views_unavailable",
        error: viewsRes.data?.error ?? `Cannot list rig views (HTTP ${viewsRes.status}).`,
        ...(windowNotes.length ? { notes: windowNotes } : {}),
      };
    }
    const byId = new Map(viewsRes.data.rigIdentities.map(rig => [rig.id, rig]));
    rigIdentities = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  } catch (err) {
    return {
      ok: false,
      provider: "tmux",
      rigs: [],
      windowAttempted: false,
      code: "terminal_window_failed",
      error: `No terminal window was opened. ${err instanceof Error ? err.message : String(err)}`,
      ...(windowNotes.length ? { notes: windowNotes } : {}),
    };
  }
  const rigs: OpenAllRigResult[] = [];
  let automationDeniedError: string | null = null;
  let anyWindowAttempted = false;
  let anyViewerEffect = false;

  for (const identity of rigIdentities) {
    const rig = identity.name;
    const view = `rig:${identity.id}`;
    try {
    if (automationDeniedError !== null) {
      rigs.push({ rig, rigId: identity.id, view, outcome: "failed", code: "automation_denied", error: automationDeniedError, opened: [], absent: [], degraded: [], skipped: [] });
      continue;
    }
    let previewData: Preview | OpenViewResult | undefined;
    let previewStatus = 200;
    try {
      const previewRes = await client.get<Preview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr&bulk=1`, { headers: terminalAuthHeaders() });
      previewStatus = previewRes.status;
      previewData = previewRes.data;
    } catch (err) {
      rigs.push({
        rig, rigId: identity.id, view, outcome: "failed", opened: [], absent: [], degraded: [], skipped: [],
        code: "terminal_window_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (previewStatus >= 400 || !previewData || !("composed" in previewData)) {
      const errData = (previewData ?? {}) as OpenViewResult;
      rigs.push({ rig, rigId: identity.id, view, outcome: "failed", opened: [], absent: [], degraded: [], skipped: [], ...(errData.code ? { code: errData.code } : {}), error: errData.error ?? "Could not compose rig view." });
      continue;
    }
    const { composed, skipped = [] } = previewData;
    if (composed.opened.length === 0) {
      const outcome = skipped.length > 0 && composed.absent.length === 0 ? "skipped" : "absent";
      rigs.push({ rig, rigId: identity.id, view, outcome, opened: [], absent: composed.absent, degraded: composed.degraded, skipped });
      continue;
    }

    try {
      if (JSON.stringify(readTmuxServerArgs(composed.localTmuxServer)) !== JSON.stringify(tmuxServer)) {
        throw new Error("The preview tmux endpoint changed. Refresh the preview; no viewer was created.");
      }
    } catch (err) {
      rigs.push({ rig, rigId: identity.id, view, outcome: "failed", code: "tmux_endpoint_changed",
        opened: [], absent: composed.absent, degraded: composed.degraded, skipped,
        error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    const viewer = `openrig-view-${deps.id()}`;
    let created: CreatedTmuxViewer | undefined;

    try {
      anyViewerEffect = true;
      created = await createTmuxViewerLayout(runTmux, viewer, composed, undefined, true, tmuxServer);
      anyWindowAttempted = true;
      const window = await launchWindow(`env -u TMUX ${tmuxCommand} attach-session -t ${shellQuote(`=${viewer}`)}`);
      rigs.push({
        rig, rigId: identity.id, view, outcome: "opened", opened: composed.opened.map(p => p.seat),
        absent: composed.absent, degraded: composed.degraded, skipped,
        notes: [`Viewing session: ${viewer} (${window.app}). Existing conversations were preserved.`, ...(created.ownershipNote ? [created.ownershipNote] : [])],
      });
    } catch (err) {
      const message = (err as Error).message;
      const isAutomationDenied = /-1743\b/.test(`${message} ${(err as { stderr?: string }).stderr ?? ""}`);
      if (isAutomationDenied) {
        automationDeniedError = "macOS denied Automation access for remaining rig viewers.";
        windowNotes.push("macOS denied Automation access. In System Settings > Privacy & Security > Automation, allow the calling app to control the terminal app before trying again.");
      }
      const cleanup = created ? await verifyAndCleanupFailedTmuxViewer(runTmux, created) : "unknown";
      const retentionNote = cleanup !== "unknown"
        ? undefined
        : created
          ? (created.proof
            ? `Viewing session ${created.sessionName} could not be verified clean and was retained; inspect it or run rig terminal close --all.`
            : `Viewing session ${created.sessionName} could not be verified clean and was retained without confirmed ownership options; inspect it before retrying.`)
          : `Attempted viewing session ${viewer} could not be verified absent or cleaned up (partially created viewer may still exist without an ownership record); inspect it before retrying.`;
      rigs.push({
        rig, rigId: identity.id, view, outcome: "failed", opened: [], absent: composed.absent, degraded: composed.degraded, skipped,
        ...(isAutomationDenied ? { code: "automation_denied" } : {}),
        cleanup, error: message,
        ...(retentionNote ? { notes: [retentionNote] } : {}),
      });
    }
    } catch (err) {
      rigs.push({ rig, rigId: identity.id, view, outcome: "failed", code: "terminal_window_failed",
        opened: [], absent: [], degraded: [], skipped: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  const anyOpened = rigs.some(r => r.outcome === "opened");
  const anyFailed = rigs.some(r => r.outcome === "failed");
  const failedSummary = rigs
    .filter(r => r.outcome === "failed")
    .map(r => `${r.rig}: ${r.error ?? "failed"}`)
    .join("; ");
  return {
    ok: anyOpened,
    provider: "tmux",
    rigs,
    ...(anyFailed ? { windowAttempted: anyWindowAttempted } : {}),
    ...(!anyOpened && anyFailed ? {
      code: "terminal_window_failed",
      error: anyWindowAttempted || anyViewerEffect
        ? `Some tmux rig viewers were started or attempted, but none opened completely: ${failedSummary}`
        : `No terminal window was opened. ${failedSummary}`,
    } : {}),
    ...(windowNotes.length ? { notes: windowNotes } : {}),
  };
}

export async function hasLiveAttachments(existing: HerdrTab, tabs: HerdrTab[], pages: Pane[][], pageLabel: (index: number) => string, herdrArgs: string[], deps: WindowDeps, serverArgs: readonly string[]): Promise<boolean> {
  return hasLiveHerdrAttachments(existing, tabs, pages, pageLabel, { platform: deps.platform, serverArgs, exec: (file,args)=>deps.exec(file,args), herdr: args=>deps.exec("/usr/bin/env", [...herdrArgs,...args]) });
}
