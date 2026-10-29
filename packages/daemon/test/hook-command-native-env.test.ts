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
