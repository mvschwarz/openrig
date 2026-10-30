import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { resolveTuiCliEntry } from "../src/cli-command.js";

it.runIf(process.platform === "win32").each(["workspace", "bundled"])("standalone native TUI selects its %s sibling CLI without cmd", layout => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tui-cli-native-"));
  try {
    const main = path.join(root, layout === "workspace" ? "packages/tui/dist/main.js" : "cli/tui/dist/main.js");
    const cli = path.join(root, layout === "workspace" ? "packages/cli/dist/index.js" : "cli/dist/index.js");
    fs.mkdirSync(path.dirname(main), { recursive: true });
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(main, "// owned TUI location\n");
    fs.writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    fs.writeFileSync(path.join(root, "rig.cmd"), "@echo off\r\necho WRONG-SHIM\r\n");
    const env = { ...process.env, PATH: root };
    delete env.OPENRIG_TUI_CLI_ENTRY;
    const selected = resolveTuiCliEntry(env, pathToFileURL(main).href);
    const args = ["config", "get", "ui.timezone", "--json", "space % ! & ' value"];
    const child = spawnSync(selected ? process.execPath : "rig", [...(selected ? [selected] : []), ...args],
      { cwd: root, env, encoding: "utf8", timeout: 5000, windowsHide: true });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(args);
    expect(selected).toBe(fs.realpathSync.native(cli));
    expect(resolveTuiCliEntry({ OPENRIG_TUI_CLI_ENTRY: "explicit-entry" }, pathToFileURL(main).href)).toBe("explicit-entry");
    fs.rmSync(cli);
    expect(resolveTuiCliEntry(env, pathToFileURL(main).href)).toBeUndefined();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
