import { homedir } from "node:os";
import path from "node:path";
import type { DaemonClient } from "./client.js";
import { shellQuote } from "./cross-host-executor.js";
import type { OpenViewResult } from "./commands/terminal.js";
import type { WindowDeps } from "./terminal-window.js";

interface RexPreview {
  planId: string;
  composed: { opened: unknown[]; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
}
interface RexStatus { providers?: Array<{ status?: { available?: boolean; server?: { instanceId?: string } }; liveness?: { detail?: string } }> }
interface RexClient { client_id?: string | null; connection_state?: string; info?: { kind?: string; label?: string; name?: string } | null }
type RexCall = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>;

const BUNDLED_REX = ["Library", "Application Support", "com.superlogical.rex", "RexServer", "Versions", "Current", "Rex Server.app", "Contents", "MacOS", "rex"];

async function rexBinary(deps: WindowDeps): Promise<string | null> {
  const fromDir = deps.env["REX_BIN_DIR"] ? path.join(deps.env["REX_BIN_DIR"], "rex") : null;
  if (fromDir && deps.exists(fromDir)) return fromDir;
  try {
    const found = (await deps.exec("/bin/sh", ["-c", "command -v rex"])).trim();
    if (path.isAbsolute(found)) return found;
  } catch { /* the app bundle is the last place to look */ }
  const bundled = path.join(deps.env["HOME"] ?? homedir(), ...BUNDLED_REX);
  return deps.exists(bundled) ? bundled : null;
}

const reason = (err: unknown): string => {
  const said = `${(err as { stderr?: string }).stderr ?? ""}\n${err instanceof Error ? err.message : String(err)}`;
  return /\bcode=([a-z_]+)/.exec(said)?.[1] ?? (err instanceof Error ? err.message.split("\n")[0]! : String(err));
};

/** The connected Rex apps that can switch sessions, narrowed to the one the person types in when that is known. */
async function selectableApps(call: RexCall, env: NodeJS.ProcessEnv): Promise<Array<RexClient & { client_id: string }>> {
  const here = env["REX_SESSION"];
  const listed = here ? await call("session.list_clients", { session_id: here }) : await call("client.list", {});
  // The listing includes this command's own short-lived `rex` client, gone by the time it would be inspected.
  const clients = (Array.isArray(listed["clients"]) ? listed["clients"] as RexClient[] : [])
    .filter((c): c is RexClient & { client_id: string } => typeof c?.client_id === "string" && c.connection_state !== "lost" && (!c.info || c.info.kind === "app"));
  const apps = (await Promise.all(clients.map(async (c) => {
    try {
      const actions = (await call("client.inspect", { client_id: c.client_id }))["actions"];
      return Array.isArray(actions) && actions.some((a) => a?.name === "session.select") ? [c] : [];
    } catch {
      return [];
    }
  }))).flat();
  if (apps.length < 2 || !here) return apps;
  // Several apps view this session; the one that owns the caller's block is the one being typed in.
  const blocks = (await call("session.list_blocks", { session_id: here }))["blocks"];
  const owner = Array.isArray(blocks) ? blocks.find((b) => b?.block_id === env["REX_BLOCK"])?.owner : undefined;
  return apps.some((c) => c.client_id === owner) ? apps.filter((c) => c.client_id === owner) : apps;
}

/** Ask the one Rex app the person is using to show the new session. Every outcome is a note, never a failure. */
async function showSession(call: RexCall, env: NodeJS.ProcessEnv, space: { id: string; label: string }): Promise<string> {
  const named = `session ${JSON.stringify(space.label)}`;
  let apps: Array<RexClient & { client_id: string }>;
  try {
    apps = await selectableApps(call, env);
  } catch (err) {
    return `Could not ask a Rex app to show ${named} (${reason(err)}); select it in Rex.`;
  }
  const name = (c: RexClient) => JSON.stringify(c.info?.label ?? c.info?.name ?? c.client_id);
  if (apps.length === 0) return `No Rex app that can switch sessions is connected; select ${named} in Rex.`;
  if (apps.length > 1) return `Several Rex apps are connected (${apps.map(name).join(", ")}), so none was switched; select ${named} in the one you're using.`;
  const app = apps[0]!;
  try {
    await call("client.perform", { client_id: app.client_id, action: "session.select", args: { session_id: space.id }, origin: "cli", timeout_ms: 10_000 }, 15_000);
    return `The Rex app ${name(app)} switched to ${named}.`;
  } catch (err) {
    const why = reason(err);
    return `The Rex app ${name(app)} did not switch to ${named} (${why}); select it in Rex.${why === "refused" ? " To let OpenRig switch it, turn on Remote Control in the app's Settings, under Rex Server." : ""}`;
  }
}

/** Open the view in the daemon's Rex server, only when it is the caller's own server, then show it in the app. */
export async function openRexView(client: DaemonClient, view: string, deps: WindowDeps, expectedPlan?: string): Promise<OpenViewResult> {
  let posted = false;
  const fail = (error: string, extra: Partial<OpenViewResult> = {}): OpenViewResult => ({
    provider: "rex", ok: false, opened: [], absent: [], degraded: [], pages: 0, error, code: "terminal_window_failed", windowAttempted: posted, ...extra,
  });
  const elsewhere = `To open it outside Rex, run: rig terminal open ${shellQuote(view)} --window --provider herdr (or --provider tmux).`;
  try {
    const rex = await rexBinary(deps);
    if (!rex) return fail(`No Rex session was opened: the rex command was not found here. ${elsewhere}`);
    // This rex reads the server only from -S, never from REX_SERVER.
    const server = deps.env["REX_SERVER"]?.trim();
    const rexArgs = ["--autostart=false", ...(server ? ["-S", server] : [])];
    const call: RexCall = async (method, params, timeoutMs) =>
      JSON.parse(await deps.exec(rex, [...rexArgs, "api", "call", method, JSON.stringify(params)], timeoutMs)) as Record<string, unknown>;
    const status = await client.get<RexStatus>("/api/terminal/status?provider=rex");
    const daemonRex = status.data?.providers?.[0];
    if (status.status >= 400 || !daemonRex?.status?.available) {
      const detail = daemonRex?.liveness?.detail ? ` (${daemonRex.liveness.detail})` : "";
      return fail(`No Rex session was opened: the daemon can't reach a Rex server${detail}. ${elsewhere}`);
    }
    let callerInstance: unknown;
    try { callerInstance = (JSON.parse(await deps.exec(rex, [...rexArgs, "whoami", "--json"])) as Record<string, unknown>)["instance_id"]; }
    catch { /* unconfirmed below */ }
    const daemonInstance = daemonRex.status.server?.instanceId;
    if (typeof callerInstance !== "string" || !callerInstance || !daemonInstance) {
      return fail("No Rex session was opened: could not confirm that this terminal and the daemon use the same Rex server.");
    }
    if (callerInstance !== daemonInstance) {
      return fail(`No Rex session was opened: this terminal uses a different Rex server than the daemon, and OpenRig won't open the view on a server you aren't looking at. Restart the daemon from a terminal in this Rex, or with REX_SERVER set to this server. ${elsewhere}`);
    }
    const measured = await deps.columns?.().catch(() => undefined);
    const viewportColumns = Number.isSafeInteger(measured) && measured! > 0 ? measured : undefined;
    const preview = await client.get<RexPreview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=rex${viewportColumns === undefined ? "" : `&viewportColumns=${viewportColumns}`}`);
    if (preview.status >= 400 || !("composed" in preview.data)) return fail((preview.data as OpenViewResult).error ?? "Could not compose the requested view.");
    const { planId, composed } = preview.data;
    if (expectedPlan !== undefined && expectedPlan !== planId) return fail("The terminal view changed since preview. Refresh the preview before opening.");
    if (!composed.opened.length) return fail("No conversations are attachable.", { absent: composed.absent, degraded: composed.degraded });
    posted = true;
    const opened = await client.post<OpenViewResult>("/api/terminal/open", { view, provider: "rex", expectedPlan: planId, ...(viewportColumns !== undefined ? { viewportColumns } : {}) }, { timeoutMs: 45_000 });
    if (opened.status >= 400) {
      return fail(opened.data?.error ?? `The daemon refused the view (HTTP ${opened.status}).`, { windowAttempted: false, absent: composed.absent, degraded: composed.degraded });
    }
    if (!Array.isArray(opened.data?.opened)) throw new Error("The daemon returned no view result.");
    const result = opened.data;
    const shown = result.space && result.opened.length > 0 ? [await showSession(call, deps.env, result.space)] : [];
    return { ...result, notes: [...(result.notes ?? []), ...shown] };
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    return fail(posted ? `The Rex view outcome could not be confirmed. ${message} Inspect Rex's sessions before retrying.` : `No Rex session was opened. ${message}`);
  }
}
