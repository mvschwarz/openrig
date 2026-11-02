import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readPlatformEnv } from "@openrig/daemon/windows-launch";

type ColumnQuery = (env: NodeJS.ProcessEnv) => Promise<string>;

/** A piped CLI still belongs to its hosting psmux pane, whose server identity
 * must survive the separate environment used to launch a new terminal. */
export async function windowsHostingColumns(env: NodeJS.ProcessEnv, query: ColumnQuery = async selected =>
  (await promisify(execFile)("tmux", ["display-message", "-p", "#{window_width}"],
    { env: selected, windowsHide: true, encoding: "utf8", timeout: 1000 })).stdout): Promise<number | undefined> {
  const session = readPlatformEnv(env, "PSMUX_TARGET_SESSION", "win32");
  const pane = readPlatformEnv(env, "TMUX_PANE", "win32");
  if (!session || session.includes("\0") || !pane || !/^%\d+$/.test(pane)) return undefined;
  // psmux resolves PSMUX_TARGET_SESSION as a full namespace/registry identity.
  // Do not send a bare pane ID through -t, which can select another server.
  try {
    const text = (await query(env)).trim();
    if (!/^\d+$/.test(text)) return undefined;
    const width = Number(text);
    return Number.isSafeInteger(width) && width > 0 ? width : undefined;
  } catch { return undefined; }
}
