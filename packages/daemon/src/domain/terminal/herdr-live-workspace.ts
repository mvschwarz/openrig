// #3052: the one check for "this view is already on screen in Herdr". The CLI's `--window` open and the
// daemon's `--provider herdr` open both use it, so a re-open focuses that workspace instead of adding a copy.
// It only reads: Herdr's workspaces, tabs, panes and their foreground processes, and the tmux server's
// clients. It never types into, focuses or closes a pane.

import path from "node:path";

/** One tab as `herdr tab list` reports it. */
export interface HerdrTab { workspace_id: string; tab_id: string; label: string }

/** A tile as the check compares it: the attach command the composer gave its pane. */
export interface LiveTile { label: string; paneCommand: string; recoveryCommand?: string }

/** The view being opened, by what its Herdr tabs carry: the view id and plan in a tab label, or a named view's space. */
export interface HerdrViewKey { id: string; planId: string; pages: readonly (readonly LiveTile[])[]; spaceLabel?: string }

export interface LiveWorkspaceReaders {
  /** Runs the Herdr CLI on the selected endpoint and returns its stdout. */
  herdr(args: string[]): Promise<string>;
  /** Runs a program and returns its stdout: resolving tmux and listing its clients. */
  exec(file: string, args: string[]): Promise<string>;
  /** The daemon's tmux server options (`-S <path>` or `-L <name>`), or none. */
  serverArgs: readonly string[];
}

export interface LiveWorkspaceSearch {
  /** The first tab of a workspace that still shows every tile of this plan, attached; absent when none does. */
  live?: HerdrTab;
  /** Workspaces holding this plan whose attachments could not be confirmed, one per candidate tab checked. */
  unconfirmed: string[];
  /** Workspaces holding an older or different plan of this view. */
  stale: string[];
  /** Workspaces of this view, kept or unconfirmed, where a writable tile's tmux client ignores its size: a tile
   * OpenRig 0.7.5-0.7.9 opened. Its script attaches that way again after every seat replacement, and Herdr saved
   * the script as the pane's restart command, so only closing the workspace and opening the view again replaces it. */
  fixedSize: string[];
}

/** What an open says about a kept `fixedSize` workspace; both open paths use it, each with its own close command. */
export function fixedSizeWorkspaceNote(id: string, closeCommand: string): string {
  return `Workspace ${id} shows this view with tiles an OpenRig before 0.7.10 opened, which keep a fixed size and attach that way again after every seat restart; it was kept. Close it to remove those tiles (its agents keep running): ${closeCommand}`;
}

/** One tmux client: the attach commands it can be (compared, never executed), and whether it is a writable client that ignores its size. */
interface Client { commands: string[]; fixedSize: boolean }

/** The daemon tmux server's clients by pid. Null when tmux or its client list can't be read. */
async function readClients({ exec, serverArgs }: LiveWorkspaceReaders): Promise<Map<string, Client> | null> {
  try {
    const tmux = (await exec("/bin/sh", ["-c", "command -v tmux"])).trim();
    if (!path.isAbsolute(tmux)) return null;
    const clients = new Map<string, Client>();
    // Match view-composer's serialization (these strings are compared, never executed).
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    const server = serverArgs.map((arg, index) => index % 2 ? quote(arg) : arg).join(" ");
    const inventory = await exec(tmux, [...serverArgs, "list-clients", "-F", "#{client_pid}\t#{session_name}\t#{client_readonly}\t#{client_flags}"]);
    for (const line of inventory.trim().split("\n")) {
      const [pid, session, readOnly, flagList] = line.split("\t");
      if (!pid || !/^\d+$/.test(pid) || !session || !["0", "1"].includes(readOnly ?? "")) continue;
      // Since 0.7.10 a writable tile sizes its window (#2614); one that ignores size came from an earlier tile script.
      // A tmux without client_flags reports none, which reads as sizing.
      const fixedSize = readOnly === "0" && (flagList ?? "").split(",").includes("ignore-size");
      // Compare the composer's exact command, including session aliases and read-only mode.
      // SSH/custom commands cannot be confirmed from this local client inventory.
      const flag = readOnly === "1" ? "-r " : fixedSize ? "-f ignore-size " : "";
      clients.set(pid, { fixedSize, commands: ["tmux", quote(tmux)].map(binary => `${binary}${server ? ` ${server}` : ""} attach ${flag}-t ${quote(session)}`) });
    }
    return clients;
  } catch {
    return null;
  }
}

