import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;
// Linux's /bin/sh is often dash, whose background commands read /dev/null unless given another input.
const shells = ["/bin/sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
describe.skipIf(!available)("a tile views its seat without sizing it, and attaches only while the person types", () => {
  it.each(shells)("under %s: whole lines, the seat's own size, keys reaching the seat, and back to the view when idle", (shell) => {
    const result = JSON.parse(execFileSync("python3", [
      fileURLToPath(new URL("./helpers/tmux-tile-size.py", import.meta.url)),
      shell,
      JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", false, 1, 2)),
      JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", true, 1, 2)),
    ], { encoding: "utf8", timeout: 50000 }));
    expect(result).toEqual({
      readOnlyAlone: { window: "160x20" },
      readOnlyBesideAnother: { window: "160x20" },
      writable: { used: "40x30" },
    });
  }, 60000);
});
