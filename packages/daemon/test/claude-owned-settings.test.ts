import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOwnedClaudeCwd, collectorCommandScriptPath, isShippedCollectorBytes, removeRepointedLegacyCollector } from "../src/domain/claude-owned-settings.js";
import { managedClaudeNodeCommand } from "../src/domain/claude-activity-hooks.js";
import { throttledCollectorCommand } from "../src/domain/claude-statusline-throttle.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("collectorCommandScriptPath", () => {
  const legacy = "/seat/.openrig/context-collector.cjs";
  const current = "/home/state/claude-context-collector/context-collector.cjs";
  const contextDir = "/home/state/context-usage";
  const providerDir = "/home/state/provider-usage";
  const plainLegacy = managedClaudeNodeCommand("node", legacy, contextDir, providerDir);
  const plainCurrent = managedClaudeNodeCommand("node", current, contextDir, providerDir);

  it("reads the script out of plain and throttled owned commands, and nothing out of a user's", () => {
    expect(collectorCommandScriptPath(plainLegacy)).toBe(legacy);
    expect(collectorCommandScriptPath(plainCurrent)).toBe(current);
    const throttled = throttledCollectorCommand({ collectorCommand: plainLegacy, contextDir, sessionName: "dev", seconds: 30 });
    expect(collectorCommandScriptPath(throttled)).toBe(legacy);
    expect(collectorCommandScriptPath(`echo '${legacy}'`)).toBeNull();
    expect(collectorCommandScriptPath(`${plainLegacy} | cat`)).toBeNull();
  });
});

describe("isShippedCollectorBytes", () => {
  const shipped = Buffer.from("// current collector\n");
  it("accepts only this release's bytes", () => {
    const old = Buffer.from("// an earlier collector\n");
    expect(isShippedCollectorBytes(shipped, shipped)).toBe(true);
    expect(isShippedCollectorBytes(old, shipped)).toBe(false);
    expect(isShippedCollectorBytes(Buffer.from("// a person's edit\n"), shipped)).toBe(false);
  });
});

describe("removeRepointedLegacyCollector", () => {
  it.each(["owned legacy", "relative legacy", "managed throttled", "another cwd", "instance copy", "user wrapper"])("uses only the repointed command's ownership: %s", (kind) => {
    const cwd = mkdtempSync(join(tmpdir(), "repointed-collector-"));
    roots.push(cwd);
    const dir = join(cwd, ".openrig");
    const legacy = join(dir, "context-collector.cjs");
    mkdirSync(dir);
    writeFileSync(legacy, "// older collector\n");
    const script = kind === "another cwd" ? join(cwd, "other", ".openrig", "context-collector.cjs")
      : kind === "instance copy" ? join(cwd, "state", "claude-context-collector", "context-collector.cjs")
      : kind === "relative legacy" ? "./.openrig/context-collector.cjs" : legacy;
    const owned = managedClaudeNodeCommand("node", script, "/context", "/provider");
    const command = kind === "user wrapper" ? `printf '{}' | ${owned}`
      : kind === "managed throttled"
        ? throttledCollectorCommand({ collectorCommand: owned, contextDir: "/context", sessionName: "dev", seconds: 30 })
        : owned;

    removeRepointedLegacyCollector(cwd, command);

    if (kind === "owned legacy" || kind === "relative legacy" || kind === "managed throttled") {
      expect(existsSync(legacy)).toBe(false);
      expect(existsSync(dir)).toBe(false);
    } else {
      expect(readFileSync(legacy, "utf8")).toBe("// older collector\n");
    }
  });
});

describe("cleanupOwnedClaudeCwd with an older shipped collector", () => {
  const CURRENT = "// current collector\n";
  const OLD = "// an earlier collector\n";

  function setup(options: { settingsCommand?: string; legacyBytes?: string; assetBytes?: string } = {}) {
    const root = mkdtempSync(join(tmpdir(), "owned-settings-"));
    roots.push(root);
    const cwd = join(root, "seat");
    const asset = join(root, "asset.cjs");
    writeFileSync(asset, options.assetBytes ?? CURRENT);
    mkdirSync(join(cwd, ".openrig"), { recursive: true });
    const legacy = join(cwd, ".openrig", "context-collector.cjs");
    writeFileSync(legacy, options.legacyBytes ?? OLD);
    if (options.settingsCommand !== undefined) {
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(join(cwd, ".claude", "settings.local.json"),
        JSON.stringify({ statusLine: { type: "command", command: options.settingsCommand } }));
    }
    return { root, cwd, asset, legacy };
  }

  it("keeps older bytes after the settings have already moved to instance state", () => {
    const s = setup({ settingsCommand: managedClaudeNodeCommand("node", "/home/state/claude-context-collector/context-collector.cjs", "/home/state/context-usage", "/home/state/provider-usage") });
    const kept = cleanupOwnedClaudeCwd(s.cwd, s.asset);
    expect(readFileSync(s.legacy, "utf8")).toBe(OLD);
    expect(kept).toEqual([`${s.legacy}: not the shipped collector's bytes, so it was kept`]);
  });

  it("keeps older bytes with no settings file at all", () => {
    const s = setup();
    const kept = cleanupOwnedClaudeCwd(s.cwd, s.asset);
    expect(readFileSync(s.legacy, "utf8")).toBe(OLD);
    expect(kept).toEqual([`${s.legacy}: not the shipped collector's bytes, so it was kept`]);
  });

  it("removes the current shipped bytes and the emptied directory", () => {
    const s = setup({ legacyBytes: CURRENT });
    const kept = cleanupOwnedClaudeCwd(s.cwd, s.asset);
    expect(existsSync(s.legacy)).toBe(false);
    expect(existsSync(join(s.cwd, ".openrig"))).toBe(false);
    expect(kept).toEqual([]);
  });

  it("still keeps a person's edit to the legacy file, and says so", () => {
    const s = setup({ legacyBytes: `${OLD}// a person's edit\n` });
    const kept = cleanupOwnedClaudeCwd(s.cwd, s.asset);
    expect(readFileSync(s.legacy, "utf-8")).toBe(`${OLD}// a person's edit\n`);
    expect(kept).toEqual([`${s.legacy}: not the shipped collector's bytes, so it was kept`]);
  });

  it("still keeps a shared legacy file", () => {
    const s = setup();
    const kept = cleanupOwnedClaudeCwd(s.cwd, s.asset, () => true);
    expect(existsSync(s.legacy)).toBe(true);
    expect(kept).toEqual([`${s.legacy}: another seat's directory still uses it through a link, so it was kept`]);
  });
});
