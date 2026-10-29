import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { RequirementsProbeRegistry } from "../src/domain/requirements-probe.js";
import { ExternalInstallPlanner } from "../src/domain/external-install-planner.js";
import { randomUUID } from "node:crypto";

it.runIf(process.platform === "win32")("recognizes current-directory PATH entries without executing or planning an install", async () => {
  const name = `openrig-owned-probe-${randomUUID()}`;
  const file = join(process.cwd(), name + ".cmd");
  const exec = vi.fn(async () => { throw new Error("must not execute"); });
  writeFileSync(file, "@exit /b 99", { flag: "wx" });
  try {
    const registry = new RequirementsProbeRegistry(exec, { env: { Path: ";", Pathext: ".CMD" } });
    const result = await registry.probeCli(name);
    expect(result).toMatchObject({ status: "installed", detectedPath: file.slice(0, -4) + ".CMD", command: null });
    expect(new ExternalInstallPlanner({ platform: "win32" }).planInstalls([result]).alreadyInstalled).toEqual([name]);
    expect(await new RequirementsProbeRegistry(exec, { env: { Path: ";", Pathext: "" } }).probeCli(name)).toMatchObject({ status: "missing" });
    expect(exec).not.toHaveBeenCalled();
  } finally { rmSync(file); }
});

it.runIf(process.platform === "win32")("probes native PATH/PATHEXT without a POSIX shell or executing the target", async () => {
  const root = mkdtempSync(join(tmpdir(), "requirements-native-用户 &-"));
  const exec = vi.fn(async () => { throw new Error("no shell allowed"); });
  writeFileSync(join(root, "fixture-tool.cmd"), "@echo this fixture must never execute");
  mkdirSync(join(root, "directory-only.exe"));
  const registry = new RequirementsProbeRegistry(exec, { env: { Path: `"${root}"`, Pathext: ".EXE;.CMD" } });
  try {
    const results = await registry.probeAll([
      { name: "fixture-tool", kind: "cli_tool", installHints: { windows: "display only" } },
      { name: "directory-only", kind: "cli_tool" },
      { name: "missing", kind: "cli_tool" },
    ]);
    expect(results[0]).toMatchObject({ status: "installed", detectedPath: join(root, "fixture-tool.CMD"), command: null, installHints: { windows: "display only" } });
    expect(results.slice(1).map(result => result.status)).toEqual(["missing", "missing"]);
    expect(await registry.probeCli(join(root, "fixture-tool.cmd"))).toMatchObject({ status: "installed", detectedPath: join(root, "fixture-tool.cmd") });
    expect(await registry.probeCli("literal&tool")).toMatchObject({ status: "missing" });
    expect(exec).not.toHaveBeenCalled();
    const plan = new ExternalInstallPlanner({ platform: "win32" }).planInstalls(results);
    expect(plan.alreadyInstalled).toEqual(["fixture-tool"]);
    expect(plan.manualOnly).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
