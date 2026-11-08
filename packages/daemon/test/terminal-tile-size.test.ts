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
describe.skipIf(!available)("a tile views its seat without sizing it, and attaches only while the person types", () => {
  it.each(shells)("under %s: whole lines, the seat's own size, keys reaching the seat, and back to the view when idle", async (shell) => {
    expect(await helper(shell)).toEqual({
      readOnlyAlone: { window: "160x20" },
      readOnlyBesideAnother: { window: "160x20" },
      writable: { used: "40x30" },
      firstInput: { bytes: 183 },
      firstInputWindow: { bytes: 3 },
    });
  }, 180000);

  it("a paste over 256 KiB arrives whole and framed, and the tile still detaches when idle after it", async () => {
    expect(await helper("/bin/sh", "big-paste")).toEqual({ bigPaste: { bytes: 6 + 16000 * 28 + 6 } });
  }, 180000);
});
