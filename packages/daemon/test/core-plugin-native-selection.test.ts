import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { CLAUDE_PLUGIN_DIRS_ENV, selectedCorePluginDir, withPluginDirs } from "../src/domain/claude-core-plugin-env.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  root = mkdtempSync(join(tmpdir(), "core-plugin-native-"));
  const plugins = join(root, "plugins"), plugin = join(plugins, "openrig-core");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
  return { plugins, plugin };
}
it.runIf(process.platform === "win32")("recognizes selected native plugin casing and avoids injecting it twice", () => {
  const { plugins, plugin } = fixture();
  expect(selectedCorePluginDir([plugin.toUpperCase()], plugins)).toBe(plugin);
  expect(selectedCorePluginDir([`${plugin}-other`], plugins)).toBeUndefined();
  const env = { [CLAUDE_PLUGIN_DIRS_ENV]: plugin.toUpperCase() };
  expect(withPluginDirs(env, [plugin])).toEqual(env);
});
it.runIf(process.platform === "win32")("retains declared plugins from a native-cased env key in the actual child environment", () => {
  const { plugin } = fixture();
  const own = join(root!, "own plugin");
  const env = withPluginDirs({ claude_code_plugin_dirs: own, OTHER_SETTING: "kept" }, [plugin]);
  expect(env).toEqual({ [CLAUDE_PLUGIN_DIRS_ENV]: [own, plugin].join(delimiter), OTHER_SETTING: "kept" });
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.env.CLAUDE_CODE_PLUGIN_DIRS))"],
    { env: { ...process.env, ...env }, windowsHide: true, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toBe([own, plugin].join(delimiter));
  expect(withPluginDirs({ [CLAUDE_PLUGIN_DIRS_ENV]: "", claude_code_plugin_dirs: own }, [plugin]))
    .toEqual({ [CLAUDE_PLUGIN_DIRS_ENV]: plugin });
});
