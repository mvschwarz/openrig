import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { prepareHerdrLaunchConfig } from "../src/herdr-launch-config.js";

const roots: string[] = [];
function root() { const dir = mkdtempSync(path.join(tmpdir(), "herdr-config-")); roots.push(dir); return dir; }
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const read = (file: string) => parse(readFileSync(file, "utf8"), { integersAsBigInt: true });

it.each([80, 120, 159, 160, 268])("keeps the person's exact config at %i columns", columns => {
  const dir = root(), source = path.join(dir, "my herdr.toml");
  const text = '# keep my original formatting\n[ui]\nsidebar_start_collapsed = false\nsidebar_width = 31\n[terminal]\nfont_size = 12.0\n[theme]\nfile = "themes/personal.toml"\n[server]\nlarge_number = 9007199254740993\n';
  writeFileSync(source, text, { mode: 0o640 });
  const before = statSync(source);
  const env = { HERDR_CONFIG_PATH: source, XDG_STATE_HOME: path.join(dir, "saved-state") };
  expect(prepareHerdrLaunchConfig(env, "/owned/herdr.sock", columns)).toBe(source);
  expect(readFileSync(source, "utf8")).toBe(text);
  expect(statSync(source).ino).toBe(before.ino);
  expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(source).mode).toBe(before.mode);
  expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
  expect(readdirSync(dir)).toEqual([path.basename(source)]);
});

it.each([false, true])("preserves normal HOME/XDG config selection, including an omitted sidebar setting (XDG %s)", xdg => {
  const dir = root(), env = { HOME: dir, ...(xdg ? { XDG_CONFIG_HOME: path.join(dir, "custom") } : {}) };
  const configDir = path.join(xdg ? env.XDG_CONFIG_HOME! : path.join(dir, ".config"), "herdr");
  mkdirSync(configDir, { recursive: true });
  const source = path.join(configDir, "config.toml");
  writeFileSync(source, '[ui]\nsidebar_width = 23\n');
  expect(prepareHerdrLaunchConfig(env, "/owned.sock", 80)).toBe(source);
  expect(read(source)).toEqual({ ui: { sidebar_width: 23n } });
});

it.each([[undefined, true], [80, true], [119, true], [120, true], [159, true], [160, false], [268, false]] as const)("defaults only an absent config at width %s to collapsed=%s", (columns, collapsed) => {
  const dir = root(), env = { HOME: dir };
  const output = prepareHerdrLaunchConfig(env, "/owned/herdr.sock", columns);
  expect(read(output)).toEqual({ onboarding: false, ui: { sidebar_start_collapsed: collapsed } });
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(existsSync(path.join(path.dirname(output), "config.toml"))).toBe(false);
  expect(prepareHerdrLaunchConfig(env, "/owned/herdr.sock", columns)).toBe(output);
});

it("keeps generated narrow/wide and endpoint settings independent", () => {
  const env = { HOME: root() };
  const narrow = prepareHerdrLaunchConfig(env, "/one.sock", 80);
  const wide = prepareHerdrLaunchConfig(env, "/one.sock", 160);
  const other = prepareHerdrLaunchConfig(env, "/two.sock", 160);
  expect(new Set([narrow, wide, other]).size).toBe(3);
  expect(read(narrow)).toEqual({ onboarding: false, ui: { sidebar_start_collapsed: true } });
  expect(read(wide)).toEqual({ onboarding: false, ui: { sidebar_start_collapsed: false } });
});

it.each(['[ui\n', 'ui = "not a table"', 'ui = []', ''])("leaves interpretation of an existing config to Herdr: %s", text => {
  const dir = root(), source = path.join(dir, "config.toml"); writeFileSync(source, text);
  expect(prepareHerdrLaunchConfig({ HERDR_CONFIG_PATH: source }, "/owned.sock", 80)).toBe(source);
  expect(readFileSync(source, "utf8")).toBe(text);
  expect(readdirSync(dir)).toEqual(["config.toml"]);
});

it("replaces its generated file atomically without following an output symlink", () => {
  const dir = root(), victim = path.join(dir, "personal.toml"), env = { HOME: dir };
  writeFileSync(victim, '[ui]\nsidebar_width = 18\n');
  const output = prepareHerdrLaunchConfig(env, "/owned.sock", 160);
  rmSync(output); symlinkSync(victim, output);
  expect(prepareHerdrLaunchConfig(env, "/owned.sock", 160)).toBe(output);
  expect(readFileSync(victim, "utf8")).toBe('[ui]\nsidebar_width = 18\n');
  expect(read(output)).toEqual({ onboarding: false, ui: { sidebar_start_collapsed: false } });
});