/** A workspace's panes, or null when Herdr's reply can't be trusted. */
async function readPanes(workspaceId: string, herdr: LiveWorkspaceReaders["herdr"]): Promise<Array<{ workspace_id: string; tab_id: string; pane_id: string }> | null> {
  const listed = JSON.parse(await herdr(["pane", "list", "--workspace", workspaceId]));
  const panes = listed?.result?.panes as Array<{ workspace_id: string; tab_id: string; pane_id: string }> | undefined;
  return Array.isArray(panes) && panes.every(pane => pane && pane.workspace_id === workspaceId && typeof pane.tab_id === "string" && typeof pane.pane_id === "string" && pane.pane_id) ? panes : null;
}

/** The pids in a pane's foreground, or null when Herdr's reply can't be trusted. */
async function foregroundPids(paneId: string, herdr: LiveWorkspaceReaders["herdr"]): Promise<string[] | null> {
  const result = JSON.parse(await herdr(["pane", "process-info", "--pane", paneId]));
  const info = result?.result?.process_info;
  if (info?.pane_id !== paneId || (info.foreground_processes !== undefined && !Array.isArray(info.foreground_processes))) return null;
  return (info.foreground_processes ?? []).map((process: { pid?: unknown }) => String(process?.pid));
}

/** Whether a pane of this workspace shows a writable tile that ignores its size. Any unreadable reply says no: unknown is never reported as fixed. */
async function showsFixedSizeTile(workspaceId: string, clients: Map<string, Client>, herdr: LiveWorkspaceReaders["herdr"]): Promise<boolean> {
  if (![...clients.values()].some(client => client.fixedSize)) return false;
  try {
    for (const pane of await readPanes(workspaceId, herdr) ?? []) {
      if ((await foregroundPids(pane.pane_id, herdr))?.some(pid => clients.get(pid)?.fixedSize)) return true;
    }
  } catch { /* unknown */ }
  return false;
}

