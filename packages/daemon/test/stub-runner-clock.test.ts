import { describe, it, expect, afterEach } from "vitest";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Slice 51-01 items 6-8 — the stub runner's OWN clock honors the injected clock.
//
// PRD §5 determinism guarantee: "no wall-clock/RNG in the stub's OWN behavior." The
// runner stamps its readiness sidecar (updatedAt, exit.at) — with plain new Date()
// those stamps drift run-to-run and break the compaction determinism pin (a
// byte-identical double-run). The runner's clock must be the SAME injectable seam the
// compaction assets use: OPENRIG_TEST_CLOCK_NOW (an ISO instant) with a real-wall-clock
// fallback (absent = production). This spawns the REAL runner (the class-fix floor) and
// reads the sidecar it actually wrote.

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const SIDECAR_SUBPATH = join(".openrig", "stub", "state.json");
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

async function waitForSidecar(dir: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  const p = join(dir, SIDECAR_SUBPATH);
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8"));
        if (parsed && parsed.ready === true) return parsed;
      } catch { /* mid-write torn read; retry */ }
    }
    if (Date.now() > deadline) throw new Error(`sidecar not ready within ${timeoutMs}ms: ${p}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stub-runner own-clock determinism (PRD §5)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("stamps the readiness sidecar updatedAt from OPENRIG_TEST_CLOCK_NOW (not wall-clock)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-clock-"));
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "dev-worker@t", "--cwd", dir, "--launch-id", "clk-1", "--posture", "floor"],
      { env: { ...process.env, OPENRIG_TEST_CLOCK_NOW: INJECTED_ISO } as NodeJS.ProcessEnv });

    const sidecar = await waitForSidecar(dir);
    expect(sidecar["ready"]).toBe(true);
    expect(sidecar["updatedAt"]).toBe(INJECTED_ISO);
  }, 20_000);

  it("falls back to real wall-clock when the injected clock is absent (production path intact)", async () => {
    dir = mkdtempSync(join(tmpdir(), "stub-clock-fallback-"));
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "dev-worker@t", "--cwd", dir, "--launch-id", "clk-2", "--posture", "floor"]);

    const sidecar = await waitForSidecar(dir);
    const updatedAt = String(sidecar["updatedAt"]);
    expect(updatedAt).not.toBe(INJECTED_ISO);
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  }, 20_000);
});
