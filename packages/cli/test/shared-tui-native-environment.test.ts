import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { detachedTerminalEnvironment } from "../src/terminal-environment.js";
import { defaultWindowDeps } from "../src/terminal-window.js";

it.runIf(process.platform === "win32")("does not pass a native-cased old multiplexer context to the attached child", () => {
  const input = { Tmux: "owned-old-context", OPENRIG_TEST_RETAIN: "owned retained value" };
  const result = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify({old:process.env.TMUX??null,retained:process.env.OPENRIG_TEST_RETAIN}))"], {
    env: detachedTerminalEnvironment(input), encoding: "utf8", windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ old: null, retained: "owned retained value" });
  expect(input.Tmux).toBe("owned-old-context");
});

it.runIf(process.platform === "win32")("clears native context in the actual desktop terminal command consumer", async () => {
  const deps = defaultWindowDeps({ tMuX: "owned old desktop context", OPENRIG_TEST_RETAIN: "owned desktop value" });
  const out = await deps.exec(process.execPath, ["-e", "console.log(JSON.stringify({old:process.env.TMUX??null,retained:process.env.OPENRIG_TEST_RETAIN}))"]);
  expect(JSON.parse(out)).toEqual({ old: null, retained: "owned desktop value" });
});
