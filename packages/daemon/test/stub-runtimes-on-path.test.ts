import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { probeCodexDaemonSupport } from "../src/domain/codex-daemon-support.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { realRuntimesRequested } from "../../../test/stub-runtimes.js";

// Daemon tests must never run the host's real `codex` or `claude`. Under a fixture HOME the host's
// ~/.local/bin/codex wrapper can hang (mise use -g), and every daemon start probes `codex --version`.
// The shared vitest setup and prepareHermeticEnv put stubs first on PATH instead.

function resolveOnPath(binary: string, pathVar: string): string | undefined {
  for (const dir of pathVar.split(delimiter)) {
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  return undefined;
}

describe("stub codex and claude on the test PATH", () => {
  it.each(["seat-handover-model-fidelity-e2e.test.ts", "seat-lifecycle-set-model-resume-e2e.test.ts"])(
    "allows only the opted-in native e2e file %s", name => {
      const testPath = join(import.meta.dirname, name);
      expect(realRuntimesRequested({ OPENRIG_E2E_REAL_CODEX: "1" }, testPath)).toBe(true);
      expect(realRuntimesRequested({}, testPath)).toBe(false);
      expect(realRuntimesRequested({ OPENRIG_E2E_REAL_CODEX: "1" }, join(tmpdir(), name))).toBe(false);
    },
  );

  it("does not grant the native exception to ordinary tests or plain Node setup consumers", () => {
    const env = { OPENRIG_E2E_REAL_CODEX: "1" };
    expect(realRuntimesRequested(env, import.meta.filename)).toBe(false);
    expect(realRuntimesRequested(env)).toBe(false);
  });

  it("resolves codex and claude inside the fixture root under the vitest setup", () => {
    const root = realpathSync(process.env["OPENRIG_HOME"]!);
    for (const binary of ["codex", "claude"]) {
      const resolved = resolveOnPath(binary, process.env["PATH"] ?? "");
      expect(resolved, `${binary} on PATH`).toBeDefined();
      expect(resolved!.startsWith(`${root}${sep}`) || resolved!.startsWith(`${root}-`), `${binary} -> ${resolved}`).toBe(true);
    }
  });

  it("answers --version at once with a version the runtime verifier parses", () => {
    for (const binary of ["codex", "claude"]) {
      const out = execFileSync(binary, ["--version"], { encoding: "utf-8", timeout: 5000 });
      expect(out).toMatch(/\d+\.\d+\.\d+/);
    }
  });

  it("reports a Codex version new enough that startup does not rewrite the Codex config", () => {
    const out = execFileSync("codex", ["--version"], { encoding: "utf-8", timeout: 5000 });
    const [, major, minor] = /(\d+)\.(\d+)/.exec(out)!;
    expect(Number(major) > 0 || Number(minor) >= 130).toBe(true);
  });

  it("exits 0 at once for any other arguments", () => {
    for (const binary of ["codex", "claude"]) {
      const r = spawnSync(binary, ["--resume"], { encoding: "utf-8", timeout: 5000 });
      expect(r.status).toBe(0);
    }
  });

  it("prints Codex usage with --no-daemon, so a Codex seat launch is not refused as unknown", async () => {
    const help = async () => execFileSync("codex", ["--help"], { encoding: "utf-8", timeout: 5000 });
    await expect(probeCodexDaemonSupport(help)).resolves.toEqual({ kind: "supported" });
  });

  describe("prepareHermeticEnv scaffold", () => {
    const scaffolds: HermeticScaffold[] = [];
    afterEach(() => {
      for (const s of scaffolds.splice(0)) s.cleanup();
    });

    it("puts codex and claude stubs inside the scaffold root ahead of the host's binaries", () => {
      const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home", PATH: "/usr/bin" } });
      scaffolds.push(s);
      const root = realpathSync(s.root);
      for (const binary of ["codex", "claude"]) {
        const resolved = resolveOnPath(binary, s.env["PATH"] ?? "");
        expect(resolved, `${binary} on scaffold PATH`).toBeDefined();
        expect(resolved!.startsWith(`${root}${sep}`), `${binary} -> ${resolved}`).toBe(true);
      }
    });

    it("hides a hanging host codex behind the stub", () => {
      const hostBin = mkdtempSync(join(tmpdir(), "hanging-host-bin-"));
      try {
        writeFileSync(join(hostBin, "codex"), "#!/bin/sh\nexec sleep 600\n");
        chmodSync(join(hostBin, "codex"), 0o755);
        const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home", PATH: `${hostBin}${delimiter}/usr/bin` } });
        scaffolds.push(s);
        const r = spawnSync("codex", ["--version"], { env: s.env as NodeJS.ProcessEnv, encoding: "utf-8", timeout: 5000 });
        expect(r.error).toBeUndefined();
        expect(r.status).toBe(0);
      } finally {
        rmSync(hostBin, { recursive: true, force: true });
      }
    });

    it("keeps scenario runtimes stubbed even when the native e2e opt-in is inherited", () => {
      const s = prepareHermeticEnv({ baseEnv: { HOME: "/real-home", PATH: "/usr/bin", OPENRIG_E2E_REAL_CODEX: "1" } });
      scaffolds.push(s);
      expect(s.env["PATH"]?.split(delimiter).some((dir) => dir.startsWith(s.root) && existsSync(join(dir, "codex")))).toBe(true);
      expect(s.env["OPENRIG_E2E_REAL_CODEX"]).toBeUndefined();
    });
  });
});
