import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;
// Linux's /bin/sh is often dash, whose background commands read /dev/null unless given another input.
const shells = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
// The helper runs for many seconds; running it without blocking keeps the test worker able to report to vitest.
const helper = async (shell: string, ...more: string[]) => JSON.parse((await promisify(execFile)("python3", [
  fileURLToPath(new URL("./helpers/tmux-tile-size.py", import.meta.url)),
  shell,
  JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", false, 1, 2)),
  JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", true, 1, 2)),
  ...more,
], { encoding: "utf8", timeout: 150000 })).stdout);
describe.skipIf(!available)("read-only tiles remain observers beside native sizing clients", () => {
  it.each(shells)("under %s: whole lines without typing or sizing the seat", async (shell) => {
    expect(await helper(shell)).toEqual({
      readOnlyAlone: { window: "160x20" },
      readOnlyBesideAnother: { window: "160x20" },
    });
  }, 30000);
});
