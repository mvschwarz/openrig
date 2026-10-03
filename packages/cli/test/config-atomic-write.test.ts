import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore } from "../src/config-store.js";
import { SettingsStore } from "../../daemon/src/domain/user-settings/settings-store.js";
const failure = vi.hoisted(() => ({ active: false }));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (failure.active) {
      failure.active = false;
      actual.writeFileSync(args[0], "{");
      throw Object.assign(new Error("injected partial write: no space left"), { code: "ENOSPC" });
    }
    return actual.writeFileSync(...args);
  } };
});
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), "config-atomic-")); });
afterEach(() => { failure.active = false; vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });
const stores = [ConfigStore, SettingsStore];
it.each(stores)("%s preserves the previous native config after a partial failed set/reset", (Store) => {
  const file = join(dir, "config.json");
  const store = new Store(file);
  for (const change of [() => store.set("transcripts.lines", "20"), () => store.reset("transcripts.lines"),
    () => store.set("feed.subscriptions.remote.enabled", "true"), () => store.reset("feed.subscriptions.remote.enabled")]) {
    fs.writeFileSync(file, JSON.stringify({ transcripts: { lines: 40 }, feed: { subscriptions: { remote: { enabled: false } } } }));
    const before = fs.readFileSync(file, "utf8");
    failure.active = true;
    expect(change).toThrow(/no space left/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  }
});
it.each(stores)("%s retains a native config symlink and its target permissions on successful writes", (Store) => {
  const target = join(dir, "target.json"), link = join(dir, "config.json");
  fs.writeFileSync(target, "{}"); fs.chmodSync(target, 0o640); fs.symlinkSync(target, link);
  new Store(link).set("transcripts.lines", "20");
  expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ transcripts: { lines: 20 } });
  expect(fs.statSync(target).mode & 0o777).toBe(0o640);
  expect(fs.readdirSync(dir).sort()).toEqual(["config.json", "target.json"]);
});
