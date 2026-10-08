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

it("preserves the person's settings and config-relative paths, changing only the private sidebar default", () => {
  const dir = root(), source = path.join(dir, "my herdr.toml");
  const text = '# keep my original formatting\n[ui]\nsidebar_start_collapsed = false\nsidebar_width = 31\n[terminal]\nfont_size = 12.0\n[theme]\nfile = "themes/personal.toml"\n[server]\nlarge_number = 9007199254740993\n[remote]\nservers = [{ name = "personal", address = "example.test" }]\n';
  writeFileSync(source, text, { mode: 0o640 });
  const before = statSync(source);
  const expected = parse(text, { integersAsBigInt: true });
  expected.ui = { ...(expected.ui as object), sidebar_start_collapsed: true };
  const env = { HERDR_CONFIG_PATH: source, XDG_STATE_HOME: path.join(dir, "saved-state") };
  const originalEnv = { ...env };
  const output = prepareHerdrLaunchConfig(env, "/owned/herdr.sock");
  expect(read(output)).toEqual(expected);
  expect(path.dirname(output)).toBe(path.dirname(source));
  expect(readFileSync(output, "utf8")).toContain("font_size = 12.0");
  expect(readFileSync(source, "utf8")).toBe(text);
  expect(statSync(source).ino).toBe(before.ino);
  expect(statSync(source).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(source).mode).toBe(before.mode);
  expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(env).toEqual(originalEnv);
  expect(existsSync(env.XDG_STATE_HOME)).toBe(false);
  expect(prepareHerdrLaunchConfig(env, "/owned/herdr.sock")).toBe(output);
  expect(readdirSync(dir).sort()).toEqual([path.basename(source), path.basename(output)].sort());
});

it.each([false, true])("uses Herdr's normal HOME/XDG selection and leaves a missing global file absent (XDG: %s)", xdg => {
  const dir = root(), env = { HOME: dir, ...(xdg ? { XDG_CONFIG_HOME: path.join(dir, "custom") } : {}) };
  const output = prepareHerdrLaunchConfig(env, "/owned/herdr.sock");
  expect(path.dirname(output)).toBe(path.join(xdg ? env.XDG_CONFIG_HOME! : path.join(dir, ".config"), "herdr"));
  expect(read(output)).toEqual({ ui: { sidebar_start_collapsed: true } });
  expect(existsSync(path.join(path.dirname(output), "config.toml"))).toBe(false);
});

it("reads an existing XDG config and scopes private copies to each endpoint", () => {
  const dir = root(), configDir = path.join(dir, "herdr"); mkdirSync(configDir);
  const source = path.join(configDir, "config.toml"); writeFileSync(source, '[ui]\nsidebar_width = 23\n');
  const env = { XDG_CONFIG_HOME: dir };
  const a = prepareHerdrLaunchConfig(env, "/one.sock"), b = prepareHerdrLaunchConfig(env, "/two.sock");
  expect(a).not.toBe(b);
  expect(read(a)).toEqual({ ui: { sidebar_width: 23n, sidebar_start_collapsed: true } });
  expect(read(b)).toEqual(read(a));
  expect(readFileSync(source, "utf8")).toBe('[ui]\nsidebar_width = 23\n');
});

it.each(['[ui\n', 'ui = "not a table"', 'ui = []'])("keeps malformed or non-table config unchanged instead of discarding it (%s)", text => {
  const dir = root(), source = path.join(dir, "config.toml"); writeFileSync(source, text);
  expect(() => prepareHerdrLaunchConfig({ HERDR_CONFIG_PATH: source }, "/owned.sock")).toThrow();
  expect(readFileSync(source, "utf8")).toBe(text);
  expect(readdirSync(dir)).toEqual(["config.toml"]);
});

it("replaces its private file atomically without following an output symlink", () => {
  const dir = root(), source = path.join(dir, "config.toml"), env = { HERDR_CONFIG_PATH: source };
  writeFileSync(source, '[ui]\nsidebar_width = 18\n');
  const output = prepareHerdrLaunchConfig(env, "/owned.sock");
  rmSync(output); symlinkSync(source, output);
  expect(prepareHerdrLaunchConfig(env, "/owned.sock")).toBe(output);
  expect(readFileSync(source, "utf8")).toBe('[ui]\nsidebar_width = 18\n');
  expect(read(output)).toEqual({ ui: { sidebar_width: 18n, sidebar_start_collapsed: true } });
});
