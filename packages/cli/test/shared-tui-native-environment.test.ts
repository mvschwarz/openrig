import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { sharedTuiEnvironment } from "../src/shared-tui.js";

it.runIf(process.platform === "win32")("does not pass a native-cased old multiplexer context to the attached child", () => {
  const input = { Tmux: "owned-old-context", OPENRIG_TEST_RETAIN: "owned retained value" };
  const result = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify({old:process.env.TMUX??null,retained:process.env.OPENRIG_TEST_RETAIN}))"], {
    env: sharedTuiEnvironment(input), encoding: "utf8", windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ old: null, retained: "owned retained value" });
  expect(input.Tmux).toBe("owned-old-context");
});
