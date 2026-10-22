import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { helperCwd } from "../helper-cwd.js";
import type { TerminalOpenResult } from "../daemon-client.js";

export function terminalWindowNotice(view: string, result: TerminalOpenResult): string {
  return [
    `Terminal view requested: ${view}`,
    ...(result.ok && result.reusedWorkspace ? [`Reused Herdr workspace ${result.reusedWorkspace.id}; existing contents were kept.`] : []),
    `${result.opened.length} tiles prepared; ${result.absent.length} absent; ${result.degraded.length} degraded.`,
    ...(result.error ? [result.error] : []),
    ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
    ...result.degraded.map(member => `Skipped: ${member.seat} — ${member.reason}`),
    ...(result.notes ?? []),
  ].join("\n");
}

const HERDR_KEYS = ["TERM_PROGRAM", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_SESSION"];

/** Herdr's own markers, as the CLI's launcher reads them. */
function inHerdr(env: NodeJS.ProcessEnv): boolean {
  return env["TERM_PROGRAM"] === "herdr" || (env["HERDR_ENV"] === "1" && !!env["HERDR_PANE_ID"] && !!env["HERDR_SOCKET_PATH"]);
}

/**
 * The Herdr markers of the tmux client that was active last: a hint for which Herdr the person is viewing, normally the
 * client whose key started this. tmux only counts keys a client types, so a key sent with `send-keys` or by a
 * control-mode client marks no one, and the client found may belong to a different viewer. A shared TUI runs in the
 * daemon's tmux server, so its own environment never carries the markers; they are on the attached client. Linux only
 * (the client's environment is read from /proc). Undefined when there's no single last-active Herdr client: no client,
 * more than one active in the same second, a client that can't be read or isn't in Herdr, or any failure. The child
 * then keeps today's detection.
 */
export async function viewerHerdrEnv(): Promise<NodeJS.ProcessEnv | undefined> {
  const pane = process.env["TMUX"] && process.env["TMUX_PANE"];
  if (!pane || process.platform !== "linux") return undefined;
  try {
    const listed = (await promisify(execFile)("tmux", ["list-clients", "-t", pane, "-F", "#{client_activity} #{client_pid} #{client_control_mode}"],
      { encoding: "utf8", timeout: 1000 })).stdout;
    const clients = listed.trim().split("\n").flatMap(line => {
      const [activity, pid, control] = line.split(" ");
      return activity && pid && control !== "1" ? [{ activity: Number(activity), pid: Number(pid) }] : [];
    });
    const newest = Math.max(...clients.map(client => client.activity));
    const latest = clients.filter(client => client.activity === newest);
    if (latest.length !== 1) return undefined;
    const env = Object.fromEntries((await readFile(`/proc/${latest[0]!.pid}/environ`, "utf8")).split("\0").flatMap(entry => {
      const at = entry.indexOf("=");
      return at > 0 ? [[entry.slice(0, at), entry.slice(at + 1)]] : [];
    }));
    return inHerdr(env) ? Object.fromEntries(HERDR_KEYS.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]])) : undefined;
  } catch { return undefined; }
}

/** Reuse the installed CLI's desktop selection and fallback, preserving this TUI's daemon. */
export async function openTerminalInWindow(view: string, endpoint: string, cliEntry?: string, expectedPlan?: string, onUnavailable?: () => void,
  viewer: () => Promise<NodeJS.ProcessEnv | undefined> = viewerHerdrEnv): Promise<TerminalOpenResult> {
  // Already in a Herdr itself: nothing to carry. Otherwise hand the child the Herdr this TUI is being viewed from.
  const viewed = inHerdr(process.env) ? undefined : await viewer();
  const base = { ...process.env };
  if (viewed) for (const key of HERDR_KEYS) delete base[key];
  const args = ["terminal", "open", "--window", "--json", ...(expectedPlan !== undefined ? ["--expected-plan", expectedPlan] : []), "--", view];
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
    throw new Error([result.error ?? executionError ?? "No terminals were confirmed open.", ...(result.notes ?? []),
      ...result.absent.map(member => `Absent: ${member.seat} — ${member.reason}`),
      ...result.degraded.map(member => `Skipped: ${member.seat} — ${member.reason}`),
      ...(result.window ? [`Terminal: ${result.window.app} (${result.window.surface})`] : []),
    ].join("\n"));
  }
  return result;
}