/** Saved Herdr labels survive reboot; only current clients prove a local attachment. */
async function hasLiveAttachments(existing: HerdrTab, tabs: HerdrTab[], pages: readonly (readonly LiveTile[])[], pageLabel: (index: number) => string, herdr: LiveWorkspaceReaders["herdr"], clients: Map<string, Client> | null): Promise<boolean> {
  try {
    if (!clients) return false;
    const panes = await readPanes(existing.workspace_id, herdr);
    if (!panes) return false;
    const used = new Set<string>();
    for (const [index, page] of pages.entries()) {
      const label = pageLabel(index);
      const matches = tabs.filter(tab => tab.workspace_id === existing.workspace_id && tab.label === label);
      if (matches.length !== 1) return false;
      const remaining = page.map(pane => pane.recoveryCommand ?? pane.paneCommand);
      for (const pane of panes.filter(pane => pane.tab_id === matches[0]!.tab_id)) {
        if (remaining.length === 0) break;
        const pids = await foregroundPids(pane.pane_id, herdr);
        if (!pids) return false;
        for (const pid of pids) {
          if (used.has(pid)) continue;
          const found = remaining.findIndex(command => clients.get(pid)?.commands.includes(command));
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

/** Every workspace's tabs, scoped per workspace. Throws when Herdr's inventory is unusable. */
async function readTabs(herdr: LiveWorkspaceReaders["herdr"]): Promise<{ tabs: HerdrTab[]; spaceLabels: Map<string, string> }> {
  const tabs: HerdrTab[] = [];
  const spaceLabels = new Map<string, string>();
  const listed = JSON.parse(await herdr(["workspace", "list"]));
  const workspaces = listed?.result?.workspaces as Array<{ workspace_id: string; label?: string }> | undefined;
  if (!Array.isArray(workspaces) || !workspaces.every(ws => ws && typeof ws.workspace_id === "string" && ws.workspace_id)) {
    throw new Error("Herdr returned no usable workspace inventory.");
  }
  for (const workspace of workspaces) {
    if (typeof workspace.label === "string") spaceLabels.set(workspace.workspace_id, workspace.label);
    const listedTabs = JSON.parse(await herdr(["tab", "list", "--workspace", workspace.workspace_id]));
    const scoped = listedTabs?.result?.tabs as HerdrTab[] | undefined;
    if (!Array.isArray(scoped) || !scoped.every(tab => tab && typeof tab.label === "string" && typeof tab.tab_id === "string" && tab.tab_id && tab.workspace_id === workspace.workspace_id)) {
      throw new Error(`Herdr returned no usable tab inventory for workspace ${workspace.workspace_id}.`);
    }
    tabs.push(...scoped);
  }
  return { tabs, spaceLabels };
}

/**
 * Find a workspace that still shows this view's plan with every tile attached. A view's tabs carry
 * `openrig:<view>#<plan>#<launch>` labels; a named view's tabs carry its panes' names inside its space.
 * Throws when Herdr's inventory can't be read, so the caller decides how to say so.
 */
export async function findLiveHerdrWorkspace(view: HerdrViewKey, readers: LiveWorkspaceReaders): Promise<LiveWorkspaceSearch> {
  const { tabs, spaceLabels } = await readTabs(readers.herdr);
  const viewMarker = `openrig:${view.id}`;
  const planMarker = `${viewMarker}#${view.planId.slice(0, 16)}`;
  const marker = (label: string) => label.includes("#") ? label.slice(0, label.lastIndexOf("#")) : "";
  // A named view's tabs carry its panes' names; the attachment check below decides reuse.
  const named = view.spaceLabel ? view.pages.map(page => page.map(pane => pane.label).join(" · ")) : undefined;
  const pageLabel = (existing: HerdrTab) => (index: number) => named ? named[index]!
    : view.pages.length > 1 ? `${existing.label.slice(0, -2)}/${index + 1}` : existing.label;
  const candidates = named
    ? tabs.filter(tab => tab.label === named[0] && spaceLabels.get(tab.workspace_id)?.replace(/ \(\d+\)$/, "") === view.spaceLabel && named.every(label => tabs.filter(other => other.workspace_id === tab.workspace_id && other.label === label).length === 1))
    : tabs.filter(tab => marker(tab.label) === planMarker && (view.pages.length <= 1 || tab.label.endsWith("/1")));
  const stale = tabs.filter(tab => {
    const value = marker(tab.label);
    return value !== planMarker && (value === viewMarker ||
      (value.startsWith(`${viewMarker}#`) && /^[a-f0-9]{16}$/.test(value.slice(viewMarker.length + 1))));
  });
  const search: LiveWorkspaceSearch = { unconfirmed: [], stale: [...new Set(stale.map(tab => tab.workspace_id))], fixedSize: [] };
  const clients = candidates.length || search.stale.length ? await readClients(readers) : null;
  let live: HerdrTab | undefined;
  for (const candidate of candidates) {
    if (await hasLiveAttachments(candidate, tabs, view.pages, pageLabel(candidate), readers.herdr, clients)) { live = candidate; break; }
    search.unconfirmed.push(candidate.workspace_id);
  }
  // Also beside a reused current copy: an old workspace next to the numbered copy an earlier open added is the usual
  // state after an upgrade. The reused workspace itself is never named for closing.
  if (clients) {
    for (const id of new Set([...search.unconfirmed, ...search.stale])) {
      if (id !== live?.workspace_id && await showsFixedSizeTile(id, clients, readers.herdr)) search.fixedSize.push(id);
    }
  }
  return live ? { ...search, live } : search;
}
