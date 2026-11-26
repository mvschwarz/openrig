import { expect, it } from "vitest";
import { processStartToken } from "../src/daemon-start-lock.js";

it.runIf(process.platform === "win32")("proves a reservation's native PID creation identity without ps or /proc", () => {
  const first = processStartToken(process.pid);
  expect(first).toMatch(/^windows:\d{4}-/);
  expect(processStartToken(process.pid)).toBe(first);
  expect(processStartToken(2_147_483_647)).toBeUndefined();
}, 20_000);
