import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rename } from "node:fs/promises";
import { TerminalFollowing } from "../src/domain/terminal/terminal-following.js";
import { expectPrivateFile } from "./helpers/private-file.js";
import type { OpenViewResult } from "../src/domain/terminal/terminal-provider.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const dirs: string[] = [], services: TerminalFollowing[] = [];
afterEach(async () => {
  vi.mocked(rename).mockRestore();
  for (const service of services.splice(0)) await service.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const selector = { view: "slice:synthetic-中文", provider: "herdr" as const };
const answer: OpenViewResult = { provider: "herdr", ok: true, opened: [], absent: [], degraded: [], pages: 0 };

it.runIf(process.platform === "win32")("persists native private selectors before provider effects without blocking timers", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "following-private-")); dirs.push(root);
  const file = path.join(root, "selectors.json");
  let timerRan = false;
  const render = vi.fn(async () => {
    expect(timerRan).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).selections).toEqual([{ selector, enabled: true }]);
    expectPrivateFile(file);
    return answer;
  });
  const bus = { subscribe: () => () => {} };
  const service = new TerminalFollowing(file, bus, render); services.push(service);
  setTimeout(() => { timerRan = true; }, 0);
  await expect(service.open(selector, { enabled: true })).resolves.toEqual(answer);
  await service.stop();
  const restored = new TerminalFollowing(file, bus, async () => answer); services.push(restored);
  expect(restored.list()).toMatchObject([{ ...selector, enabled: true }]);
  await restored.stop();
  const prior = fs.readFileSync(file, "utf8");
  vi.mocked(rename).mockRejectedValueOnce(new Error("synthetic publication failure"));
  await expect(service.open(selector, { enabled: false })).resolves.toMatchObject({ ok: false });
  // Use a live controller for the failed save; no provider effect may precede it.
  const live = new TerminalFollowing(file, bus, render); services.push(live);
  await expect(live.open(selector, { enabled: false })).rejects.toThrow("synthetic publication failure");
  expect(render).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(file, "utf8")).toBe(prior);
  expectPrivateFile(file);
  expect(fs.readdirSync(root)).toEqual(["selectors.json"]);
}, 30_000);
