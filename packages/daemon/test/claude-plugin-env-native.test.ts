import { describe, expect, it } from "vitest";
import path from "node:path";
import { CLAUDE_PLUGIN_DIRS_ENV, withPluginDirs } from "../src/domain/claude-core-plugin-env.js";

describe("Claude plugin environment native path lists", () => {
  const first = path.resolve("plugin fixtures", "first");
  const second = path.resolve("plugin fixtures", "second");

  it("loads separate absolute directories using the provider's native delimiter", () => {
    const env = withPluginDirs({ KEEP: "unchanged" }, [first, second]);
    expect(env.KEEP).toBe("unchanged");
    expect(env[CLAUDE_PLUGIN_DIRS_ENV]?.split(path.delimiter)).toEqual([first, second]);
  });

  it("retains a declared list exactly and avoids duplicate absolute directories", () => {
    const own = [first, second].join(path.delimiter);
    const declared = { [CLAUDE_PLUGIN_DIRS_ENV]: own };
    expect(withPluginDirs(declared, [second, first])).toBe(declared);
    expect(withPluginDirs({}, [first, first])[CLAUDE_PLUGIN_DIRS_ENV]).toBe(first);
  });
});
