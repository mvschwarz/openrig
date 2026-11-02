import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { helperCwd } from "../helper-cwd.js";
import type { TerminalOpenResult } from "../daemon-client.js";
import { windowsViewerEnvironment } from "./windows-viewer-env.js";

export function terminalWindowNotice(view: string, result: TerminalOpenResult): string {
  return [
    `Terminal view requested: ${view}`,
    ...(result.ok && result.reusedWorkspace ? [`Reused Herdr workspace ${result.reusedWorkspace.id}; existing contents were kept.`] : []),
    `${result.opened.length} tiles prepared; ${result.absent.length} absent; ${result.degraded.length} degraded.`,
    ...(result.error ? [result.error] : []),
    ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
    ...result.degraded.map(member => `${member.code === "pane_unconfirmed" ? "Unconfirmed" : "Skipped"}: ${member.seat} — ${member.reason}`),
    ...(result.notes ?? []),
  ].join("\n");
}

const MARKER_KEYS = ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION", "REX_SESSION", "REX_BLOCK", "REX_SERVER", "REX_BIN_DIR"];

/** Windows environment names are case insensitive, including inherited terminal markers. */
export function terminalMarkerEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform !== "win32") return env;
  const normalized = { ...env };
  for (const key of Object.keys(env)) {
    const canonical = key.toUpperCase();
    if (MARKER_KEYS.includes(canonical) || canonical.startsWith("CMUX_")) normalized[canonical] = env[key];
  }
  return normalized;
}

const inHerdrPane = (env: NodeJS.ProcessEnv): boolean => env["HERDR_ENV"] === "1" && !!env["HERDR_PANE_ID"] && !!env["HERDR_SOCKET_PATH"];

/** Herdr's own markers, as the CLI's launcher reads them. */
function inHerdr(env: NodeJS.ProcessEnv): boolean {
  env = terminalMarkerEnvironment(env);
  return env["TERM_PROGRAM"] === "herdr" || inHerdrPane(env);
}

/** Rex's markers, as the CLI's launcher reads them; inside a Herdr pane, Herdr keeps the view. */
export function inRex(env: NodeJS.ProcessEnv): boolean {
  env = terminalMarkerEnvironment(env);
  return !inHerdrPane(env) && (env["TERM_PROGRAM"] === "rex"
    || (env["TERM_PROGRAM"] !== "herdr" && !!env["REX_SESSION"] && !!env["REX_BLOCK"] && !!env["REX_SERVER"]));
}

/** cmux's markers on a terminal it runs: its socket and the surface. The daemon's own environment drops both, so a shared
 *  TUI is never read as running in cmux. A Herdr or Rex inside cmux keeps the view. A tmux server started inside cmux keeps
 *  the markers too, so a TUI in that tmux opens in cmux even when the tmux is attached from another terminal. */
export function inCmux(env: NodeJS.ProcessEnv): boolean {
  env = terminalMarkerEnvironment(env);
  return !!env["CMUX_SOCKET_PATH"] && !!env["CMUX_SURFACE_ID"] && !inHerdr(env) && !inRex(env);
}

/** Said with cmux_unavailable from inside cmux, where "install cmux" can't be the fix; cmux's default socket mode refuses
 *  outside clients such as the daemon. */
const CMUX_SOCKET_HINT = 'This TUI runs inside cmux, so cmux is installed; its socket is most likely refusing OpenRig. In cmux Settings > Automation, select "Automation mode" for Socket Control Mode, then try again. `rig doctor` checks this setting.';

/**
 * The Herdr or Rex markers of the tmux client that was active last: a hint for which one the person is viewing, normally the
 * client whose key started this. tmux only counts keys a client types, so a key sent with `send-keys` or by a
 * control-mode client marks no one, and the client found may belong to a different viewer. A shared TUI runs in the
 * daemon's tmux server, so its own environment never carries the markers; they are on the attached client. Linux uses
 * /proc; Windows reads only an own-user, same-bitness client's marker allowlist. Undefined when there's no single last-active Herdr or Rex client: no
 * client, more than one active in the same second, a client that can't be read or is in neither, or any failure. The
 * child then keeps today's detection.
 */
