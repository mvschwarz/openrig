import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { communityHarnessesRoutes } from "../src/routes/community-harnesses.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("checks executable availability on request while preserving normal listings", async () => {
  const root = mkdtempSync(join(tmpdir(), "community-harness-preflight-"));
  roots.push(root);
  vi.stubEnv("OPENRIG_HOME", root);
  vi.stubEnv("PATH", dirname(process.execPath));
  const dir = join(root, "community-harnesses");
  mkdirSync(dir);
  for (const [name, command] of [["valid", basename(process.execPath)], ["missing", "openrig-absent-executable"], ["relative", "./launcher"]]) {
    writeFileSync(join(dir, `${name}.yaml`), `format: 1\nname: ${name}\ncommand: ${command}\nmaintainer: fixture\nlimits: []\n`);
  }
  const app = communityHarnessesRoutes();
  const ordinary = await (await app.request("/")).json();
  expect(ordinary.harnesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "missing", usable: true }),
  ]));
  expect(ordinary.harnesses[0]).not.toHaveProperty("executableProblem");
  const checked = await (await app.request("/?preflight=true")).json();
  expect(checked.harnesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "missing", usable: true, executableProblem: expect.stringContaining("PATH") }),
    expect.objectContaining({ name: "relative", usable: true, executableProblem: expect.stringContaining("working directory") }),
    expect.objectContaining({ name: "valid", usable: true, executable: expect.any(String) }),
  ]));
});
