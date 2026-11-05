import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { resolveWindowsProviderCommand } from "../src/domain/windows-provider-command.js";
import { resolveWindowsPiCommand } from "../src/adapters/windows-pi-command.js";

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });
it.runIf(process.platform === "win32").each((["codex", "claude", "pi"] as const).flatMap(name => [false, true].map(relativePath => ({ name, relativePath }))))("runs local npm $name without a batch shell (relative PATH=$relativePath)", ({ name, relativePath }) => {
  root = mkdtempSync(join(tmpdir(), "local-npm-runtime-"));
  const modules = join(root, "node_modules"), bin = join(modules, ".bin");
  const packageName = name === "codex" ? "@openai/codex" : name === "claude" ? "@anthropic-ai/claude-code" : "@earendil-works/pi-coding-agent";
  const pkg = join(modules, ...packageName.split("/"));
  mkdirSync(bin, { recursive: true }); mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [name]: "entry.cjs" } }));
  writeFileSync(join(pkg, "entry.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
  writeFileSync(join(bin, `${name}.cmd`), `@echo off\r\n"%_prog%" "%dp0%\\..\\${packageName.replaceAll("/", "\\")}\\entry.cjs" %*\r\n`);
  if (name === "pi") mkdirSync(join(bin, "pi.exe")); // PATH lookup must skip directories named like executables.
  const searchPath = `${relativePath ? relative(root, bin) : bin};${dirname(process.execPath)}`;
  const select = () => name === "pi" ? resolveWindowsPiCommand(searchPath, process.execPath, root)
    : resolveWindowsProviderCommand(name, { PATH: searchPath }, root);
  const launch = select();
  const args = ["用户 space", 'quote"', "", "trailing\\", "%LITERAL%", "amp&word"];
  const child = spawnSync(launch.command, [...launch.prefix, ...args], { cwd: root, windowsHide: true, encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toEqual(args);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "unrelated-package", bin: { [name]: "entry.cjs" } }));
  expect(select).toThrow(/recognized npm installation/);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [name]: "../outside.cjs" } }));
  expect(select).toThrow(/escapes its package/);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: packageName, bin: { [name]: "entry.cjs" } }));
  writeFileSync(join(bin, `${name}.cmd`), "@echo unrecognized shim\r\n");
  expect(select).toThrow(/Unrecognized Windows/);
});
