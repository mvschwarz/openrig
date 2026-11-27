import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import { readNativeProcessLaunch, readNativeProcessLaunches } from "../src/domain/native-process-arguments.js";

it("invalid process ids produce no launch captures", async () => {
  expect(await readNativeProcessLaunches([0, -1, NaN, 1.5, 2147483648])).toEqual(new Map());
  expect(await readNativeProcessLaunch(0)).toBeNull();
});

it.runIf(process.platform === "linux" || process.platform === "darwin")("batch captures keep each owned process's exact argv and home, while a missing pid stays unknown", async () => {
  const script = "setInterval(() => {}, 1000)";
  const children = [0, 1].map(index => spawn(process.execPath, ["-e", script, `argument ${index} \"quoted\"`], {
    env: { HOME: `/tmp/home ${index}`, CODEX_HOME: `/tmp/codex ${index}/Ω` }, stdio: "ignore",
  }));
  try {
    await Promise.all(children.map(child => once(child, "spawn")));
    const captures = await readNativeProcessLaunches([children[0]!.pid!, children[1]!.pid!, children[0]!.pid!, 2147483647]);
    expect(captures.size).toBe(2);
    for (const [index, child] of children.entries()) {
      const capture = captures.get(child.pid!);
      expect(capture?.argv).toEqual([process.execPath, "-e", script, `argument ${index} \"quoted\"`]);
      expect(capture?.env.HOME).toBe(`/tmp/home ${index}`);
      expect(capture?.env.CODEX_HOME).toBe(`/tmp/codex ${index}/Ω`);
      expect(await readNativeProcessLaunch(child.pid!)).toEqual(capture);
    }
    expect(captures.has(2147483647)).toBe(false);
    expect(await readNativeProcessLaunch(2147483647)).toBeNull();
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await Promise.all(children.map(child => child.exitCode === null && child.signalCode === null ? once(child, "close") : Promise.resolve()));
  }
}, 15_000);
