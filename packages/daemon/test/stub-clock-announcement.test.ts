import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_CLOCK_ANNOUNCEMENT } from "../src/adapters/stub-runner.js";

// Slice 51-01 items 6-8 — RIDER (review-r1 safety escalation, orch-ruled): the injected
// clock SELF-ANNOUNCES. OPENRIG_TEST_CLOCK_NOW is read in the SHIPPED precompact hook, so
// a leaked var silently FREEZES production createdAt. When the var is ACTIVE, both the
// precompact hook AND the stub runner emit ONE loud stderr line — making any leak visible
// in seat logs. Absence stays silent (production path unchanged; zero behavior change).
// Pin: announcement PRESENT under injection, ABSENT without — for BOTH emitters.

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(
  HERE, "..", "assets", "plugins", "openrig-core",
  "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs",
);
const RUNNER = resolve(HERE, "../src/adapters/stub-runner.ts");
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";

describe("injected-clock self-announcement (precompact hook)", () => {
  function runHook(clock: string | undefined): string {
    const dir = mkdtempSync(join(tmpdir(), "clock-announce-hook-"));
    try {
      const env = { ...process.env, OPENRIG_HOME: join(dir, ".openrig"), OPENRIG_SESSION_NAME: "seat@x", RIGGED_HOME: undefined } as NodeJS.ProcessEnv;
      if (clock !== undefined) env.OPENRIG_TEST_CLOCK_NOW = clock; else delete env.OPENRIG_TEST_CLOCK_NOW;
      const r = spawnSync(process.execPath, [HOOK_SCRIPT], { input: JSON.stringify({ cwd: dir }), encoding: "utf8", env });
      return r.stderr || "";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("emits the announcement on stderr when OPENRIG_TEST_CLOCK_NOW is active", () => {
    expect(runHook(INJECTED_ISO)).toContain(STUB_CLOCK_ANNOUNCEMENT);
  });

  it("stays SILENT (no announcement) when the injected clock is absent — production path", () => {
    expect(runHook(undefined)).not.toContain(STUB_CLOCK_ANNOUNCEMENT);
  });
});

describe("injected-clock self-announcement (stub runner)", () => {
  let child: ChildProcess | undefined;
  let dir: string | undefined;
  afterEach(() => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function runRunner(clock: string | undefined): Promise<string> {
    dir = mkdtempSync(join(tmpdir(), "clock-announce-runner-"));
    const env = { ...process.env, OPENRIG_HOME: join(dir, ".openrig") } as NodeJS.ProcessEnv;
    if (clock !== undefined) env.OPENRIG_TEST_CLOCK_NOW = clock; else delete env.OPENRIG_TEST_CLOCK_NOW;
    let stderr = "";
    child = execFile("node", ["--import", "tsx", RUNNER,
      "--session-name", "seat@x", "--cwd", dir, "--launch-id", "ann-1", "--posture", "floor"], { env });
    child.stderr?.on("data", (d) => { stderr += String(d); });
    // Wait until the runner is up (sidecar ready) so the startup announcement has fired.
    const sidecar = join(dir, ".openrig", "stub", "state.json");
    const deadline = Date.now() + 12_000;
    while (!existsSync(sidecar)) {
      if (Date.now() > deadline) throw new Error("runner did not ready within 12s");
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 150)); // let a same-tick stderr flush
    return stderr;
  }

  it("emits the announcement on stderr when OPENRIG_TEST_CLOCK_NOW is active", async () => {
    expect(await runRunner(INJECTED_ISO)).toContain(STUB_CLOCK_ANNOUNCEMENT);
  }, 20_000);

  it("stays SILENT (no announcement) when the injected clock is absent — production path", async () => {
    expect(await runRunner(undefined)).not.toContain(STUB_CLOCK_ANNOUNCEMENT);
  }, 20_000);
});
