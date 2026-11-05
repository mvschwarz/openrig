import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const require = createRequire(import.meta.url);
const hooks = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
it.runIf(process.platform === "win32").each([2, 3, 4, 5])("hook resolves the paired seat CLI v%s without executing its shim", version => {
  const root = mkdtempSync(join(tmpdir(), "hook-paired-中文 & %-"));
  try {
    const pkg = join(root, "package"), cli = join(pkg, "dist", "entry.mjs"); mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/entry.mjs" } }));
    writeFileSync(cli, "console.log(JSON.stringify(process.argv.slice(2)));process.exitCode=7;");
    const seat = new SeatLaunchEnvironment({} as TmuxAdapter, { OPENRIG_HOME: root }, root, cli, undefined, "win32");
    const generated = (seat as unknown as { rigBin(): string }).rigBin();
    const bin = version === 5 ? generated : join(root, "run", "seat-bin", createHash("sha256").update(realpathSync(cli)).update(`\0windows-seat-bin-v${version}`).digest("hex"));
    mkdirSync(bin, { recursive: true });
    let ps = readFileSync(join(generated, "rig.ps1"), "utf8");
    if (version === 4) ps = ps.replace("$global:LASTEXITCODE = 1\n$ErrorActionPreference = 'Stop'\n", "");
    const cmd = version >= 4 ? readFileSync(join(generated, "rig.cmd"), "utf8")
      : `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath.replaceAll("%", "%%")}" "${realpathSync(cli).replaceAll("%", "%%")}" %*\r\n`;
    writeFileSync(join(bin, "rig.ps1"), ps); writeFileSync(join(bin, "rig.cmd"), cmd);
    const { resolveRigCommand, spawnRig } = require(join(hooks, "rig-command.cjs"));
    const env = { Path: bin, PATHEXT: ".CMD" };
    expect(resolveRigCommand(env, root)).toEqual({ command: process.execPath, prefix: [realpathSync(cli)] });
    const args = ["", 'literal"quote', "中文 & %PATH% !bang!", "trailing\\"];
    const result = spawnRig(args, { cwd: root, env, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual(args);
    if (version >= 4) {
      writeFileSync(join(bin, "rig.ps1"), ps + "\nWrite-Output 'unrecognized'\n");
      expect(() => resolveRigCommand(env, root)).toThrow();
      writeFileSync(join(bin, "rig.ps1"), ps);
    }
    const marker = join(root, "must-not-execute.txt");
    writeFileSync(join(bin, "rig.cmd"), cmd + `echo unexpected > "${marker}"\r\n`);
    expect(() => resolveRigCommand(env, root)).toThrow();
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it.runIf(process.platform === "win32")("resolves rig and explicit Python from native-case environment snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-env-用户 &-"));
  const pkg = join(root, "node_modules/@openrig/cli"); mkdirSync(pkg, { recursive: true });
  const entry = join(pkg, "fixture.cjs"); writeFileSync(entry, "// synthetic entry");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "fixture.cjs" } }));
  writeFileSync(join(root, "rig.cmd"), String.raw`@"%dp0%\node_modules\@openrig\cli\fixture.cjs"`);
  try {
    const { resolveRigCommand } = require(join(hooks, "rig-command.cjs"));
    expect(resolveRigCommand({ pAtH: root })).toMatchObject({ command: process.execPath, prefix: [entry] });
    expect(() => resolveRigCommand({ PATH: "", Path: root })).toThrow();
    const { spawnPython } = require(join(hooks, "python-command.cjs"));
    const result = spawnPython(["-e", "process.stdout.write('synthetic interpreter')"], {
      env: { pYtHoN: process.execPath, PATH: "" }, encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("synthetic interpreter");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === "win32")("runs a local npm rig entry from .bin with literal hook arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "hook-local-用户 &-"));
  try {
    const modules = join(root, "node_modules"), bin = join(modules, ".bin"), pkg = join(modules, "@openrig", "cli");
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@openrig/cli", bin: { rig: "dist/fixture.cjs" } }));
    writeFileSync(join(pkg, "dist", "fixture.cjs"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    writeFileSync(join(bin, "rig.cmd"), '@ECHO off\r\n"%_prog%" "%dp0%\\..\\@openrig\\cli\\dist\\fixture.cjs" %*\r\n');
    const { spawnRig, resolveRigCommand } = require(join(hooks, "rig-command.cjs"));
    const env = { Path: bin, PATHEXT: ".CMD" };
    const args = ["context", "用户 & space", "apostrophe'", 'quote"', "%NOT_EXPANDED%", "$(literal)", ""];
    const result = spawnRig(args, { env, cwd: root, encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(() => resolveRigCommand({ ...env, PATHEXT: "" }, root)).toThrow("No rig executable");
    writeFileSync(join(bin, "rig.cmd"), '@echo unrelated\r\n');
    expect(() => resolveRigCommand(env, root)).toThrow("Unrecognized Windows rig shim");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
