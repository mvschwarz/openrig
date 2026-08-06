// Slice 51-01 items 6-8 — A3-R3 CLOCK/STAMP INJECTION SEAM on the compaction assets.
//
// The shipped compaction hook scripts stamp wall-clock time with `new Date()` at
// FOUR sites across THREE assets, none injectable:
//   * restore-from-jsonl.mjs:379   — the packet output-dir timestamped path element
//   * precompact-hook.mjs:66        — marker.createdAt (the PreCompact writer)
//   * compaction-restore-bridge.cjs:145 — marker.postCompactAt (PostCompact reader)
//   * compaction-restore-bridge.cjs:154 — marker.deliveredAt (delivery reader)
//
// A5 ruling (sourcefit cbbb4903 → A3-R3): the slice ADDS a bounded injectable clock —
// real wall-clock by default (production), deterministic when the shared hermetic
// env-var OPENRIG_TEST_CLOCK_NOW is set. The determinism pin: run the SAME script
// sequence twice under the SAME injected clock and get byte-identical compaction-asset
// stamps (the packet dir path + every marker timestamp).
//
// These tests spawn the REAL asset scripts as subprocesses (the class-fix floor:
// real-spawn, never an in-memory shortcut — the exact precompact-hook.test.ts
// convention) with an isolated OPENRIG_HOME, so the on-disk stamps match what Claude
// observes at PreCompact/SessionStart/PostCompact time.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = resolve(HERE, "..", "assets", "plugins", "openrig-core");
const HOOK_SCRIPT = resolve(ASSET_ROOT, "skills", "claude-compaction-restore", "scripts", "precompact-hook.mjs");
const BRIDGE_SCRIPT = resolve(ASSET_ROOT, "hooks", "scripts", "compaction-restore-bridge.cjs");

// A distinctive fixed ISO instant. `new Date().toISOString()` real wall-clock will
// (essentially) never equal this, so an assertion that a stamp EQUALS it can only
// pass once the injected clock is honored — a true RED against the un-seamed code.
const INJECTED_ISO = "2021-06-06T06:06:06.000Z";
// The packet-dir stamp is the ISO with ':' and '.' replaced by '-' (writeOutputs).
const INJECTED_STAMP = INJECTED_ISO.replace(/[:.]/g, "-");
const SEAT = "clock-seat@kernel";

function assetEnv(openrigHome: string, injectClockNow?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENRIG_HOME: openrigHome,
    OPENRIG_SESSION_NAME: SEAT,
    RIGGED_HOME: undefined,
    // Absence => production real-time fallback; presence => deterministic injection.
    OPENRIG_TEST_CLOCK_NOW: injectClockNow,
  } as NodeJS.ProcessEnv;
}

function markerPathFor(openrigHome: string): string {
  return join(openrigHome, "compaction", "restore-pending", `${SEAT}.json`);
}

function readMarker(openrigHome: string): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPathFor(openrigHome), "utf8"));
}

