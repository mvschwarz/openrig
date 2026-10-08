import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { DaemonClient } from "./client.js";
import { shellQuote } from "./cross-host-executor.js";
import type { OpenViewResult } from "./commands/terminal.js";

interface Pane { seat: string; label: string; paneCommand: string }
interface Preview {
  planId: string;
  status: { launch?: { socketPath: string; session?: string } };
  composed: { id: string; opened: Pane[]; pages: Pane[][]; columns?: number; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
}

export interface WindowDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(file: string): boolean;
  exec(file: string, args: string[], timeoutMs?: number): Promise<string>;
  launch(file: string, args: string[]): Promise<void>;
  sleep(ms: number): Promise<void>;
  id(): string;
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
async function windowLauncher(deps: WindowDeps, notes: string[]): Promise<((command: string) => Promise<{ app: string; surface: string }>) | string> {
  // Shell tools can pipe stdio while still running inside the person's terminal.
  const program = deps.env["TERM_PROGRAM"];
  const linuxHost = deps.platform !== "linux" ? undefined
    : deps.env["GNOME_TERMINAL_SERVICE"] ? "gnome-terminal"
    : deps.env["KONSOLE_VERSION"] ? "konsole" : deps.env["XTERM_VERSION"] ? "xterm" : undefined;
  const host = !program || program === "tmux" ? deps.env["__CFBundleIdentifier"] ?? linuxHost : program;
  if (deps.env["CI"] && !["0", "false"].includes(deps.env["CI"])) return "This is a CI run.";
  if (deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]) return "This is an SSH session; no desktop window is opened over SSH.";
  if (deps.platform === "darwin") {
    const inGhostty = host === "ghostty" || host === "com.mitchellh.ghostty";
    if (!inGhostty && host !== "Apple_Terminal" && host !== "com.apple.Terminal") return `Unrecognised or unscriptable hosting terminal: ${JSON.stringify(host ?? "unknown")}.`;
    const app = inGhostty ? ["/Applications/Ghostty.app", path.join(deps.env["HOME"] ?? homedir(), "Applications/Ghostty.app")].find(deps.exists) : undefined;
    let ghostty = false;
    if (app) {
      try {
        const version = await deps.exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")]);
        const [major, minor] = version.trim().split(".").map(Number);
        ghostty = major! > 1 || (major === 1 && minor! >= 3);
      } catch { /* No other app is a substitute for the hosting terminal. */ }
    }
    if (inGhostty && !ghostty) return "The hosting Ghostty does not provide a supported scripting interface.";
    // Native macOS tab groups appear as separate one-tab Terminal windows.
    // That is not evidence that resizing one would leave existing windows alone.
    const script = ghostty ? `on run argv
tell application "Ghostty"
  set cfg to new surface configuration
  set command of cfg to item 1 of argv
  if (count of windows) > 0 then
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
  do script (item 1 of argv)
  activate
end tell
return "window"
end run`;
    // A denied/uncertain Automation request is returned once, never replayed in another app.
    return async command => {
      const surface = (await deps.exec("/usr/bin/osascript", ["-e", script, command], 120_000)).trim();
      notes.push(ghostty
        ? "Ghostty's macOS scripting interface does not expose window size. Enlarge the new view manually if its columns are cramped; existing window settings were kept."
        : "Terminal opened with its own window sizing. Resize or move the new view manually if needed; OpenRig did not request a size or position change.");
      return { app: ghostty ? "Ghostty" : "Terminal", surface: ghostty ? surface : "window" };
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

/** Render the daemon's existing composition; never rediscover/relaunch kernel seats here. */
export async function openTerminalWindow(client: DaemonClient, view: string, requestedProvider?: string, deps = defaultWindowDeps(), expectedPlan?: string): Promise<OpenViewResult> {
  let provider = requestedProvider ?? "herdr";
  let window: { app: string; surface: string } | undefined;
  let viewer: string | undefined;
  let windowAttempted = false;
  const recovery = `rig terminal open ${shellQuote(view)} --window${requestedProvider && ["herdr", "tmux"].includes(requestedProvider) ? ` --provider ${shellQuote(requestedProvider)}` : ""}`;
  const failed = (reason: string): OpenViewResult => ({ ...failure(provider,
    window ? `A terminal window was requested, but the view outcome could not be confirmed. ${reason} Inspect the terminal before retrying: ${recovery}`
      : windowAttempted ? `Terminal window status is unknown. ${reason} Inspect the desktop before retrying: ${recovery}`
        : `No terminal window was opened. ${reason} On the daemon's desktop, run: ${recovery}`), windowAttempted });
  const windowNotes: string[] = [];
  try {
    if (!localDaemon(client.baseUrl)) throw new Error("The window launcher must run on the daemon's own desktop; the configured daemon is remote.");
    if (requestedProvider && !["herdr", "tmux"].includes(requestedProvider)) throw new Error("--window supports herdr or tmux. Use cmux without --window.");
    const launchWindow = await windowLauncher(deps, windowNotes);
    const herdr = requestedProvider === "tmux" ? null : await herdrBinary(deps);
    if (!herdr && requestedProvider === "herdr") throw new Error("Herdr is not installed. Run rig setup, or use --provider tmux --window.");
    provider = herdr ? "herdr" : "tmux";
    // Preview is provider-neutral composition, including saved-view membership, absences and quoting.
    const preview = await client.get<Preview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr`);
    if (preview.status >= 400 || !("composed" in preview.data)) {
      return failed((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
    }
    const { composed, planId } = preview.data;
    if (expectedPlan !== undefined && expectedPlan !== planId) {
      return failure(provider, "The terminal view changed since preview. Refresh the preview before opening.");
    }
    if (!composed.opened.length) return { ...failed("No conversations are attachable."), absent: composed.absent, degraded: composed.degraded };
    if (typeof launchWindow === "string") {
      const socket = preview.data.status.launch?.socketPath;
      const command = herdr && socket
        ? `env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(socket)} ${shellQuote(herdr)}`
        : `env -u TMUX ${composed.opened[0]!.paneCommand.replace(/^ssh /, "ssh -t ")}`;
      const headless = deps.env["SSH_CONNECTION"] || deps.env["SSH_CLIENT"] || deps.env["SSH_TTY"]
        || (deps.platform === "linux" && !deps.env["DISPLAY"] && !deps.env["WAYLAND_DISPLAY"]);
      const where = headless ? "Open a new SSH session to the daemon's host" : "Open a new terminal window on the daemon's host";
      const notes = herdr && socket
        ? [`After the person starts Herdr, have the agent place this view by running: rig terminal open ${shellQuote(view)} --provider herdr`] : [];
      return { ...failure(provider, `No terminal window was opened. ${launchWindow} ${where} and run: ${command}`), windowAttempted: false, absent: composed.absent, degraded: composed.degraded, notes };
    }

    if (herdr) {
      const endpoint = preview.data.status.launch;
      if (!endpoint?.socketPath) throw new Error("The daemon does not report its herdr endpoint. Update the daemon, or use --provider tmux --window.");
      // A CLI session would override the daemon's resolved socket in Herdr.
      windowAttempted = true;
      window = await launchWindow(`env -u TMUX -u HERDR_SESSION -u HERDR_SOCKET_PATH HERDR_SOCKET_PATH=${shellQuote(endpoint.socketPath)} ${shellQuote(herdr)}`);
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
      let tabs: Array<{ workspace_id: string; tab_id: string; label: string }> = [];
      try {
        const listed = JSON.parse(await deps.exec("/usr/bin/env", [...herdrArgs, "workspace", "list"]));
        const workspaces = listed?.result?.workspaces as Array<{ workspace_id: string }> | undefined;
        if (!Array.isArray(workspaces) || !workspaces.every(ws => ws && typeof ws.workspace_id === "string" && ws.workspace_id)) {
          throw new Error("Herdr returned no usable workspace inventory.");
        }
        for (const workspace of workspaces) {
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
      const viewMarker = `openrig:${composed.id}`;
      const planMarker = `${viewMarker}#${planId.slice(0, 16)}`;
      const marker = (label: string) => label.includes("#") ? label.slice(0, label.lastIndexOf("#")) : "";
      const existing = tabs.find(tab => marker(tab.label) === planMarker && (composed.pages.length <= 1 || tab.label.endsWith("/1")));
      const stale = tabs.filter(tab => {
        const value = marker(tab.label);
        return value !== planMarker && (value === viewMarker ||
          (value.startsWith(`${viewMarker}#`) && /^[a-f0-9]{16}$/.test(value.slice(viewMarker.length + 1))));
      });
      for (const id of new Set(stale.map(tab => tab.workspace_id))) {
        windowNotes.push(`Workspace ${id} has an older or different plan for this view and was kept. After inspecting it, close it if no longer needed: herdr workspace close ${shellQuote(id)}`);
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
          notes: [...windowNotes, "Existing workspace contents were kept; no layout refresh or new tiles were requested. Check the new terminal shows the intended view."],
        };
      }
      const result = await client.post<OpenViewResult>("/api/terminal/open", { view, provider: "herdr", expectedPlan: planId }, { timeoutMs: 45_000 });
      if (result.status >= 400) return { ...failed(result.data.error ?? `The daemon refused the view (HTTP ${result.status}).`), window, notes: windowNotes, absent: composed.absent, degraded: composed.degraded };
      if (!Array.isArray(result.data?.opened)) throw new Error("The terminal opened, but the daemon returned no view result. Inspect it before retrying.");
      return { ...result.data, window, notes: [...(result.data.notes ?? []), ...windowNotes, "Check the new terminal shows the intended view; window creation alone is not visual confirmation."] };
    }

    const tmux = (await deps.exec("/bin/sh", ["-c", "command -v tmux"]).catch(() => "")).trim();
    if (!tmux) throw new Error("tmux is unavailable; run rig setup first.");
    viewer = `openrig-view-${deps.id()}`;
    for (const [pageIndex, page] of composed.pages.entries()) {
      if (!page.length) continue;
      const name = `view-${pageIndex + 1}`;
      const first = page[0]!;
      const args = pageIndex === 0 ? ["new-session", "-d", "-s", viewer, "-n", name] : ["new-window", "-d", "-t", `${viewer}:`, "-n", name];
      let pane = (await deps.exec(tmux, [...args, "-P", "-F", "#{pane_id}", `env -u TMUX ${first.paneCommand}`])).trim();
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
    windowAttempted = true;
    window = await launchWindow(`env -u TMUX ${shellQuote(tmux)} attach-session -t ${shellQuote(`=${viewer}`)}`);
    return { provider, ok: true, opened: composed.opened.map(pane => pane.seat), absent: composed.absent, degraded: composed.degraded, pages: composed.pages.length, window, notes: [`Viewing session: ${viewer}. Existing conversations were preserved.`, ...windowNotes, "Check the new terminal shows the intended view; window creation alone is not visual confirmation."] };
  } catch (err) {
    return { ...failed((err as Error).message), ...(window ? { window } : {}), ...(windowNotes.length || viewer ? { notes: [...windowNotes, ...(viewer ? [`Viewing session ${viewer} may exist. Inspect it before retrying; no existing conversation was replaced.`] : [])] } : {}) };
  }
}
