import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createProgram } from "../src/index.js";

let home: string;
beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), "openrig-root-help-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const wrapper = fileURLToPath(new URL("../dist/bin-wrapper.js", import.meta.url));
const helpPath = fileURLToPath(new URL("../dist/root-help.txt", import.meta.url));

it("ships exactly the complete current command tree's root help", () => {
  let expected = "";
  createProgram().configureHelp({ helpWidth: 80 }).configureOutput({ writeOut: text => { expected += text; } }).outputHelp();
  expect(readFileSync(helpPath, "utf8")).toBe(expected);
});

it.each(["bin-wrapper.js", "index.js"].flatMap(entry => [[], ["--help"], ["-h"]].map(args => ({ entry, args }))))("root help $entry $args exits within the existing five-second limit", ({ entry, args }) => {
  const entryPath = path.join(path.dirname(wrapper), entry);
  const result = spawnSync(process.execPath, [entryPath, ...args], {
    input: "x\n", encoding: "utf8", timeout: 5000, windowsHide: true,
    cwd: home, env: { ...process.env, OPENRIG_HOME: home },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(args.length ? result.stdout : result.stderr).toBe(readFileSync(helpPath, "utf8"));
  expect(args.length ? result.stderr : result.stdout).toBe("");
});

it.each(["bin-wrapper.js", "index.js"])("keeps version and named-command help fast through %s", entry => {
  for (const args of [["--version"], ["queue", "--help"]]) {
    const result = spawnSync(process.execPath, [path.join(path.dirname(wrapper), entry), ...args], {
      input: "", encoding: "utf8", timeout: 5000, windowsHide: true,
      cwd: home, env: { ...process.env, OPENRIG_HOME: home },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(args[0] === "--version" ? /^\d+\.\d+\.\d+/ : /Usage: rig queue/);
    expect(result.stderr).toBe("");
  }
});
