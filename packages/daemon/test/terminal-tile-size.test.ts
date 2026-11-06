import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;
it.skipIf(!available)("a writable tile sizes and resizes with an older competing client, while a read-only observer does not", () => {
  const result = JSON.parse(execFileSync("python3", [
    fileURLToPath(new URL("./helpers/tmux-tile-size.py", import.meta.url)),
    JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", false, 1)),
    JSON.stringify(tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", true, 1)),
  ], { encoding: "utf8", timeout: 15000 }));
  expect(result).toMatchObject({ initial: "101x32", resized: "121x43", clientsReaped: 3 });
  expect(result.writableFlags).not.toContain("ignore-size");
  expect(result.observerFlags).toContain("read-only");
}, 20000);