export interface ViewerEnvironmentDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  listClients(target: string): Promise<string>;
  readClientEnvironment(pid: number): Promise<NodeJS.ProcessEnv | undefined>;
}

export async function viewerTerminalEnv(overrides: Partial<ViewerEnvironmentDeps> = {}): Promise<NodeJS.ProcessEnv | undefined> {
  const platform = overrides.platform ?? process.platform;
  const inherited = overrides.env ?? process.env;
  const env = platform === "win32" ? Object.fromEntries(Object.entries(inherited).map(([key, value]) => [key.toUpperCase(), value])) : inherited;
  const pane = env["TMUX_PANE"];
  if (!pane || (platform !== "linux" && platform !== "win32")) return undefined;
  // psmux pane IDs are only unique within a session/server. Never list another
  // session's clients by interpreting a bare %N as its server name.
  const session = env["PSMUX_TARGET_SESSION"];
  const target = platform === "win32" ? session && !session.includes("\0") ? `=${session}` : undefined : env["TMUX"] ? pane : undefined;
  if (!target) return undefined;
  // PSMUX_TARGET_SESSION is the full registry/server identity (including its
  // namespace), not a display session name to feed back through -t parsing.
  const listClients = overrides.listClients ?? (async (selected: string) => (await promisify(execFile)("tmux", ["list-clients", ...(platform === "win32" ? [] : ["-t", selected]), "-F", "#{client_activity} #{client_pid} #{client_control_mode}"],
    { env: inherited, encoding: "utf8", timeout: 1000, windowsHide: true })).stdout);
  const readClientEnvironment = overrides.readClientEnvironment ?? (platform === "win32" ? windowsViewerEnvironment : async (pid: number) =>
    Object.fromEntries((await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").flatMap(entry => {
      const at = entry.indexOf("=");
      return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : [];
    })));
  const latestClient = (listed: string): number | undefined => {
    const clients = listed.trim().split(/\r?\n/).flatMap(line => {
      const match = /^(\d+) (\d+) ([01])$/.exec(line);
      if (!match || match[3] === "1") return [];
      const activity = Number(match[1]), pid = Number(match[2]);
      return Number.isSafeInteger(activity) && Number.isSafeInteger(pid) && pid > 0 && pid <= 0x7fffffff ? [{ activity, pid }] : [];
    });
    const newest = Math.max(...clients.map(client => client.activity));
    const latest = clients.filter(client => client.activity === newest);
    return latest.length === 1 ? latest[0]!.pid : undefined;
  };
  try {
    const pid = latestClient(await listClients(target));
    if (pid === undefined) return undefined;
    const markers = await readClientEnvironment(pid);
    if (!markers || latestClient(await listClients(target)) !== pid) return undefined;
    const selected = terminalMarkerEnvironment(markers, platform);
    return inHerdr(selected) || inRex(selected) ? Object.fromEntries(MARKER_KEYS.flatMap(key => selected[key] === undefined ? [] : [[key, selected[key]]])) : undefined;
  } catch { return undefined; }
}

/** The viewer markers the window opener is given, or undefined when this TUI's own environment decides. */
async function viewedFrom(viewer: () => Promise<NodeJS.ProcessEnv | undefined>): Promise<NodeJS.ProcessEnv | undefined> {
  return inHerdr(process.env) || inRex(process.env) || inCmux(process.env) ? undefined : await viewer();
}

