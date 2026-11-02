import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxAdapter } from "../src/adapters/tmux.js";

let available = process.platform !== "win32";
if (available) try { execFileSync("tmux", ["-V"], { timeout: 2000, stdio: "ignore" }); } catch { available = false; }
it.runIf(available)("reads exact environment values from a real isolated POSIX tmux server", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "openrig-env-read-")), socket = path.join(root, "socket");
  const execute = promisify(execFile);
  const invoke = async (argv: string[]) => (await execute("tmux", ["-f", "/dev/null", "-S", socket, ...argv], { timeout: 5000, encoding: "utf8" })).stdout;
  const adapter = new TmuxAdapter(async () => { throw new Error("Unexpected shell transport"); }, undefined, argv => invoke(argv.slice(1)));
  try {
    await invoke(["new-session", "-d", "-s", "owned", "--", process.execPath, "-e", "setInterval(()=>{},1000)"]);
    for (const value of ["", "synthetic trailing CR\r", "synthetic trailing LF\n", "synthetic trailing CRLF\r\n", "日本語🙂\nVALUE=literal line\n", String.raw`literal\r\n\033\$`, 'quotes " $ ` \\ and controls\x01\t\x1b']) {
      await adapter.setSessionEnv("owned", "VALUE", value);
      expect(await adapter.getSessionEnv("owned", "VALUE")).toBe(value);
    }
    expect(await adapter.getSessionEnv("owned", "OPENRIG_ABSENT_SYNTHETIC")).toBeUndefined();
  } finally {
    await invoke(["kill-server"]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
