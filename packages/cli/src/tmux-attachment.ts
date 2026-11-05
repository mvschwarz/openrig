import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import path from "node:path";
import type { DaemonClient } from "./client.js";

export interface TmuxAttachment {
  session: string;
  serverArgs: string[];
  readOnly?: boolean;
}

/** The daemon supplies server options as data; clients never parse a shell command. */
export function readTmuxServerArgs(value: unknown): string[] {
  if (value === undefined) return []; // Compatibility with a daemon predating server metadata.
  if (!Array.isArray(value) || (value.length !== 0 && (value.length !== 2
    || (value[0] !== "-S" && value[0] !== "-L")
    || typeof value[1] !== "string" || !value[1] || value[1].includes("\0")))) {
    throw new Error("The daemon returned invalid tmux server options.");
  }
  return [...value] as string[];
}

/** Offline cleanup pins only active isolation/migration; ordinary inherit uses tmux's environment. */
export function readRecordedTmuxServerArgs(home: string): string[] {
  let record: { version?: unknown; home?: unknown; mode?: unknown; socketPath?: unknown; isolatedSocketPath?: unknown; pinned?: unknown } | null = null;
  let readError: unknown;
  try { record = JSON.parse(readFileSync(path.join(home, "tmux-server.json"), "utf8")); }
  catch (error) { readError = error; }
  const pinned = record?.mode === "isolated" || record?.pinned === true;
  let matchesHome = false;
  try { matchesHome = record?.home === realpathSync(home); } catch { /* A missing/unreadable home is not a valid record. */ }
  const valid = record?.version === 1 && matchesHome
    && (record.mode === "inherit" || record.mode === "isolated")
    && (record.pinned === undefined || typeof record.pinned === "boolean")
    && !(record.mode === "isolated" && record.pinned === false)
    && typeof record.socketPath === "string" && path.isAbsolute(record.socketPath) && !record.socketPath.includes("\0")
    && (record.isolatedSocketPath === undefined || (typeof record.isolatedSocketPath === "string"
      && path.isAbsolute(record.isolatedSocketPath) && !record.isolatedSocketPath.includes("\0")));
  if (valid) {
    // An explicit opt-out record is committed before the marker is removed.
    // Older inherit records are advisory too, never a remembered cleanup socket.
    return pinned ? readTmuxServerArgs(["-S", record!.socketPath]) : [];
  }

  let marked = false;
  if (!pinned) {
    try { marked = readFileSync(path.join(home, "tmux-server.initialized"), "utf8").trim() === "openrig-tmux-pinned-v1"; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Cannot read the tmux server pin marker: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!marked) return []; // No active pin: missing/bad advisory records cannot change inheritance.
  }
  if (readError) {
    if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Missing tmux server record after pinned server selection; restore it before destroying this instance's sessions.");
    }
    throw new Error(`Cannot read the tmux server record: ${readError instanceof Error ? readError.message : String(readError)}`);
  }
  throw new Error("Invalid tmux server record; inspect it before destroying this instance's sessions.");
}

/** Host locality keeps the existing window-launcher behaviour in inherit mode. */
export function isLocalTmuxHost(url: string): boolean {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return ["localhost", "::1", "::", "0.0.0.0", hostname()].includes(host)
    || /^127\./.test(host)
    || Object.values(networkInterfaces()).flat().some(iface => iface?.address === host);
}

/** Only an effective isolated server needs proof beyond the legacy host check. */
export async function assertLocalTmux(
  client: Pick<DaemonClient, "isLocalInstance">,
  mode: "inherit" | "isolated" | undefined,
  message = "Terminal attachment uses local tmux. The selected daemon's instance identity could not be confirmed locally; run this command on that daemon's machine.",
): Promise<void> {
  if (mode === "isolated" && !await client.isLocalInstance()) throw new Error(message);
}

/** Attach only; creating or retargeting somebody else's tmux client is not part of this operation. */
export function attachTmux(target: TmuxAttachment): Promise<number> {
  const server = readTmuxServerArgs(target.serverArgs);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX;
    delete env.TMUX_PANE;
    const child = spawn("tmux", [...server, "attach-session", ...(target.readOnly ? ["-r"] : []), "-t", `=${target.session}`],
      { stdio: "inherit", env, windowsHide: true });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}
