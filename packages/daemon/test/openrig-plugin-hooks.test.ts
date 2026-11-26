// Slice 15: the `openrig` plugin (a person's own Claude Code or Codex) ships the hook bridge's conversation hooks. Each
// runtime's manifest names its own hooks file, so neither loads the other's (both runtimes, and other apps, would read a
// default hooks/hooks.json, which the plugin therefore doesn't have). The hooks run the plugin's copy of the bridge, which
// stays byte-equal to the one OpenRig's own seats run: a plugin can't reach files outside its folder.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const assets = fileURLToPath(new URL("../assets", import.meta.url));
const plugin = join(assets, "plugins", "openrig");
const json = (path: string) => JSON.parse(readFileSync(join(plugin, path), "utf8")) as Record<string, any>;
type Hook = { type: string; command: string; asyncRewake?: boolean; async?: boolean; timeout?: number };
const only = (file: Record<string, any>, event: string): Hook => {
  const groups = file.hooks[event] as Array<{ matcher?: string; hooks: Hook[] }>;
  expect(groups, event).toHaveLength(1);
  expect(groups[0]!.matcher, event).toBeUndefined();
  expect(groups[0]!.hooks, event).toHaveLength(1);
  return groups[0]!.hooks[0]!;
};

describe("the openrig plugin's conversation hooks", () => {
  it("Claude Code: the manifest names hooks/claude.json, with the waiter on SessionStart and Stop as asyncRewake and the turn marker", () => {
    expect(json(".claude-plugin/plugin.json").hooks).toBe("./hooks/claude.json");
    const hooks = json("hooks/claude.json");
    expect(Object.keys(hooks.hooks).sort()).toEqual(["SessionStart", "Stop", "UserPromptSubmit"]);
    for (const event of ["SessionStart", "Stop"]) {
      expect(only(hooks, event)).toEqual({ type: "command", asyncRewake: true, timeout: 7200,
        command: 'exec "${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/claude-hook-bridge.cjs" conversation-waiter' });
    }
    expect(only(hooks, "UserPromptSubmit")).toEqual({ type: "command", timeout: 5,
      command: 'exec "${OPENRIG_NODE:-node}" "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/claude-hook-bridge.cjs" conversation-turn' });
  });

  it("Codex: the manifest names hooks/codex.json, with an async SessionStart that starts the watcher and a SessionEnd that stops it", () => {
    expect(json(".codex-plugin/plugin.json").hooks).toBe("./hooks/codex.json");
    const hooks = json("hooks/codex.json");
    expect(Object.keys(hooks.hooks).sort()).toEqual(["SessionEnd", "SessionStart"]);
    expect(only(hooks, "SessionStart")).toEqual({ type: "command", async: true, timeout: 30,
      command: 'exec "${OPENRIG_NODE:-node}" "${PLUGIN_ROOT}/hooks/scripts/claude-hook-bridge.cjs" codex-start' });
    // Codex runs SessionEnd synchronously and clamps it to 3 seconds.
    expect(only(hooks, "SessionEnd")).toEqual({ type: "command", timeout: 3,
      command: 'exec "${OPENRIG_NODE:-node}" "${PLUGIN_ROOT}/hooks/scripts/claude-hook-bridge.cjs" codex-end' });
    // Neither runtime, nor another app, picks up a default hooks/hooks.json, and the formats other apps read carry no hooks.
    expect(existsSync(join(plugin, "hooks", "hooks.json"))).toBe(false);
    expect(json("plugin.json")).not.toHaveProperty("hooks");
    expect(json(".cursor-plugin/plugin.json")).not.toHaveProperty("hooks");
  });

  it("runs the plugin's copy of the bridge, byte-equal to OpenRig's own (copy assets/claude-hook-bridge.cjs over it when this fails)", () => {
    const copy = join(plugin, "hooks", "scripts", "claude-hook-bridge.cjs");
    expect(readFileSync(copy).equals(readFileSync(join(assets, "claude-hook-bridge.cjs")))).toBe(true);
    for (const [file, root] of [["hooks/claude.json", "${CLAUDE_PLUGIN_ROOT}/"], ["hooks/codex.json", "${PLUGIN_ROOT}/"]] as const) {
      for (const groups of Object.values(json(file).hooks) as Array<Array<{ hooks: Hook[] }>>) {
        for (const hook of groups.flatMap((group) => group.hooks)) {
          const script = hook.command.match(/"\$\{(?:CLAUDE_)?PLUGIN_ROOT\}\/([^"]+)"/)?.[1];
          expect(hook.command.includes(root), hook.command).toBe(true);
          expect(script && existsSync(join(plugin, script)), hook.command).toBe(true);
        }
      }
    }
  });
});
