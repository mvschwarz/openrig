import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const hooks = resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks/scripts");
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
