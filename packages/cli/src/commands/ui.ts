import { Command } from "commander";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { readOpenRigEnv } from "../openrig-compat.js";
import { realDeps } from "./daemon.js";

export interface UiDeps {
  lifecycleDeps: LifecycleDeps;
  exec: (cmd: string, args: string[]) => Promise<void>;
  /** Reads the daemon's own answer for the UI page. Defaults to fetch with a short timeout. */
  probeUi?: (url: string) => Promise<{ status: number; headers: { get(name: string): string | null } }>;
}

export const UI_DISABLED_GUIDANCE =
  "The OpenRig web UI is off on this daemon. To turn it on, run `rig config set ui.enabled true`, then stop and start the daemon (`rig daemon stop`, `rig daemon start`).";

export const UI_MAINTENANCE_NOTICE =
  "The OpenRig UI is experimental and in maintenance mode. It is not under active development; support is best-effort. The CLI is the primary supported interface. Contributions welcome.";

export function uiCommand(depsOverride?: UiDeps): Command {
  const cmd = new Command("ui").description("UI commands");
  const getDeps = (): UiDeps => depsOverride ?? {
    lifecycleDeps: realDeps(),
    exec: async (cmd, args) => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)(cmd, args);
    },
  };

  cmd
    .command("open")
    .description("Open the OpenRig UI in the default browser")
    .action(async () => {
      console.error(UI_MAINTENANCE_NOTICE);
      const deps = getDeps();

      // Explicit override skips daemon status entirely (dev workflow with Vite)
      const overrideUrl = readOpenRigEnv("OPENRIG_UI_URL", "RIGGED_UI_URL")?.trim();
      if (overrideUrl) {
        console.log(overrideUrl);
        try {
          await deps.exec("open", [overrideUrl]);
        } catch {
          console.error("Failed to open browser — open the URL manually");
          process.exitCode = 1;
        }
        return;
      }

      // Default: derive UI URL from daemon status (daemon serves the UI)
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;

      const url = getDaemonUrl(status);
      // Ask the running daemon, not local config: the setting takes effect when the daemon starts.
      const probeUi = deps.probeUi ?? ((target: string) => fetch(target, { signal: AbortSignal.timeout(3000) }));
      try {
        const res = await probeUi(url);
        if (res.status === 404 && res.headers.get("x-openrig-web-ui") === "off") {
          console.error(UI_DISABLED_GUIDANCE);
          process.exitCode = 1;
          return;
        }
      } catch {
        // No answer: open the URL as before; the browser shows whatever the daemon serves.
      }
      console.log(url);

      try {
        await deps.exec("open", [url]);
      } catch {
        console.error("Failed to open browser — open the URL manually");
        process.exitCode = 1;
      }
    });

  return cmd;
}
