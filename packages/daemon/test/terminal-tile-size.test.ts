import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { tileAttachArgv } from "../src/domain/terminal/tile-attach.js";

const available = spawnSync("tmux", ["-V"]).status === 0 && spawnSync("python3", ["--version"]).status === 0;
// From tmux 3.5 a tile's first keys go through the attaching client, so a prefix typed first acts as the prefix. Below
// 3.5 they go to the pane, so Ctrl-b d typed first reaches the seat (two more bytes), and the prefix-then-PgUp case is
// skipped.
const tmuxVersion = String(spawnSync("tmux", ["-V"], { encoding: "utf8" }).stdout ?? "").trim().replace(/^tmux /, "");
const tmuxMinor = /^(\d+)\.(\d+)/.exec(tmuxVersion);
const throughClient = /^(next-|master$)/.test(tmuxVersion)
  || (tmuxMinor !== null && (Number(tmuxMinor[1]) > 3 || (Number(tmuxMinor[1]) === 3 && Number(tmuxMinor[2]) >= 5)));
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
// tmux 3.4 and later turn paste framing on only when a client starts, so a framing-off write between the first key and
// the attach leaves a paste in that gap unframed: each of its lines would reach the agent as Enter.
it("a writable tile turns paste framing off only on the return that doesn't attach", () => {
  const script = tileAttachArgv("tmux", ["-S", "TILE_SOCKET"], "seat", true, 1, 2).find((arg) => arg.includes("use()")) ?? "";
  const use = script.slice(script.indexOf("use()"), script.indexOf("take()"));
  expect(use.length).toBeGreaterThan(0);
  expect(use.split("\\033[?2004l").length - 1).toBe(1);
  expect(use).toContain(`then printf "\\033[?2004l"; stty sane 2>/dev/null;`);
});

describe.skipIf(!available)("a tile views its seat without sizing it, and attaches only while the person types", () => {
  it.each(shells)("under %s: whole lines, the seat's own size, keys reaching the seat, and back to the view when idle", async (shell) => {
    expect(await helper(shell)).toEqual({
      readOnlyAlone: { window: "160x20" },
      readOnlyBesideAnother: { window: "160x20" },
      writable: { used: "40x30" },
      firstInput: { bytes: throughClient ? 183 : 185 },
      firstInputWindow: { bytes: 3 },
    });
  }, 180000);

  it("a paste over 256 KiB arrives whole and framed, and the tile still detaches when idle after it", async () => {
    expect(await helper("/bin/sh", "big-paste")).toEqual({ bigPaste: { bytes: 6 + 16000 * 28 + 6 } });
  }, 180000);
});
