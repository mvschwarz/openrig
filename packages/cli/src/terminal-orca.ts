import { setTimeout as wait } from "node:timers/promises";
import { terminalAuthHeaders, type DaemonClient } from "./client.js";
import type { OpenViewResult } from "./commands/terminal.js";
import { defaultWindowDeps, type WindowDeps } from "./terminal-window.js";
import { isLocalTmuxHost } from "./tmux-attachment.js";

interface OrcaReply<T> { ok: boolean; _meta?: { runtimeId?: string }; result?: T }
interface Workspace { id: string; hostId?: string; identity?: { key?: string; executionHostId?: string } }
interface Terminal {
  handle: string; tabId: string; worktreeId: string; connected?: boolean; orphaned?: boolean;
  executionHostId?: string; hostPlatform?: string;
}
interface OrcaStatus { app?: { running?: boolean; desktopWindowStatus?: string }; runtime?: { reachable?: boolean } }
interface Tile { seat: string; paneCommand: string; host?: string }
interface Preview {
  composed: { pages: Tile[][]; columns?: number; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
}

const OPEN_TIMEOUT_MS = 15_000;
// Orca 1.4.263's command help/CLI skill document this runtime pin. The website's --host local is not
// accepted by status or worktree show in that version; never fall back to an ambient paired runtime.
const LOCAL_RUNTIME_ARGS = ["--environment", "local"] as const;
const hasLocalRuntimeFlag = (help: string) => /^\s+--environment\b/m.test(help);
export type OrcaDeps = Pick<WindowDeps, "platform" | "env" | "exec">;
class OrcaProtocolError extends Error {}
class OrcaLocalSelectorError extends Error {}

function rejectedLocalSelector(text: string, fixedStatusArgs: boolean): boolean {
  if (/\b(?:unknown|unrecognized|unsupported|invalid) (?:flag|option)\s+['"`]?--environment\b/i.test(text)) return true;
  if (!fixedStatusArgs) return false;
  try { return (JSON.parse(text) as { error?: { code?: string } } | null)?.error?.code === "invalid_argument"; }
  catch { return false; }
}

/** Check the documented CLI, not Windows-only runtime capability flags or a guessed minimum version. */
async function missingTerminalCommand(deps: OrcaDeps, orca: string, split: boolean): Promise<string | undefined> {
  const commands = [
    ["create", "--worktree", "--title", "--command"],
    ["show", "--terminal"],
    ...(split ? [["split", "--terminal", "--direction", "--command"]] : []),
  ];
  const missing = await Promise.all(commands.map(async ([verb, ...flags]) => {
    try {
      const help = await deps.exec(orca, ["terminal", verb!, "--help"], 4_000);
      const usage = help.split(/\r?\n/).find(line => line.startsWith("Usage:") && line.includes(` terminal ${verb} `));
      if (usage && [...flags, "--json"].every(flag => usage.includes(flag)) && hasLocalRuntimeFlag(help)) return undefined;
    } catch { /* Help is read-only; a failed probe cannot authorize a write. */ }
    return `terminal ${verb}`;
  }));
  return missing.find(command => command !== undefined);
}

/** CLI-local: the daemon only composes the view. It cannot launch terminals in an Orca profile. */
export async function openOrcaView(client: DaemonClient, view: string, selector?: string, deps: OrcaDeps = defaultWindowDeps()): Promise<OpenViewResult> {
  const result: OpenViewResult = { provider: "orca", ok: false, opened: [], remote: [], absent: [], degraded: [], pages: 0 };
  const fail = (code: string, error: string) => ({ ...result, code, error });
  if (deps.platform !== "darwin") return fail("orca_unsupported_platform", "The experimental Orca provider supports macOS only.");
  const env = deps.env;
  const caller = env.ORCA_WORKSPACE_ID?.trim() || env.ORCA_WORKTREE_ID?.trim();
  const orca = env.ORCA_CLI_COMMAND?.trim() || (env.ORCA_DEV_REPO_ROOT ? "orca-dev" : "orca");
  // The calling Orca terminal's workspace stays the default even after the shell changes directory.
  const target = selector === undefined ? (caller?.startsWith("folder:") ? caller : caller && `id:${caller}`) : selector.trim();
  if (!target) return fail("orca_workspace_required", "Run inside an Orca terminal or pass --orca-workspace <selector>.");

  // The preview includes shell commands. Require the selected local daemon's identity, not merely a loopback URL.
  if (!isLocalTmuxHost(client.baseUrl) || !await client.isLocalInstance()) {
    return fail("orca_local_daemon_required", "Open Orca views on the machine running this OpenRig instance, using its OpenRig home.");
  }
  const preview = await client.get<Preview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr`, { headers: terminalAuthHeaders() });
  if (preview.status >= 400 || !preview.data || !("composed" in preview.data)) {
    return fail("orca_preview_failed", (preview.data as OpenViewResult | undefined)?.error ?? "The daemon did not return a terminal view.");
  }
  // The ordinary desktop launcher uses this same provider-neutral preview even when Herdr is absent.
  const { composed } = preview.data;
  result.absent.push(...composed.absent);
  result.degraded.push(...composed.degraded);
  const pages = composed.pages.map(page => page.filter(pane => {
    if (!pane.host) return true;
    result.degraded.push({ seat: pane.seat, host: pane.host, reason: "The experimental Orca provider does not open remote seats." });
    return false;
  })).filter(page => page.length > 0);
  if (!pages.length) return fail("orca_no_local_tiles", "No local conversations are attachable.");

  let runtimeId: string | undefined;
  let interrupted = false;
  async function call<T>(args: string[], timeoutMs = 4_000): Promise<T> {
    const fixedStatusArgs = args[0] === "status";
    let text: string;
    try {
      text = await deps.exec(orca, [...args, ...LOCAL_RUNTIME_ARGS, "--json"], timeoutMs);
    } catch (error) {
      const { stdout, stderr } = (error ?? {}) as { stdout?: string; stderr?: string };
      if ([stdout, stderr].some(value => typeof value === "string" && rejectedLocalSelector(value, fixedStatusArgs))) {
        throw new OrcaLocalSelectorError();
      }
      throw error;
    }
    const reply = JSON.parse(text) as OrcaReply<T>;
    if (reply?.ok === false && rejectedLocalSelector(text, fixedStatusArgs)) throw new OrcaLocalSelectorError();
    const actual = reply?._meta?.runtimeId;
    if (runtimeId && actual !== runtimeId) {
      interrupted = true;
      throw new Error("Orca runtime changed or could not be confirmed");
    }
    if (!reply?.ok || !reply.result) throw new Error("Orca reply unconfirmed");
    if (typeof actual !== "string" || !actual) throw new OrcaProtocolError("Orca did not identify the responding runtime");
    runtimeId = actual;
    return reply.result;
  }
  const upgrade = "Update Orca and register its CLI again (tested with Orca 1.4.263).";
  const localSelectorUnavailable = () => fail("orca_capability_unavailable", `The Orca CLI does not support the required local runtime selector (\`--environment local\`). ${upgrade}`);
  let status: OrcaStatus;
  try {
    if (!hasLocalRuntimeFlag(await deps.exec(orca, ["status", "--help"], 4_000))) return localSelectorUnavailable();
    status = await call<OrcaStatus>(["status"]);
  } catch (error) {
    if (error instanceof OrcaLocalSelectorError) return localSelectorUnavailable();
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "EACCES" || code === "ENOEXEC") {
      return fail("orca_cli_unavailable", "The Orca CLI could not be launched. Register it in Orca Settings and make it available on PATH.");
    }
    if (error instanceof OrcaProtocolError || error instanceof SyntaxError) return fail("orca_capability_unavailable", `The Orca CLI did not return usable runtime identity metadata. ${upgrade}`);
    return fail("orca_unavailable", "The local Orca desktop did not answer. Open Orca before retrying.");
  }
  if (!status.app?.running || !status.runtime?.reachable) return fail("orca_unavailable", "The local Orca desktop did not answer. Open Orca before retrying.");
  if (!status.app.desktopWindowStatus) return fail("orca_capability_unavailable", `The Orca CLI did not report desktop window availability. ${upgrade}`);
  if (status.app.desktopWindowStatus !== "available") return fail("orca_unavailable", "The local Orca desktop has no available window. Open one before retrying.");
  let workspace: Workspace | undefined;
  try { ({ worktree: workspace } = await call<{ worktree?: Workspace }>(["worktree", "show", "--worktree", target])); }
  catch (error) {
    if (error instanceof OrcaLocalSelectorError) return localSelectorUnavailable();
    return fail("orca_workspace_unavailable", "Orca could not resolve the destination workspace. Pass an exact selector from `orca worktree ps --json`.");
  }
  const workspaceId = workspace?.id;
  const identity = workspace?.identity;
  const host = identity?.executionHostId ?? workspace?.hostId;
  if (!workspaceId || host !== "local" || (workspace?.hostId !== undefined && workspace.hostId !== "local")) {
    return fail("orca_workspace_not_local", "The destination must be an existing local Orca workspace.");
  }
  const missing = await missingTerminalCommand(deps, orca, pages.some(page => page.length > 1));
  if (missing) return fail("orca_capability_unavailable", `The Orca CLI did not confirm JSON support for \`orca ${missing}\` with the required options, including \`--environment local\`. ${upgrade}`);
  // Pin the confirmed identity for writes. Non-Git projects may have a canonical id but no Git identity key.
  const exact = workspaceId.startsWith("folder:") ? workspaceId : identity?.key ? `identity:${identity.key}` : `id:${workspaceId}`;
  // Titles are only for display and recovery, never used to choose a pane or workspace.
  const label = `OpenRig: ${view.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100)}`;
  const confirmed = new Set<Tile>();
  const notes: string[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const title = pages.length === 1 ? label : `${label} (${pageIndex + 1}/${pages.length})`;
    const handles = new Map<number, string>();
    let tabId: string | undefined;
    const columns = Math.min(page.length, composed.columns || Math.ceil(Math.sqrt(page.length)));
    const indices = page.map((_, index) => index);
    // Establish rows first; splitting each row then keeps the columns within that row.
    const order = [...indices.filter(i => i % columns === 0), ...indices.filter(i => i % columns !== 0)];
    for (const index of order) {
      const pane = page[index]!;
      if (interrupted) {
        result.degraded.push({ seat: pane.seat, host: "local", reason: "Not attempted after an unconfirmed Orca operation." });
        continue;
      }
      // Preserve the composer's command, endpoint and read-only policy without inheriting a tmux client.
      const command = `exec /usr/bin/env -u TMUX -u TMUX_PANE ${pane.paneCommand}`;
      try {
        let handle: string;
        if (index === 0) {
          const { terminal } = await call<{ terminal: Terminal }>(["terminal", "create", "--worktree", exact, "--title", title, "--command", command], OPEN_TIMEOUT_MS);
          if (terminal.worktreeId !== workspaceId || !terminal.tabId || (terminal.executionHostId !== undefined && terminal.executionHostId !== "local")
            || (terminal.hostPlatform !== undefined && terminal.hostPlatform !== "darwin")) throw new Error("Orca tab unconfirmed");
          ({ tabId, handle } = terminal);
        } else {
          const across = index % columns !== 0;
          const anchor = handles.get(index - (across ? 1 : columns));
          if (!anchor) throw new Error("Orca split anchor unconfirmed");
          const { split } = await call<{ split: Pick<Terminal, "handle" | "tabId"> }>(["terminal", "split", "--terminal", anchor, "--direction", across ? "horizontal" : "vertical", "--command", command], OPEN_TIMEOUT_MS);
          if (split.tabId !== tabId) throw new Error("Orca split unconfirmed");
          handle = split.handle;
        }
        if (!/^term_[\w-]+$/.test(handle) || [...handles.values()].includes(handle)) throw new Error("Orca terminal handle unconfirmed");
        handles.set(index, handle);
      } catch {
        interrupted = true;
        result.degraded.push({ seat: pane.seat, host: "local", code: "pane_unconfirmed", reason: "Orca did not confirm this tab or split; it may still have been created." });
        notes.push(`Inspect the Orca workspace for ${JSON.stringify(title)} before retrying. No command was retried.`);
      }
    }
    let placed = false;
    for (const [index, handle] of handles) {
      const pane = page[index]!;
      try {
        async function connected(): Promise<boolean> {
          // `show` may include a terminal output preview. Inspect only identity and connection fields.
          const { terminal } = await call<{ terminal: Terminal }>(["terminal", "show", "--terminal", handle]);
          if (terminal.handle !== handle || terminal.worktreeId !== workspaceId || terminal.tabId !== tabId
            || (terminal.executionHostId !== undefined && terminal.executionHostId !== "local")) throw new Error("Orca pane identity changed");
          return terminal.connected === true && terminal.orphaned === false;
        }
        if (!await connected()) {
          // Splitting can remount an existing pane; allow its renderer to reconnect. Only retry the read.
          await wait(250);
          if (!await connected()) throw new Error("Orca pane not connected");
        }
        confirmed.add(pane);
        placed = true;
      } catch {
        result.degraded.push({ seat: pane.seat, host: "local", code: "pane_unconfirmed", reason: `Orca did not confirm a connected pane for ${handle}; inspect ${JSON.stringify(title)} before retrying.` });
      }
    }
    if (placed) result.pages++;
  }
  result.opened = pages.flat().filter(pane => confirmed.has(pane)).map(pane => pane.seat);
  result.ok = result.opened.length > 0;
  result.workspaceId = workspaceId;
  if (result.ok) notes.push("Connected Orca panes were confirmed. Check them in Orca to verify the seat view.");
  if (notes.length) result.notes = notes;
  return result.ok ? result : fail(interrupted ? "orca_outcome_unknown" : "orca_panes_unconfirmed", "No connected Orca panes could be confirmed.");
}