// Write a pending restore marker directly (bridge-only tests need no writer run).
function seedMarker(openrigHome: string, overrides: Record<string, unknown> = {}): void {
  const p = markerPathFor(openrigHome);
  mkdirSync(dirname(p), { recursive: true });
  const data = {
    version: 1,
    createdAt: "2000-01-01T00:00:00.000Z",
    sessionName: SEAT,
    outputDir: "/tmp/claude-compaction-restore/seeded",
    expectedAck: "restored from packet at <path>; resumed at step <X>",
    deliveredAt: null,
    deliveryCount: 0,
    ...overrides,
  };
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// A minimal but real Claude JSONL transcript so the PreCompact writer's
// restore-from-jsonl child produces a deterministic sessionId → deterministic
// packet dir under the injected clock.
function writeFixtureJsonl(dir: string): string {
  const p = join(dir, "transcript.jsonl");
  const line = JSON.stringify({
    sessionId: "fixture-sess",
    cwd: dir,
    message: { role: "user", content: "hello from the clock fixture" },
  });
  writeFileSync(p, `${line}\n`, "utf8");
  return p;
}

function runBridge(
  openrigHome: string,
  input: Record<string, unknown>,
  injectClockNow?: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [BRIDGE_SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: assetEnv(openrigHome, injectClockNow),
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

function runHook(
  openrigHome: string,
  input: Record<string, unknown>,
  injectClockNow?: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: assetEnv(openrigHome, injectClockNow),
  });
  return { stdout: result.stdout || "", stderr: result.stderr || "", status: result.status };
}

describe("A3-R3 compaction-asset clock/stamp injection (real-spawn)", () => {
  let tmpDir: string;
  let openrigHome: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "compaction-clock-"));
    openrigHome = join(tmpDir, ".openrig");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("bridge stamps marker.deliveredAt from OPENRIG_TEST_CLOCK_NOW (delivery path)", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "UserPromptSubmit" }, INJECTED_ISO);
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["deliveryCount"]).toBe(1);
    expect(marker["deliveredAt"]).toBe(INJECTED_ISO);
  });

  it("bridge stamps marker.postCompactAt from OPENRIG_TEST_CLOCK_NOW (PostCompact path)", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "PostCompact" }, INJECTED_ISO);
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["postCompactAt"]).toBe(INJECTED_ISO);
  });

  it("PreCompact writer stamps marker.createdAt + the packet-dir path from the injected clock", () => {
    const jsonl = writeFixtureJsonl(tmpDir);
    const hook = runHook(openrigHome, { transcript_path: jsonl, cwd: tmpDir }, INJECTED_ISO);
    expect(hook.status).toBe(0);
    const marker = readMarker(openrigHome);
    expect(marker["createdAt"]).toBe(INJECTED_ISO);
    // The packet output dir carries the injected timestamped-path element.
    expect(String(marker["outputDir"])).toContain(INJECTED_STAMP);
    expect(existsSync(String(marker["outputDir"]))).toBe(true);
  });

  it("DETERMINISM PIN: the full writer→bridge sequence twice under the SAME clock → byte-identical asset stamps", () => {
    const runOnce = (): { createdAt: unknown; outputDir: unknown; deliveredAt: unknown; postCompactAt: unknown } => {
      const home = join(mkdtempSync(join(tmpdir(), "compaction-clock-run-")), ".openrig");
      const jsonl = writeFixtureJsonl(dirname(home));
      expect(runHook(home, { transcript_path: jsonl, cwd: dirname(home) }, INJECTED_ISO).status).toBe(0);
      expect(runBridge(home, { hook_event_name: "UserPromptSubmit" }, INJECTED_ISO).status).toBe(0);
      expect(runBridge(home, { hook_event_name: "PostCompact" }, INJECTED_ISO).status).toBe(0);
      const m = readMarker(home);
      // Normalize the ephemeral per-run tmp prefix out of outputDir — the timestamped
      // STAMP element (the clock-derived part) is what the pin proves deterministic.
      const outStamp = String(m["outputDir"]).split("/").pop();
      return { createdAt: m["createdAt"], outputDir: outStamp, deliveredAt: m["deliveredAt"], postCompactAt: m["postCompactAt"] };
    };
    const run1 = runOnce();
    const run2 = runOnce();
    expect(run1).toEqual(run2);
    // And every stamp is the injected instant, not wall-clock.
    expect(run1.createdAt).toBe(INJECTED_ISO);
    expect(run1.deliveredAt).toBe(INJECTED_ISO);
    expect(run1.postCompactAt).toBe(INJECTED_ISO);
    expect(String(run1.outputDir)).toContain(INJECTED_STAMP);
  });

  it("PRESERVATION: absent clock var → real wall-clock stamps (production fallback intact, never the sentinel)", () => {
    seedMarker(openrigHome);
    const bridge = runBridge(openrigHome, { hook_event_name: "UserPromptSubmit" });
    expect(bridge.status).toBe(0);
    const marker = readMarker(openrigHome);
    const deliveredAt = String(marker["deliveredAt"]);
    // A valid ISO instant that is NOT the injected sentinel — the fallback ran.
    expect(deliveredAt).not.toBe(INJECTED_ISO);
    expect(Number.isNaN(Date.parse(deliveredAt))).toBe(false);
  });
});
