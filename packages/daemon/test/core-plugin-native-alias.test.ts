import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { selectedCorePluginDir, seatCorePluginDir, seatCodexCorePluginDir, withPluginDirs } from "../src/domain/claude-core-plugin-env.js";

it.runIf(process.platform === "win32")("recognizes a selected core plugin through native long/short directory aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "core-plugin-native-"));
  try {
    const plugins = join(root, "plugins");
    const dir = join(plugins, "openrig-core");
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "owned-core-fixture" }));
    const selected = realpathSync.native(dir);
    expect(selectedCorePluginDir([selected], plugins)).toBe(dir);
    const db = { prepare: () => { throw new Error("explicit selection must not read a real database"); } } as never;
    expect(seatCorePluginDir({ id: "owned", runtime: "claude-code" }, db, [selected], plugins)).toBe(dir);
    expect(seatCodexCorePluginDir({ id: "owned", runtime: "codex" }, db, [selected], plugins)).toBe(dir);
    expect(withPluginDirs({ CLAUDE_CODE_PLUGIN_DIRS: selected }, [dir])).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: selected });
    expect(withPluginDirs({ CLAUDE_CODE_PLUGIN_DIRS: selected }, [join(root, "other")])).toEqual({ CLAUDE_CODE_PLUGIN_DIRS: `${selected}${delimiter}${join(root, "other")}` });
    expect(selectedCorePluginDir([join(root, "other")], plugins)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
