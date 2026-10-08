import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DaemonClient } from "./client.js";
import { shellQuote } from "./cross-host-executor.js";
import { prepareHerdrLaunchConfig } from "./herdr-launch-config.js";
import type { OpenViewResult } from "./commands/terminal.js";

interface Pane { seat: string; label: string; paneCommand: string }
interface HerdrTab { workspace_id: string; tab_id: string; label: string }
interface Preview {
  planId: string;
  status: { launch?: { socketPath: string; session?: string } };
  composed: { id: string; opened: Pane[]; pages: Pane[][]; columns?: number; kernelLayout?: string; spaceLabel?: string; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
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

export function defaultWindowDeps(): WindowDeps {
  const env = { ...process.env };
  delete env["TMUX"];
  const run = promisify(execFile);
  return {
    platform: process.platform, env, exists: existsSync,
    exec: async (file, args, timeoutMs = 10_000) => (await run(file, args, { env, encoding: "utf8", timeout: timeoutMs })).stdout,
    launch: (file, args) => new Promise((resolve, reject) => {
      const child = spawn(file, args, { env, detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    id: () => randomUUID().slice(0, 12),
    notice: message => process.stderr.write(`${message}\n`),
    herdrConfig: (socketPath, columns) => prepareHerdrLaunchConfig(env, socketPath, columns),
    columns: async () => {
      if (process.stdout.isTTY && process.stdout.columns > 0) return process.stdout.columns;
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

function localDaemon(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return ["localhost", "::1", "::", "0.0.0.0", hostname()].includes(host)
    || /^127\./.test(host)
    || Object.values(networkInterfaces()).flat().some(iface => iface?.address === host);
}

async function herdrBinary(deps: WindowDeps): Promise<string | null> {
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
  if (deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]) return "This is an SSH session; no desktop window is opened over SSH.";
  if (host === "herdr") return { currentHerdr: true };
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

function failure(provider: string, error: string): OpenViewResult {
  return { provider, ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code: "terminal_window_failed" };
}

/** Saved Herdr labels survive reboot; only current clients prove a local attachment. */
async function hasLiveAttachments(existing: HerdrTab, tabs: HerdrTab[], pages: Pane[][], pageLabel: (index: number) => string, herdrArgs: string[], deps: WindowDeps): Promise<boolean> {
  try {
    const tmux = (await deps.exec("/bin/sh", ["-c", "command -v tmux"])).trim();
    if (!path.isAbsolute(tmux)) return false;
    const listed = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "pane", "list", "--workspace", existing.workspace_id]));
    const panes = listed?.result?.panes as Array<{ workspace_id: string; tab_id: string; pane_id: string }> | undefined;
    if (!Array.isArray(panes) || !panes.every(pane => pane && pane.workspace_id === existing.workspace_id && typeof pane.tab_id === "string" && typeof pane.pane_id === "string" && pane.pane_id)) return false;
    const clients = new Map<string, string[]>();
    // Match view-composer's serialization (these strings are compared, never executed).
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const inventory = await deps.exec(tmux, ["list-clients", "-F", "#{client_pid}\t#{session_name}\t#{client_readonly}"]);
    for (const line of inventory.trim().split("\n")) {
      const [pid, session, readOnly] = line.split("\t");
      if (!pid || !/^\d+$/.test(pid) || !session || !["0", "1"].includes(readOnly ?? "")) continue;
      // Compare the composer's exact command, including session aliases and read-only mode.
      // SSH/custom commands cannot be confirmed from this local client inventory.
      clients.set(pid, ["tmux", quote(tmux)].map(binary => `${binary} attach ${readOnly === "1" ? "-r " : ""}-t ${quote(session)}`));
    }
    const used = new Set<string>();
    for (const [index, page] of pages.entries()) {
      const label = pageLabel(index);
      const matches = tabs.filter(tab => tab.workspace_id === existing.workspace_id && tab.label === label);
      if (matches.length !== 1) return false;
      const remaining = page.map(pane => pane.paneCommand);
      for (const pane of panes.filter(pane => pane.tab_id === matches[0]!.tab_id)) {
        if (remaining.length === 0) break;
        const result = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "pane", "process-info", "--pane", pane.pane_id]));
        const info = result?.result?.process_info;
        if (info?.pane_id !== pane.pane_id || (info.foreground_processes !== undefined && !Array.isArray(info.foreground_processes))) return false;
        for (const process of info.foreground_processes ?? []) {
          const pid = String(process?.pid);
          if (used.has(pid)) continue;
          const found = remaining.findIndex(command => clients.get(pid)?.includes(command));
          if (found < 0) continue;
          remaining.splice(found, 1);
          used.add(pid);
          break; // One Herdr pane can satisfy only one expected tile.
        }
      }
      if (remaining.length) return false;
    }
    return pages.length > 0;
  } catch {
    // Read failures prevent reuse, not opening. Never type into or close an unverified pane.
    return false;
  }
}

/** Render the daemon's existing composition; never rediscover/relaunch kernel seats here. */
export async function openTerminalWindow(client: DaemonClient, view: string, requestedProvider?: string, deps = defaultWindowDeps(), expectedPlan?: string): Promise<OpenViewResult> {
  let provider = requestedProvider ?? "herdr";
  let window: { app: string; surface: string; columns?: number } | undefined;
  let viewer: string | undefined;
  let windowAttempted = false;
  let manualCommand: string | undefined;
  let currentHerdr = false;
  const recovery = `rig terminal open ${shellQuote(view)} --window${requestedProvider && ["herdr", "tmux"].includes(requestedProvider) ? ` --provider ${shellQuote(requestedProvider)}` : ""}`;
  const failed = (reason: string): OpenViewResult => ({ ...failure(provider,
    currentHerdr ? `The current Herdr view outcome could not be confirmed. ${reason} Inspect the selected space before retrying: ${recovery}`
      : window ? `A terminal window was requested, but the view outcome could not be confirmed. ${reason} Inspect the terminal before retrying: ${recovery}`
      : windowAttempted ? `Terminal window status is unknown. ${reason} Inspect the desktop before retrying: ${recovery}`
        : `No terminal window was opened. ${reason} On the daemon's desktop, run: ${recovery}`), windowAttempted });
  const windowNotes: string[] = [];
  try {
    if (!localDaemon(client.baseUrl)) throw new Error("The window launcher must run on the daemon's own desktop; the configured daemon is remote.");
    if (requestedProvider && !["herdr", "tmux"].includes(requestedProvider)) throw new Error("--window supports herdr or tmux. Use cmux without --window.");
    const launchWindow = await windowLauncher(deps, windowNotes);
    const measured = typeof launchWindow !== "string" ? await deps.columns?.().catch(() => undefined) : undefined;
    let viewportColumns = Number.isSafeInteger(measured) && measured! > 0 ? measured : undefined;
    const herdr = requestedProvider === "tmux" ? null : await herdrBinary(deps);
    if (!herdr && requestedProvider === "herdr") throw new Error("Herdr is not installed. Run rig setup, or use --provider tmux --window.");
    provider = herdr ? "herdr" : "tmux";
    // Preview is provider-neutral composition, including saved-view membership, absences and quoting.
    const previewUrl = () => `/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr${viewportColumns === undefined ? "" : `&viewportColumns=${viewportColumns}`}`;
    const preview = await client.get<Preview | OpenViewResult>(previewUrl());
    if (preview.status >= 400 || !("composed" in preview.data)) {
      return failed((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
    }
    let { composed, planId } = preview.data;
    if (expectedPlan !== undefined && expectedPlan !== planId) {
      return failure(provider, "The terminal view changed since preview. Refresh the preview before opening.");
    }
    if (!composed.opened.length) return { ...failed("No conversations are attachable."), absent: composed.absent, degraded: composed.degraded };
    const measureWindow = async () => {
      if (window && "columns" in window && window.columns !== viewportColumns && composed.kernelLayout) {
        viewportColumns = window.columns;
        const next = await client.get<Preview | OpenViewResult>(previewUrl());
        if (next.status >= 400 || !("composed" in next.data)) throw new Error("Could not compose the measured terminal view.");
        if (expectedPlan !== undefined && expectedPlan !== next.data.planId) throw new Error("The measured terminal layout differs from the expected preview; refresh the preview before opening.");
        ({ composed, planId } = next.data);
        if (!composed.opened.length) throw new Error("No conversations are attachable after opening the terminal.");
      }
      if (composed.kernelLayout) windowNotes.push(viewportColumns === undefined
        ? "Terminal width could not be measured; the OpenRig view uses the operator-only first page."
        : `OpenRig view layout measured at ${viewportColumns} columns: ${viewportColumns >= 120 ? "dashboard and operator side by side; advisor on a separate page" : "operator first; dashboard and advisor on separate pages"}.`);
    };
    const socket = preview.data.status.launch?.socketPath;
    if (typeof launchWindow === "object") {
      provider = "herdr";
      if (requestedProvider === "tmux") return failed("The current Herdr view requires provider herdr; no extra window was opened.");
      const base = path.join(deps.env["HOME"] ?? homedir(), ".config", "herdr");
      const callerSocket = deps.env["HERDR_SOCKET_PATH"] ?? (deps.env["HERDR_SESSION"]
        ? path.join(base, "sessions", deps.env["HERDR_SESSION"], "herdr.sock") : path.join(base, "herdr.sock"));
      if (!socket || path.resolve(socket) !== path.resolve(callerSocket)) return failed("The current Herdr endpoint differs from the daemon's endpoint; no space was opened in another session.");
      if (!herdr) return failed("The Herdr executable is unavailable; no space was opened.");
      // Set only once a space may open, so the refusals above read as "nothing was opened".
      currentHerdr = true;
      windowNotes.push("Using the current Herdr session; no terminal window or personal config was changed.");
    }
    let configEnv = "";
    let configPrefix = "";
    if (herdr && socket && !currentHerdr) {
      try {
        const narrow = deps.herdrConfig(socket);
        const wide = typeof launchWindow === "function" ? deps.herdrConfig(socket, 160) : narrow;
        if (narrow === wide) configEnv = ` HERDR_CONFIG_PATH=${shellQuote(narrow)}`;
        else configPrefix = `set -- $(stty size 2>/dev/null); if [ "${'${2:-0}'}" -ge 160 ]; then export HERDR_CONFIG_PATH=${shellQuote(wide)}; else export HERDR_CONFIG_PATH=${shellQuote(narrow)}; fi; exec `;
        windowNotes.push("Your Herdr config is kept when present; otherwise the sidebar starts open at 160 columns and collapsed below.");
      } catch (error) {
        windowNotes.push(`Could not prepare OpenRig's private Herdr settings (${error instanceof Error ? error.message : String(error)}); Herdr starts with its usual sidebar.`);
      }
    }
    const directCommand = herdr && socket
      ? `${configPrefix}env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)}${configEnv} ${shellQuote(herdr)}`
      : `env -u TMUX ${composed.opened[0]!.paneCommand.replace(/^ssh /, "ssh -t ")}`;
    manualCommand = directCommand;
    if (typeof launchWindow === "string") {
      const headless = deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]
        || (deps.platform === "linux" && !deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]);
      const where = headless ? "Open a new SSH session to the daemon's host" : "Open a new terminal window on the daemon's host";
      const notes = herdr && socket
        ? [`After the person starts Herdr, have the agent place this view by running: rig terminal open ${shellQuote(view)} --provider herdr`] : [];
      return { ...failure(provider, `No terminal window was opened. ${launchWindow} ${where} and run: ${manualCommand}`), windowAttempted: false, absent: composed.absent, degraded: composed.degraded, notes: [...notes, ...windowNotes] };
    }

    if (herdr) {
      const endpoint = preview.data.status.launch;
      if (!endpoint?.socketPath) throw new Error("The daemon does not report its herdr endpoint. Update the daemon, or use --provider tmux --window.");
      // A CLI session would override the daemon's resolved socket in Herdr.
      if (typeof launchWindow === "function") {
        windowAttempted = true;
        window = await launchWindow(configPrefix ? `/bin/sh -c ${shellQuote(manualCommand)}` : manualCommand);
      }
      await measureWindow();
      let alive = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const status = await client.get<{ providers: Array<{ liveness: { alive: boolean } }> }>("/api/terminal/status?provider=herdr");
        if (status.data.providers?.[0]?.liveness.alive) { alive = true; break; }
        await deps.sleep(250);
      }
      if (!alive) throw new Error("The terminal was requested, but herdr's control socket did not become ready. Inspect the new terminal before retrying.");
      // Inventory is read-only: a failed read must not prevent the first open.
      // Scope each tab list to its workspace, on the daemon's exact endpoint.
      const herdrArgs = ["-u", "TMUX", "-u", "HERDR_SESSION", "-u", "HERDR_SOCKET_PATH", `HERDR_SOCKET_PATH=${endpoint.socketPath}`, herdr];
      let tabs: HerdrTab[] = [];
      const spaceLabels = new Map<string, string>();
      try {
        const listed = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "workspace", "list"]));
        const workspaces = listed?.result?.workspaces as Array<{ workspace_id: string; label?: string }> | undefined;
        if (!Array.isArray(workspaces) || !workspaces.every(ws => ws && typeof ws.workspace_id === "string" && ws.workspace_id)) {
          throw new Error("Herdr returned no usable workspace inventory.");
        }
        for (const workspace of workspaces) {
          if (typeof workspace.label === "string") spaceLabels.set(workspace.workspace_id, workspace.label);
          const listedTabs = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "tab", "list", "--workspace", workspace.workspace_id]));
          const scoped = listedTabs?.result?.tabs as typeof tabs | undefined;
          if (!Array.isArray(scoped) || !scoped.every(tab => tab && typeof tab.label === "string" && typeof tab.tab_id === "string" && tab.tab_id && tab.workspace_id === workspace.workspace_id)) {
            throw new Error(`Herdr returned no usable tab inventory for workspace ${workspace.workspace_id}.`);
          }
          tabs.push(...scoped);
        }
      } catch (err) {
        tabs = [];
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
      const viewMarker = `openrig:${composed.id}`;
      const planMarker = `${viewMarker}#${planId.slice(0, 16)}`;
      const marker = (label: string) => label.includes("#") ? label.slice(0, label.lastIndexOf("#")) : "";
      // A named view's tabs carry its panes' names; the attachment check below decides reuse.
      const named = composed.spaceLabel ? composed.pages.map(page => page.map(pane => pane.label).join(" · ")) : undefined;
      const pageLabel = (existing: HerdrTab) => (index: number) => named ? named[index]!
        : composed.pages.length > 1 ? `${existing.label.slice(0, -2)}/${index + 1}` : existing.label;
      const candidates = named
        ? tabs.filter(tab => tab.label === named[0] && spaceLabels.get(tab.workspace_id)?.replace(/ \(\d+\)$/, "") === composed.spaceLabel && named.every(label => tabs.filter(other => other.workspace_id === tab.workspace_id && other.label === label).length === 1))
        : tabs.filter(tab => marker(tab.label) === planMarker && (composed.pages.length <= 1 || tab.label.endsWith("/1")));
      const stale = tabs.filter(tab => {
        const value = marker(tab.label);
        return value !== planMarker && (value === viewMarker ||
          (value.startsWith(`${viewMarker}#`) && /^[a-f0-9]{16}$/.test(value.slice(viewMarker.length + 1))));
      });
      for (const id of new Set(stale.map(tab => tab.workspace_id))) {
        windowNotes.push(`Workspace ${id} has an older or different plan for this view and was kept. After inspecting it, close it if no longer needed: herdr workspace close ${shellQuote(id)}`);
      }
      let existing: HerdrTab | undefined;
      for (const candidate of candidates) {
        if (await hasLiveAttachments(candidate, tabs, composed.pages, pageLabel(candidate), herdrArgs, deps)) { existing = candidate; break; }
        windowNotes.push(`Could not confirm live attachments in workspace ${candidate.workspace_id}. Its contents were kept. After inspecting it, close it if no longer needed: herdr workspace close ${shellQuote(candidate.workspace_id)}`);
      }
      if (existing) {
        const focused = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "tab", "focus", existing.tab_id])) as {
          result?: { tab?: { tab_id?: string; workspace_id?: string } };
        };
        if (focused?.result?.tab?.tab_id !== existing.tab_id || focused.result.tab.workspace_id !== existing.workspace_id) {
          throw new Error("Herdr did not confirm the existing view selection; no replacement space was created.");
        }
        return {
          provider, ok: true, opened: [], absent: composed.absent, degraded: composed.degraded, pages: 0, window,
          reusedWorkspace: { id: existing.workspace_id, tabId: existing.tab_id, view: composed.id },
          notes: [...windowNotes, "Existing local tmux attachments were confirmed and workspace contents were kept; no layout refresh or new tiles were requested.", await shownNote(existing.workspace_id)],
        };
      }
      const result = await client.post<OpenViewResult>("/api/terminal/open", { view, provider: "herdr", expectedPlan: planId, ...(viewportColumns !== undefined ? { viewportColumns } : {}) }, { timeoutMs: 45_000 });
      if (result.status >= 400) return { ...failed(result.data.error ?? `The daemon refused the view (HTTP ${result.status}).`), window, notes: windowNotes, absent: composed.absent, degraded: composed.degraded };
      if (!Array.isArray(result.data?.opened)) throw new Error("The terminal opened, but the daemon returned no view result. Inspect it before retrying.");
      return { ...result.data, window, notes: [...(result.data.notes ?? []), ...windowNotes, await shownNote()] };
    }

    if (typeof launchWindow !== "function") throw new Error("No terminal window launcher is available.");
    const tmux = (await deps.exec("/bin/sh", ["-c", "command -v tmux"]).catch(() => "")).trim();
    if (!tmux) throw new Error("tmux is unavailable; run rig setup first.");
    viewer = `openrig-view-${deps.id()}`;
    let placeholder: string | undefined;
    if (composed.kernelLayout) {
      // This is our fresh, empty viewer, never a source seat. Attach it first so Terminal can
      // report the real new window width before we select the OpenRig view layout.
      placeholder = (await deps.exec(tmux, ["new-session", "-d", "-s", viewer, "-n", "view-1", "-P", "-F", "#{pane_id}"])).trim();
      windowAttempted = true;
      window = await launchWindow(`env -u TMUX ${shellQuote(tmux)} attach-session -t ${shellQuote(`=${viewer}`)}`);
      await measureWindow();
    }
    for (const [pageIndex, page] of composed.pages.entries()) {
      if (!page.length) continue;
      const name = `view-${pageIndex + 1}`;
      const first = page[0]!;
      const args = pageIndex === 0 ? ["new-session", "-d", "-s", viewer, "-n", name] : ["new-window", "-d", "-t", `${viewer}:`, "-n", name];
      let pane: string;
      if (pageIndex === 0 && placeholder) {
        await deps.exec(tmux, ["respawn-pane", "-k", "-t", placeholder, `env -u TMUX ${first.paneCommand}`]);
        pane = placeholder;
      } else pane = (await deps.exec(tmux, [...args, "-P", "-F", "#{pane_id}", `env -u TMUX ${first.paneCommand}`])).trim();
      // Nested source clients on this server can make a new window too narrow to split.
      // Use the viewer's configured detached size, then restore normal client resizing.
      const [width, height] = (await deps.exec(tmux, ["show-options", "-Av", "-t", viewer, "default-size"])).trim().split("x");
      const sizing = (await deps.exec(tmux, ["show-options", "-Awv", "-t", pane, "window-size"])).trim();
      await deps.exec(tmux, ["resize-window", "-t", pane, "-x", width!, "-y", height!]);
      await deps.exec(tmux, ["select-pane", "-t", pane, "-T", first.label]);
      for (const item of page.slice(1)) {
        pane = (await deps.exec(tmux, ["split-window", "-d", "-h", "-t", pane, "-P", "-F", "#{pane_id}", `env -u TMUX ${item.paneCommand}`])).trim();
        await deps.exec(tmux, ["select-pane", "-t", pane, "-T", item.label]);
        await deps.exec(tmux, ["select-layout", "-t", `${viewer}:${name}`, "even-horizontal"]);
      }
      await deps.exec(tmux, ["select-layout", "-t", `${viewer}:${name}`, composed.columns === page.length ? "even-horizontal" : "tiled"]);
      await deps.exec(tmux, ["set-option", "-w", "-t", `${viewer}:${name}`, "window-size", sizing]);
    }
    await deps.exec(tmux, ["select-window", "-t", `${viewer}:view-1`]);
    if (!window) {
      windowAttempted = true;
      window = await launchWindow(`env -u TMUX ${shellQuote(tmux)} attach-session -t ${shellQuote(`=${viewer}`)}`);
    }
    return { provider, ok: true, opened: composed.opened.map(pane => pane.seat), absent: composed.absent, degraded: composed.degraded, pages: composed.pages.length, window, notes: [`Viewing session: ${viewer}. Existing conversations were preserved.`, ...windowNotes, "Check the new terminal shows the intended view; window creation alone is not visual confirmation."] };
  } catch (err) {
    if (windowAttempted && /-1743\b/.test(`${(err as Error).message} ${(err as { stderr?: string }).stderr ?? ""}`)) {
      windowNotes.push("macOS denied Automation access. In System Settings > Privacy & Security > Automation, allow the calling app to control the terminal app before trying again.");
      if (manualCommand) windowNotes.push(`To continue without Automation, open a terminal yourself and run: ${manualCommand}`);
      if (provider === "herdr") windowNotes.push(`After Herdr starts, have the agent place the view: rig terminal open ${shellQuote(view)} --provider herdr`);
    }
    return { ...failed((err as Error).message), ...(window ? { window } : {}), ...(windowNotes.length || viewer ? { notes: [...windowNotes, ...(viewer ? [`Viewing session ${viewer} may exist. Inspect it before retrying; no existing conversation was replaced.`] : [])] } : {}) };
  }
}