/** The provider the terminal action will use from this TUI, so a preview's plan matches the open. */
export async function windowProvider(viewer: () => Promise<NodeJS.ProcessEnv | undefined> = viewerTerminalEnv, platform: NodeJS.Platform = process.platform): Promise<"rex" | "herdr" | "cmux"> {
  // The Windows CLI's native window path composes a Herdr plan even when it
  // renders through Windows Terminal. Inherited POSIX viewer markers must not
  // select an unsupported Rex/cmux preview and invalidate that expected plan.
  if (platform === "win32") return "herdr";
  if (inRex(process.env)) return "rex";
  if (inCmux(process.env)) return "cmux";
  const viewed = await viewedFrom(viewer);
  return viewed && inRex(viewed) ? "rex" : "herdr";
}

/** Reuse the installed CLI's desktop selection and fallback, preserving this TUI's daemon. In cmux, the view opens in that
 *  cmux, as `rig terminal open --provider cmux` does; cmux has no desktop window for `--window` to open. */
export async function openTerminalInWindow(view: string, endpoint: string, cliEntry?: string, expectedPlan?: string, onUnavailable?: () => void,
  viewer: () => Promise<NodeJS.ProcessEnv | undefined> = viewerTerminalEnv, platform: NodeJS.Platform = process.platform): Promise<TerminalOpenResult> {
  // Already in a Herdr, Rex or cmux itself: nothing to carry. Otherwise hand the child the one this TUI is being viewed from.
  const viewed = await viewedFrom(viewer);
  const base = { ...process.env };
  if (viewed) for (const key of Object.keys(base)) {
    if (MARKER_KEYS.includes(platform === "win32" ? key.toUpperCase() : key)) delete base[key];
  }
  const cmux = platform !== "win32" && inCmux(process.env);
  const placement = cmux ? ["--provider", "cmux"] : ["--window"];
  const args = ["terminal", "open", ...placement, "--json", ...(expectedPlan !== undefined ? ["--expected-plan", expectedPlan] : []), "--", view];
  let stdout: string;
  let executionError: string | undefined;
  try {
    ({ stdout } = await promisify(execFile)(cliEntry ? process.execPath : "rig", cliEntry ? [cliEntry, ...args] : args, {
      cwd: helperCwd(), env: { ...base, ...viewed, OPENRIG_URL: endpoint }, timeout: 180_000, maxBuffer: 1024 * 1024, encoding: "utf8",
    }));
  } catch (error) {
    const failure = error as Error & { stdout?: string };
    if (!failure.stdout?.trim()) throw new Error(`${failure.message}. Inspect any new terminal before retrying; the window outcome is unconfirmed.`);
    executionError = failure.message;
    stdout = failure.stdout;
  }
  let result: TerminalOpenResult & { window?: { app: string; surface: string }; windowAttempted?: boolean };
  try { result = JSON.parse(stdout); }
  catch { throw new Error("The terminal command returned no readable result. Inspect any new terminal before retrying."); }
  if (!result || typeof result !== "object") throw new Error("The terminal command returned no view result. Inspect any new terminal before retrying.");
  if (!Array.isArray(result.opened) || !Array.isArray(result.absent) || !Array.isArray(result.degraded)) {
    throw new Error(result.error ?? "The terminal command returned no view result. Inspect any new terminal before retrying.");
  }
  if (executionError || (!result.opened.length && !(result.ok && result.reusedWorkspace))) {
    // Only a definite pre-launch failure can reveal passive recovery; unknown outcomes stay put.
    if (result.code === "terminal_window_failed" && result.windowAttempted === false && !result.window && !result.opened.length) onUnavailable?.();
    throw new Error([result.error ?? executionError ?? "No terminals were confirmed open.",
      ...(cmux && result.code === "cmux_unavailable" ? [CMUX_SOCKET_HINT] : []), ...(result.notes ?? []),
      ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
      ...result.degraded.map(member => `${member.code === "pane_unconfirmed" ? "Unconfirmed" : "Skipped"}: ${member.seat} — ${member.reason}`),
      ...(result.window ? [`Terminal: ${result.window.app} (${result.window.surface})`] : []),
    ].join("\n"));
  }
  return result;
}
