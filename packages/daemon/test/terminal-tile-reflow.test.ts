import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

it("the writable argv remains valid for Herdr restart reporting", () => {
  const argv = tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", false);
  expect(argv.every(word => !/['\u0000-\u001f\u007f]/.test(word))).toBe(true);
});

it.skipIf(spawnSync("tmux", ["-V"]).status !== 0)("the shipped writable tile follows phone, laptop and every outer-terminal resize", async () => {
  const { stdout } = await promisify(execFile)("python3", [
    fileURLToPath(new URL("./helpers/tmux-tile-reflow.py", import.meta.url)),
    JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", false)),
  ], { timeout: 45000 });
  expect(JSON.parse(stdout)).toEqual({ sizes: ["40x24", "120x35", "160x45", "52x28", "132x40", "40x24", "132x40"], localPin: "unset", nativeInput: true, firstKeys: true, pasteBytes: 448012, prefixCopyMode: true });
}, 50000);
