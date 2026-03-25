import { Command } from "commander";
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  startDaemon,
  stopDaemon,
  getDaemonStatus,
  readLogs,
  tailLogs,
  type LifecycleDeps,
} from "../daemon-lifecycle.js";

export function realDeps(): LifecycleDeps {
  return {
    spawn: (cmd, args, opts) => spawn(cmd, args, opts as Parameters<typeof spawn>[2]),
    fetch: async (url) => {
      const res = await globalThis.fetch(url);
      return { ok: res.ok };
    },
    kill: (pid, signal) => { process.kill(pid, signal as NodeJS.Signals); return true; },
    readFile: (p) => { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } },
    writeFile: (p, content) => fs.writeFileSync(p, content, "utf-8"),
    removeFile: (p) => { try { fs.unlinkSync(p); } catch { /* ignore */ } },
    exists: (p) => fs.existsSync(p),
    mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
    openForAppend: (p) => fs.openSync(p, "a"),
    isProcessAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  };
}

export function daemonCommand(depsOverride?: LifecycleDeps): Command {
  const getDeps = () => depsOverride ?? realDeps();
  const cmd = new Command("daemon").description("Manage the rigged daemon");

  cmd
    .command("start")
    .description("Start the daemon")
    .option("--port <port>", "Port to listen on", "7433")
    .option("--db <path>", "Database path", "rigged.sqlite")
    .action(async (opts: { port: string; db: string }) => {
      try {
        const state = await startDaemon(
          { port: parseInt(opts.port, 10), db: opts.db },
          getDeps(),
        );
        console.log(`Daemon started on port ${state.port} (pid ${state.pid})`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("stop")
    .description("Stop the daemon")
    .action(async () => {
      try {
        await stopDaemon(getDeps());
        console.log("Daemon stopped");
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  cmd
    .command("status")
    .description("Show daemon status")
    .action(async () => {
      const status = await getDaemonStatus(getDeps());
      switch (status.state) {
        case "running":
          if (status.healthy === false) {
            console.log(`Daemon running on port ${status.port} (pid ${status.pid}) — healthz failed`);
          } else {
            console.log(`Daemon running on port ${status.port} (pid ${status.pid})`);
          }
          break;
        case "stopped":
          console.log("Daemon stopped");
          break;
        case "stale":
          console.log("Daemon stale (cleaned up)");
          break;
      }
    });

  cmd
    .command("logs")
    .description("Show daemon logs")
    .option("--follow", "Follow log output")
    .action((opts: { follow?: boolean }) => {
      if (opts.follow) {
        tailLogs(getDeps(), { follow: true });
      } else {
        const content = readLogs(getDeps());
        if (content) {
          console.log(content);
        } else {
          console.log("No daemon logs found");
        }
      }
    });

  return cmd;
}
