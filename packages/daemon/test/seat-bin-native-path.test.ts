import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

it.runIf(process.platform === "win32")("runs the paired CLI from a literal percent and bang path in cmd", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "seat-bin-path-"));
  try {
    const directory = path.join(root, "paired-%OPENRIG_PATH_DECOY%-!OPENRIG_PATH_DECOY!");
    fs.mkdirSync(directory);
    const cli = path.join(directory, "rig.mjs");
    fs.writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)))");
    const previous = path.join(root, "run", "seat-bin", createHash("sha256").update(fs.realpathSync(cli)).digest("hex"));
    fs.mkdirSync(previous, { recursive: true });
    fs.writeFileSync(path.join(previous, "rig.cmd"), "older-shim-owned-by-running-daemon");
    const seat = new SeatLaunchEnvironment({} as TmuxAdapter, { OPENRIG_HOME: root }, root, cli, undefined, "win32");
    // Exercise shim construction only: no terminal, session or provider is created.
    const bin = (seat as unknown as { rigBin(): string }).rigBin();
    expect(bin).not.toBe(previous);
    expect(fs.readFileSync(path.join(previous, "rig.cmd"), "utf8")).toBe("older-shim-owned-by-running-daemon");
    const cmd = path.join(process.env.SystemRoot!, "System32", "cmd.exe");
    const result = spawnSync(cmd, ["/d", "/v:on", "/s", "/c", `""${path.join(bin, "rig.cmd")}" literal-argument"`], {
      cwd: root, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, timeout: 10000,
      env: { ...process.env, OPENRIG_PATH_DECOY: "WRONG-DIRECTORY" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["literal-argument"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
