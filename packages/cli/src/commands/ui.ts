import { Command } from "commander";
import { getDaemonStatus, type LifecycleDeps } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

export interface UiDeps {
  lifecycleDeps: LifecycleDeps;
  exec: (cmd: string, args: string[]) => Promise<void>;
}

const DEFAULT_UI_URL = process.env["RIGGED_UI_URL"]?.trim() || "http://127.0.0.1:5173";

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
    .description("Open the Rigged UI in the default browser")
    .action(async () => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);

      if (status.state !== "running" || status.healthy === false) {
        if (status.state === "running" && status.healthy === false) {
          console.error("Daemon unhealthy — healthz failed");
        } else {
          console.error("Daemon not running");
        }
        process.exitCode = 1;
        return;
      }

      const url = DEFAULT_UI_URL;
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
