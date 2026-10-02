import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runtimeProbeFailure, runtimeVersionProbeCwd } from "../src/adapters/preflight-exec.js";
import { verifyPiRuntimeAvailable } from "../src/domain/rigspec-preflight.js";
import type { RigSpec } from "../src/domain/types.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function probe(mode: string, runtime = "pi") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-probe-"));
  roots.push(root);
  for (const name of ["home", "openrig", "codex", "tmp", "seat", "bin", "empty-bin", "rig/agents/impl"]) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "rig/agents/impl/agent.yaml"),
    'name: impl\nversion: "1.0.0"\nresources:\n  skills: []\nprofiles:\n  default:\n    uses:\n      skills: []\n');
  // Mirrors the relevant Pi startup behaviour: getcwd before handling --version.
  // No real runtime, session or provider is invoked.
  for (const name of ["pi", "omp", "codex"]) {
    fs.writeFileSync(path.join(root, "bin", name),
      `#!${process.execPath}\nconsole.log(process.cwd());\n`, { mode: 0o700 });
  }
  const child = spawnSync(process.execPath, [
    "--import", createRequire(import.meta.url).resolve("tsx"),
    path.join(import.meta.dirname, "fixtures/runtime-probe-cwd.ts"), root, mode, runtime,
  ], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { PATH: process.env.PATH, HOME: path.join(root, "home"), OPENRIG_HOME: path.join(root, "openrig"),
      CODEX_HOME: path.join(root, "codex"), TMPDIR: path.join(root, "tmp") },
  });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

describe("runtime version preflight cwd", () => {
  it.each(["pi", "omp", "codex", "claude"])("preserves a healthy cwd for %s --version", (runtime) => {
    const cwd = runtimeVersionProbeCwd(`${runtime} --version`);
    expect(cwd).toBe(process.cwd());
    expect(fs.statSync(cwd!).isDirectory()).toBe(true);
    expect(runtimeVersionProbeCwd(`${runtime} --help`)).toBeUndefined();
  });

  it("leaves Codex profile probes and injected executors intact", async () => {
    expect(runtimeVersionProbeCwd("codex -p fixture mcp list")).toBeUndefined();
    const exec = vi.fn().mockResolvedValue("synthetic");
    const spec = { pods: [{ members: [{ runtime: "pi" }] }] } as RigSpec;
    expect(await verifyPiRuntimeAvailable(spec, exec)).toEqual([]);
    expect(exec.mock.calls).toEqual([["pi --version"]]);
  });

  it.skipIf(process.platform === "win32")("passes both production probe paths and preserves non-version cwd", () => {
    const result = probe("stable");
    expect(result.status).toBe(200);
    expect(result.core.ready).toBe(true);
    expect(result.route.ready).toBe(true);
    expect(result.legacy.ready).toBe(true);
    expect(result.bootstrap).toMatchObject({ status: 200, result: { status: "planned", errors: [] } });
    expect(fs.realpathSync(result.nonVersion)).toBe(fs.realpathSync(result.work));
    expect(result.generic).toBe(result.nonVersion);
  });

  it.skipIf(process.platform === "win32").each(["pi", "omp"])("survives a deleted daemon cwd for %s through all preflight paths", (runtime) => {
    const result = probe("deleted", runtime);
    expect(result.core).toMatchObject({ ready: true, errors: [] });
    expect(result.route).toMatchObject({ ready: true, errors: [] });
    expect(result.legacy).toMatchObject({ ready: true, errors: [] });
    expect(result.bootstrap).toMatchObject({ status: 200, result: { status: "planned", errors: [] } });
  });

  it.skipIf(process.platform === "win32").each(["pi", "omp"])("keeps relative PATH lookup in a healthy cwd for %s", (runtime) => {
    const result = probe("relative", runtime);
    expect(fs.realpathSync(result.generic)).toBe(fs.realpathSync(result.work));
    expect(result.core).toMatchObject({ ready: true, errors: [] });
    expect(result.route).toMatchObject({ ready: true, errors: [] });
    expect(result.legacy).toMatchObject({ ready: true, errors: [] });
    expect(result.bootstrap).toMatchObject({ status: 200, result: { status: "planned", errors: [] } });
  });

  it.skipIf(process.platform === "win32").each(["pi", "omp"])("does not trust a cached cwd after deletion for %s", (runtime) => {
    const result = probe("deleted-cached", runtime);
    expect(result.core).toMatchObject({ ready: true, errors: [] });
    expect(result.route).toMatchObject({ ready: true, errors: [] });
    expect(result.legacy).toMatchObject({ ready: true, errors: [] });
    expect(result.bootstrap).toMatchObject({ status: 200, result: { status: "planned", errors: [] } });
  });

  it.skipIf(process.platform === "win32")("still refuses a genuinely absent executable, with bounded detail", () => {
    const result = probe("missing");
    for (const value of [result.core, result.route, result.legacy]) {
      expect(value.ready).toBe(false);
      expect(value.errors).toHaveLength(1);
      expect(value.errors[0]).toContain("exit status 127");
      expect(value.errors[0]).toContain("executable not found on PATH");
    }
    expect(result.bootstrap).toMatchObject({ status: 409, result: { status: "failed" } });
    expect(result.bootstrap.result.errors.join("\n")).toContain("executable not found on PATH");
  });

  it("distinguishes cwd lookup failure without echoing arbitrary process output", async () => {
    const failure = Object.assign(new Error("private-output"), {
      code: 1, stderr: Buffer.from("secret-input: Error ENOENT uv_cwd\n"),
    });
    const detail = runtimeProbeFailure(failure);
    expect(detail).toBe("exit status 1; working-directory lookup failed");
    const spec = { pods: [{ members: [{ runtime: "pi" }] }] } as RigSpec;
    const errors = await verifyPiRuntimeAvailable(spec, async () => { throw failure; });
    expect(errors[0]).toContain(detail);
    expect(errors[0]).not.toMatch(/private-output|secret-input/);
    expect(runtimeProbeFailure({ status: 127, stderr: Buffer.from("sh: pi: not found") })).toBe("exit status 127; executable not found on PATH");
    expect(runtimeProbeFailure({ code: "EACCES" })).toBe("EACCES");
    expect(runtimeProbeFailure({ code: "SECRET", message: "private-output" })).toBe("execution failed");
  });
});
